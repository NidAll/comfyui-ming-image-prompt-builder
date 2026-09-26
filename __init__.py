# SPDX-License-Identifier: GPL-3.0-only
from .nodes import MingImagePromptBuilder
from .api import register_routes

NODE_CLASS_MAPPINGS = {"MingImagePromptBuilder": MingImagePromptBuilder}
NODE_DISPLAY_NAME_MAPPINGS = {"MingImagePromptBuilder": "Ming Image Prompt Builder"}
WEB_DIRECTORY = "./web"

register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
