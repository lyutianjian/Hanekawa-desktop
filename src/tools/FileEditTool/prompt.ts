export const FILE_EDIT_TOOL_NAME = 'Edit'

export const DESCRIPTION = `Replace an exact string in an existing text file.

Usage:
- Parameters are camelCase: \`filePath\`, \`oldString\`, \`newString\` (all required) and \`replaceAll\` (optional). Any other key is rejected.
- You MUST Read the file in this conversation first. Editing an unread or stale file fails.
- In global config.json/settings.json, match the displayed [REDACTED] API-key placeholders as shown. Existing keys are preserved when other fields change; to rename an endpoint/model, use Settings to carry its key over.
- \`oldString\` must match the file byte for byte, including indentation. Strip Read's line-number prefix before matching, and write line breaks as \\n.
- Matching runs on LF-normalized content, so a CRLF file matches an LF \`oldString\`; the file's original line endings and encoding are restored on write.
- The edit FAILS unless \`oldString\` occurs exactly once. Either widen it with surrounding lines until it is unique, or pass \`replaceAll: true\` to change every occurrence (the right choice for renaming a symbol).
- Prefer the smallest unique \`oldString\` — usually two to four adjacent lines.
- An empty \`newString\` deletes the matched text.
- For several edits to one file, use MultiEdit. For .ipynb files, use NotebookEdit.`
