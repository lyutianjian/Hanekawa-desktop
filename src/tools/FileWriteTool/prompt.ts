export const FILE_WRITE_TOOL_NAME = 'Write'

export const DESCRIPTION = `Write a text file, creating it or replacing it whole.

Usage:
- Parameters are camelCase: \`filePath\` and \`content\`, both required. Any other key is rejected.
- Overwriting an existing file requires reading it in this conversation first; creating a new one does not.
- In global config.json/settings.json, keep [REDACTED] API-key placeholders. Existing keys in retained endpoints/models are preserved even if omitted; new endpoints/models need their keys set in Settings.
- \`content\` is the complete file. Write partial changes with Edit or MultiEdit instead — this tool discards whatever was there.
- Missing parent directories are created. An existing file keeps its line endings and encoding; a new file is UTF-8 with LF.
- Prefer editing a file that already exists over adding a new one.`
