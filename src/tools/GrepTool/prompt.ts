import { DEFAULT_HEAD_LIMIT } from './constants.js'

export const GREP_TOOL_NAME = 'Grep'

/**
 * The `Grep` tool's description.
 *
 * The failures this text exists to prevent are all shaped the same way: the
 * model reaches for Claude Code's wire format (`output_mode`, `type`, `-C`) or
 * for grep syntax, and finds out what this tool accepts only by being rejected.
 * So the parameter list is spelled out, the ripgrep-not-grep distinction is
 * explicit, and every place the default differs from Claude Code says so.
 */
export const DESCRIPTION = `Search file contents with a regular expression, powered by ripgrep.

Usage:
- Parameters are camelCase: \`pattern\`, \`path\`, \`glob\`, \`type\`, \`outputMode\`, \`caseInsensitive\`, \`multiline\`, \`contextLines\`, \`contextBefore\`, \`contextAfter\`, \`headLimit\`, \`offset\`. Any other key is rejected.
- Search with this tool rather than running \`grep\` or \`rg\` through Bash.
- \`pattern\` is ripgrep regex syntax, not grep: literal braces need escaping, so \`interface\\{\\}\` is how you find \`interface{}\`.
- A pattern that spans lines needs \`multiline: true\`. Without it ripgrep refuses a literal \`\\n\`.
- \`outputMode\`: \`"content"\` (default, unlike Claude Code's files_with_matches) returns \`path:line:text\` rows, \`"files_with_matches"\` returns file paths only, \`"count"\` returns \`path:count\` rows.
- \`contextLines\` (both sides), \`contextBefore\` and \`contextAfter\` add surrounding lines. They are valid only with \`outputMode: "content"\`.
- Narrow the search with \`glob\` (\`"*.ts"\`, \`"**/*.{ts,tsx}"\`) or \`type\` (\`"js"\`, \`"py"\`, \`"rust"\`). \`path\` may be a directory or a single file; when it names a file, \`glob\` and \`type\` are ignored.
- \`headLimit\` caps the rows returned (default ${DEFAULT_HEAD_LIMIT}, \`0\` means unlimited) and \`offset\` skips rows before that cap.
- Paths come back relative to the working directory, and version control directories are always excluded.
- For an open-ended search that needs several rounds of grepping, use the Agent tool instead.`
