export const MULTI_EDIT_TOOL_NAME = 'MultiEdit'

export const DESCRIPTION = `Apply several exact string replacements to one text file atomically.

Usage:
- Parameters are camelCase: \`filePath\` and \`edits\`, an array of \`{ oldString, newString, replaceAll? }\`. Any other key is rejected.
- You MUST Read the file in this conversation first. Editing an unread or stale file fails.
- Global config.json/settings.json edits match the displayed [REDACTED] API-key placeholders; existing keys are restored before saving.
- Every edit is validated against the ORIGINAL file content, not against the result of the edits before it. Two edits must not target overlapping text.
- All or nothing: if one edit fails to match, or matches more than once without \`replaceAll: true\`, nothing is written.
- Each \`oldString\` follows the same rules as Edit: byte-exact, indentation included, \\n for line breaks, no Read line-number prefixes.
- Use Edit for a single replacement and Write when you are replacing the whole file.`
