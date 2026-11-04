// C15: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/15-observation-entry.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { withComputerUsePolicy } from "./computer-use-policy.js";
import { getClient } from "./lazy-client.js";
import { window_result } from "./window_result.js";
function get_app_state(s, p) {
  return __awaiter(this, void 0, void 0, function* () {
    return withComputerUsePolicy("get_app_state", s, t => __awaiter(this, void 0, void 0, function* () {
      const i = yield getClient();
      return window_result(t.app, yield i.getAppState({
        app: t.app,
        disableDiff: t.disableDiff
      }), p);
    }));
  });
}
export { get_app_state };
