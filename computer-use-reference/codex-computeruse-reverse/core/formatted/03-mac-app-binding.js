// C03: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/bind_mac_app.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { __awaiter as e } from "../../../oai_js/node_modules/tslib/tslib.es6.js";
import { text as t, image as o } from "../core/display.js";
import { screenshot_bytes as n } from "../core/screenshot_bytes.js";
import { duration_seconds as i } from "./duration_seconds.js";
function r(r, l) {
  return {
    getAXState(o) {
      return e(this, void 0, void 0, function* () {
        const e = (yield r.get_app_state(s(l, o))).text;
        return yield t(e, o), e;
      });
    },
    getScreenshot(t) {
      return e(this, void 0, void 0, function* () {
        const e = yield r.get_app_state({
          app: l
        });
        if (null === e.screenshot) throw new Error(`Screenshot unavailable for ${l}.`);
        const i = yield n(e.screenshot.url);
        return yield o({
          bytes: i,
          options: t
        }), i;
      });
    },
    getAXStateAndScreenshot(i) {
      return e(this, void 0, void 0, function* () {
        const e = yield r.get_app_state(s(l, i)),
          d = e.text;
        if (yield t(d, i), null === e.screenshot) return {
          state: d
        };
        const u = yield n(e.screenshot.url);
        return yield o({
          bytes: u,
          options: i
        }), {
          state: d,
          screenshot: u
        };
      });
    },
    paste(e, t) {
      var o;
      const n = null !== (o = null == t ? void 0 : t.format) && void 0 !== o ? o : "text";
      return r.paste({
        app: l,
        text: e,
        format: n
      });
    },
    click(e, t) {
      const o = {
        app: l
      };
      return Array.isArray(e) ? (o.x = e[0], o.y = e[1]) : o.element_index = e, void 0 !== (null == t ? void 0 : t.mouseButton) && (o.mouse_button = t.mouseButton), void 0 !== (null == t ? void 0 : t.clickCount) && (o.click_count = t.clickCount), void 0 !== (null == t ? void 0 : t.key) && (o.key = t.key), void 0 !== (null == t ? void 0 : t.durationMs) && (o.duration = i(t.durationMs)), r.click(o);
    },
    drag(e, t) {
      const [o, n] = e,
        [i, s] = t;
      return r.drag({
        app: l,
        from_x: o,
        from_y: n,
        to_x: i,
        to_y: s
      });
    },
    pressKey(e, t) {
      const o = {
        app: l,
        key: e
      };
      return void 0 !== (null == t ? void 0 : t.durationMs) && (o.duration = i(t.durationMs)), r.press_key(o);
    },
    scroll(e, t, o) {
      if ("object" == typeof o) throw new Error("macOS scroll accepts pages, not pixels.");
      const n = {
        app: l,
        direction: t
      };
      return Array.isArray(e) ? (n.x = e[0], n.y = e[1]) : n.element_index = e, void 0 !== o && (n.pages = o), r.scroll(n);
    },
    selectText(e, t, o) {
      const n = {
        app: l,
        element_index: e,
        text: t
      };
      return void 0 !== (null == o ? void 0 : o.prefix) && (n.prefix = o.prefix), void 0 !== (null == o ? void 0 : o.suffix) && (n.suffix = o.suffix), void 0 !== (null == o ? void 0 : o.selectionType) && (n.selection_type = o.selectionType), r.select_text(n);
    },
    setValue: (e, t) => r.set_value({
      app: l,
      element_index: e,
      value: t
    }),
    typeText(e, t) {
      if (void 0 !== t) throw new Error("Typing into a specific element is only supported on Linux.");
      return r.type_text({
        app: l,
        text: e
      });
    },
    performSecondaryAction: (e, t) => r.perform_secondary_action({
      app: l,
      element_index: e,
      action: t
    })
  };
}
function s(e, t) {
  const o = {
    app: e
  };
  return void 0 !== (null == t ? void 0 : t.disableDiffing) && (o.disableDiff = t.disableDiffing), o;
}
export { r as bind_mac_app };
