// C18: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/18-browser-bootstrap.js. Relative imports are intentionally not vendored.
import { bind_tab } from "./bind_tab.js";
function setup_browser(n) {
  var e;
  const i = globalThis.nodeRepl,
    r = null === (e = null == i ? void 0 : i.env) || void 0 === e ? void 0 : e.CUA_REPL_BROWSER_ENV;
  if (void 0 !== r && "codex-app" !== r && "training" !== r && "cloud" !== r && "orbit" !== r) throw new Error("Invalid CUA_REPL_BROWSER_ENV");
  const t = ["tab-claiming-chrome", "tab-mentions-iab"];
  return n.exclude_browser_confirmations && t.push("confirmations"), n.setupBrowserRuntime({
    decorateTab: bind_tab,
    environment: r,
    undocumentedApiMembers: ["Tab.ax"],
    excludedDocumentation: t
  });
}
export { setup_browser };
