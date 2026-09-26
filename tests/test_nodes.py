"""Run with ComfyUI's Python: python -m unittest discover -s tests -v."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

import torch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("ming_builder_nodes", ROOT / "nodes.py")
ming = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ming)


def region(**changes):
    value = dict(id="object_1", x=0.2, y=0.1, w=0.6, h=0.2, kind="object", text="",
                 description="A red ceramic bowl.", relation="In front of the background.", colors=["#aabbcc"])
    value.update(changes)
    return value


def text_region(**changes):
    value = region(id="text_1", kind="text", text="THE FUTURE IS HANDMADE",
                   description="bold condensed editorial typography", relation="Primary title above the subject.")
    value.update(changes)
    return value


def serialize(regions, **kwargs):
    text, warnings = ming.serialize_ming(regions, 1024, 1024, **kwargs)
    return json.loads(text), warnings


def document(layers=None, ratio="1:1"):
    if layers is None:
        layers = [{"description": "A blue background.", "coordinates": "cx: 0.500, cy: 0.500, w: 1.000, h: 1.000",
                   "hierarchy_and_relation": "Background", "color_specs": ["#0000ff"]}]
    return json.dumps({"canvas_settings": {"aspect_ratio": ratio, "ambient_lighting": "soft", "image_style": "editorial"}, "layers": layers})


class Coordinates(unittest.TestCase):
    def test_forward_and_reverse(self):
        value = ming.serialize_coordinates(region())
        self.assertEqual(value, "cx: 0.500, cy: 0.200, w: 0.600, h: 0.200")
        actual = ming.parse_coordinates(value)
        for key in ("x", "y", "w", "h"):
            self.assertAlmostEqual(actual[key], region()[key])

    def test_coordinate_whitespace_and_scientific_notation(self):
        self.assertAlmostEqual(ming.parse_coordinates(" cx : 5e-1, cy: .2, w: 0.6, h: .2 ")["x"], .2)

    def test_malformed_coordinates(self):
        for value in ("0.5,0.2,0.6,0.2", "cx: .5, cy: .2, w: .6", "cx: .5, cy: .2, w: .6, h: .2 trailing",
                      "cx: NaN, cy: .2, w: .6, h: .2", "cx: 1e999, cy: .2, w: .6, h: .2", None):
            with self.subTest(value=value), self.assertRaises(ming.PromptValidationError):
                ming.parse_coordinates(value)

    def test_invalid_coordinate_ranges(self):
        for value in ("cx: 1.1, cy: .2, w: .6, h: .2", "cx: .5, cy: .2, w: 0, h: .2",
                      "cx: .5, cy: .2, w: -.1, h: .2", "cx: .5, cy: .2, w: 2, h: .2"):
            with self.subTest(value=value), self.assertRaises(ming.PromptValidationError):
                ming.parse_coordinates(value)

    def test_aspect_ratios(self):
        for w, h, ratio in [(1024, 1024, "1:1"), (1536, 1024, "3:2"), (1024, 1536, "2:3"), (1920, 1080, "16:9")]:
            with self.subTest(ratio=ratio): self.assertEqual(ming.aspect_ratio(w, h), ratio)

    def test_bad_dimensions(self):
        for value in (0, -1, 1.5, True, 16385, float("nan")):
            with self.subTest(value=value), self.assertRaises(ming.PromptValidationError): ming.aspect_ratio(value, 1024)

    def test_imported_aspect_exact(self):
        self.assertEqual(ming.dimensions_for_ratio("1920:1080", 1024, 1024), (1024, 576))
        self.assertEqual(ming.dimensions_for_ratio("2:3", 1024, 1536), (1024, 1536))

    def test_bad_aspect(self):
        for ratio in ("0:1", "1.5:1", "16x9", "-1:1", "999999:1", None):
            with self.subTest(ratio=ratio), self.assertRaises(ming.PromptValidationError): ming.dimensions_for_ratio(ratio, 1024, 1024)


class Serialization(unittest.TestCase):
    def test_object_exact_schema(self):
        prompt, _ = serialize([region()])
        self.assertEqual(set(prompt), {"canvas_settings", "layers"})
        self.assertEqual(set(prompt["canvas_settings"]), {"aspect_ratio", "ambient_lighting", "image_style"})
        layer = prompt["layers"][0]
        self.assertEqual(set(layer), {"description", "coordinates", "hierarchy_and_relation", "color_specs"})
        self.assertEqual(layer["description"], "A red ceramic bowl.")
        self.assertEqual(layer["color_specs"], ["#AABBCC"])

    def test_text_once(self):
        prompt, _ = serialize([text_region()])
        description = prompt["layers"][0]["description"]
        self.assertEqual(description, 'A text element reading exactly "THE FUTURE IS HANDMADE" in bold condensed editorial typography.')
        self.assertEqual(json.dumps(prompt).count("THE FUTURE IS HANDMADE"), 1)

    def test_relation_and_visual_do_not_repeat_text(self):
        prompt, warnings = serialize([text_region(description="THE FUTURE IS HANDMADE in blue", relation="THE FUTURE IS HANDMADE over the bowl")])
        self.assertEqual(json.dumps(prompt).count("THE FUTURE IS HANDMADE"), 1)
        self.assertEqual(len(warnings), 2)

    def test_special_characters_multiline_and_unicode(self):
        for text in ['He said "hello" \\ slash / {a|b}', "  leading  spaces\nsecond line\n", "未来 — مرحبًا 👩🏽‍🎨 e\u0301", "tab\tcarriage\rreturn", 'quoted " in the middle']:
            with self.subTest(text=text):
                prompt, _ = serialize([text_region(text=text)])
                self.assertIn(f'reading exactly "{text}"', prompt["layers"][0]["description"])
                imported = ming.import_ming(json.dumps(prompt))["regions"][0]
                self.assertEqual(imported["text"], text)

    def test_multiline_text_with_punctuated_visual_description(self):
        for visual in ("bold type!", "handwritten?", "bold type."):
            prompt, _ = serialize([text_region(text="First\nSecond", description=visual)])
            imported = ming.import_ming(json.dumps(prompt))["regions"][0]
            self.assertEqual(imported["kind"], "text")
            self.assertEqual(imported["text"], "First\nSecond")
            self.assertEqual(serialize([imported])[0], prompt)

    def test_order_reversed_once(self):
        prompt, _ = serialize([region(id="front", description="Front"), region(id="back", description="Back")])
        self.assertEqual([l["description"] for l in prompt["layers"]], ["Back", "Front"])
        imported = ming.import_ming(json.dumps(prompt))
        self.assertEqual([r["description"] for r in imported["regions"]], ["Front", "Back"])

    def test_input_is_not_mutated(self):
        original = [region(), text_region()]
        before = copy.deepcopy(original)
        serialize(original)
        self.assertEqual(original, before)

    def test_pretty_and_compact_equivalent(self):
        pretty, _ = ming.serialize_ming([region()], 1024, 1024)
        compact, _ = ming.serialize_ming([region()], 1024, 1024, output_format="compact")
        self.assertIn("\n", pretty)
        self.assertNotIn("\n", compact)
        self.assertEqual(json.loads(pretty), json.loads(compact))

    def test_no_editor_metadata(self):
        prompt, _ = serialize([text_region(hover=True, canvas=object(), selected=True)])
        self.assertNotIn("kind", prompt["layers"][0])
        self.assertNotIn("hover", json.dumps(prompt))

    def test_no_layers_is_valid(self):
        prompt, warnings = serialize([])
        self.assertEqual(prompt["layers"], [])
        self.assertTrue(warnings)


class Import(unittest.TestCase):
    def test_valid_prompt(self):
        result = ming.import_ming(document())
        self.assertEqual(result["image_style"], "editorial")
        self.assertEqual(result["ambient_lighting"], "soft")
        self.assertEqual(result["regions"][0]["colors"], ["#0000FF"])

    def test_malformed_json_and_top_level(self):
        for value in ("{", "[]", "null", "42", "{}", '{"layers": []}', '{"canvas_settings": {"aspect_ratio":"1:1"},"layers":NaN}'):
            with self.subTest(value=value), self.assertRaises(ming.PromptValidationError): ming.import_ming(value)

    def test_malformed_layer_coordinate_has_context(self):
        data = json.loads(document()); data["layers"][0]["coordinates"] = "bad"
        with self.assertRaisesRegex(ming.PromptValidationError, "Layer 1.*Malformed"):
            ming.import_ming(json.dumps(data))

    def test_missing_colors_and_relation_are_repaired(self):
        data = json.loads(document())
        del data["layers"][0]["color_specs"]; del data["layers"][0]["hierarchy_and_relation"]
        result = ming.import_ming(json.dumps(data))
        self.assertEqual(result["regions"][0]["colors"], [])
        self.assertEqual(result["regions"][0]["relation"], "")
        self.assertEqual(len(result["warnings"]), 2)

    def test_invalid_color_array_rejected(self):
        for colors in (None, "#FFFFFF", ["red"], ["#FFF"], ["#ZZZZZZ"]):
            data = json.loads(document()); data["layers"][0]["color_specs"] = colors
            with self.subTest(colors=colors), self.assertRaises(ming.PromptValidationError): ming.import_ming(json.dumps(data))

    def test_no_layers_import(self):
        self.assertEqual(ming.import_ming(document([]))["regions"], [])

    def test_conservative_text_detection_and_raw_preservation(self):
        raw = 'A large headline reading exactly "FUTURE MEMORY" in condensed white typography.'
        data = json.loads(document()); data["layers"][0]["description"] = raw
        imported = ming.import_ming(json.dumps(data))["regions"]
        self.assertEqual(imported[0]["kind"], "text")
        self.assertEqual(imported[0]["text"], "FUTURE MEMORY")
        imported[0]["x"], imported[0]["w"] = .1, .9
        prompt, _ = serialize(imported)
        self.assertEqual(prompt["layers"][0]["description"], raw)

    def test_uncertain_text_is_object(self):
        raw = 'A poster reading "ambiguous" with "other quotes".'
        data = json.loads(document()); data["layers"][0]["description"] = raw
        result = ming.import_ming(json.dumps(data))["regions"][0]
        self.assertEqual(result["kind"], "object")
        self.assertEqual(result["description"], raw)

    def test_edit_imported_text_rebuilds_description(self):
        value, _ = ming.serialize_ming([text_region()], 1024, 1024)
        imported = ming.import_ming(value)["regions"]
        imported[0]["text"] = "NEW TITLE"
        prompt, _ = serialize(imported)
        self.assertIn('reading exactly "NEW TITLE"', prompt["layers"][0]["description"])
        self.assertNotIn("THE FUTURE", prompt["layers"][0]["description"])

    def test_roundtrip_geometry_and_content(self):
        source = [text_region(x=.1501, y=.0802, w=.7002, h=.1401), region(x=.3333, y=.4444, w=.4321, h=.1234)]
        prompt, _ = ming.serialize_ming(source, 1536, 1024, image_style="poster", ambient_lighting="studio")
        result = ming.import_ming(prompt, 1536, 1024)
        for first, second in zip(source, result["regions"]):
            for key in ("x", "y", "w", "h"): self.assertAlmostEqual(first[key], second[key], delta=.001)
            for key in ("kind", "text", "description", "relation"): self.assertEqual(first[key], second[key])
        exported, _ = ming.serialize_ming(result["regions"], result["width"], result["height"], result["image_style"], result["ambient_lighting"])
        self.assertEqual(json.loads(prompt), json.loads(exported))


class Validation(unittest.TestCase):
    def test_bad_region_data(self):
        cases = [region(w=0), region(h=-.1), region(x=float("nan")), region(x=True), region(description=" "),
                 region(kind="shape"), text_region(text=""), region(colors=["#XYZXYZ"])]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ming.PromptValidationError): serialize([value])

    def test_clipped_geometry_warns(self):
        values, warnings = ming.validate_regions([region(x=-.02, w=.7)])
        self.assertEqual(values[0]["x"], 0)
        self.assertAlmostEqual(values[0]["w"], .68)
        self.assertTrue(warnings)

    def test_tiny_region_not_serialized_to_zero(self):
        prompt, warnings = serialize([region(w=.00001)])
        self.assertIn("w: 0.001", prompt["layers"][0]["coordinates"])
        self.assertTrue(warnings)

    def test_outside_canvas_fails(self):
        with self.assertRaises(ming.PromptValidationError): serialize([region(x=2)])

    def test_density_duplicates_overlap_are_warnings(self):
        prompt, warnings = serialize([text_region(id="a", text="long paragraph " * 20, w=.2, h=.1),
                                      text_region(id="b", text="long paragraph " * 20, w=.2, h=.1)])
        self.assertEqual(len(prompt["layers"]), 2)
        self.assertTrue(any("Identical" in warning for warning in warnings))
        self.assertTrue(any("relative to its size" in warning for warning in warnings))
        self.assertTrue(any("overlap" in warning for warning in warnings))

    def test_invalid_editor_json_is_not_silently_empty(self):
        for value in ("[", "null", '{"version":2,"regions":[]}', '{"version":1,"regions":null}'):
            with self.subTest(value=value), self.assertRaises(ming.PromptValidationError): ming.parse_editor_state(value)

    def test_duplicate_ids(self):
        with self.assertRaisesRegex(ming.PromptValidationError, "duplicate region id"): serialize([region(), region()])


class Execution(unittest.TestCase):
    def test_preview_and_bbox_dimensions(self):
        result = ming.MingImagePromptBuilder().build(320, 180, layers_data=json.dumps([region()]))["result"]
        self.assertEqual(result[1].shape, (1, 180, 320, 3))
        self.assertEqual(result[1].dtype, torch.float32)
        self.assertEqual(result[2], [[dict(x=64, y=18, width=192, height=36)]])
        self.assertEqual(result[3:], (320, 180))

    def test_batch_bboxes_and_background_brightness(self):
        image = torch.ones((2, 32, 64, 3))
        result = ming.MingImagePromptBuilder().build(64, 32, bg_brightness=25, image=image)["result"]
        self.assertEqual(result[1].shape, (2, 32, 64, 3))
        self.assertAlmostEqual(float(result[1][0, 16, 32, 0]), .25, delta=.004)
        self.assertEqual(result[2], [[], []])

    def test_background_letterboxing(self):
        preview, background = ming.render_preview([], 64, 64, torch.ones((1, 32, 64, 3)), 100)
        self.assertTrue(background.startswith("data:image/png;base64,"))
        self.assertEqual(float(preview[0, 32, 32, 0]), 1)
        self.assertLess(float(preview[0, 0, 32, 0]), .2)

    def test_large_preview_is_capped_bboxes_use_canvas(self):
        result = ming.MingImagePromptBuilder().build(1920, 1080, layers_data=json.dumps([region()]))["result"]
        self.assertEqual(result[1].shape, (1, 576, 1024, 3))
        self.assertEqual(result[2][0][0]["x"], 384)
        self.assertEqual(result[3:], (1920, 1080))

    def test_pixel_boxes_follow_export_order(self):
        boxes = ming.pixel_bboxes([region(id="a", x=.1), region(id="b", x=.2)], 100, 100, 2)
        self.assertEqual([box["x"] for box in boxes[0]], [20, 10])
        self.assertEqual(boxes[0], boxes[1]); self.assertIsNot(boxes[0][0], boxes[1][0])

    def test_selection_hint_changes_preview_not_prompt(self):
        data = {"version": 1, "order": "front_to_back", "regions": [region()]}
        unselected = ming.MingImagePromptBuilder().build(320, 180, layers_data=json.dumps(data))["result"]
        data["_preview_selected"] = "object_1"
        selected = ming.MingImagePromptBuilder().build(320, 180, layers_data=json.dumps(data))["result"]
        self.assertEqual(unselected[0], selected[0])
        self.assertFalse(torch.equal(unselected[1], selected[1]))

    def test_import_overrides_and_returns_resolved_state(self):
        result = ming.MingImagePromptBuilder().build(1024, 1024, layers_data=json.dumps([region()]), import_json=document(ratio="16:9"))
        self.assertEqual(result["result"][3:], (1024, 576))
        self.assertEqual(result["ui"]["ming"][0]["regions"][0]["description"], "A blue background.")

    def test_output_types(self):
        self.assertEqual(ming.MingImagePromptBuilder.RETURN_TYPES, ("STRING", "IMAGE", "BOUNDING_BOX", "INT", "INT"))
        self.assertFalse(ming.MingImagePromptBuilder.INPUT_TYPES()["required"]["layers_data"][1]["dynamicPrompts"])

    def test_execution_mirrors_connected_settings_to_editor(self):
        output = ming.MingImagePromptBuilder().build(320, 180, bg_brightness=67, output_format="compact",
            image_style="connected style", ambient_lighting="connected lighting", layers_data=json.dumps([region()]))
        settings = output["ui"]["ming"][0]
        self.assertEqual(settings["bg_brightness"], 67)
        self.assertEqual(settings["output_format"], "compact")
        self.assertEqual(settings["image_style"], "connected style")
        self.assertEqual(settings["ambient_lighting"], "connected lighting")

    def test_bundled_workflow_matches_executable_node(self):
        workflow = json.loads((ROOT / "example_workflows" / "ming_prompt_builder.json").read_text())
        node = next(n for n in workflow["nodes"] if n["type"] == "MingImagePromptBuilder")
        result = ming.MingImagePromptBuilder().build(**node["widgets_values_named"])["result"]
        prompt = json.loads(result[0])
        self.assertEqual(len(prompt["layers"]), 3)
        self.assertIn("paper background", prompt["layers"][0]["description"])
        self.assertIn("FUTURE MEMORY", prompt["layers"][-1]["description"])
        self.assertEqual(len(result[2][0]), 3)


if __name__ == "__main__":
    unittest.main()
