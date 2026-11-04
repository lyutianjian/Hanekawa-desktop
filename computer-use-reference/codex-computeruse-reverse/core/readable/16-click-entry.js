// C16: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/16-click-entry.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { withComputerUsePolicy } from "./computer-use-policy.js";
import { getClient } from "./lazy-client.js";
function click(e) {
  return __awaiter(this, void 0, void 0, function* () {
    return withComputerUsePolicy("click", e, i => __awaiter(this, void 0, void 0, function* () {
      const o = yield getClient();
      yield o.click({
        app: i.app,
        clickCount: i.click_count,
        elementIndex: i.element_index,
        key: i.key,
        duration: i.duration,
        mouseButton: i.mouse_button,
        x: i.x,
        y: i.y
      });
    }));
  });
}
export { click };
