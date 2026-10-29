export const FILE_EDIT_TOOL_NAME = 'Edit'

export const DESCRIPTION = `Replace an exact string in an existing text file.

Usage:
- Parameters are camelCase: \`filePath\`, \`oldString\`, \`newString\` (all required) and \`replaceAll\` (optional). Any other key is rejected.
- If you already know the exact text from Grep, Bash, or the conversation, edit it directly; a prior Read is not required. Use Read when you need surrounding context.
- Replacements match the CURRENT file on disk. Changes elsewhere are preserved; a missing or ambiguous match fails without writing. Read deny/ask rules still apply to the internal read.
- In global config.json/settings.json, match the displayed [REDACTED] API-key placeholders as shown. Existing keys are preserved when other fields change; to rename an endpoint/model, use Settings to carry its key over.
- \`oldString\` must match the file byte for byte, including indentation. Strip Read's line-number prefix before matching, and write line breaks as \\n.
- Matching runs on LF-normalized content, so a CRLF file matches an LF \`oldString\`; the file's original line endings and encoding are restored on write.
- Only UTF-8 and BOM-marked UTF-16LE text are editable. Binary files and unsupported encodings are rejected.
- The edit FAILS unless \`oldString\` occurs exactly once. Either widen it with surrounding lines until it is unique, or pass \`replaceAll: true\` to change every occurrence (the right choice for renaming a symbol).
- Prefer the smallest unique \`oldString\` — usually two to four adjacent lines.
- An empty \`newString\` deletes the matched text.
- For several edits to one file, use MultiEdit. For .ipynb files, use NotebookEdit.`
