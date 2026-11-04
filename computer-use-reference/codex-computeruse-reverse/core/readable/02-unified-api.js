// C02: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/02-unified-api.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../oai_js/node_modules/tslib/tslib.es6.js";
import { UnreachableCaseError } from "../../../oai_js_core/src/UnreachableCaseError.js";
import { get_apps } from "../get_apps.js";
import { get_state } from "../get_state.js";
import { bind_linux_app } from "./bind_linux_app.js";
import { bind_mac_app } from "./bind_mac_app.js";
import { bind_windows_app } from "./bind_windows_app.js";
import { create_bootstrap_emitter } from "./create_bootstrap_emitter.js";
import { create_browser_api } from "./create_browser_api.js";
import { create_documentation } from "./create_documentation.js";
import { read_documentation } from "./read_documentation.js";
import { setup_browser } from "./setup_browser.js";
function create_tinysky_alt() {
  return __awaiter(this, arguments, void 0, function* (m = {}) {
    const l = create_documentation(read_documentation),
      _ = m.browser,
      b = l.exclude_browser_confirmations,
      [v, g] = yield Promise.all([w({
        browser: _,
        exclude_browser_confirmations: b
      }), f(m)]),
      y = create_bootstrap_emitter({
        documentation: l,
        target: void 0 === g ? "no-cua" : g.target
      });
    yield y.emit();
    const j = {
      rewriteDocumentation: y.rewrite_documentation,
      getState(i) {
        return __awaiter(this, void 0, void 0, function* () {
          const t = yield get_state({
            browsers: null == v ? void 0 : v.browsers,
            computer: g
          });
          return yield y.emit(t, i), t;
        });
      }
    };
    if (void 0 !== v) {
      const t = v.browsers;
      Reflect.set(globalThis, "agent", v), Object.assign(j, create_browser_api(t, y));
    }
    if (void 0 !== g) {
      Object.assign(j, {
        computer: g,
        listApps(i) {
          return __awaiter(this, void 0, void 0, function* () {
            const t = yield get_apps(g);
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
                  return __awaiter(this, void 0, void 0, function* () {
                    if ("string" != typeof i) throw new Error("macOS getApp requires an app name, path, or bundle ID.");
                    const t = yield g.get_app_state({
                        app: i,
                        disableDiff: !0
                      }),
                      e = bind_mac_app(g, t.app);
                    return yield y.emit(t.text), e;
                  });
                }
              };
            case "linux":
              return {
                getApp(i) {
                  return __awaiter(this, void 0, void 0, function* () {
                    const t = p(i, "linux"),
                      e = (yield g.list_windows()).find(i => i.id === t);
                    if (void 0 === e) throw new Error(`Window ${t} is unavailable.`);
                    const r = bind_linux_app(g, e),
                      n = yield r.getAXState({
                        disableDiffing: !0,
                        emit: !1
                      });
                    return yield y.emit(n), r;
                  });
                },
                listWindows(i) {
                  return __awaiter(this, void 0, void 0, function* () {
                    const t = yield g.list_windows();
                    return yield y.emit(t, i), t;
                  });
                }
              };
            case "windows":
              return {
                getApp(i) {
                  return __awaiter(this, void 0, void 0, function* () {
                    const t = p(i, "windows"),
                      e = yield g.get_window({
                        id: t
                      }),
                      r = bind_windows_app(g, e),
                      o = yield r.getAXState({
                        disableDiffing: !0,
                        emit: !1
                      });
                    return yield y.emit(o), r;
                  });
                },
                listWindows(i) {
                  return __awaiter(this, void 0, void 0, function* () {
                    const t = yield g.list_windows();
                    return yield y.emit(t, i), t;
                  });
                }
              };
            default:
              throw new UnreachableCaseError(r);
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
  return __awaiter(this, void 0, void 0, function* () {
    if (!1 === i.browser) return;
    const {
        setupBrowserRuntime: t
      } = yield import("../../../oai_js_browser/dist/skill/scripts/browser-client.js"),
      e = i.exclude_browser_confirmations;
    return setup_browser({
      setupBrowserRuntime: t,
      exclude_browser_confirmations: e
    });
  });
}
function f(i) {
  return __awaiter(this, void 0, void 0, function* () {
    if (!1 === i.computer) return;
    const {
      sky: t
    } = yield import("../../../../../project/cua/sky_js/src/index.js");
    return t;
  });
}
export { create_tinysky_alt };
