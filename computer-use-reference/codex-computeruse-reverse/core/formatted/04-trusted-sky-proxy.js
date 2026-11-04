// C04: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/sky.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { __awaiter as t } from "../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { create_client as e } from "./create_client.js";
import { load_options as o } from "./load_options.js";
import { create_drag_handle as r, invoke as n } from "./sky_service_rpc.js";
const i = globalThis.nodeRepl;
let s, c, l;
if ("function" == typeof (null == i ? void 0 : i.rpc)) try {
  s = await f({
    type: "setup"
  });
} catch (t) {
  c = t;
}
const u = new Proxy({}, {
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
  if (void 0 === i) return l = e(o()), l;
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
  return "linux" === n.target && (null == s ? void 0 : s.methods.includes("drag_handle")) && (n.drag_handle = () => r(t => f(t))), l = n, l;
}
function f(e) {
  return t(this, void 0, void 0, function* () {
    return n(i, e, null == s ? void 0 : s.target);
  });
}
export { u as sky };
