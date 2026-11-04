// C05: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/05-trusted-service-dispatch.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { UnreachableCaseError } from "../../../../lib/js/oai_js_core/src/UnreachableCaseError.js";
import { create_client } from "./create_client.js";
import { load_options } from "./load_options.js";
import { require_audio_model_support } from "./require_audio_model_support.js";
import { WindowsComputerUseClient } from "./targets/windows/internal/computer_use_client.js";
let d, s;
const l = new Map();
let a;
function handleRpc(c) {
  return __awaiter(this, void 0, void 0, function* () {
    var h, p, _;
    const g = null != s ? s : s = load_options(),
      w = "windows" === g.target && "api" in g && "desktop" === g.api;
    if ("create" === c.type) {
      if (!w) throw new Error("The Sky configuration must enable the desktop API");
      if ("desktop" !== (null === (h = c.options) || void 0 === h ? void 0 : h.api)) throw new Error("Only the desktop API is supported");
      if ("windows" !== (null !== (p = c.options.target) && void 0 !== p ? p : g.target)) throw new Error("The desktop API requires Windows");
      if (null != a) throw new Error("A Windows desktop session is already active");
      const e = {
        id: crypto.randomUUID(),
        client: WindowsComputerUseClient.createDesktopClient({}),
        drag_handles: new Map()
      };
      return a = e, {
        target: e.client.target,
        client_id: e.id
      };
    }
    const f = "client_id" in c ? c.client_id : void 0;
    if (w && null == f) throw new Error("The configured desktop API requires create_client({ api: 'desktop' })");
    const m = null == f ? void 0 : a;
    if (null != f && (null == m ? void 0 : m.id) !== f) throw new Error("Sky client is unknown or closed");
    const y = null == m ? null != d ? d : d = create_client(g) : m.client;
    if ("execute" === c.type && "close" === c.method && null != m) return m.drag_handles.clear(), yield m.client.close(), void (a === m && (a = void 0));
    if ("drag_start" !== c.type && "drag_move" !== c.type && "drag_end" !== c.type) switch (c.type) {
      case "setup":
        return {
          target: y.target,
          methods: Object.keys(y).filter(e => "function" == typeof Reflect.get(y, e))
        };
      case "execute":
        return function (t, r) {
          return __awaiter(this, void 0, void 0, function* () {
            const e = Object.getOwnPropertyDescriptor(t, r.method),
              o = null == e ? void 0 : e.value;
            if ("function" != typeof o || "drag_handle" === r.method) throw new Error(`Sky runtime method is not available: ${r.method}`);
            if ("start_audio_recording" === r.method) {
              const e = globalThis.nodeRepl;
              require_audio_model_support({
                model_allowlist: process.env.SKY_AUDIO_MODEL_ALLOWLIST,
                request_meta: null == e ? void 0 : e.requestMeta
              });
            }
            const i = yield o.call(t, ...r.args);
            if ("get_screenshot" === r.method) {
              return i.map(u);
            }
            if ("get_window_state" === r.method && "linux" === t.target) {
              const e = i;
              return Object.assign(Object.assign({}, e), {
                screenshots: e.screenshots.map(u)
              });
            }
            if ("stop_audio_recording" === r.method) {
              return u(i);
            }
            return i;
          });
        }(y, c);
      default:
        throw new UnreachableCaseError(c);
    } else {
      const e = null !== (_ = null == m ? void 0 : m.drag_handles) && void 0 !== _ ? _ : l;
      if ("drag_start" === c.type) {
        if ("linux" !== y.target && "windows_desktop" !== y.target) throw new Error("Sky drag handles require a desktop runtime");
        if (e.has(c.handle_id)) throw new Error("drag handle can only be started once");
        const t = y.drag_handle(),
          r = {
            handle: t,
            starting: !0
          };
        e.set(c.handle_id, r);
        try {
          yield t.start(c.point), r.starting = !1;
        } catch (t) {
          throw e.get(c.handle_id) === r && e.delete(c.handle_id), t;
        }
        return;
      }
      const t = e.get(c.handle_id);
      if (null == t) throw new Error("Sky drag handle has not been started");
      if (t.starting) throw new Error("Sky drag handle is still starting");
      try {
        if ("drag_move" === c.type) return yield t.handle.move_to(c.point);
        yield t.handle.end(), e.get(c.handle_id) === t && e.delete(c.handle_id);
      } catch (r) {
        throw "windows_desktop" === y.target && e.get(c.handle_id) === t && e.delete(c.handle_id), r;
      }
    }
  });
}
function u(e) {
  return {
    filepath: e.filepath,
    data_url: e.data_url
  };
}
export { handleRpc };
