export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `Fetch a URL and return what a reader would read, as markdown.

Parameters:
- \`url\` — required. A full absolute URL including the scheme, e.g. "https://nodejs.org/api/stream.html".
- \`pattern\` — optional string or array of strings (at most 6). Returns only the lines that contain one of these patterns, case-insensitively, each prefixed with its line number and two lines of context around it. Use this instead of paging through a large reference page: \`{"url": "https://nodejs.org/api/stream.html", "pattern": ["backpressure", "highWaterMark"]}\` answers in a few dozen lines what \`offset\` would take several calls to reach.
- \`offset\` — optional line number to start from (1-based, counted in lines of the markdown returned by an earlier call). Use it when the previous answer ended with a \`continue with offset=N\` note.

There is no \`prompt\` parameter: the page comes back for you to read, not summarized by a second model.

What comes back:
- The article, not the chrome. Scripts, styles, cookie banners, navigation, sidebars and footers are removed before conversion, so a documentation page arrives as its prose and code rather than as 70% menu.
- Tables become markdown tables, code blocks keep their language fence, and relative links are rewritten as absolute URLs you can fetch next.
- Text, JSON and markdown responses are returned as they arrived; JSON is pretty-printed.
- One answer holds about 40,000 characters. When a page is longer, the tail says \`[lines a–b of N; continue with offset=b+1]\` — page through with \`offset\` instead of assuming the page ended.
- A fetched page is cached for 15 minutes, so re-reading part of it (with \`offset\` or \`pattern\`) costs nothing and returns the same bytes.

Limits:
- Only the same host is followed across redirects. A redirect to another host comes back as a message naming the target URL: call WebFetch again with it, which is a new permission decision.
- A PDF or other binary response is reported as such; this tool does not extract PDF text. Download it with Bash and \`pdftotext\`, or use the Browser tool.
- A page that renders its content with JavaScript (or that shows a bot wall) comes back with an explanation and no prose. The Browser tool runs a real browser and reads the rendered page — use it for those URLs. WebFetch does not execute scripts.
- Requests are not authenticated. A page behind a login is a 401/403 answer, not content; the Browser tool can carry a session.

Permissions:
- Well-known documentation hosts are pre-approved; every other host asks the user before the request goes out, and "don't ask again" writes a \`WebFetch(domain:...)\` rule for that host.

Usage:
- Find the URL with WebSearch first unless you already have one; guessing URLs wastes a permission prompt.
- Prefer a URL that points at the specific page or anchor you need, and use \`pattern\` rather than reading a 3,000-line page end to end.
- Several pages that are independent can be fetched in parallel in one step, one WebFetch call each.`