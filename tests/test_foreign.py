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
        self.assertTrue(any("said nothing about position" in w for w in result["warnings"]))  # the moon

    def test_compiles_to_moss(self):
        result = moss.import_moss(json.dumps(IDEOGRAM), 1024, 1024)
        prompt = json.loads(moss.resolve_moss(1024, 1024, result["summary_caption"], result["meta"], "single",
                                              result["palette"], json.dumps(result["regions"]))["prompt"])
        self.assertEqual(prompt["bbox_format"], "yxyx")
        self.assertEqual(prompt["items"][-1]["label"], "text")  # MOSS lists back to front: the title is last


ideogram = importlib.import_module("moss_builder_pkg.ideogram")


def placed(elements, width=896, height=1152):
    """Ideogram element index -> (box in pixels, layer from the back), plus the notes."""
    result, notes = ideogram.place_elements(elements, width, height, kind_of=moss._head_kind)
    boxes = {e["index"]: ([e["box"][0] * width, e["box"][1] * height, e["box"][2] * width, e["box"][3] * height], layer)
             for layer, e in enumerate(result)}
    return boxes, notes


def centre(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


class IdeogramWords(unittest.TestCase):
    """LLM-written Ideogram prompts rarely carry a bbox; positions are in the words."""

    COTTAGE = [
        {"type": "obj", "desc": "Mushroom cottage, the focal subject, occupying about half of the frame height, "
                                "slightly left of center on a mossy log. Red cap with white spots."},
        {"type": "obj", "desc": "Round wooden door set into the front of the mushroom cottage, centered. Brass hinges."},
        {"type": "obj", "desc": "Round window flanking the door on the left, with a tiny flower box."},
        {"type": "obj", "desc": "Round window flanking the door on the right, with a tiny flower box."},
        {"type": "obj", "desc": "Little lantern on the upper-left portion of the mushroom cottage, glowing softly."},
        {"type": "obj", "desc": "Ferns gathered around the base of the cottage on the right, lit from the upper-left."},
        {"type": "obj", "desc": "Stepping stones winding from the foreground up to the door of the cottage."},
    ]

    def test_relations_place_parts_on_their_parent(self):
        boxes, notes = placed(self.COTTAGE)
        house, door, left, right, lantern, ferns, path = (boxes[i][0] for i in range(7))
        self.assertAlmostEqual((house[3] - house[1]) / 1152, 0.5, places=2)       # "about half of the frame height"
        self.assertLess(centre(house)[0], 448)                                       # slightly left of centre
        self.assertTrue(house[0] <= door[0] and door[2] <= house[2] and door[3] <= house[3])
        self.assertGreater(door[3], house[1] + (house[3] - house[1]) * 0.85)         # a door stands on the ground line
        self.assertLess(left[2], door[0])
        self.assertGreater(right[0], door[2])
        self.assertLess(centre(lantern)[0], centre(house)[0])                       # upper-left portion
        self.assertLess(centre(lantern)[1], centre(house)[1])
        self.assertGreater(centre(ferns)[0], centre(house)[0])                      # "on the right", not the light's side
        self.assertEqual(path[3], 1152)                                             # from the near edge ...
        self.assertAlmostEqual(path[1], door[3] - (door[3] - door[1]) * 0.05, delta=2)  # ... up to the door
        self.assertTrue(any("7 of 7" in note for note in notes))

    def test_poster_text_stacks_and_layers(self):
        elements = [
            {"type": "obj", "desc": "Huge pale moon centered behind the lighthouse in the upper-middle of the frame."},
            {"type": "obj", "desc": "Tall striped lighthouse anchored center-frame on a rocky point."},
            {"type": "obj", "desc": "Rowing boat in the lower-left foreground."},
            {"type": "text", "text": "TIDE\nKEEPER", "desc": "Bold headline lettering spanning the upper third of the frame."},
            {"type": "text", "text": "EVERY LIGHT HAS A SECRET", "desc": "Small tagline directly beneath the title, centered."},
            {"type": "text", "text": "IN CINEMAS SOON", "desc": "Tiny credit line beneath the tagline, centered."},
        ]
        boxes, _ = placed(elements)
        (moon, moon_layer), (tower, tower_layer), (boat, _), (title, title_layer), (tag, _), (credit, _) = (boxes[i] for i in range(6))
        self.assertLess(moon_layer, tower_layer)                                    # behind = further back
        self.assertAlmostEqual(centre(moon)[0], centre(tower)[0], delta=2)
        self.assertGreater(tower[3] - tower[1], tower[2] - tower[0])                # tall
        self.assertLess(centre(boat)[0], 300)
        self.assertGreater(centre(boat)[1], 800)
        self.assertLessEqual(title[3], 1152 / 3 + 1)                                # inside the upper third
        self.assertGreater(tag[1], title[3])
        self.assertGreater(credit[1], tag[3])
        self.assertGreater(title_layer, max(moon_layer, tower_layer))               # lettering in front
        self.assertLess(tag[2] - tag[0], 896)

    def test_light_and_gaze_words_do_not_place(self):
        cue = ideogram.cues("Glass bottle centered on the table, lit from the upper-left, looking toward the right.")
        self.assertEqual(cue["x"], 0.5)
        self.assertNotIn("y", cue)

    def test_square_things_are_square_in_pixels(self):
        boxes, _ = placed([{"type": "obj", "desc": "Large round clock in the center of the frame."}])
        box = boxes[0][0]
        self.assertAlmostEqual(box[2] - box[0], box[3] - box[1], delta=2)

    def test_bboxes_kept_and_wordless_elements_spread(self):
        boxes, notes = placed([{"type": "obj", "bbox": [100, 100, 600, 500], "desc": "A cat"},
                               {"type": "obj", "desc": "A teapot"}, {"type": "obj", "desc": "A spoon"}], 1000, 1000)
        self.assertEqual([round(v) for v in boxes[0][0]], [100, 100, 500, 600])
        overlap = lambda a, b: max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
        self.assertEqual(overlap(boxes[1][0], boxes[2][0]), 0)
        self.assertTrue(any("said nothing about position" in note for note in notes))

    def test_all_bbox_documents_keep_their_order(self):
        doc = {"high_level_description": "x", "compositional_deconstruction": {"elements": [
            {"type": "obj", "bbox": [0, 0, 1000, 1000], "desc": "A big rug in front"},
            {"type": "obj", "bbox": [400, 400, 600, 600], "desc": "A small cat behind it"}]}}
        regions = moss.import_moss(json.dumps(doc), 1024, 1024)["regions"]
        self.assertEqual([r["description"] for r in regions], ["A big rug in front", "A small cat behind it"])

    def test_people_words_count_only_as_the_noun(self):
        for head, kind in (("strawberry-shaped fairy house", "object"), ("a small goblin", "character"),
                           ("woman reading", "character"), ("knight statue", "object"), ("two hikers", "character")):
            self.assertEqual(moss._head_kind(head, ""), kind, head)
        self.assertEqual(ideogram.head_phrase("A small goblin in a red cap, grinning."), "a small goblin")


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
        for noun, kind in (("two hikers", "character"), ("woman reading", "character"), ("troll", "character"), ("goblins", "character"),
                          ("elves", "character"), ("giant tree", "object"), ("street lamp", "object"), ("poster", "object")):
            self.assertEqual(moss._kind(noun, ""), kind, noun)

    def test_plain_moss_is_untouched(self):
        compiled = {"summary": {"caption": "x"}, "items": [], "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
        self.assertIsNone(moss.foreign_layout(compiled, 1024, 1024))


if __name__ == "__main__":
    unittest.main()
