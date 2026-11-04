# Browser extension point

This directory is an explicit extension point, not an implemented driver.

Before adding it, extend `Target` to carry browser/session/tab/document identities,
and negotiate `ax`, `domSnapshot`, `locator`, `screenshot`, and coordinate capabilities separately.
Do not pass a DOM-only snapshot index to the macOS `press` action.
Navigation must invalidate references using frame + loader/document identity.
Origin permissions, downloads/uploads and tab claim ownership belong in the trusted service.
Keep full CDP inaccessible through the renderer's public bridge.
