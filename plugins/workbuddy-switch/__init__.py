"""workbuddy-switch Hermes plugin package.

All behaviour lives in the dashboard extension (dashboard/manifest.json +
dashboard/plugin_api.py). This module only satisfies the directory-plugin
loader, which requires __init__.py exposing a register() function.
"""


def register(ctx):
    """No-op registration: the plugin contributes no tools or hooks."""
    return None
