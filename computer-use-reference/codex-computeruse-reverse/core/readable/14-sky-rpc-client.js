// C14: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/14-sky-rpc-client.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { accessibility_tree } from "./targets/linux/accessibility_tree.js";
function create_drag_handle(e) {
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
function invoke(r, o, n) {
  return __awaiter(this, void 0, void 0, function* () {
    if ("function" != typeof (null == r ? void 0 : r.rpc)) throw new Error("Computer Use requires a trusted Node REPL Sky service");
    let e = yield r.rpc("sky", o);
    if ("execute" === o.type && "get_screenshot" === o.method && (e = e.map(i)), "execute" === o.type && "get_window_state" === o.method && "linux" === n) {
      const r = e;
      e = Object.assign(Object.assign({}, r), {
        ax_tree: accessibility_tree(r.ax_tree, r.focused_modal),
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
export { create_drag_handle, invoke };
