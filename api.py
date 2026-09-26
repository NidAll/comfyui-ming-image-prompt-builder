# SPDX-License-Identifier: GPL-3.0-only
"""Same-origin editor operations; use the exact parser and serializer used at execution."""

from aiohttp import web
from server import PromptServer

from .nodes import PromptValidationError, import_ming, resolve_prompt


async def editor_operation(request):
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise PromptValidationError("The request must be a JSON object.")
        if request.path.endswith("/import"):
            result = import_ming(data.get("prompt", ""), data.get("width", 1024), data.get("height", 1024))
        else:
            result = resolve_prompt(**{key: value for key, value in data.items() if key in {
                "width", "height", "image_style", "ambient_lighting", "layers_data", "import_json", "output_format"}})
        return web.json_response(result)
    except (ValueError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)


def register_routes():
    for path in ("/ming_prompt_builder/import", "/ming_prompt_builder/serialize"):
        PromptServer.instance.routes.post(path)(editor_operation)
