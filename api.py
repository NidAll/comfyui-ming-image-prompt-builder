# SPDX-License-Identifier: GPL-3.0-only
"""Same-origin editor operations; use the exact parser and serializer used at execution."""

from aiohttp import web
from server import PromptServer

from .moss import import_moss, resolve_moss
from .nodes import PromptValidationError, import_ming, resolve_prompt

MING_FIELDS = {"width", "height", "image_style", "ambient_lighting", "layers_data", "import_json", "output_format"}
MOSS_FIELDS = {"width", "height", "summary_caption", "meta", "canvas", "palette", "layers_data", "import_json",
               "output_format"}


def editor_operation(moss: bool):
    """One handler per format. ComfyUI serves each route at /name and /api/name, so never parse the path."""
    reader, resolver, fields = (import_moss, resolve_moss, MOSS_FIELDS) if moss else (import_ming, resolve_prompt, MING_FIELDS)

    async def operation(request):
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise PromptValidationError("The request must be a JSON object.")
            if request.path.endswith("/import"):
                result = reader(data.get("prompt", ""), data.get("width", 1024), data.get("height", 1024))
            else:
                result = resolver(**{key: value for key, value in data.items() if key in fields})
            return web.json_response(result)
        except (ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
    return operation


def register_routes():
    for route, moss in (("ming_prompt_builder", False), ("moss_prompt_builder", True)):
        handler = editor_operation(moss)
        for operation in ("import", "serialize"):
            PromptServer.instance.routes.post(f"/{route}/{operation}")(handler)
