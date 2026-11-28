"""Ideogram 4 caption elements -> boxes and layer order (pure Python, no dependencies).

Ideogram 4's ``bbox`` is optional (``[ymin, xmin, ymax, xmax]`` on 0-1000, each axis normalised to its own
side), and LLM-written Ideogram prompts usually leave it out and say where things go in words instead:
"in the upper-middle of the frame", "leaning in from the lower-left foreground", "occupying roughly 60% of the
frame height", "flanking the door on the left", "centered behind the manor". Ideogram also has no layer
order: elements are listed by importance, not depth.

``place_elements`` reads those words. Each element gets a box (fractions 0-1, ``[x1, y1, x2, y2]``) from its
own ``bbox`` when it has one, else from position and size phrases in the first sentence of ``desc``,
relative to another element when the sentence names one ("behind the manor", "at the base of the house").
Elements with no usable words are spread over free spots instead of piling up in a corner. The result is
in back-to-front order: lettering over pictures, depth words ("deep background", "foreground", "behind"),
then importance (earlier = nearer the front), except that of two overlapping boxes the larger goes behind.
When every element has a bbox (a layout editor's export), the list order is kept.

SPDX-License-Identifier: Apache-2.0. The canonical copy is ``src/moss_layout/ideogram.py`` in moss-layout-pipeline;
the MOSS Image Layout builder node carries the same file unchanged. Change it there, copy it here, and run
both test suites.
"""
from __future__ import annotations

import math
import re

__all__ = ["place_elements", "cues", "head_phrase"]

# Words that only say where light or motion comes from, never where the element is.
_LIGHT = re.compile(r"\b(light|lit|lighting|sun|sunlight|sunlit|glow|glowing|shadow|shadows|shine|rays|beam|beams|"
                    r"illuminated|backlit|wind|breeze)\b")
_SENTENCE = re.compile(r"(?<=[a-z0-9)\"'%])[.;](?:\s|$)|\s[—–]\s")

# (pattern, x) and (pattern, y) centres; the first match on each axis wins, so specific phrases come first.
_X = [
    (r"slightly (?:to the )?left of (?:the )?cent(?:er|re)", 0.42), (r"slightly (?:to the )?right of (?:the )?cent(?:er|re)", 0.58),
    (r"\bleft of (?:the )?cent(?:er|re)", 0.36), (r"\bright of (?:the )?cent(?:er|re)", 0.64),
    (r"\b(?:upper|lower|top|bottom)[- ]left\b", 0.22), (r"\b(?:upper|lower|top|bottom)[- ]right\b", 0.78),
    (r"\bleft (?:edge|margin|border)\b", 0.1), (r"\bright (?:edge|margin|border)\b", 0.9),
    (r"\bleft (?:side|third|half|portion|corner)\b", 0.2), (r"\bright (?:side|third|half|portion|corner)\b", 0.8),
    (r"\b(?:on|to|at|in|from) the (?:far )?left\b", 0.2), (r"\b(?:on|to|at|in|from) the (?:far )?right\b", 0.8),
    (r"\bleft\b", 0.25), (r"\bright\b(?! (?:now|away))", 0.75),
    (r"\bcent(?:er|re)[- ](?:frame|stage)\b|\bcent(?:er|re)(?:ed|d)?\b|\bmiddle of the (?:frame|image|composition)\b|\bmid-frame\b", 0.5),
]
_Y = [
    (r"\bupper[- ]middle\b|\bupper[- ]cent(?:er|re)\b|\bupper[- ]mid\b", 0.34), (r"\blower[- ]middle\b|\blower[- ]cent(?:er|re)\b|\blower[- ]mid\b", 0.66),
    (r"\b(?:upper|top) third\b", 0.17), (r"\b(?:lower|bottom) third\b", 0.83), (r"\bmiddle third\b", 0.5),
    (r"\b(?:upper|top) half\b", 0.25), (r"\b(?:lower|bottom) half\b", 0.75),
    (r"\b(?:upper|top)[- ](?:left|right)\b", 0.2), (r"\b(?:lower|bottom)[- ](?:left|right)\b", 0.8),
    (r"\btop (?:edge|margin|border|of the (?:frame|image|poster|page|composition))\b|\balong the top\b|\bat the top\b|\bacross the top\b", 0.1),
    (r"\bbottom (?:edge|margin|border|of the (?:frame|image|poster|page|composition))\b|\balong the bottom\b|\bat the bottom\b|\bacross the bottom\b|\bbase of the (?:frame|image|poster|composition)\b", 0.9),
    (r"\bmid-?ground\b", 0.56), (r"\bmid-height\b|\bmiddle\b|\bcent(?:er|re)[- ]frame\b|\bhorizon\b", 0.5),
    (r"\bin the sky\b|\boverhead\b|\bupper\b|\btop\b", 0.22), (r"\bforeground\b|\bon the (?:ground|floor)\b|\blower\b|\bbottom\b", 0.78),
]
_X = [(re.compile(p), v) for p, v in _X]
_Y = [(re.compile(p), v) for p, v in _Y]

_SIZE = [(re.compile(p), v) for p, v in [
    (r"\btiny\b|\bminiature\b|\bminuscule\b", 0.08), (r"\bsmall\b|\blittle\b|\bpetite\b", 0.16),
    (r"\bmassive\b|\bhuge\b|\bgiant\b|\benormous\b|\btowering\b|\bdominant\b|\bdominates\b|\bdominating\b|\bimmense\b|\bfills? the frame\b", 0.55),
    (r"\bfocal (?:subject|point)\b|\bmain subject\b|\bhero\b", 0.5), (r"\blarge\b|\bbig\b|\bbold\b|\btall\b", 0.42),
    (r"\bmedium\b|\bmid-sized\b", 0.28)]]
_TALL = re.compile(r"\b(tall|towering|standing|upright|vertical|tower|spire|lighthouse|tree|trees|figure|man|woman|person|girl|boy|"
                   r"door|doorway|bottle|column|pillar|statue|robot|knight|warrior|lamp|lamppost|chimney|candle|waterfall|"
                   r"skyscraper|portrait|full[- ]body|from the waist up)\b")
_WIDE = re.compile(r"\b(wide|horizontal|band|strip|row|skyline|banner|horizon|landscape|panorama|path|pathway|road|street|river|"
                   r"fence|table|counter|shelf|bench|bridge|wall|crowd|flock|swarm|cluster|range|coastline|shoreline|cliffs|graveyard|cemetery|hillside|"
                   r"credits|billing|tagline|title|headline|wordmark|lettering|typography)\b")
_GROUNDED = re.compile(r"\b(?:door|doorway|gate|gateway|entrance|archway|porch|steps|stairs)\b")
_TALL_WORDS = re.compile(r"\b(?:tall|towering|upright|vertical|full[- ]body|from the waist up)\b")
_WIDE_WORDS = re.compile(r"\b(?:wide|horizontal|panoramic|row of|line of)\b")
_SPAN_FULL = re.compile(r"\b(?:spanning|across|filling|covering) (?:the )?(?:full|entire|whole) (?:width|frame)\b|\bfull[- ]width\b|"
                        r"\bedge[- ]to[- ]edge\b|\bfull[- ]bleed\b|\bentire width\b|\bacross the (?:frame|image|composition)\b")
_SPREAD = re.compile(r"\b(?:scattered|distributed|spread|dotted|strewn|sprinkled)\b")
_PERCENT = re.compile(r"(\d{1,3})\s*%\s*(?:of\s+)?(?:the\s+)?(?:frame|image|canvas|composition|picture)?(?:'s)?\s*(height|width|area)?")
_BAND = re.compile(r"\b(?:across|along|in|occupying|filling|spanning) (?:the )?(upper|top|lower|bottom|middle) (third|half|band|quarter|region|area|portion)\b")
_BACK = re.compile(r"\bdeep background\b|\bin the background\b|\bbackground\b|\bbackdrop\b|\bdistant\b|\bin the distance\b|\bfar[- ](?:away|off)\b")
_FRONT = re.compile(r"\bforeground\b|\bclosest to the (?:viewer|camera)\b|\bnearest\b|\bclose-up\b")

# Relations to another element. (?P<n>) is the named thing; it stops before the next preposition or clause.
_NOUN = (r"(?!(?:left|right|upper|lower|top|bottom|cent(?:er|re)|middle|far|foreground|background|ground|floor|frame|"
         r"image|horizon|sky|distance)\b)(?P<n>[a-z'-]+(?: [a-z'-]+){0,5}?)(?=$|[,;.:]| [—–-] | (?:on|in|at|with|from|that|which|who|and|near|toward|"
         r"towards|so|while|as|to|against|leaning|rising|behind|beside|below|above|under|over|centered|centred|"
         r"slightly|partially|casting|framing|facing)\b)")
_RELATIONS = [(re.compile(p.replace("NOUN", _NOUN)), r) for p, r in [
    (r"\b(?:flanking|beside|next to|alongside) the NOUN(?: on (?:the|its) (?P<s>left|right))?", "side"),
    (r"\b(?:to the |on the |just )?(?P<s>left|right) of the NOUN", "side"),
    (r"\b(?:on|in|at) the (?P<v>upper|lower|top|bottom)?[- ]?(?P<hz>left|right)? ?(?:portion|part|side|corner|face|edge|half) of the NOUN", "portion"),
    (r"\b(?:leading|winding|running|stretching|curving|receding|climbing|snaking)(?: [a-z-]+){0,6}? (?:up )?to(?:ward|wards)? the NOUN", "lead"),
    (r"\b(?:directly |just |partially |slightly )?behind the NOUN", "behind"),
    (r"\bin front of the NOUN", "front_of"),
    (r"\b(?:around|at|along|near) the (?:base|foot|bottom|feet|foundations?) of (?:the|a|an) NOUN", "base"),
    (r"\b(?:directly |just )?(?:below|beneath|under|underneath) the NOUN", "below"),
    (r"\b(?:above|over|atop|on top of|crowning|topping|perched on) the NOUN", "above"),
    (r"\b(?:set into|built into|on the front of|inside|within|in the (?:center|centre|middle) of|on) the NOUN", "inside"),
]]
_PARTS = {"side", "top", "front", "back", "part", "portion", "middle", "edge", "base", "foot", "corner", "center", "centre",
          "left", "right", "upper", "lower", "half", "the", "a", "an"}
_GENERIC = {"figure", "subject", "character", "person", "focal", "hero", "protagonist", "main"}
_STOP = {"the", "a", "an", "of", "and", "with", "in", "on", "at", "its", "his", "her", "their", "to", "from", "by", "for",
         "small", "large", "tiny", "big", "central", "main", "whole", "entire", "frame", "image", "s"}
# Where a description stops naming the thing and starts placing or dressing it ("of" stays: "a pair of boots").
_STOP_TAIL = re.compile(r"\b(?:on|in|at|by|with|from|that|which|who|while|as|and|so|to|toward|towards|across|behind|beside|near|"
                        r"around|along|among|amid|between|through|into|onto|inside|beneath|underneath|"
                        r"under|over|above|below|against|wearing|holding|carrying|standing|sitting|leaning|rising|set|"
                        r"partially|slightly|positioned|placed|occupying|centered|centred|flanking|leading)\b.*$")


def cues(desc: str) -> dict:
    """Position words of one element description (first sentence): x, y, size, w, h, depth, relation, band."""
    text = " ".join(str(desc or "").lower().split())
    first = _SENTENCE.split(text, maxsplit=1)[0]
    found = {"text": first}
    # Drop phrases that only say where light comes from ("lit from the upper-left").
    scan = re.sub(r"(" + _LIGHT.pattern + r")[^,]*?\bfrom the [a-z-]+(?: [a-z-]+)?", r"\1", first)
    scan = re.sub(r"\b(?:toward|towards|facing|looking (?:at|toward|towards)|pointing (?:at|to|toward))\b[^,]*", "", scan)
    # Every relation phrase, in the order written; placement uses the first whose named thing is found.
    relations = []
    for regex, relation in _RELATIONS:
        for match in regex.finditer(scan):
            if not any(start <= match.start() < end for _, _, (start, end) in relations):
                relations.append((relation, {k: v for k, v in match.groupdict().items() if v}, match.span()))
    relations.sort(key=lambda entry: entry[2][0])
    if relations:
        found["relations"] = relations
    absolute = scan
    for _, _, (start, end) in sorted(relations, key=lambda entry: -entry[2][0]):
        # Keep a side word that follows the named thing ("around the base of the house on the left").
        absolute = absolute[:start] + " " + absolute[end:]
    band = _BAND.search(absolute)
    if band:
        found["band"] = (band.group(1), band.group(2))
    for axis, table in (("x", _X), ("y", _Y)):
        for regex, value in table:
            if regex.search(absolute):
                found[axis] = value
                break
    for match in _PERCENT.finditer(first):
        share = int(match.group(1)) / 100
        if 0.02 <= share <= 1:
            axis = match.group(2) or "area"
            found["h" if axis == "height" else "w" if axis == "width" else "area"] = share
            break
    for regex, value in _SIZE:
        if regex.search(first):
            found["size"] = value
            break
    if _SPAN_FULL.search(first):
        found["full_width"] = True
    if _SPREAD.search(first):
        found["spread"] = True
    if _BACK.search(first) and not re.search(r"\bforeground\b", first):
        found["depth"] = -1
    elif _FRONT.search(first):
        found["depth"] = 1
    # Shape nouns count only where they name the element ("a path", not "standing on the path").
    head = head_phrase(text)
    found["tall"] = bool(_TALL.search(head) or _TALL_WORDS.search(first))
    found["wide"] = bool(_WIDE.search(head) or _WIDE_WORDS.search(first)) and not found["tall"]
    return found


def head_phrase(desc: str) -> str:
    """The words that name the element: "A small goblin in a red cap, ..." -> "a small goblin"."""
    head = re.split(r"[,.;:(]|\s[—–-]\s", " ".join(str(desc or "").lower().split()), maxsplit=1)[0]
    return _STOP_TAIL.sub("", head).strip()


def _head_words(desc: str) -> set[str]:
    words = re.findall(r"[a-z]+", head_phrase(desc))
    out = set()
    for word in words:
        if word in _STOP:
            continue
        out.add(word)
        if word.endswith("s") and len(word) > 3:
            out.add(word[:-1])
    return out


_TEXT_ROLES = [("title", r"title|headline|heading|wordmark|logo|masthead"), ("tagline", r"tagline|slogan|subtitle|subheading"),
               ("credit", r"credits?|byline|billing")]


def _find(name: str, index: int, heads: list[set[str]], descs: list[str], people: list[bool], texts=()) -> int | None:
    """The element a phrase such as "the strawberry house" or "the central figure" names, or None."""
    # "the door of the house" names the door; "the side of the house" names the house.
    first, _, rest = name.lower().partition(" of ")
    if rest and not set(re.findall(r"[a-z]+", first)) <= _PARTS:
        name = first
    elif rest:
        name = rest
    name = re.sub(r"^(.*?)'s\b.*$", r"\1", name)  # "the manor's arched entrance" -> the manor
    words = [w for w in re.findall(r"[a-z]+", name.lower()) if w not in _STOP]
    words = words[:4]
    role = next((r for w in words for r, pattern in _TEXT_ROLES if re.fullmatch(pattern, w)), None)
    if role:
        # "beneath the title", "below the tagline": the lettering element whose description says so.
        pattern = dict(_TEXT_ROLES)[role]
        for where in (head_phrase, lambda d: d.lower().split(". ")[0]):  # its naming words first
            for other, desc in enumerate(descs):
                if other != index and texts[other] and re.search(pattern, where(desc)):
                    return other
        if role == "title":
            return next((other for other in range(len(descs)) if other != index and texts[other]), None)
    if not words:
        return None
    best, score = None, 0
    for other, head in enumerate(heads):
        if other == index:
            continue
        hits = sum(1 for word in words if word in head or (word.endswith("s") and word[:-1] in head))
        # The last word of the phrase is its noun: it counts double.
        if words[-1] in head:
            hits += 1
        if hits > score:
            best, score = other, hits
    if best is not None:
        return best
    if set(words) & _GENERIC:
        for other, desc in enumerate(descs):
            if other != index and re.search(r"focal (?:subject|point)|main subject", desc.lower()):
                return other
        for other, is_person in enumerate(people):
            if other != index and is_person:
                return other
    return None


def _clamp_box(cx: float, cy: float, w: float, h: float) -> list[float]:
    w, h = min(max(w, 0.02), 1.0), min(max(h, 0.02), 1.0)
    x1 = min(max(cx - w / 2, 0.0), 1.0 - w)
    y1 = min(max(cy - h / 2, 0.0), 1.0 - h)
    return [x1, y1, x1 + w, y1 + h]


def _size(found: dict, kind: str, aspect: float) -> tuple[float, float]:
    """Width and height (frame fractions) from size words, shape words, the text and the element kind.

    ``aspect`` is frame height / width, so a shape that is square in pixels has ``w = h * aspect``.
    """
    base = found.get("size")
    w, h = found.get("w"), found.get("h")
    if "area" in found and w is None and h is None:
        h = math.sqrt(found["area"] / aspect)
        w = h * aspect
    if kind == "text":
        # Lettering: line height from the size words, width from the longest line (about 0.55 em a letter).
        lines = found.get("lines") or [""]
        line_h = h / len(lines) if h is not None else (base * 0.3 if base is not None else 0.06)
        longest = max((len(line) for line in lines), default=0)
        if w is None:
            w = longest * 0.55 * line_h * aspect if longest else 0.5
            if w > 0.92:
                line_h *= 0.92 / w
                w = 0.92
            w = max(w, 0.12)
        return w, line_h * len(lines)
    if base is None:
        base = 0.42 if kind == "character" else 0.3
    if found.get("tall"):
        h = h if h is not None else min(0.85, base * 1.3)
        w = w if w is not None else h * 0.5 * aspect
    elif found.get("wide"):
        w = w if w is not None else min(1.0, base * 2.2)
        h = h if h is not None else base * 0.6
    else:
        if h is None and w is None:
            h = base
        if w is None:
            w = h * aspect  # square in pixels
        if h is None:
            h = w / aspect
    if found.get("full_width"):
        w = 1.0
    if found.get("spread"):
        w, h = max(w, 0.6), max(h, 0.25)
    return min(w, 1.0), min(h, 1.0)


def _band(found: dict) -> tuple[float, float] | None:
    """A named band ("across the upper third") as (y1, y2)."""
    if "band" not in found:
        return None
    where, part = found["band"]
    share = {"third": 1 / 3, "half": 0.5, "quarter": 0.25}.get(part, 0.25)
    if where in ("upper", "top"):
        return (0.02, share)
    if where in ("lower", "bottom"):
        return (1 - share, 0.98)
    return (0.5 - share / 2, 0.5 + share / 2)


def place_elements(elements: list[dict], width: int = 1000, height: int = 1000, kind_of=None) -> tuple[list[dict], list[str]]:
    """Boxes for Ideogram elements, back to front.

    Returns ``(placed, notes)``. ``placed`` holds one dict per element: ``index`` (position in the Ideogram
    list), ``box`` (``[x1, y1, x2, y2]`` fractions of the frame), ``source`` ('bbox', 'words' or 'spread') and
    ``depth``; it is sorted back to front. ``notes`` are short warnings for the person importing.
    ``kind_of(head_phrase, text)`` may name each element's kind (object, character or text) the caller's way.
    """
    aspect = height / width if width and height else 1.0  # frame height / width: squares need w = h / aspect
    count = len(elements)
    descs = [str((element or {}).get("desc") or "") for element in elements]
    kinds = []
    for element, desc in zip(elements, descs):
        text = str((element or {}).get("text") or "").strip() if (element or {}).get("type") == "text" else ""
        if kind_of is not None:
            kinds.append(kind_of(head_phrase(desc), text))
        elif text:
            kinds.append("text")
        elif re.search(r"\b(person|people|man|men|woman|women|girl|boy|child|children|figure|warrior|knight|hero|character|"
                       r"couple|family|crowd)s?\b", head_phrase(desc)):
            kinds.append("character")
        else:
            kinds.append("object")
    heads = [_head_words(desc) for desc in descs]
    found = [cues(desc) for desc in descs]
    for element, cue, kind in zip(elements, found, kinds):
        if kind == "text":
            cue["lines"] = [line.strip() for line in str((element or {}).get("text") or "").split("\n") if line.strip()]
    boxes: list[list[float] | None] = [None] * count
    sources = [""] * count
    depth = [found[i].get("depth", 0) for i in range(count)]
    for i, element in enumerate(elements):
        box = _given_box((element or {}).get("bbox"))
        if box is not None:
            boxes[i], sources[i] = box, "bbox"
    # Absolute words first, then relations in passes (an element can name one placed after it).
    pending = [i for i in range(count) if boxes[i] is None]
    for _ in range(4):
        progressed = False
        for i in list(pending):
            box = _from_words(i, found[i], kinds[i], aspect, boxes, heads, descs, kinds, depth, waiting=_ != 3)
            if box is not None:
                boxes[i], sources[i] = box, "words"
                pending.remove(i)
                progressed = True
        if not pending or not progressed and _ == 3:
            break
    # Nothing to go on: spread over free spots, most important nearest the centre.
    spots = [(0.5, 0.5), (0.3, 0.35), (0.7, 0.35), (0.3, 0.68), (0.7, 0.68), (0.5, 0.22), (0.5, 0.8), (0.18, 0.5), (0.82, 0.5)]
    for i in pending:
        w, h = _size(found[i], kinds[i], aspect)
        cx, cy = min(spots, key=lambda spot: sum(_overlap(_clamp_box(spot[0], spot[1], w, h), b) for b in boxes if b))
        boxes[i], sources[i] = _clamp_box(cx, cy, w, h), "spread"
    notes = []
    worded = sum(1 for s in sources if s == "words")
    spread = sum(1 for s in sources if s == "spread")
    if worded:
        notes.append(f"{worded} of {count} elements had no bbox; they were placed from the position words in their descriptions.")
    if spread:
        notes.append(f"{spread} element{'s' if spread > 1 else ''} said nothing about position and {'were' if spread > 1 else 'was'} spread around the centre; move {'them' if spread > 1 else 'it'} where you want.")
    if all(source == "bbox" for source in sources):
        order = list(range(count))[::-1]  # every box given (a tool's export): keep its front-first list as written
    else:
        order = _layers(boxes, depth, kinds)
    return ([{"index": i, "box": [round(v, 4) for v in boxes[i]], "source": sources[i], "depth": depth[i], "kind": kinds[i]} for i in order], notes)


def _layers(boxes, depth, kinds) -> list[int]:
    """Back-to-front order: lettering over pictures, then depth words, then importance (Ideogram lists the most
    important first, so it goes nearest the front); of two overlapping boxes the clearly larger goes behind."""
    order = sorted(range(len(boxes)), key=lambda i: (kinds[i] == "text", depth[i], -i))
    group = lambda i: (kinds[i] == "text", depth[i])
    for _ in range(len(order) ** 2):
        moved = False
        for p in range(len(order)):
            for q in range(p + 1, len(order)):
                back, front = order[p], order[q]
                if group(back) == group(front) and _overlap(boxes[back], boxes[front]) > 0 \
                        and _area(boxes[front]) > _area(boxes[back]) * 1.15:
                    order.insert(p, order.pop(q))
                    moved = True
                    break
            if moved:
                break
        if not moved:
            break
    return order


def _given_box(value) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        ymin, xmin, ymax, xmax = (float(v) for v in value)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (ymin, xmin, ymax, xmax)):
        return None
    scale = 1000.0
    x1, x2 = sorted((xmin / scale, xmax / scale))
    y1, y2 = sorted((ymin / scale, ymax / scale))
    x1, y1, x2, y2 = max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2)
    if x2 - x1 <= 0 or y2 - y1 <= 0:
        return None
    return [x1, y1, x2, y2]


def _area(box) -> float:
    return (box[2] - box[0]) * (box[3] - box[1]) if box else 0.0


def _overlap(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _from_words(i, found, kind, aspect, boxes, heads, descs, kinds, depth, waiting=True):
    """A box from one element's words, or None while the element it is placed against has no box yet."""
    people = [k == "character" for k in kinds]
    for name, groups, _ in found.get("relations", []):
        ref = _find(groups.get("n", ""), i, heads, descs, people, [k == "text" for k in kinds])
        if ref is None:
            continue
        if boxes[ref] is None:
            if waiting:
                return None
            continue
        return _relative(name, groups, boxes[ref], ref, i, found, kind, aspect, depth)
    if any(name == "behind" for name, _, _ in found.get("relations", [])) and depth[i] == 0:
        depth[i] = -1  # behind something not in the list: at least further back
    return _absolute(found, kind, aspect)


def _relative(name, groups, ref_box, ref, i, found, kind, aspect, depth):
    rx1, ry1, rx2, ry2 = ref_box
    rw, rh = rx2 - rx1, ry2 - ry1
    rcx, rcy = (rx1 + rx2) / 2, (ry1 + ry2) / 2
    w, h = _size(found, kind, aspect)
    if name in ("behind", "front_of"):
        # Same place as the named element, one layer further back (or forward).
        depth[i] = depth[ref] - 1 if name == "behind" else depth[ref] + 1
        return _clamp_box(found.get("x", rcx), found.get("y", rcy), w, h)
    if name == "side":
        side = groups.get("s") or ("left" if found.get("x", 0.5) < 0.5 else "right")
        w, h = min(w, rw * 0.9), min(h, rh * 0.7)
        gap = 0.01
        cx = rx1 - gap - w / 2 if side == "left" else rx2 + gap + w / 2
        return _clamp_box(cx, found.get("y", rcy), w, h)
    if name == "portion":
        vertical, horizontal = groups.get("v"), groups.get("hz")
        w, h = min(w, rw * 0.35), min(h, rh * 0.35)
        cx = rx1 + rw * (0.8 if horizontal == "right" else 0.2 if horizontal == "left" else 0.5)
        cy = ry1 + rh * (0.2 if vertical in ("upper", "top") else 0.8 if vertical in ("lower", "bottom") else 0.5)
        return _clamp_box(cx, cy, w, h)
    if name == "inside":
        w, h = min(w, rw * 0.45), min(h, rh * 0.45)
        cx = rx1 + rw * found.get("x", 0.5)
        cy = ry1 + rh * found.get("y", 0.6)
        if _GROUNDED.search(head_phrase(found.get("text", ""))):
            cy = ry2 - rh * 0.04 - h / 2  # a door stands on its building's ground line
        return _clamp_box(cx, cy, w, h)
    if name == "base":
        w = max(min(w, rw * 0.6), rw * 0.25)
        h = min(h, 0.2)
        side = found.get("x")
        cx = rx1 + rw * 0.2 if side is not None and side < 0.5 else rx2 - rw * 0.2 if side is not None and side > 0.5 else rcx
        return _clamp_box(cx, ry2 - h * 0.3, w, h)
    if name in ("below", "above") and "y" in found and kind != "text":
        return _clamp_box(found.get("x", rcx), found["y"], w, h)  # "looms over the city", but "center-frame"
    if name == "below":
        return _clamp_box(found.get("x", rcx), ry2 + h / 2 + 0.01, w if kind == "text" else min(w, max(rw, 0.2)), h)
    if name == "above":
        return _clamp_box(found.get("x", rcx), ry1 - h / 2 - 0.01, w if kind == "text" else min(w, max(rw, 0.2)), h)
    # "lead": a path from the near edge up to the named thing.
    top = min(ry2 - rh * 0.05, 0.95)
    w = max(min(w, 0.4), rw * 0.35)
    return [max(0.0, rcx - w / 2), top, min(1.0, rcx + w / 2), 1.0]


def _absolute(found, kind, aspect):
    w, h = _size(found, kind, aspect)
    band = _band(found)
    if band:
        y1, y2 = band
        band_h = y2 - y1
        if found.get("wide") or found.get("full_width") or found.get("spread"):
            w, h = max(w, 0.9), band_h * 0.85
        elif kind == "text":
            # Lettering "spanning the upper third": as big as fits the band.
            grow = min(band_h * 0.85 / h, 0.92 / w) if h and w else 1
            w, h = w * grow, h * grow
        return _clamp_box(found.get("x", 0.5), (y1 + y2) / 2, w, min(h, band_h))
    cx = found.get("x")
    cy = found.get("y")
    if kind == "text" and cy is None:
        text = found.get("text", "")
        cy = 0.88 if re.search(r"\b(credits?|billing|tagline|subtitle|footer|caption|byline|date|url|website)\b", text) else 0.12
    if cx is None and cy is None and found.get("size") is None and "h" not in found and "w" not in found \
            and not found.get("full_width") and "depth" not in found:
        return None
    return _clamp_box(0.5 if cx is None else cx, 0.5 if cy is None else cy, w, h)
