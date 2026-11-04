// C04: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/04-trusted-sky-proxy.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { create_client } from "./create_client.js";
import { load_options } from "./load_options.js";
import { create_drag_handle, invoke } from "./sky_service_rpc.js";
const i = globalThis.nodeRepl;
let s, c, l;
if ("function" == typeof (null == i ? void 0 : i.rpc)) try {
  s = await f({
    type: "setup"
  });
} catch (t) {
  c = t;
}
const sky = new Proxy({}, {
  get(t, e) {
    const o = d(),
      r = Reflect.get(o, e);
    return "function" == typeof r ? r.bind(o) : e in o || void 0 === c ? r : () => Promise.reject(c);
  },
  getOwnPropertyDescriptor(t, e) {
    const o = d();
    return Object.getOwnPropertyDescriptor(o, e);
  },
  has: (t, e) => e in d(),
  ownKeys() {
    const t = d();
    return Object.keys(t);
  }
});
function d() {
  var t;
  if (null != l) return l;
  if (void 0 === i) return l = create_client(load_options()), l;
  if ("function" != typeof i.rpc) throw new Error("sky requires node_repl; configure NODE_REPL_TRUSTED_SERVICES");
  const n = {
    target: null == s ? void 0 : s.target
  };
  for (const e of null !== (t = null == s ? void 0 : s.methods) && void 0 !== t ? t : []) {
    const t = (...t) => f({
      type: "execute",
      method: e,
      args: t
    });
    Reflect.set(n, e, t);
  }
  return "linux" === n.target && (null == s ? void 0 : s.methods.includes("drag_handle")) && (n.drag_handle = () => create_drag_handle(t => f(t))), l = n, l;
}
function f(e) {
  return __awaiter(this, void 0, void 0, function* () {
    return invoke(i, e, null == s ? void 0 : s.target);
  });
}
export { sky };
