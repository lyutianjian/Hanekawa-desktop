export const MULTI_EDIT_TOOL_NAME = 'MultiEdit'

export const DESCRIPTION = `Apply several exact string replacements to one text file atomically.

Usage:
- Parameters are camelCase: \`filePath\` and \`edits\`, an array of \`{ oldString, newString, replaceAll? }\`. Any other key is rejected.
- A prior Read is not required if you already know the exact text. Use Read when you need surrounding context. Read deny/ask rules still apply to the internal read.
- Global config.json/settings.json edits match the displayed [REDACTED] API-key placeholders; existing keys are restored before saving.
- Every edit is validated against the CURRENT file on disk before any replacements, not against the result of the edits before it. Changes elsewhere are preserved. Two edits must not target overlapping text.
- All or nothing: if one edit fails to match, or matches more than once without \`replaceAll: true\`, nothing is written.
- Each \`oldString\` follows the same rules as Edit: byte-exact, indentation included, \\n for line breaks, no Read line-number prefixes.
- Use Edit for a single replacement and Write when you are replacing the whole file.`
