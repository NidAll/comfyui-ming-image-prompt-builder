"""Ideogram 4 and 0-1000 assistant layouts convert on import. python -m unittest discover -s tests -v."""
import importlib
import json
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("moss_builder_pkg")
package.__path__ = [str(ROOT)]
sys.modules.setdefault("moss_builder_pkg", package)
moss = importlib.import_module("moss_builder_pkg.moss")

IDEOGRAM = {
    "high_level_description": "A poster of a fox at night.",
    "style_description": {"aesthetics": "moody", "lighting": "moonlight", "medium": "digital painting",
                          "art_style": "flat vector", "color_palette": ["#112233", "#ffaa00"]},
    "compositional_deconstruction": {"background": "A dark blue sky with stars.", "elements": [
        {"type": "text", "bbox": [50, 100, 150, 900], "text": "NORTH", "desc": "Bold white serif title", "color_palette": ["#FFFFFF"]},
        {"type": "obj", "bbox": [500, 100, 950, 450], "desc": "A woman holding a lantern"},
        {"type": "obj", "desc": "A moon"}]},
}


def pixels(region, width, height):
    return [round(region["x"] * width), round(region["y"] * height),
            round((region["x"] + region["w"]) * width), round((region["y"] + region["h"]) * height)]


class Ideogram(unittest.TestCase):
    def test_boxes_order_and_fields(self):
        result = moss.import_moss(json.dumps(IDEOGRAM), 896, 1152)
        self.assertIn("Converted from Ideogram 4.", result["warnings"])
        self.assertEqual(result["summary_caption"], "A poster of a fox at night. A dark blue sky with stars.")
        self.assertEqual(result["meta"], "digital painting, flat vector, moody, moonlight")
        self.assertEqual(result["palette"], "#112233, #FFAA00")
        front = result["regions"]  # editor order is FRONT -> BACK, as Ideogram lists them
        self.assertEqual([r["kind"] for r in front], ["text", "character", "object"])
        self.assertEqual(front[0]["text"], "NORTH")
        self.assertEqual(pixels(front[0], 896, 1152), [89, 57, 807, 173])  # [ymin,xmin,ymax,xmax] on 0-1000, enclosed outward
        self.assertEqual(front[0]["colors"], ["#FFFFFF"])
        self.assertTrue(any("no bbox" in w for w in result["warnings"]))

    def test_compiles_to_moss(self):
        result = moss.import_moss(json.dumps(IDEOGRAM), 1024, 1024)
        prompt = json.loads(moss.resolve_moss(1024, 1024, result["summary_caption"], result["meta"], "single",
                                              result["palette"], json.dumps(result["regions"]))["prompt"])
        self.assertEqual(prompt["bbox_format"], "yxyx")
        self.assertEqual(prompt["items"][-1]["label"], "text")  # MOSS lists back to front: the title is last


class Assistant(unittest.TestCase):
    LAYOUT = {"caption": "A knight in a forest.", "meta": ["fantasy", "painterly"], "grid": "xyxy-1000", "items": [
        {"label": "man in armor", "caption": "A knight in silver armor.", "bbox": [268, 148, 687, 964]},
        {"label": "lantern", "caption": "A glowing brass lantern.", "bbox": [287, 413, 395, 639]},
        {"label": "text", "text": "THE LANTERN BEARER", "caption": "Gold serif lettering.", "bbox": [294, 48, 701, 113]}]}

    def test_xyxy_and_kinds(self):
        result = moss.import_moss(json.dumps(self.LAYOUT), 896, 1152)
        self.assertIn("Converted from layout assistant.", result["warnings"])
        self.assertEqual(result["meta"], "fantasy, painterly")
        kinds = [(r["kind"], r["tags"], r["text"]) for r in result["regions"]]
        self.assertEqual(kinds, [("text", [], "THE LANTERN BEARER"), ("object", ["lantern"], ""),
                                 ("character", ["man in armor"], "")])
        self.assertEqual(pixels(result["regions"][2], 896, 1152), [240, 170, 616, 1111])

    def test_people_nouns_become_characters(self):
        for noun, kind in (("two hikers", "character"), ("woman reading", "character"), ("street lamp", "object"), ("poster", "object")):
            self.assertEqual(moss._kind(noun, ""), kind, noun)

    def test_plain_moss_is_untouched(self):
        compiled = {"summary": {"caption": "x"}, "items": [], "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
        self.assertIsNone(moss.foreign_layout(compiled, 1024, 1024))


if __name__ == "__main__":
    unittest.main()
