# SPDX-License-Identifier: GPL-3.0-only
"""MOSS-Image Layout prompts: validation, import and export. No model loading.

The model-facing format is the one documented by OpenMOSS (USERGUIDE.md, "Layout Prompts",
and skills/moss-image-prompt-enhancer, reviewed 2026-11-18):

    {"summary": {"meta": [...], "canvas": "single", "caption": "..."},
     "items": [{"label": "text", "caption": "...", "text": "EXPLORE", "bbox": [y1, x1, y2, x2]}, ...],
     "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}

Boxes are integer pixels relative to the canvas centre (y grows downward). Fractional editor
edges are enclosed (floor left/top, ceil right/bottom) before the centre is subtracted, the same
rule as the official compile_prompt.py. Canvas dimensions are not part of the prompt; they must be
used as the generation width and height. The editable "draft" form (top-left ``abs`` / ``xyxy``
with ``width`` and ``height``) is also produced and accepted.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from typing import Any

from .ideogram import place_elements
from .nodes import (MAX_DIMENSION, PromptValidationError, _geometry, _load_json, _number, _string,
                    parse_editor_state)

LABELS = ("object", "character", "text")
CANVASES = ("single", "multi_panel", "collage")
SUMMARY_KEYS = ("meta", "canvas", "caption", "palette")
ITEM_KEYS = ("label", "caption", "text", "tags", "palette", "bbox")
HEX = re.compile(r"#[0-9a-fA-F]{6}\Z")
CJK = re.compile(r"[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]")
MIN_GLYPH_PX = 14


def dimension(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 16 <= value <= MAX_DIMENSION:
        raise PromptValidationError(f"{name} must be an integer from 16 to {MAX_DIMENSION}.")
    if value % 16:
        raise PromptValidationError(f"{name} {value} is not a multiple of 16, which MOSS-Image requires "
                                    f"(nearest: {max(16, round(value / 16) * 16)}).")
    return value


def split_list(value: Any, name: str) -> list[str]:
    """Widget text "poster, travel" -> ["poster", "travel"]; arrays pass through after checks."""
    if isinstance(value, list):
        items = value
    else:
        items = re.split(r"[,\n]", _string(value, name))
    result = []
    for item in items:
        if not isinstance(item, str):
            raise PromptValidationError(f"{name} entries must be strings.")
        if item.strip():
            result.append(item.strip())
    return result


def _palette(value: Any, name: str) -> list[str]:
    return [item.upper() if HEX.fullmatch(item) else item for item in split_list(value, name)]


def _canvas(value: Any) -> str:
    value = _string(value or "single", "canvas")
    if value not in CANVASES:
        raise PromptValidationError(f"canvas must be one of {', '.join(CANVASES)}.")
    return value


def validate_regions(regions: Any) -> tuple[list[dict], list[str]]:
    """Editor regions (FRONT first). MOSS adds the character label and per-item tags."""
    if not isinstance(regions, list):
        raise PromptValidationError("layers_data must be an array of regions, or a version 1 editor state.")
    clean, warnings, ids = [], [], set()
    for index, value in enumerate(regions):
        label = f"Region {len(regions) - index}"
        if not isinstance(value, dict):
            raise PromptValidationError(f"{label} must be an object.")
        kind = value.get("kind", "object")
        if kind not in LABELS:
            raise PromptValidationError(f"{label}: type must be object, character or text.")
        identifier = _string(value.get("id", f"layer_{index + 1}"), f"{label}.id", True)
        if identifier in ids:
            raise PromptValidationError(f"{label}: duplicate region id {identifier!r}.")
        ids.add(identifier)
        clean.append({"id": identifier, **_geometry(value, label, warnings), "kind": kind,
                      "text": _string(value.get("text", ""), f"{label}.text"),
                      "description": _string(value.get("description", ""), f"{label}.caption"),
                      "relation": _string(value.get("relation", ""), f"{label}.relation"),
                      "colors": _palette(value.get("colors", []), f"{label}.palette"),
                      "tags": split_list(value.get("tags", []), f"{label}.tags")})
    return clean, warnings


def enclosed_box(region: dict, width: int, height: int) -> list[int]:
    """Top-left pixel edges [x1, y1, x2, y2], enclosing fractional edges."""
    x1 = math.floor(round(region["x"] * width, 9))
    y1 = math.floor(round(region["y"] * height, 9))
    x2 = math.ceil(round((region["x"] + region["w"]) * width, 9))
    y2 = math.ceil(round((region["y"] + region["h"]) * height, 9))
    x1, y1 = max(0, min(x1, width - 1)), max(0, min(y1, height - 1))
    return [x1, y1, max(x1 + 1, min(x2, width)), max(y1 + 1, min(y2, height))]


def centered_box(region: dict, width: int, height: int) -> list[int]:
    """abs_centralized / yxyx: [y_min, x_min, y_max, x_max] relative to the canvas centre."""
    x1, y1, x2, y2 = enclosed_box(region, width, height)
    return [y1 - height // 2, x1 - width // 2, y2 - height // 2, x2 - width // 2]


def _text_warnings(region: dict, box: list[int], name: str) -> list[str]:
    warnings = []
    text = region["text"]
    if len(text) >= 4 and text in region["description"]:
        warnings.append(f"{name}: the caption repeats the exact text; describe its appearance and keep the words in Text.")
    lines = [line for line in text.split("\n") if line.strip()] or [text]
    longest = max(lines, key=len)
    units = sum(1.0 if CJK.match(char) else 0.55 for char in longest) or 1
    box_w, box_h = box[2] - box[0], box[3] - box[1]
    glyph = min(box_h / (len(lines) * 1.25), box_w / units)
    if glyph < MIN_GLYPH_PX:
        warnings.append(f"{name}: about {glyph:.0f} px per glyph at this size; enlarge the box or shorten the text "
                        "so it stays legible.")
    return warnings


def serialize_moss(regions: list[dict], width: int, height: int, summary_caption: str = "", meta: Any = "",
                   canvas: str = "single", palette: Any = "", output_format: str = "compact") -> dict:
    """Return the MOSS prompt, the editable draft and warnings. Items are exported BACK -> FRONT."""
    if output_format not in ("compact", "pretty"):
        raise PromptValidationError("output_format must be compact or pretty.")
    dimension(width, "width")
    dimension(height, "height")
    caption = _string(summary_caption, "summary_caption")
    meta, palette, canvas = split_list(meta, "meta"), _palette(palette, "palette"), _canvas(canvas)
    regions, warnings = validate_regions(regions)
    options = {"indent": 2} if output_format == "pretty" else {"separators": (",", ":")}
    pixels = width * height
    if not 262144 <= pixels <= 4194304:
        warnings.append(f"{width}×{height} is outside MOSS-Image's 0.25–4 MP range; 1–2 MP works best.")
    if not regions:
        # No boxes: an ordinary caption prompt, as the official enhancer delivers it.
        if not caption.strip():
            warnings.append("Empty prompt. Write a summary caption or draw a region.")
        draft = {"caption": caption}
        return {"prompt": caption, "draft": json.dumps(draft, ensure_ascii=False, indent=2),
                "warnings": warnings, "mode": "caption"}
    if not caption.strip():
        raise PromptValidationError("Summary caption is required for a layout: describe the whole image, its medium and style.")
    summary = {}
    if meta:
        summary["meta"] = meta
    summary["canvas"] = canvas
    summary["caption"] = caption
    if palette:
        summary["palette"] = palette
    items, draft_items = [], []
    texts = Counter(region["text"] for region in regions if region["kind"] == "text")
    for number, region in enumerate(reversed(regions), 1):
        name = f"Region {number:02d}"
        if not region["description"].strip():
            raise PromptValidationError(f"{name}: write a caption describing its visible appearance.")
        if region["kind"] == "text" and not region["text"].strip():
            raise PromptValidationError(f"{name}: a text region needs the exact words to render.")
        item = {"label": region["kind"], "caption": region["description"]}
        if region["kind"] == "text":
            item["text"] = region["text"]
        if region["tags"]:
            item["tags"] = region["tags"]
        if region["colors"]:
            item["palette"] = region["colors"]
        box = enclosed_box(region, width, height)
        if region["kind"] == "text":
            warnings.extend(_text_warnings(region, box, name))
        items.append({**item, "bbox": centered_box(region, width, height)})
        draft_items.append({**item, "bbox": box})
    if any(count > 1 for count in texts.values()):
        warnings.append("The same exact text is used by several text regions.")
    prompt = {"summary": summary, "items": items, "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    draft = {"width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
             "summary": summary, "items": draft_items}
    return {"prompt": json.dumps(prompt, ensure_ascii=False, allow_nan=False, **options),
            "draft": json.dumps(draft, ensure_ascii=False, allow_nan=False, indent=2),
            "warnings": warnings, "mode": "layout"}


def _box(value: Any, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise PromptValidationError(f"{label}.bbox must be an array of four numbers.")
    return [_number(item, f"{label}.bbox") for item in value]


PEOPLE = re.compile(r"\b(person|people|man|men|woman|women|girl|boy|child|children|kid|baby|knight|warrior|soldier|"
                    r"character|figure|lady|gentleman|guy|player|dancer|rider|hero|heroine|witch|wizard|princess|"
                    r"prince|king|queen|robot|android|cyborg|creature|monster|portrait|face|hiker|traveler|traveller|"
                    r"walker|runner|climber|skier|surfer|swimmer|reader|singer|musician|athlete|student|teacher|"
                    r"doctor|nurse|chef|cook|worker|farmer|fisherman|pirate|ninja|samurai|elf|fairy|angel|vampire|"
                    r"zombie|mermaid|astronaut|couple|family|friend|crowd|villager|merchant|shopkeeper|clerk|"
                    r"customer|cowboy|detective|officer|firefighter|mother|father|grandmother|grandfather|"
                    r"businessman|businesswoman|idol|mage|archer|hunter|ranger|monk|priest|nun|goblin|troll|gnome|dwarf|orc|ogre|imp|"
                    r"pixie|alien|mascot|hobbit|elves|dwarves|fairies)s?\b", re.I)


def _kind(noun: str, text: str) -> str:
    if text:
        return "text"
    return "character" if PEOPLE.search(noun or "") else "object"


def _head_kind(head: str, text: str) -> str:
    """Kind from an element's naming phrase: a people word counts when it is the noun ("a small goblin",
    "woman reading"), not when it describes another noun ("fairy house", "knight statue")."""
    if text:
        return "text"
    words = re.findall(r"[a-z'-]+", (head or "").lower())
    for at, word in enumerate(words):
        if PEOPLE.fullmatch(word) or PEOPLE.fullmatch(word.split("-")[-1]):
            after = words[at + 1] if at + 1 < len(words) else ""
            if not after or PEOPLE.fullmatch(after) or after.endswith(("ing", "ed")) or after in ("of", "and", "or"):
                return "character"
    return "object"


def _grid_box(box: Any, label: str, width: int, height: int, order: str) -> list[int]:
    """A 0-1000 box (``xyxy`` or ``yxyx``) as top-left pixels ``[x1, y1, x2, y2]`` on the canvas."""
    values = _box(box, label)
    x1, y1, x2, y2 = values if order == "xyxy" else (values[1], values[0], values[3], values[2])
    scale = 1000.0
    if max(values) > 1000:  # pixel boxes written by tools in "absolute" mode: read on this canvas
        scale = None
    def px(value, side):
        return value if scale is None else value / scale * side
    x1, x2 = sorted((px(x1, width), px(x2, width)))
    y1, y2 = sorted((px(y1, height), px(y2, height)))
    return [max(0, math.floor(x1)), max(0, math.floor(y1)), min(width, math.ceil(x2)), min(height, math.ceil(y2))]


def _phrases(*values: Any) -> list[str]:
    out = []
    for value in values:
        for part in (value if isinstance(value, list) else re.split(r"[,;]", value) if isinstance(value, str) else []):
            part = part.strip().strip(".") if isinstance(part, str) else ""
            if part and part.lower() not in (entry.lower() for entry in out):
                out.append(part)
    return out


def _hexes(value: Any) -> list[str]:
    return [c.upper() for c in (value or []) if isinstance(c, str) and HEX.match(c.strip())][:5] if isinstance(value, list) else []


def foreign_layout(document: dict, width: int, height: int):
    """Ideogram 4 caption JSON or a 0-1000 assistant layout -> (editable MOSS draft, source name), else None.

    Ideogram 4: ``compositional_deconstruction.elements`` (listed by importance; boxes and layers come from
    ``ideogram.place_elements``), optional ``bbox`` ``[ymin, xmin,
    ymax, xmax]`` on 0-1000, ``type`` obj/text, ``desc``, ``color_palette``; ``style_description`` becomes meta.
    Assistant layouts (PromptStyler Next Layout Assist): ``items`` with ``[x1, y1, x2, y2]`` on 0-1000, back to
    front, ``"grid": "xyxy-1000"``.
    """
    ideogram = isinstance(document.get("compositional_deconstruction"), dict)
    assistant = document.get("grid") == "xyxy-1000" or (
        "bbox_coord_space" not in document and "summary" not in document and isinstance(document.get("items"), list)
        and any(isinstance(i, dict) and "bbox" in i for i in document["items"]))
    if not ideogram and not assistant:
        return None
    items, warnings = [], []
    if ideogram:
        scene = document["compositional_deconstruction"]
        style = document.get("style_description") if isinstance(document.get("style_description"), dict) else {}
        caption = " ".join(p for p in (_string(document.get("high_level_description", ""), "high_level_description").strip(),
                                       _string(scene.get("background", ""), "background").strip()) if p)
        meta = _phrases(style.get("medium"), style.get("photo"), style.get("art_style"), style.get("aesthetics"),
                        style.get("lighting"))
        palette = _hexes(style.get("color_palette"))
        elements = scene.get("elements") or []
        if not isinstance(elements, list):
            raise PromptValidationError("compositional_deconstruction.elements must be an array.")
        for index, element in enumerate(elements):
            if not isinstance(element, dict):
                raise PromptValidationError(f"elements[{index}] must be an object.")
            if element.get("bbox") is not None:
                _grid_box(element["bbox"], f"elements[{index}]", width, height, "yxyx")  # same errors as before
        # 2026-11-25: Ideogram lists elements by importance, not depth, and LLM-written prompts rarely carry a
        # bbox. Boxes now come from each bbox or from the position words in desc, and layers from depth words and
        # size (ideogram.py); before, every bbox-less element sat in the top-left corner and list order was depth.
        placed, notes = place_elements(elements, width, height, kind_of=_head_kind)
        warnings.extend(notes)
        for entry in placed:  # back to front, as MOSS lists them
            index, element = entry["index"], elements[entry["index"]]
            label = f"elements[{index}]"
            text = _string(element.get("text", ""), f"{label}.text") if element.get("type") == "text" else ""
            desc = _string(element.get("desc", ""), f"{label}.desc")
            if entry["source"] == "bbox":
                box = _grid_box(element["bbox"], label, width, height, "yxyx")
            else:
                x1, y1, x2, y2 = entry["box"]
                box = [round(x1 * width), round(y1 * height), round(x2 * width), round(y2 * height)]
            items.append({"label": entry["kind"],
                          "caption": desc, "text": text, "palette": _hexes(element.get("color_palette")), "bbox": box})
        source = "Ideogram 4"
    else:
        caption = _string(document.get("caption", ""), "caption")
        meta = _phrases(document.get("meta"))
        palette = _hexes(document.get("palette"))
        for index, item in enumerate(document["items"]):
            label = f"items[{index}]"
            if not isinstance(item, dict):
                raise PromptValidationError(f"{label} must be an object.")
            noun = _string(item.get("label", ""), f"{label}.label").strip()
            text = _string(item.get("text", ""), f"{label}.text")
            kind = noun if noun in LABELS and not (noun == "text" and not text) else _kind(noun, text)
            entry = {"label": kind, "caption": _string(item.get("caption", ""), f"{label}.caption"), "text": text if kind == "text" else "",
                     "palette": _hexes(item.get("palette")), "bbox": _grid_box(item.get("bbox"), label, width, height, "xyxy")}
            if noun and noun not in LABELS:
                entry["tags"] = [noun]
            items.append(entry)
        source = "layout assistant"
    for item in items:
        x1, y1, x2, y2 = item["bbox"]
        if x2 - x1 < 1 or y2 - y1 < 1:
            item["bbox"] = [min(x1, width - 1), min(y1, height - 1), min(x1, width - 1) + 1, min(y1, height - 1) + 1]
        for key in ("text", "palette", "tags"):
            if not item.get(key):
                item.pop(key, None)
    summary = {"caption": caption, **({"meta": meta} if meta else {}), **({"palette": palette} if palette else {})}
    draft = {"width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
             "summary": summary, "items": items}
    return draft, source, warnings


def import_moss(prompt: str, width: int = 1024, height: int = 1024) -> dict:
    """Accept a compiled MOSS layout, an editable draft, a {"caption"} draft, plain caption text, an Ideogram 4
    caption JSON or a 0-1000 assistant layout (both converted on the current canvas).

    A compiled layout has no dimensions, so its centred pixel boxes are read on the current canvas.
    A draft supplies its own width and height.
    """
    dimension(width, "width")
    dimension(height, "height")
    text = _string(prompt, "MOSS prompt")
    warnings = []
    base = {"width": width, "height": height, "meta": "", "canvas": "single", "palette": ""}
    stripped = text.strip()
    if not stripped.startswith("{"):
        return {**base, "summary_caption": text, "regions": [], "warnings": warnings, "mode": "caption"}
    document = _load_json(stripped, "MOSS JSON")
    if not isinstance(document, dict):
        raise PromptValidationError("MOSS JSON must be a top-level object.")
    if set(document) == {"caption"}:
        return {**base, "summary_caption": _string(document["caption"], "caption"), "regions": [],
                "warnings": warnings, "mode": "caption"}
    converted = foreign_layout(document, width, height)
    if converted is not None:
        document, source, notes = converted
        warnings.append(f"Converted from {source}.")
        warnings.extend(notes)
    space = document.get("bbox_coord_space")
    order = document.get("bbox_format")
    if space is None and order is None:
        space, order = "abs_centralized", "yxyx"
        warnings.append("bbox_coord_space/bbox_format were missing; boxes were read as abs_centralized yxyx.")
    if (space, order) not in (("abs_centralized", "yxyx"), ("abs", "xyxy")):
        raise PromptValidationError('Supported boxes: "abs_centralized" + "yxyx" (model prompt) or "abs" + "xyxy" (draft).')
    draft = space == "abs"
    if draft:
        width, height = dimension(document.get("width"), "width"), dimension(document.get("height"), "height")
    known = {"summary", "items", "bbox_coord_space", "bbox_format"} | ({"width", "height"} if draft else set())
    if set(document) - known:
        warnings.append(f"Unsupported top-level keys were omitted: {', '.join(sorted(set(document) - known))}.")
    summary = document.get("summary", {})
    if not isinstance(summary, dict):
        raise PromptValidationError("summary must be an object.")
    if set(summary) - set(SUMMARY_KEYS):
        warnings.append("Unsupported summary keys were omitted.")
    caption = _string(summary.get("caption", ""), "summary.caption")
    meta = split_list(summary.get("meta", []), "summary.meta")
    palette = _palette(summary.get("palette", []), "summary.palette")
    canvas = _canvas(summary.get("canvas", "single"))
    items = document.get("items", [])
    if not isinstance(items, list):
        raise PromptValidationError("items must be a flat array.")
    regions = []
    for index, item in enumerate(items):
        label = f"items[{index}]"
        if not isinstance(item, dict):
            raise PromptValidationError(f"{label} must be an object.")
        kind = item.get("label", "object")
        if kind not in LABELS:
            raise PromptValidationError(f"{label}.label must be object, character or text.")
        if set(item) - set(ITEM_KEYS):
            warnings.append(f"{label}: unsupported keys were omitted ({', '.join(sorted(set(item) - set(ITEM_KEYS)))}).")
        value = _string(item.get("text", ""), f"{label}.text")
        if kind != "text" and value:
            warnings.append(f"{label}: text on a {kind} item was dropped; use a separate text item for visible words.")
            value = ""
        box = _box(item.get("bbox"), label)
        if draft:
            x1, y1, x2, y2 = box
        else:
            y1, x1, y2, x2 = box
            x1, x2, y1, y2 = x1 + width // 2, x2 + width // 2, y1 + height // 2, y2 + height // 2
        if x2 <= x1 or y2 <= y1:
            raise PromptValidationError(f"{label}.bbox must have positive width and height.")
        regions.append({"id": f"layer_{index + 1}", "x": x1 / width, "y": y1 / height,
                        "w": (x2 - x1) / width, "h": (y2 - y1) / height, "kind": kind, "text": value,
                        "description": _string(item.get("caption", ""), f"{label}.caption"), "relation": "",
                        "colors": _palette(item.get("palette", []), f"{label}.palette"),
                        "tags": split_list(item.get("tags", []), f"{label}.tags")})
    if any("," in entry for entry in meta + palette):
        warnings.append("A meta or palette entry contains a comma; the editor field splits entries at commas.")
    regions.reverse()  # MOSS lists BACK -> FRONT; the editor array is FRONT -> BACK.
    regions, geometry = validate_regions(regions)
    return {**base, "width": width, "height": height, "summary_caption": caption, "meta": ", ".join(meta),
            "canvas": canvas, "palette": ", ".join(palette), "regions": regions,
            "warnings": warnings + geometry, "mode": "layout"}


def resolve_moss(width: int, height: int, summary_caption: str = "", meta: str = "", canvas: str = "single",
                 palette: str = "", layers_data: str = "[]", import_json: str = "",
                 output_format: str = "compact") -> dict:
    dimension(width, "width")
    dimension(height, "height")
    _string(import_json, "import_json")
    regions, selected = parse_editor_state(layers_data)
    warnings = []
    if import_json.strip():
        imported = import_moss(import_json, width, height)
        regions, width, height = imported["regions"], imported["width"], imported["height"]
        summary_caption, meta, canvas, palette = (imported[key] for key in ("summary_caption", "meta", "canvas", "palette"))
        warnings.extend(imported["warnings"])
    regions, geometry = validate_regions(regions)
    result = serialize_moss(regions, width, height, summary_caption, meta, canvas, palette, output_format)
    warnings.extend(geometry + result["warnings"])
    return {"prompt": result["prompt"], "draft": result["draft"], "mode": result["mode"], "regions": regions,
            "width": width, "height": height, "summary_caption": summary_caption, "meta": meta,
            "canvas": canvas, "palette": palette, "warnings": list(dict.fromkeys(warnings)), "selected": selected}


class MossImagePromptBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        text = {"multiline": True, "dynamicPrompts": False}
        return {"required": {
            "width": ("INT", {"default": 1024, "min": 16, "max": MAX_DIMENSION, "step": 16,
                              "tooltip": "Generation width. MOSS-Image needs a multiple of 16; use the same value on the latent."}),
            "height": ("INT", {"default": 1024, "min": 16, "max": MAX_DIMENSION, "step": 16,
                               "tooltip": "Generation height. MOSS-Image needs a multiple of 16; use the same value on the latent."}),
            "summary_caption": ("STRING", {"default": "", **text,
                                           "tooltip": "summary.caption: the whole scene, medium, style and lighting."}),
            "meta": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False,
                                "tooltip": "summary.meta, comma separated: medium or genre tags such as poster, product campaign."}),
            "canvas": (list(CANVASES), {"default": "single", "tooltip": "summary.canvas"}),
            "palette": ("STRING", {"default": "", "multiline": False, "dynamicPrompts": False,
                                   "tooltip": "Optional summary.palette, comma separated (#RRGGBB or color names)."}),
            "import_json": ("STRING", {"default": "", **text,
                "tooltip": "Non-empty MOSS JSON overrides the editor on execution. Import into editor clears this field."}),
            "bg_brightness": ("INT", {"default": 25, "min": 0, "max": 100}),
            "output_format": (["compact", "pretty"], {"default": "compact",
                              "tooltip": "compact is the official one-line prompt; pretty is indented for reading."}),
            "layers_data": ("STRING", {"default": "[]", "multiline": False, "dynamicPrompts": False}),
        }, "optional": {"image": ("IMAGE",)}}

    RETURN_TYPES = ("STRING", "IMAGE", "BOUNDING_BOX", "INT", "INT", "STRING")
    RETURN_NAMES = ("prompt", "preview", "bboxes", "width", "height", "layout_draft")
    CATEGORY = "MOSS Image/Prompt"
    FUNCTION = "build"
    DESCRIPTION = ("Build a MOSS-Image Layout prompt (summary + items, abs_centralized yxyx boxes) from visual regions. "
                   "Connect prompt to CLIP Text Encode and width/height to the latent.")

    def build(self, width, height, summary_caption="", meta="", canvas="single", palette="", import_json="",
              bg_brightness=25, output_format="compact", layers_data="[]", image=None):
        from .nodes import LOGGER, pixel_bboxes, render_preview
        resolved = resolve_moss(width, height, summary_caption, meta, canvas, palette, layers_data, import_json, output_format)
        width, height, regions = resolved["width"], resolved["height"], resolved["regions"]
        preview, background = render_preview(regions, width, height, image, bg_brightness, resolved["selected"])
        for warning in resolved["warnings"]:
            LOGGER.warning("[MossImagePromptBuilder] %s", warning)
        keys = ("width", "height", "summary_caption", "meta", "canvas", "palette", "warnings", "mode")
        ui = {"moss": [{key: resolved[key] for key in keys}], "ming_background": [background]}
        ui["moss"][0].update(bg_brightness=bg_brightness, output_format=output_format)
        if import_json.strip():
            ui["moss"][0]["regions"] = regions
        return {"ui": ui, "result": (resolved["prompt"], preview, pixel_bboxes(regions, width, height, preview.shape[0]),
                                     width, height, resolved["draft"])}
