// C18: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/setup_browser.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { bind_tab as o } from "./bind_tab.js";
function n(n) {
  var e;
  const i = globalThis.nodeRepl,
    r = null === (e = null == i ? void 0 : i.env) || void 0 === e ? void 0 : e.CUA_REPL_BROWSER_ENV;
  if (void 0 !== r && "codex-app" !== r && "training" !== r && "cloud" !== r && "orbit" !== r) throw new Error("Invalid CUA_REPL_BROWSER_ENV");
  const t = ["tab-claiming-chrome", "tab-mentions-iab"];
  return n.exclude_browser_confirmations && t.push("confirmations"), n.setupBrowserRuntime({
    decorateTab: o,
    environment: r,
    undocumentedApiMembers: ["Tab.ax"],
    excludedDocumentation: t
  });
}
export { n as setup_browser };
