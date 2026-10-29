export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export const DESCRIPTION = `Search the web and return titles, URLs and snippets from a real search engine.

Parameters:
- \`queries\` — required. 1–4 entries, each either a plain query string, or an object with \`q\` plus optional \`recencyDays\` and \`domains\` for that query alone:
  \`{"queries": ["rust async book", {"q": "tokio 1.40 release", "recencyDays": 30}]}\`
  All queries in one call run in parallel, so several angles cost one round trip.
- \`domains\` — optional. Restrict every string query to these domains, e.g. \`["nodejs.org", "developer.mozilla.org"]\`. Applied as a \`site:\` scope and then enforced on the result hosts.
- \`blockedDomains\` — optional. Drop results from these domains.
- \`recencyDays\` — optional. Only recent results, e.g. \`7\`. Applied where the engine supports it, so treat it as a strong hint rather than a guarantee.
- \`maxResults\` — optional, 1–20, default 8. Results per query.

There is no \`allowed_domains\`/\`blocked_domains\` (use \`domains\`/\`blockedDomains\`) and no \`prompt\` parameter: the snippets come back for you to read.

What comes back:
- Up to \`maxResults\` numbered results per query: title, the URL to hand to WebFetch, and a one-line snippet — plus the engine that answered.
- Snippets are short and often truncated mid-sentence. They tell you which page to read, not what it says: follow the ones that matter with WebFetch.
- Engines are tried best-first until one answers, so a blocked or rate-limited engine is not a failed search: DuckDuckGo, then Bing, then Baidu, then Wikipedia (a Chinese query asks Baidu first). An engine that just failed to connect or challenged the request is skipped for the next couple of minutes rather than retried on every search, so a network that blocks one engine costs one timeout, not one per query. When *every* engine fails, the error names each one's reason; when some queries worked and others did not, the answer says which and why.
- Results come from whichever engine answered, so a snippet is not a source you have already read; open the page before quoting figures from it.

Use this for anything that can have changed since your training data — releases, versions, current documentation, prices, schedules, news, people and company roles — or when the user asks you to look something up, verify a claim, or wants sources and links. When in doubt about whether a fact is still current, search rather than recall. For a specific page whose URL you already have, skip this and call WebFetch.`