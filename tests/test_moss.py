"""MOSS-Image Layout export/import. Run with ComfyUI's Python: python -m unittest discover -s tests -v."""
import importlib
import json
import sys
import types
import unittest
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
# Import the package's modules without running __init__ (which registers server routes).
package = types.ModuleType("moss_builder_pkg")
package.__path__ = [str(ROOT)]
sys.modules.setdefault("moss_builder_pkg", package)
moss = importlib.import_module("moss_builder_pkg.moss")


def px(x1, y1, x2, y2, width, height, **changes):
    """An editor region from top-left pixel edges."""
    value = dict(id=f"r{x1}_{y1}", x=x1 / width, y=y1 / height, w=(x2 - x1) / width, h=(y2 - y1) / height,
                 kind="object", text="", description="An ivory ceramic cup.", relation="", colors=[], tags=[])
    value.update(changes)
    return value


CUP = dict(kind="object", description="An ivory ceramic cup with a rounded handle.")
TITLE = dict(kind="text", text="把日常，过成诗。", description="Large dark-green Chinese title in crisp lettering.")


class MossExportTests(unittest.TestCase):
    def layout(self, regions, width=1536, height=1024, **kwargs):
        options = dict(summary_caption="A warm studio campaign for a handmade ceramic cup.",
                       meta="product campaign, studio photography")
        options.update(kwargs)
        return moss.serialize_moss(regions, width, height, **options)

    def test_official_example_boxes(self):
        # USERGUIDE.md / references/layout.md: 1536x1024, draft [176,224,800,864] -> [-288,-592,352,32].
        regions = [px(928, 272, 1408, 448, 1536, 1024, **TITLE), px(176, 224, 800, 864, 1536, 1024, **CUP)]
        result = self.layout(regions)
        prompt = json.loads(result["prompt"])
        self.assertEqual(prompt["items"][0]["bbox"], [-288, -592, 352, 32])
        self.assertEqual(prompt["items"][1]["bbox"], [-240, 160, -64, 640])
        self.assertEqual(prompt["bbox_coord_space"], "abs_centralized")
        self.assertEqual(prompt["bbox_format"], "yxyx")
        self.assertEqual(list(prompt), ["summary", "items", "bbox_coord_space", "bbox_format"])
        self.assertEqual(prompt["summary"], {"meta": ["product campaign", "studio photography"], "canvas": "single",
                                             "caption": "A warm studio campaign for a handmade ceramic cup."})
        self.assertEqual(prompt["items"][1]["text"], "把日常，过成诗。")
        self.assertNotIn("width", prompt)
        self.assertNotIn("\n", result["prompt"])
        self.assertIn("把日常", result["prompt"])  # ensure_ascii=False, as in the official compiler

    def test_draft_round_trips_to_the_same_prompt(self):
        regions = [px(928, 272, 1408, 448, 1536, 1024, **TITLE), px(176, 224, 800, 864, 1536, 1024, **CUP)]
        result = self.layout(regions)
        draft = json.loads(result["draft"])
        self.assertEqual((draft["width"], draft["height"], draft["bbox_coord_space"], draft["bbox_format"]),
                         (1536, 1024, "abs", "xyxy"))
        self.assertEqual(draft["items"][0]["bbox"], [176, 224, 800, 864])
        imported = moss.import_moss(result["draft"], 1024, 1024)
        self.assertEqual((imported["width"], imported["height"]), (1536, 1024))
        again = moss.serialize_moss(imported["regions"], 1536, 1024, imported["summary_caption"], imported["meta"],
                                    imported["canvas"], imported["palette"])
        self.assertEqual(again["prompt"], result["prompt"])

    def test_compiled_prompt_round_trips_on_its_canvas(self):
        regions = [px(928, 272, 1408, 448, 1536, 1024, **TITLE), px(176, 224, 800, 864, 1536, 1024, **CUP)]
        result = self.layout(regions)
        imported = moss.import_moss(result["prompt"], 1536, 1024)
        self.assertEqual([r["kind"] for r in imported["regions"]], ["text", "object"])  # FRONT first
        again = moss.serialize_moss(imported["regions"], 1536, 1024, imported["summary_caption"], imported["meta"])
        self.assertEqual(again["prompt"], result["prompt"])

    def test_fractional_edges_are_enclosed(self):
        region = dict(id="a", x=10.9 / 768, y=20.1 / 1344, w=(100.01 - 10.9) / 768, h=(200.99 - 20.1) / 1344,
                      kind="object", description="x", text="", relation="", colors=[], tags=[])
        # Same vector as the official test: [10.9, 20.1, 100.01, 200.99] on 768x1344.
        self.assertEqual(moss.centered_box(region, 768, 1344), [-652, -374, -471, -283])
        full = dict(region, x=0, y=0, w=1, h=1)
        self.assertEqual(moss.centered_box(full, 768, 1344), [-672, -384, 672, 384])

    def test_official_user_guide_layout_imports(self):
        prompt = json.dumps({
            "summary": {"meta": ["poster"], "canvas": "single", "caption": "A minimalist travel poster."},
            "items": [{"label": "text", "caption": "Large dark-blue uppercase title.", "text": "EXPLORE",
                       "bbox": [-416, -384, -288, 384]},
                      {"label": "object", "caption": "A flat blue mountain.", "bbox": [-192, -288, 384, 288]}],
            "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"})
        imported = moss.import_moss(prompt, 1024, 1024)
        title = imported["regions"][1]
        self.assertEqual((title["kind"], title["text"]), ("text", "EXPLORE"))
        self.assertAlmostEqual(title["x"], 128 / 1024)
        self.assertAlmostEqual(title["y"], 96 / 1024)
        self.assertEqual(imported["meta"], "poster")
        again = moss.serialize_moss(imported["regions"], 1024, 1024, imported["summary_caption"], imported["meta"])
        self.assertEqual(json.loads(again["prompt"]), json.loads(prompt))

    def test_character_tags_and_palette(self):
        region = px(0, 0, 512, 1024, 1024, 1024, kind="character", description="A knight in silver armour.",
                    tags=["full body"], colors=["#aabbcc", "warm ivory"])
        prompt = json.loads(self.layout([region], 1024, 1024, palette="#112233, deep teal")["prompt"])
        self.assertEqual(prompt["items"][0], {"label": "character", "caption": "A knight in silver armour.",
                                              "tags": ["full body"], "palette": ["#AABBCC", "warm ivory"],
                                              "bbox": [-512, -512, 512, 0]})
        self.assertEqual(prompt["summary"]["palette"], ["#112233", "deep teal"])

    def test_text_is_literal_and_hidden_on_other_labels(self):
        exact = 'Line one\n"MOSS" \\ 🪴'
        text = px(0, 0, 1024, 512, 1024, 1024, kind="text", text=exact, description="Bold serif.")
        obj = px(0, 512, 1024, 1024, 1024, 1024, text="stale", description="A table.")
        prompt = json.loads(self.layout([text, obj], 1024, 1024)["prompt"])
        self.assertEqual(prompt["items"][1]["text"], exact)
        self.assertNotIn("text", prompt["items"][0])

    def test_caption_mode_without_regions(self):
        result = self.layout([], 1024, 1024, summary_caption="A red fox in fresh snow.")
        self.assertEqual((result["prompt"], result["mode"]), ("A red fox in fresh snow.", "caption"))
        imported = moss.import_moss("A red fox in fresh snow.", 1024, 1024)
        self.assertEqual((imported["summary_caption"], imported["regions"]), ("A red fox in fresh snow.", []))

    def test_validation(self):
        with self.assertRaisesRegex(ValueError, "multiple of 16"):
            self.layout([], 1000, 1024)
        with self.assertRaisesRegex(ValueError, "Summary caption"):
            self.layout([px(0, 0, 10, 10, 1024, 1024)], 1024, 1024, summary_caption=" ")
        with self.assertRaisesRegex(ValueError, "caption"):
            self.layout([px(0, 0, 10, 10, 1024, 1024, description="")], 1024, 1024)
        with self.assertRaisesRegex(ValueError, "exact words"):
            self.layout([px(0, 0, 10, 10, 1024, 1024, kind="text", text="  ")], 1024, 1024)
        with self.assertRaisesRegex(ValueError, "canvas"):
            self.layout([], 1024, 1024, canvas="grid")
        with self.assertRaisesRegex(ValueError, "Supported boxes"):
            moss.import_moss('{"summary":{"caption":"x"},"items":[],"bbox_coord_space":"rel","bbox_format":"yxyx"}')

    def test_warnings(self):
        tiny = px(0, 0, 64, 16, 1024, 1024, kind="text", text="A very long sentence in a tiny box", description="Grey.")
        warnings = self.layout([tiny], 1024, 1024)["warnings"]
        self.assertTrue(any("per glyph" in w for w in warnings))
        repeated = px(0, 0, 1024, 512, 1024, 1024, kind="text", text="EXPLORE", description="EXPLORE in blue.")
        self.assertTrue(any("repeats" in w for w in self.layout([repeated], 1024, 1024)["warnings"]))
        self.assertTrue(any("0.25–4 MP" in w for w in self.layout([], 256, 256, summary_caption="x")["warnings"]))
        imported = moss.import_moss('{"summary":{"caption":"x","extra":1},"items":[{"label":"object","caption":"y",'
                                    '"bbox":[-600,-512,0,0],"id":3}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}')
        self.assertTrue(any("summary keys" in w for w in imported["warnings"]))
        self.assertTrue(any("clipped" in w for w in imported["warnings"]))

    def test_resolve_and_node(self):
        regions = [px(928, 272, 1408, 448, 1536, 1024, **TITLE), px(176, 224, 800, 864, 1536, 1024, **CUP)]
        state = json.dumps({"version": 1, "order": "front_to_back", "regions": regions, "_preview_selected": regions[0]["id"]})
        node = moss.MossImagePromptBuilder()
        output = node.build(1536, 1024, "A warm studio campaign.", "poster", "single", "", "", 25, "pretty", state)
        prompt, preview, boxes, width, height, draft = output["result"]
        self.assertEqual(json.loads(prompt)["items"][0]["bbox"], [-288, -592, 352, 32])
        self.assertIn("\n", prompt)
        self.assertEqual(tuple(preview.shape), (1, 683, 1024, 3))
        self.assertEqual(boxes[0][0], {"x": 176, "y": 224, "width": 624, "height": 640})
        self.assertEqual((width, height), (1536, 1024))
        self.assertEqual(json.loads(draft)["bbox_format"], "xyxy")
        self.assertEqual(output["ui"]["moss"][0]["mode"], "layout")
        image = torch.rand(2, 64, 96, 3)
        batch = node.build(1536, 1024, "A warm studio campaign.", "", "single", "", "", 25, "compact", state, image)
        self.assertEqual(batch["result"][1].shape[0], 2)
        override = node.build(1024, 1024, "", "", "single", "", draft, 25, "compact", "[]")
        self.assertEqual(override["result"][0], json.dumps(json.loads(prompt), ensure_ascii=False, separators=(",", ":")))
        self.assertIn("regions", override["ui"]["moss"][0])


if __name__ == "__main__":
    unittest.main()
