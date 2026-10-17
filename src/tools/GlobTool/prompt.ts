export const GLOB_TOOL_NAME = 'Glob'

export const DESCRIPTION = `Find files by name pattern.

Usage:
- Parameters are \`pattern\` (required) and \`path\` (optional). Any other key is rejected.
- \`pattern\` matches whole paths relative to the search root: "**/*.ts", "src/**/*.{ts,tsx}", "**/README.md".
- \`path\` is the directory to search and defaults to the working directory. Returned paths are relative to it.
- Files ignored by .gitignore (node_modules, build output) and version control directories are skipped, as in Grep.
- Results come back in filesystem order, not sorted by modification time, and stop at 200; the result then gives the total, so narrow the pattern or path.
- Dotfiles and dot-directories are skipped. Match them by naming them, e.g. ".myagent/**/*.md".
- Use Glob for file names and Grep for file contents. For an open-ended search that needs several rounds of globbing and grepping, use the Agent tool instead.`
