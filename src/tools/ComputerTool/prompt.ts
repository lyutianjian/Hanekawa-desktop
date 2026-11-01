export const COMPUTER_TOOL_NAME = 'Computer'

export const DESCRIPTION = `Observe and operate real desktop applications through the operating system's accessibility tree using built-in agent-desktop. No CLI installation or MCP setup is needed. Prefer Browser for web pages inside Hanekawa; use Computer for other desktop apps and system UI.

Input: operation is a native command name below, or help/docs; args is an array of individual CLI argument strings (default []), never a shell command; headed permits physical input/focus changes (default false); timeoutMs is the total deadline including queueing, 100–120000 ms, default 30000. Do not put the executable or global flags in args.

Before first use, call status, then docs with args ["desktop"] and ["platform"]. These documents match the bundled binary. Use help with args ["snapshot"] (or another command) for native syntax. docs also accepts a second reference name: commands-observation, commands-interaction, commands-system, workflows, troubleshooting.

Observe: list-apps, list-windows, list-displays, list-surfaces, snapshot, find, get, is, screenshot.
Ref actions: click, double-click, triple-click, right-click, type, set-value, clear, focus, select, toggle, check, uncheck, expand, collapse, scroll, scroll-to.
Keyboard/mouse: press, hover, drag, mouse-move, mouse-click, mouse-wheel.
Apps/windows: launch, close-app, focus-window, resize-window, move-window, minimize, maximize, restore, open-system-surface.
Other: list-notifications, dismiss-notification, dismiss-all-notifications, notification-action, clipboard-get, clipboard-set, clipboard-clear, wait, status, permissions, version.

Examples:
- {"operation":"snapshot","args":["--app","Finder","-i","--compact"]}
- {"operation":"snapshot","args":["--root","@s8f3k2p9:e3","-i"]}
- {"operation":"type","args":["@s8f3k2p9:e8","hello"]}
- {"operation":"press","args":["--app","TextEdit","cmd+s"]}
- {"operation":"screenshot","args":["--app","TextEdit"]}
- {"operation":"wait","args":["--app","TextEdit","--text","Saved","--timeout","5000"]}

Read the live UI, act using its qualified @<snapshot>:e<N> ref, then observe again to verify. Read data.complete: a partial snapshot is not the whole UI. Use --skeleton then --root to drill into dense apps; surface menu/sheet/alert snapshots should not use --skeleton. After STALE_REF, AMBIGUOUS_TARGET or SNAPSHOT_NOT_FOUND, read fresh refs. Multiple windows require an explicit --window-id from list-windows. Refs are isolated to this conversation; never borrow another conversation's refs.

Results retain the native JSON envelope, including error.code and disposition.delivery/retry. ok:true can mean delivered_unverified; it does not prove an application saved a change. Repeat or substitute an action only when disposition.retry is safe. For unsafe/unknown delivery, or a cancelled/timed-out call, read the live UI before doing anything again. Hanekawa never automatically retries desktop actions. Use wait for asynchronous changes.

Headless semantic actions are the default. headed:true is required for physical input, double/triple-click, hover, drag and raw mouse operations; it can move the user's pointer and change focus. Use it only when the user permits physical input, not as an automatic fallback. Physical input, forced shortcuts and closing apps have a higher permission tier. Desktop changes go beyond the project directory, and are not covered by file-tool /rewind.

Screenshots attach actual image pixels through the conversation's attachment store and require an image-capable model. Screenshot args accept only --app, --window-id or --screen, never an output path. Coordinates for mouse commands are absolute OS screen coordinates, potentially negative. Screenshot pixels may be scaled and window-local: use accessibility bounds and list-displays; never assume screenshot pixels equal absolute screen coordinates.

The args allowlist covers documented observation/action options, not arbitrary global flags. Namespace/state paths, trace/debug outputs, batch/session/cursor-overlay commands, held keys/buttons, launch --arg/--env/--cwd/--cdp, and file/image clipboard input/output are unavailable. Clipboard operations support plain text only. Use -- before positional text that begins with '-'. Long option values can use --xy=-100,50. Set native wait/action timeouts below timeoutMs to leave time for command startup. Unsupported OS features return native errors.

permissions checks access without prompting; args ["--guide"] opens the macOS permission guide, ["--request"] requests OS prompts. Only the user can grant macOS Accessibility/Screen Recording permissions. If denied, explain the missing permission and guide the user to authorize the app launching the native helper (Hanekawa/Electron in the desktop app).`
