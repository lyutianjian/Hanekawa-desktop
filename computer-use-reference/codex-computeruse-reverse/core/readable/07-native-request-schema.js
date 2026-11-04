// C07: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/07-native-request-schema.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { MacNativePipeTransport } from "./native-pipe.js";
export { SkyComputerUseError, SkyComputerUseTransportError } from "./errors.js";
const POLICY_REQUEST = "ComputerUseIPCAppPolicyRequest",
  START_AUDIO_REQUEST = "ComputerUseIPCStartAudioRecordingRequest",
  STOP_AUDIO_REQUEST = "ComputerUseIPCStopAudioRecordingRequest",
  GET_SKYSHOT_REQUEST = "ComputerUseIPCAppGetSkyshotRequest",
  LIST_APPS_REQUEST = "ComputerUseIPCListAppsRequest",
  PERFORM_ACTION_REQUEST = "ComputerUseIPCAppPerformActionRequest",
  START_APP_REQUEST = "ComputerUseIPCAppStartRequest";
class MacComputerUseClient {
  constructor(e = {}) {
    var t, r;
    this.transports = new Map(), this.apiVersion = null !== (t = e.apiVersion) && void 0 !== t ? t : "CodexComputerUseIPC-5", this.codexMetadata = e.codexMetadata, this.timeoutSeconds = null !== (r = e.timeoutSeconds) && void 0 !== r ? r : 120;
  }
  listApps(e = {}) {
    return this.request(LIST_APPS_REQUEST, {}, e);
  }
  startAudioRecording(e, t = {}) {
    return this.request(START_AUDIO_REQUEST, e, t);
  }
  stopAudioRecording(e = {}) {
    return this.request(STOP_AUDIO_REQUEST, {}, e);
  }
  getAppPolicy(e, t = {}) {
    return this.request(POLICY_REQUEST, policyInput(e), t);
  }
  startApp(e, t = {}) {
    return this.request(START_APP_REQUEST, policyInput(e), t);
  }
  getAppState(e, t = {}) {
    return this.request(GET_SKYSHOT_REQUEST, function (e) {
      return "string" == typeof e ? appInput(e) : Object.assign(Object.assign({}, appInput(e.app)), {
        disableDiff: e.disableDiff
      });
    }(e), t);
  }
  click(e, t = {}) {
    if (void 0 !== e.duration && !Number.isFinite(e.duration)) throw new TypeError("duration must be a finite number");
    const r = void 0 === e.clickCount ? 1 : e.clickCount,
      o = void 0 === e.mouseButton ? "left" : e.mouseButton;
    return this.performAction(e.app, {
      click: {
        at: actionLocation({
          elementIndex: e.elementIndex,
          x: e.x,
          y: e.y
        }),
        clickCount: r,
        key: e.key,
        duration: e.duration,
        mouseButton: mouseButton(o)
      }
    }, t);
  }
  drag(e, t = {}) {
    return this.performAction(e.app, {
      drag: {
        from: point({
          x: e.fromX,
          y: e.fromY
        }, "from"),
        to: point({
          x: e.toX,
          y: e.toY
        }, "to")
      }
    }, t);
  }
  paste(e, t = {}) {
    return this.performAction(e.app, {
      paste: {
        text: e.text,
        format: e.format
      }
    }, t);
  }
  performSecondaryAction(e, t = {}) {
    return this.performAction(e.app, {
      performSecondaryAction: {
        action: e.action,
        elementID: elementId(e.elementIndex)
      }
    }, t);
  }
  pressKey(e, t = {}) {
    if ("" === e.key.trim()) throw new TypeError("key is required");
    if (void 0 !== e.duration && !Number.isFinite(e.duration)) throw new TypeError("duration must be a finite number");
    return this.performAction(e.app, {
      pressKey: {
        _0: e.key,
        duration: e.duration
      }
    }, t);
  }
  scroll(e, t = {}) {
    const r = void 0 === e.pages ? 1 : e.pages;
    if (!Number.isFinite(r) || r <= 0) throw new TypeError("pages must be a finite number > 0");
    return this.performAction(e.app, {
      scroll: {
        at: actionLocation({
          elementIndex: e.elementIndex,
          x: e.x,
          y: e.y
        }),
        direction: scrollDirection(e.direction),
        pages: r
      }
    }, t);
  }
  setValue(e, t = {}) {
    return this.performAction(e.app, {
      setValue: {
        elementID: elementId(e.elementIndex),
        value: e.value
      }
    }, t);
  }
  selectText(e, t = {}) {
    const r = void 0 === e.selection ? "text" : e.selection;
    return this.performAction(e.app, {
      selectText: {
        elementID: elementId(e.elementIndex),
        text: e.text,
        prefix: e.prefix,
        suffix: e.suffix,
        selection: r
      }
    }, t);
  }
  typeText(e, t = {}) {
    return this.performAction(e.app, {
      type: {
        _0: e.text
      }
    }, t);
  }
  performAction(e, t, r) {
    return this.request(PERFORM_ACTION_REQUEST, Object.assign(Object.assign({}, appInput(e)), {
      action: t
    }), r);
  }
  request(t, r, o) {
    return __awaiter(this, void 0, void 0, function* () {
      var e, n;
      const i = null !== (e = o.apiVersion) && void 0 !== e ? e : this.apiVersion;
      return (yield this.getTransport(i)).request({
        requestType: t,
        request: stripUndefined(r),
        timeoutSeconds: null !== (n = o.timeoutSeconds) && void 0 !== n ? n : this.timeoutSeconds,
        codexMetadata: resolveMetadata(o, this.codexMetadata)
      });
    });
  }
  getTransport(t) {
    return __awaiter(this, void 0, void 0, function* () {
      for (;;) {
        const e = this.transport(t);
        try {
          const r = yield e;
          if (!r.isClosed) return r;
          this.transports.get(t) === e && this.transports.delete(t);
        } catch (r) {
          throw this.transports.get(t) === e && this.transports.delete(t), r;
        }
      }
    });
  }
  transport(e) {
    let r = this.transports.get(e);
    return null == r && (r = MacNativePipeTransport.create(e), this.transports.set(e, r)), r;
  }
}
const defaultClient = new MacComputerUseClient();
function currentTurnMetadata() {
  var e, t;
  return null === (t = null === (e = globalThis.nodeRepl) || void 0 === e ? void 0 : e.requestMeta) || void 0 === t ? void 0 : t["x-codex-turn-metadata"];
}
function resolveMetadata(e, t) {
  return void 0 !== e.codexMetadata ? e.codexMetadata : void 0 !== t ? t : currentTurnMetadata();
}
function policyInput(e) {
  return appInput("string" == typeof e ? e : e.app);
}
function appInput(e) {
  if (null == e || "" === e.trim()) throw new TypeError("app is required");
  return {
    app: e
  };
}
function actionLocation(e) {
  return null == e.elementIndex ? {
    coordinate: {
      _0: point({
        x: e.x,
        y: e.y
      }, "coordinate")
    }
  } : {
    elementID: {
      _0: elementId(e.elementIndex)
    }
  };
}
function point(e, t) {
  if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) throw new TypeError(`${t} must include finite x and y coordinates`);
  return [Number(e.x), Number(e.y)];
}
function elementId(e) {
  if (!Number.isInteger(e)) throw new TypeError("elementIndex must be an integer");
  return String(e);
}
function mouseButton(e) {
  if ("number" == typeof e) {
    if ([0, 1, 2].includes(e)) return e;
    throw new TypeError("mouseButton number must be 0, 1, or 2");
  }
  switch (e.trim().toLowerCase()) {
    case "l":
    case "left":
      return 0;
    case "r":
    case "right":
      return 1;
    case "m":
    case "middle":
      return 2;
    default:
      throw new TypeError("mouseButton must be left, right, middle, l, r, m, 0, 1, or 2");
  }
}
function scrollDirection(e) {
  switch (e.trim().toLowerCase()) {
    case "u":
    case "up":
      return "up";
    case "d":
    case "down":
      return "down";
    case "l":
    case "left":
      return "left";
    case "r":
    case "right":
      return "right";
    default:
      throw new TypeError("direction must be up, down, left, or right");
  }
}
function stripUndefined(e) {
  return Array.isArray(e) ? e.map(stripUndefined) : null == e || "object" != typeof e ? e : Object.fromEntries(Object.entries(e).filter(([, e]) => void 0 !== e).map(([e, t]) => [e, stripUndefined(t)]));
}
export { MacComputerUseClient, defaultClient as client };
