// C11: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/bind_tab.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { __rest as t, __awaiter as e } from "../../../oai_js/node_modules/tslib/tslib.es6.js";
import { text as o, image as i } from "../core/display.js";
import { duration_seconds as r } from "./duration_seconds.js";
function n(n) {
  return Object.assign(n, {
    getAXState(t) {
      return e(this, void 0, void 0, function* () {
        const e = void 0 === n.ax ? yield s(n) : yield n.ax.get("state", a(t));
        return yield o(e, t), e;
      });
    },
    getScreenshot(t) {
      return e(this, void 0, void 0, function* () {
        const e = void 0 === n.ax ? yield d(n) : yield n.ax.get("screenshot");
        return yield i({
          bytes: e,
          options: t
        }), e;
      });
    },
    getAXStateAndScreenshot(t) {
      return e(this, void 0, void 0, function* () {
        const e = void 0 === n.ax ? yield Promise.all([s(n), d(n)]).then(([t, e]) => ({
          state: t,
          screenshot: e
        })) : yield n.ax.get("both", a(t));
        if (yield o(e.state, t), void 0 !== e.screenshot) {
          const o = e.screenshot;
          yield i({
            bytes: o,
            options: t
          });
        }
        return e;
      });
    },
    paste(t, o, i) {
      return e(this, void 0, void 0, function* () {
        c(t), yield u(n).paste(t, o, i);
      });
    },
    click(e, o) {
      if (void 0 === (null == o ? void 0 : o.durationMs)) return u(n).click(e, o);
      const {
          durationMs: i
        } = o,
        s = t(o, ["durationMs"]);
      return u(n).click(e, Object.assign(Object.assign({}, s), {
        duration: r(i)
      }));
    },
    drag: (t, e) => u(n).drag(t, e),
    pressKey(t, e, o) {
      c(t);
      const i = null == o ? void 0 : o.durationMs,
        s = void 0 === i ? void 0 : {
          duration: r(i)
        };
      return u(n).pressKey(t, e, s);
    },
    scroll: (t, e, o) => u(n).scroll(t, e, o),
    selectText: (t, e, o) => u(n).selectText(t, e, o),
    setValue: (t, e) => u(n).setValue(t, e),
    typeText: (t, e) => (c(t), u(n).typeText(t, e)),
    performSecondaryAction: (t, e) => u(n).performSecondaryAction(t, e)
  });
}
function s(t) {
  return e(this, void 0, void 0, function* () {
    var e;
    if (void 0 === (null === (e = t.playwright) || void 0 === e ? void 0 : e.domSnapshot)) throw new Error(`Tab ${t.id} does not support DOM snapshots.`);
    return t.playwright.domSnapshot();
  });
}
function d(t) {
  return e(this, void 0, void 0, function* () {
    if (void 0 === t.screenshot) throw new Error(`Tab ${t.id} does not support screenshots.`);
    return t.screenshot();
  });
}
function u(t) {
  if (void 0 === t.ax) throw new Error("This tab does not support accessibility input. Use its Playwright API.");
  return t.ax;
}
function c(t) {
  if (null !== t && (!Number.isInteger(t) || t < 0)) throw new Error("Browser input requires an element index from the latest AX snapshot, or null to use current focus.");
}
function a(t) {
  const e = null == t ? void 0 : t.disableDiffing;
  if (void 0 !== e) return {
    disableDiffing: e
  };
}
export { n as bind_tab };
