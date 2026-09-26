"""Optional CPU-only contract check against an installed ComfyUI checkout.

Usage: python tests/check_comfy_compatibility.py /path/to/ComfyUI
Uses recording text-encoder stubs; does not load weights or run inference.
"""
import importlib.util
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))

from comfy.cli_args import args
args.cpu = True


def load(name, file, package=False):
    spec = importlib.util.spec_from_file_location(name, file,
        submodule_search_locations=[str(file.parent)] if package else None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class RecordingClip:
    def tokenize(self, text, **kwargs):
        self.text = text
        self.options = kwargs
        return text

    def encode_from_tokens_scheduled(self, tokens):
        return tokens


backend = load("ming_builder_backend", Path(__file__).resolve().parents[1] / "nodes.py")
core = load("comfy_core_nodes", root / "nodes.py")
region = {"id": "text", "x": .1, "y": .1, "w": .8, "h": .2, "kind": "text",
          "text": '  "Exact" {left|right}\n未来 مرحبًا  ', "description": "bold typography", "relation": "Above the subject.", "colors": ["#FFFFFF"]}
prompt, _ = backend.serialize_ming([region], 1024, 1024)
clip = RecordingClip()
assert core.CLIPTextEncode().encode(clip, prompt)[0] == prompt
assert clip.text == prompt
assert "STRING" == backend.MingImagePromptBuilder.RETURN_TYPES[0]
assert core.CLIPTextEncode.INPUT_TYPES()["required"]["text"][0] == "STRING"
print("PASS official CLIPTextEncode accepts the exact Ming STRING without rewriting")

# Both optional Ming-specific conditioning nodes also accept the same string with
# zero reference images. Design T2I normally uses CLIPTextEncode above.
official = load("ming_official_conditioning", root / "comfy_extras" / "nodes_ming.py")
result = official.TextEncodeMingImageEdit.execute(clip, prompt, {})
assert result.result[0] == prompt
assert clip.text == prompt and clip.options == {"images": []}
print("PASS official Ming conditioning accepts a T2I prompt with no references")

custom = root / "custom_nodes" / "comfyui_ming_native"
if custom.is_dir():
    module = load("ming_custom_integration", custom / "__init__.py", package=True)
    result = module.MingNativeTextEncodeEdit.execute(clip, prompt, {})
    assert result.result[0] == prompt
    assert clip.text == prompt and clip.options == {"images": []}
    schema = module.MingNativeTextEncoderLoader.define_schema()
    assert schema.outputs[0].io_type == "CLIP"
    print("PASS installed comfyui_ming_native CLIP loader / zero-reference conditioning contracts")
else:
    print("SKIP optional comfyui_ming_native is not installed")

print("No model weights or generation were used in this contract check.")
