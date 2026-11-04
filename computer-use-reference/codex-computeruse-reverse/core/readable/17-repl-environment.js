// C17: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/17-repl-environment.js. Relative imports are intentionally not vendored.
import { readFileSync } from "node:fs";
import { load_instructions } from "./instructions.js";
function create_launch_environment({
  env: r,
  instructions_directory: s,
  platform: _
}) {
  var e, i;
  const t = load_instructions(s, _, r.CUA_REPL_BROWSER_ENV, r.CUA_REPL_BROWSER_GUIDANCE),
    n = r.CUA_REPL_ENABLED_SURFACES;
  if (void 0 === n) throw new Error("CUA_REPL_ENABLED_SURFACES is required");
  const R = new Set(n.split(",").map(E => E.trim()).filter(Boolean)),
    L = ["browser", "computer"];
  for (const E of R) if (!L.includes(E)) throw new Error(`unknown CUA_REPL_ENABLED_SURFACES surface=${E}`);
  const S = {},
    c = [t.description];
  R.has("browser") ? (S.browser = "@oai/browser-desktop/service", c.push(t.browser)) : c.push(t.browser_disabled), R.has("computer") ? (S.sky = "@oai/sky/service", c.push(t.computer)) : c.push(t.computer_disabled), c.push(t.output), R.has("computer") && "1" === r.SKY_ENABLE_AUDIO && "1" === r.NODE_REPL_ENABLE_AUDIO && c.push(t.audio);
  const N = {
    server_instructions: t.server,
    tools: {
      js: {
        description: c.join("\n\n"),
        field_descriptions: {
          code: t.code,
          title: t.title
        }
      },
      js_reset: {
        description: t.reset
      }
    }
  };
  return Object.assign(Object.assign({}, r), {
    CUA_REPL_ENABLED_SURFACES: [...R].join(","),
    NODE_REPL_JS_COMPLETION_SUMMARY: R.size > 0 ? JSON.stringify({
      instructions: t.task_completion,
      description: t.completion_summary
    }) : void 0,
    NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: [r.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST, "CUA_REPL_ENABLED_SURFACES", "CUA_REPL_BROWSER_ENV"].filter(Boolean).join(","),
    NODE_REPL_TRUSTED_SERVICES: null !== (e = r.NODE_REPL_TRUSTED_SERVICES) && void 0 !== e ? e : JSON.stringify(S),
    NODE_REPL_JS_BANNER: null !== (i = r.NODE_REPL_JS_BANNER) && void 0 !== i ? i : readFileSync(new URL("banner.js", s), "utf8"),
    NODE_REPL_TOOL_OVERRIDES: JSON.stringify(N)
  });
}
export { create_launch_environment };
