// C13: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/13-documentation-emitter.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../oai_js/node_modules/tslib/tslib.es6.js";
function create_bootstrap_emitter(o) {
  const t = new Map();
  let i, n;
  const r = new Map();
  let d = !1,
    l = Promise.resolve();
  function s(e) {
    var o;
    const t = globalThis.nodeRepl,
      i = null === (o = null == t ? void 0 : t.write) || void 0 === o ? void 0 : o.bind(t);
    if (void 0 === i) return Promise.resolve();
    const n = null == t ? void 0 : t.requestMeta,
      r = l.then(() => e(i, n));
    return l = r.catch(() => {}), r;
  }
  return {
    load_browser_documentation: function (o) {
      return __awaiter(this, void 0, void 0, function* () {
        const e = globalThis.nodeRepl;
        if (void 0 !== (null == e ? void 0 : e.write)) {
          let e = t.get(o.browserId);
          void 0 === e && (e = o.documentation().catch(e => {
            throw t.delete(o.browserId), e;
          }), t.set(o.browserId, e)), yield e;
        }
      });
    },
    emit: function (l = "", u) {
      return s((s, c) => __awaiter(this, void 0, void 0, function* () {
        const e = null == u ? void 0 : u.browser;
        let a = "",
          v = "",
          f = "";
        if (void 0 === i) {
          a = yield o.documentation.read_core(o.target);
          const e = globalThis.nodeRepl;
          if ("function" == typeof (null == e ? void 0 : e.emitAudio)) {
            a = `${a}\n${yield o.documentation.read("audio")}`;
          }
        }
        if (void 0 !== e) {
          const i = yield t.get(e.browserId);
          d || (v = yield o.documentation.read("other-browser-apis")), void 0 === i || r.has(e.browserId) || (f = i);
        }
        let b = "";
        !1 !== (null == u ? void 0 : u.emit) && (b = "string" == typeof l ? l : JSON.stringify(l)), "" !== a && (yield s(a, "cua.core"), n = c), null != i || (i = a);
        const w = [v, f].filter(e => "" !== e).join("\n\n");
        void 0 !== e && "" !== w && (yield s(w, `cua.browser.${e.browserId}`), r.set(e.browserId, {
          text: w,
          request_meta: c
        })), void 0 !== e && (d = !0), "" !== b && (yield s(b, "cua.state"));
      }));
    },
    rewrite_documentation: function () {
      return s((o, t) => __awaiter(this, void 0, void 0, function* () {
        !i || null != t && t === n || (yield o(i, "cua.core"), n = t);
        for (const [e, i] of r) null != t && t === i.request_meta || (yield o(i.text, `cua.browser.${e}`), i.request_meta = t);
      }));
    }
  };
}
export { create_bootstrap_emitter };
