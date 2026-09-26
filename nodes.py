# SPDX-License-Identifier: GPL-3.0-only
"""Ming-native prompt validation, import/export, and layout preview. No model loading."""

from __future__ import annotations

import base64
import io
import json
import logging
import math
import re
from collections import Counter
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps

LOGGER = logging.getLogger(__name__)
HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")
NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
COORDINATES = re.compile(
    rf"\s*cx\s*:\s*({NUMBER})\s*,\s*cy\s*:\s*({NUMBER})\s*,\s*"
    rf"w\s*:\s*({NUMBER})\s*,\s*h\s*:\s*({NUMBER})\s*\Z"
)
MAX_DIMENSION = 16384
PREVIEW_EDGE = 1024


class PromptValidationError(ValueError):
    """An actionable error in the editor state or a Ming document."""


def _string(value: Any, name: str, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise PromptValidationError(f"{name} must be {'a non-empty' if nonempty else 'a'} string.")
    return value


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise PromptValidationError(f"{name} must be a finite number.")
    return float(value)


def _dimension(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_DIMENSION:
        raise PromptValidationError(f"{name} must be an integer from 1 to {MAX_DIMENSION}.")
    return value


def aspect_ratio(width: int, height: int) -> str:
    _dimension(width, "width")
    _dimension(height, "height")
    divisor = math.gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def dimensions_for_ratio(ratio: str, width: int, height: int) -> tuple[int, int]:
    """Keep the current long edge approximately, using an exact integer ratio."""
    match = re.fullmatch(r"\s*([1-9]\d*)\s*:\s*([1-9]\d*)\s*", _string(ratio, "aspect_ratio"))
    if not match:
        raise PromptValidationError('aspect_ratio must contain positive integers, such as "16:9".')
    a, b = map(int, match.groups())
    divisor = math.gcd(a, b)
    a, b = a // divisor, b // divisor
    if max(a, b) > MAX_DIMENSION:
        raise PromptValidationError("The imported aspect ratio needs dimensions greater than 16384.")
    _dimension(width, "width")
    _dimension(height, "height")
    scale = max(1, min(MAX_DIMENSION // max(a, b), round(max(width, height) / max(a, b))))
    return a * scale, b * scale


def parse_coordinates(value: str) -> dict[str, float]:
    match = COORDINATES.fullmatch(_string(value, "coordinates"))
    if not match:
        raise PromptValidationError('Malformed coordinates; expected "cx: 0.500, cy: 0.500, w: 0.300, h: 0.200".')
    cx, cy, width, height = map(float, match.groups())
    for key, number in zip(("cx", "cy", "w", "h"), (cx, cy, width, height)):
        _number(number, f"coordinates.{key}")
    if not 0 <= cx <= 1 or not 0 <= cy <= 1 or not 0 < width <= 1 or not 0 < height <= 1:
        raise PromptValidationError("Ming cx/cy must be in 0..1 and w/h in (0..1].")
    return {"x": cx - width / 2, "y": cy - height / 2, "w": width, "h": height}


def serialize_coordinates(region: dict) -> str:
    return (f"cx: {region['x'] + region['w'] / 2:.3f}, "
            f"cy: {region['y'] + region['h'] / 2:.3f}, "
            f"w: {region['w']:.3f}, h: {region['h']:.3f}")


def _geometry(region: dict, label: str, warnings: list[str]) -> dict[str, float]:
    x, y, w, h = (_number(region.get(key), f"{label}.{key}") for key in ("x", "y", "w", "h"))
    if w <= 0 or h <= 0:
        raise PromptValidationError(f"{label}: width and height must be greater than zero.")
    left, top = max(0.0, x), max(0.0, y)
    right, bottom = min(1.0, x + w), min(1.0, y + h)
    if right <= left or bottom <= top:
        raise PromptValidationError(f"{label}: the region does not intersect the canvas.")
    if max(abs(left - x), abs(top - y), abs(right - x - w), abs(bottom - y - h)) > 1e-9:
        warnings.append(f"{label}: coordinates were clipped to the canvas.")
    w, h = right - left, bottom - top
    if w < 0.001 or h < 0.001:
        warnings.append(f"{label}: a dimension was raised to 0.001 for three-decimal coordinates.")
        w, h = max(w, 0.001), max(h, 0.001)
        left, top = min(left, 1 - w), min(top, 1 - h)
    return {"x": left, "y": top, "w": w, "h": h}


def _colors(value: Any, label: str) -> list[str]:
    if not isinstance(value, list):
        raise PromptValidationError(f"{label}: colors must be an array of #RRGGBB strings.")
    result = []
    for color in value:
        if not isinstance(color, str) or not HEX_COLOR.fullmatch(color):
            raise PromptValidationError(f"{label}: invalid color {color!r}; use #RRGGBB.")
        result.append(color.upper())
    return result


def _load_json(value: str, label: str) -> Any:
    def invalid_constant(token):
        raise PromptValidationError(f"{label}: {token} is not valid JSON.")

    try:
        return json.loads(_string(value, label), parse_constant=invalid_constant)
    except json.JSONDecodeError as error:
        raise PromptValidationError(f"{label}: {error.msg} (line {error.lineno}, column {error.colno}).") from error


def _detect_text(description: str) -> tuple[str, str] | None:
    """Only extract unambiguous quoted text. Uncertain prose remains an object.

    Use literal text inside the quotes, not a second JSON encoding: backslashes,
    line breaks and Unicode in the visible string must survive character-for-character.
    """
    prefix = 'A text element reading exactly "'
    if description.startswith(prefix):
        body = description[len(prefix):]
        if '" in ' in body:
            text, visual = body.rsplit('" in ', 1)
            # Ambiguous delimiters in the visual prose are not guessed at.
            if '"' not in visual and visual.endswith((".", "!", "?")):
                return text, visual[:-1] if visual.endswith(".") else visual
        elif body.endswith('".'):
            return body[:-2], ""
    match = re.search(r'\b(?:text(?: element)?|headline|title|caption)?\s*reading exactly "([^"\n]+)"', description, re.I)
    if not match or '"' in description[:match.start()] + description[match.end():]:
        return None
    visual = (description[:match.start()] + description[match.end():]).strip()
    visual = re.sub(r"^(?:A|An)\s*$", "", visual, flags=re.I)
    return match.group(1), visual


def validate_regions(regions: Any) -> tuple[list[dict], list[str]]:
    if not isinstance(regions, list):
        raise PromptValidationError("layers_data must be an array of regions, or a version 1 editor state.")
    clean, warnings, ids = [], [], set()
    for index, value in enumerate(regions):
        label = f"Region {index + 1}"
        if not isinstance(value, dict):
            raise PromptValidationError(f"{label} must be an object.")
        kind = value.get("kind", "object")
        if kind not in ("object", "text"):
            raise PromptValidationError(f"{label}: type must be object or text.")
        identifier = value.get("id", f"layer_{index + 1}")
        _string(identifier, f"{label}.id", True)
        if identifier in ids:
            raise PromptValidationError(f"{label}: duplicate region id {identifier!r}.")
        ids.add(identifier)
        region = {"id": identifier, **_geometry(value, label, warnings), "kind": kind,
                  "text": _string(value.get("text", ""), f"{label}.text", kind == "text"),
                  "description": _string(value.get("description", ""), f"{label}.description", kind == "object"),
                  "relation": _string(value.get("relation", ""), f"{label}.relation"),
                  "colors": _colors(value.get("colors", []), label)}
        if "relation" not in value:
            warnings.append(f"{label}: missing hierarchy / relation was filled with an empty string.")
        if "raw_description" in value:
            region["raw_description"] = _string(value["raw_description"], f"{label}.raw_description")
        clean.append(region)
    if not clean:
        warnings.append("No layers yet. Draw a region to describe a visible group.")
    texts = [r for r in clean if r["kind"] == "text"]
    counts = Counter(r["text"] for r in texts)
    if any(count > 1 for count in counts.values()):
        warnings.append("Identical exact text is used by multiple text layers.")
    for region in texts:
        if len(region["text"]) >= 80 and len(region["text"]) / (region["w"] * region["h"]) > 2400:
            warnings.append(f"{region['id']}: This region contains a large amount of text relative to its size.")
    for i, first in enumerate(texts):
        for second in texts[i + 1:]:
            overlap = max(0, min(first["x"] + first["w"], second["x"] + second["w"]) - max(first["x"], second["x"]))
            overlap *= max(0, min(first["y"] + first["h"], second["y"] + second["h"]) - max(first["y"], second["y"]))
            smaller = min(first["w"] * first["h"], second["w"] * second["h"])
            if smaller >= 0.02 and overlap / smaller > 0.65:
                warnings.append(f"{first['id']} and {second['id']}: large text regions overlap heavily.")
    return clean, warnings


def parse_editor_state(layers_data: str) -> tuple[list[dict], str | None]:
    state = _load_json(layers_data or "[]", "layers_data")
    selected = None
    if isinstance(state, dict):
        if state.get("version") != 1 or state.get("order", "front_to_back") != "front_to_back":
            raise PromptValidationError("Unsupported editor version or layer order.")
        # This hint is supplied only for execution. It is never restored as editor state.
        selected = state.get("_preview_selected")
        state = state.get("regions")
    if selected is not None and not isinstance(selected, str):
        raise PromptValidationError("The preview selection must be a region id.")
    if not isinstance(state, list):
        raise PromptValidationError("layers_data must contain a region array.")
    return state, selected


def import_ming(prompt: str, width: int = 1024, height: int = 1024) -> dict:
    document = _load_json(prompt, "Ming JSON")
    if not isinstance(document, dict):
        raise PromptValidationError("Ming JSON must be a top-level object.")
    settings = document.get("canvas_settings")
    if not isinstance(settings, dict):
        raise PromptValidationError("canvas_settings must be an object.")
    width, height = dimensions_for_ratio(settings.get("aspect_ratio"), width, height)
    style = _string(settings.get("image_style", ""), "image_style")
    lighting = _string(settings.get("ambient_lighting", ""), "ambient_lighting")
    layers = document.get("layers")
    if not isinstance(layers, list):
        raise PromptValidationError("layers must be an array (an empty array is allowed).")
    regions, warnings = [], []
    if set(document) - {"canvas_settings", "layers"} or set(settings) - {"aspect_ratio", "image_style", "ambient_lighting"}:
        warnings.append("Unsupported document or canvas keys were omitted from the Ming prompt.")
    for i, layer in enumerate(layers):
        label = f"Layer {i + 1}"
        if not isinstance(layer, dict):
            raise PromptValidationError(f"{label} must be an object.")
        description = _string(layer.get("description"), f"{label}.description", True)
        try:
            geometry = parse_coordinates(layer.get("coordinates"))
        except PromptValidationError as error:
            raise PromptValidationError(f"{label}: {error}") from error
        if "color_specs" not in layer:
            warnings.append(f"{label}: missing color_specs was filled with an empty array.")
        if "hierarchy_and_relation" not in layer:
            warnings.append(f"{label}: missing hierarchy_and_relation was filled with an empty string.")
        if set(layer) - {"description", "coordinates", "hierarchy_and_relation", "color_specs"}:
            warnings.append(f"{label}: unsupported layer keys were omitted.")
        region = {"id": f"layer_{i + 1}", **geometry, "kind": "object", "text": "", "description": description,
                  "relation": _string(layer.get("hierarchy_and_relation", ""), f"{label}.hierarchy_and_relation"),
                  "colors": _colors(layer.get("color_specs", []), label)}
        detected = _detect_text(description)
        if detected and detected[0].strip():
            region.update(kind="text", text=detected[0], description=detected[1], raw_description=description)
        regions.append(region)
    # Ming is BACK -> FRONT. The graphics-editor array is FRONT -> BACK.
    regions.reverse()
    regions, validation_warnings = validate_regions(regions)
    return {"regions": regions, "width": width, "height": height, "image_style": style,
            "ambient_lighting": lighting, "warnings": warnings + validation_warnings}


def _description(region: dict, warnings: list[str]) -> str:
    if region["kind"] == "object":
        return region["description"]
    text, visual = region["text"], region["description"]
    raw = region.get("raw_description")
    if raw and _detect_text(raw) == (text, visual):
        return raw
    if text in visual:
        visual = visual.replace(text, "the specified text")
        warnings.append(f"{region['id']}: repeated exact text in the visual description was replaced with a reference.")
    # Interpolate literally, then JSON-escape the complete document exactly once.
    # Do not strip, case-fold, normalize Unicode, or interpret escapes in text.
    suffix = f" in {visual}" if visual else ""
    result = f'A text element reading exactly "{text}"{suffix}'
    return result if visual.endswith((".", "!", "?")) else result + "."


def serialize_ming(regions: list[dict], width: int, height: int, image_style: str = "",
                   ambient_lighting: str = "", output_format: str = "pretty") -> tuple[str, list[str]]:
    if output_format not in ("pretty", "compact"):
        raise PromptValidationError("output_format must be pretty or compact.")
    settings = {"aspect_ratio": aspect_ratio(width, height),
                "ambient_lighting": _string(ambient_lighting, "ambient_lighting"),
                "image_style": _string(image_style, "image_style")}
    regions, warnings = validate_regions(regions)
    layers = []
    # UI index 0 is FRONT. Export reverses exactly once to Ming BACK -> FRONT.
    for region in reversed(regions):
        relation = region["relation"]
        if region["kind"] == "text" and region["text"] in relation:
            relation = relation.replace(region["text"], "this text element")
            warnings.append(f"{region['id']}: repeated exact text in the relation was replaced with a reference.")
        layers.append({"description": _description(region, warnings),
                       "coordinates": serialize_coordinates(region),
                       "hierarchy_and_relation": relation, "color_specs": region["colors"]})
    document = {"canvas_settings": settings, "layers": layers}
    options = {"indent": 2} if output_format == "pretty" else {"separators": (",", ":")}
    return json.dumps(document, ensure_ascii=False, allow_nan=False, **options), warnings


def resolve_prompt(width: int, height: int, image_style: str = "", ambient_lighting: str = "",
                   layers_data: str = "[]", import_json: str = "", output_format: str = "pretty") -> dict:
    _dimension(width, "width")
    _dimension(height, "height")
    _string(import_json, "import_json")
    regions, selected = parse_editor_state(layers_data)
    warnings = []
    if import_json.strip():
        imported = import_ming(import_json, width, height)
        regions = imported["regions"]
        width, height = imported["width"], imported["height"]
        image_style, ambient_lighting = imported["image_style"], imported["ambient_lighting"]
        warnings.extend(imported["warnings"])
    regions, geometry_warnings = validate_regions(regions)
    prompt, export_warnings = serialize_ming(regions, width, height, image_style, ambient_lighting, output_format)
    warnings.extend(geometry_warnings + export_warnings)
    return {"prompt": prompt, "regions": regions, "width": width, "height": height,
            "image_style": image_style, "ambient_lighting": ambient_lighting,
            "warnings": list(dict.fromkeys(warnings)), "selected": selected}


def pixel_bboxes(regions: list[dict], width: int, height: int, frames: int = 1) -> list[list[dict]]:
    """SAM3 / KJ convention: bboxes[frame][region], in Ming export order."""
    boxes = []
    for region in reversed(regions):
        x = min(width - 1, round(region["x"] * width))
        y = min(height - 1, round(region["y"] * height))
        right = max(x + 1, min(width, round((region["x"] + region["w"]) * width)))
        bottom = max(y + 1, min(height, round((region["y"] + region["h"]) * height)))
        boxes.append({"x": x, "y": y, "width": right - x, "height": bottom - y})
    return [[dict(box) for box in boxes] for _ in range(frames)]


def _preview_size(width: int, height: int) -> tuple[int, int]:
    scale = min(1, PREVIEW_EDGE / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def _background(frame: torch.Tensor | None, size: tuple[int, int]) -> Image.Image:
    base = Image.new("RGB", size, "#141820")
    if frame is not None:
        array = (frame.detach().cpu().float().clamp(0, 1).numpy() * 255).astype(np.uint8)
        if array.shape[-1] == 1:
            array = array[..., 0]
        source = Image.fromarray(array).convert("RGBA")
        source = ImageOps.contain(source, size, Image.Resampling.LANCZOS)
        base.paste(source, ((size[0] - source.width) // 2, (size[1] - source.height) // 2), source)
    return base


def render_preview(regions: list[dict], width: int, height: int, image: torch.Tensor | None = None,
                   brightness: float = 25, selected: str | None = None) -> tuple[torch.Tensor, str | None]:
    brightness = _number(brightness, "bg_brightness")
    if not 0 <= brightness <= 100:
        raise PromptValidationError("bg_brightness must be between 0 and 100.")
    if image is not None and (image.ndim != 4 or image.shape[-1] not in (1, 3, 4) or image.shape[0] < 1):
        raise PromptValidationError("image must be a non-empty ComfyUI IMAGE batch [B, H, W, C].")
    size = _preview_size(width, height)
    font = ImageFont.load_default(size=max(11, round(min(size) / 45)))
    previews, thumbnail = [], None
    for frame in image if image is not None else [None]:
        base = _background(frame, size)
        if frame is not None:
            if thumbnail is None:
                buffer = io.BytesIO()
                base.save(buffer, format="PNG")
                thumbnail = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
            base = ImageEnhance.Brightness(base).enhance(brightness / 100)
        draw = ImageDraw.Draw(base)
        for index, region in enumerate(reversed(regions), 1):
            x, y = round(region["x"] * size[0]), round(region["y"] * size[1])
            right = min(size[0] - 1, round((region["x"] + region["w"]) * size[0]))
            bottom = min(size[1] - 1, round((region["y"] + region["h"]) * size[1]))
            x, y = min(x, right), min(y, bottom)
            color = region["colors"][0] if region["colors"] else "#8AB4F8"
            draw.rectangle((x, y, right, bottom), outline=color, width=2)
            tag = f"{index:02d} {'TEXT' if region['kind'] == 'text' else 'OBJ'}"
            box = draw.textbbox((x + 4, y + 3), tag, font=font)
            draw.rectangle((x, y, box[2] + 4, box[3] + 3), fill="#141820", outline=color)
            draw.text((x + 4, y + 3), tag, font=font, fill="white")
        active = next((region for region in regions if region["id"] == selected), None)
        if active:
            x = min(size[0] - 1, round(active["x"] * size[0]))
            y = min(size[1] - 1, round(active["y"] * size[1]))
            right = min(size[0] - 1, round((active["x"] + active["w"]) * size[0]))
            bottom = min(size[1] - 1, round((active["y"] + active["h"]) * size[1]))
            draw.rectangle((x, y, right, bottom), outline="white", width=3)
        previews.append(torch.from_numpy(np.array(base, dtype=np.float32) / 255))
    return torch.stack(previews), thumbnail


class MingImagePromptBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "width": ("INT", {"default": 1024, "min": 1, "max": MAX_DIMENSION, "step": 1}),
            "height": ("INT", {"default": 1024, "min": 1, "max": MAX_DIMENSION, "step": 1}),
            "image_style": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "ambient_lighting": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            "import_json": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False,
                "tooltip": "Non-empty JSON overrides the editor on execution. Import into editor clears this field."}),
            "bg_brightness": ("INT", {"default": 25, "min": 0, "max": 100}),
            "output_format": (["pretty", "compact"], {"default": "pretty"}),
            "layers_data": ("STRING", {"default": "[]", "multiline": False, "dynamicPrompts": False}),
        }, "optional": {"image": ("IMAGE",)}}

    RETURN_TYPES = ("STRING", "IMAGE", "BOUNDING_BOX", "INT", "INT")
    RETURN_NAMES = ("prompt", "preview", "bboxes", "width", "height")
    CATEGORY = "Ming Image/Prompt"
    FUNCTION = "build"
    DESCRIPTION = "Build a Ming-Image-0.1-Design T2I JSON prompt from visual regions. Connect prompt to CLIP Text Encode."

    def build(self, width, height, image_style="", ambient_lighting="", import_json="", bg_brightness=25,
              output_format="pretty", layers_data="[]", image=None):
        resolved = resolve_prompt(width, height, image_style, ambient_lighting, layers_data, import_json, output_format)
        width, height, regions = resolved["width"], resolved["height"], resolved["regions"]
        preview, background = render_preview(regions, width, height, image, bg_brightness, resolved["selected"])
        for warning in resolved["warnings"]:
            LOGGER.warning("[MingImagePromptBuilder] %s", warning)
        ui = {"ming": [{key: resolved[key] for key in ("width", "height", "image_style", "ambient_lighting", "warnings")}],
              "ming_background": [background]}
        ui["ming"][0].update(bg_brightness=bg_brightness, output_format=output_format)
        if import_json.strip():
            ui["ming"][0]["regions"] = regions
        return {"ui": ui, "result": (resolved["prompt"], preview,
                pixel_bboxes(regions, width, height, preview.shape[0]), width, height)}
