// C14: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/sky_service_rpc.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { __awaiter as e } from "../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { accessibility_tree as t } from "./targets/linux/accessibility_tree.js";
function r(e) {
  const t = crypto.randomUUID();
  return {
    start: r => e({
      type: "drag_start",
      handle_id: t,
      point: r
    }),
    move_to: r => e({
      type: "drag_move",
      handle_id: t,
      point: r
    }),
    end: () => e({
      type: "drag_end",
      handle_id: t
    })
  };
}
function o(r, o, n) {
  return e(this, void 0, void 0, function* () {
    if ("function" != typeof (null == r ? void 0 : r.rpc)) throw new Error("Computer Use requires a trusted Node REPL Sky service");
    let e = yield r.rpc("sky", o);
    if ("execute" === o.type && "get_screenshot" === o.method && (e = e.map(i)), "execute" === o.type && "get_window_state" === o.method && "linux" === n) {
      const r = e;
      e = Object.assign(Object.assign({}, r), {
        ax_tree: t(r.ax_tree, r.focused_modal),
        screenshots: r.screenshots.map(i)
      });
    }
    return "execute" === o.type && "stop_audio_recording" === o.method && (e = i(e)), null != e ? e : void 0;
  });
}
function i(e) {
  var t;
  return {
    filepath: e.filepath,
    data_url: e.data_url,
    bytes: Uint8Array.from(Buffer.from(null !== (t = e.data_url.split(",")[1]) && void 0 !== t ? t : "", "base64"))
  };
}
export { r as create_drag_handle, o as invoke };
