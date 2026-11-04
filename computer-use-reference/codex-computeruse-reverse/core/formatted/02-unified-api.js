// C02: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { __awaiter as t } from "../../../oai_js/node_modules/tslib/tslib.es6.js";
import { UnreachableCaseError as i } from "../../../oai_js_core/src/UnreachableCaseError.js";
import { get_apps as e } from "../get_apps.js";
import { get_state as r } from "../get_state.js";
import { bind_linux_app as o } from "./bind_linux_app.js";
import { bind_mac_app as n } from "./bind_mac_app.js";
import { bind_windows_app as s } from "./bind_windows_app.js";
import { create_bootstrap_emitter as d } from "./create_bootstrap_emitter.js";
import { create_browser_api as u } from "./create_browser_api.js";
import { create_documentation as c } from "./create_documentation.js";
import { read_documentation as a } from "./read_documentation.js";
import { setup_browser as m } from "./setup_browser.js";
function l() {
  return t(this, arguments, void 0, function* (m = {}) {
    const l = c(a),
      _ = m.browser,
      b = l.exclude_browser_confirmations,
      [v, g] = yield Promise.all([w({
        browser: _,
        exclude_browser_confirmations: b
      }), f(m)]),
      y = d({
        documentation: l,
        target: void 0 === g ? "no-cua" : g.target
      });
    yield y.emit();
    const j = {
      rewriteDocumentation: y.rewrite_documentation,
      getState(i) {
        return t(this, void 0, void 0, function* () {
          const t = yield r({
            browsers: null == v ? void 0 : v.browsers,
            computer: g
          });
          return yield y.emit(t, i), t;
        });
      }
    };
    if (void 0 !== v) {
      const t = v.browsers;
      Reflect.set(globalThis, "agent", v), Object.assign(j, u(t, y));
    }
    if (void 0 !== g) {
      Object.assign(j, {
        computer: g,
        listApps(i) {
          return t(this, void 0, void 0, function* () {
            const t = yield e(g);
            return yield y.emit(t, i), t;
          });
        }
      });
      const r = g.target,
        d = (() => {
          switch (r) {
            case "mac":
              return {
                getApp(i) {
                  return t(this, void 0, void 0, function* () {
                    if ("string" != typeof i) throw new Error("macOS getApp requires an app name, path, or bundle ID.");
                    const t = yield g.get_app_state({
                        app: i,
                        disableDiff: !0
                      }),
                      e = n(g, t.app);
                    return yield y.emit(t.text), e;
                  });
                }
              };
            case "linux":
              return {
                getApp(i) {
                  return t(this, void 0, void 0, function* () {
                    const t = p(i, "linux"),
                      e = (yield g.list_windows()).find(i => i.id === t);
                    if (void 0 === e) throw new Error(`Window ${t} is unavailable.`);
                    const r = o(g, e),
                      n = yield r.getAXState({
                        disableDiffing: !0,
                        emit: !1
                      });
                    return yield y.emit(n), r;
                  });
                },
                listWindows(i) {
                  return t(this, void 0, void 0, function* () {
                    const t = yield g.list_windows();
                    return yield y.emit(t, i), t;
                  });
                }
              };
            case "windows":
              return {
                getApp(i) {
                  return t(this, void 0, void 0, function* () {
                    const t = p(i, "windows"),
                      e = yield g.get_window({
                        id: t
                      }),
                      r = s(g, e),
                      o = yield r.getAXState({
                        disableDiffing: !0,
                        emit: !1
                      });
                    return yield y.emit(o), r;
                  });
                },
                listWindows(i) {
                  return t(this, void 0, void 0, function* () {
                    const t = yield g.list_windows();
                    return yield y.emit(t, i), t;
                  });
                }
              };
            default:
              throw new i(r);
          }
        })();
      Object.assign(j, d);
    }
    return j;
  });
}
function p(t, i) {
  if ("object" != typeof t || null === t || !Number.isSafeInteger(t.windowId) || t.windowId <= 0) throw new Error(`${i} getApp requires { windowId } from listApps() or listWindows().`);
  return t.windowId;
}
function w(i) {
  return t(this, void 0, void 0, function* () {
    if (!1 === i.browser) return;
    const {
        setupBrowserRuntime: t
      } = yield import("../../../oai_js_browser/dist/skill/scripts/browser-client.js"),
      e = i.exclude_browser_confirmations;
    return m({
      setupBrowserRuntime: t,
      exclude_browser_confirmations: e
    });
  });
}
function f(i) {
  return t(this, void 0, void 0, function* () {
    if (!1 === i.computer) return;
    const {
      sky: t
    } = yield import("../../../../../project/cua/sky_js/src/index.js");
    return t;
  });
}
export { l as create_tinysky_alt };
