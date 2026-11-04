// C17: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/environment.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { readFileSync as E } from "node:fs";
import { load_instructions as o } from "./instructions.js";
function r({
  env: r,
  instructions_directory: s,
  platform: _
}) {
  var e, i;
  const t = o(s, _, r.CUA_REPL_BROWSER_ENV, r.CUA_REPL_BROWSER_GUIDANCE),
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
    NODE_REPL_JS_BANNER: null !== (i = r.NODE_REPL_JS_BANNER) && void 0 !== i ? i : E(new URL("banner.js", s), "utf8"),
    NODE_REPL_TOOL_OVERRIDES: JSON.stringify(N)
  });
}
export { r as create_launch_environment };
