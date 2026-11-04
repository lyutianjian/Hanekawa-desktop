// C01: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/globals.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { create_tinysky_alt as e } from "./create_tinysky_alt.js";
var o;
const r = globalThis.nodeRepl,
  t = null === (o = null == r ? void 0 : r.env) || void 0 === o ? void 0 : o.CUA_REPL_ENABLED_SURFACES;
if (void 0 === t) throw new Error("CUA_REPL_ENABLED_SURFACES is required");
const i = new Set(t.split(",").map(e => e.trim()).filter(Boolean)),
  s = ["browser", "computer"];
for (const e of i) if (!s.includes(e)) throw new Error(`unknown CUA_REPL_ENABLED_SURFACES surface=${e}`);
const n = await e({
  browser: i.has("browser"),
  computer: i.has("computer")
});
Object.assign(n, {
  initialize: n.getState
}), Reflect.set(globalThis, "cua", n);
