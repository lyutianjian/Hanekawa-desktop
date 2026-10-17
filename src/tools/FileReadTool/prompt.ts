export const FILE_READ_TOOL_NAME = 'Read'

export const DESCRIPTION = `Read a text file or view an image from the current project.

Usage:
- Parameters are camelCase: \`filePath\` (required), \`offset\`, \`limit\`. Any other key is rejected — there is no \`pages\` parameter.
- \`filePath\` may be absolute or relative to the working directory.
- Text content comes back with \`cat -n\` style line numbers. They are display only: never copy a line-number prefix into an Edit \`oldString\`.
- CRLF files are normalized to LF on read, so a multi-line \`oldString\` written with \\n matches what you saw.
- \`offset\` is a 1-based starting line and \`limit\` caps the lines returned (default 2000). A read also stops early once it reaches about 20k tokens, and lines longer than 2000 characters are cut; the result then says which lines it shows, so continue with \`offset\`. A windowed read still remembers the whole file, so a later Edit can match anywhere in it, not just inside the window.
- Images: PNG, JPEG, GIF, and WebP are supported (the format is detected from file content, so a wrong extension still works). The result is a short caption — original dimensions, supplied dimensions, and the local cache path — plus the image itself attached to the tool result; no text is extracted from the pixels. Animated GIF/WebP supply their first frame, and EXIF orientation is applied. \`offset\`/\`limit\` do not apply to images and are rejected.
- Image reads require the current model to accept image input; on a text-only model they fail with \`precondition_failed\` instead of returning the bytes as text. BMP, HEIC, TIFF, and AVIF are not supported — convert them to PNG or JPEG first. SVG files are read as text. PDFs are not supported.
- An image read does not count as reading the file for editing: Edit and Write still refuse to treat image bytes as previously read text.
- This tool does not read directories (use Glob or Bash \`ls\`). Jupyter notebooks are read as raw JSON; edit them with NotebookEdit.
- Read a file before editing, overwriting, or deleting it — those tools refuse to act on a file they have not seen.`
