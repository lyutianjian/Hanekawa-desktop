// C01: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/01-bootstrap.js. Relative imports are intentionally not vendored.
import { create_tinysky_alt } from "./create_tinysky_alt.js";
var o;
const r = globalThis.nodeRepl,
  t = null === (o = null == r ? void 0 : r.env) || void 0 === o ? void 0 : o.CUA_REPL_ENABLED_SURFACES;
if (void 0 === t) throw new Error("CUA_REPL_ENABLED_SURFACES is required");
const i = new Set(t.split(",").map(e => e.trim()).filter(Boolean)),
  s = ["browser", "computer"];
for (const e of i) if (!s.includes(e)) throw new Error(`unknown CUA_REPL_ENABLED_SURFACES surface=${e}`);
const n = await create_tinysky_alt({
  browser: i.has("browser"),
  computer: i.has("computer")
});
Object.assign(n, {
  initialize: n.getState
}), Reflect.set(globalThis, "cua", n);
