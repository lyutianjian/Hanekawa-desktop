// C06: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/06-app-policy-and-approval.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { logComputerUseToolCalled, logComputerUseApprovalRequested, logComputerUseApprovalResolved } from "./computer-use-telemetry.js";
import { SkyComputerUseError, ServerErrorCode } from "./errors.js";
import { getClient } from "./lazy-client.js";
const TOOL_SURFACE_META = "codex/toolSurface",
  CHROME_META = "codex/computerUseChrome";
function withComputerUsePolicy(t, n, a) {
  return __awaiter(this, void 0, void 0, function* () {
    setComputerUseResponseMeta(null);
    const s = freezePlainInput(n),
      c = requireElicitation(),
      l = startSpan("computer_use.policy", {
        "computer_use.target": "mac"
      });
    let u, _;
    try {
      const e = yield getClient();
      u = yield e.getAppPolicy(s.app), setComputerUseResponseMeta(u.target.bundleIdentifier), _ = function (e) {
        const {
          bundleIdentifier: t
        } = e.target;
        switch (e.decision) {
          case "allowed":
            return e.target;
          case "denied":
            throw new Error(`Computer Use is blocked from using the app '${t}' by your organization's policy.`);
          case "forbidden":
            throw new Error(`Computer Use is not allowed to use the app '${t}' for safety reasons.`);
        }
      }(u), endSpan(l, {
        attrs: {
          "computer_use.policy.result": "allowed"
        },
        status: "ok"
      });
    } catch (e) {
      const t = null != u && ("denied" === u.decision || "forbidden" === u.decision);
      throw endSpan(l, {
        attrs: {
          "computer_use.policy.result": t ? "blocked" : "error"
        },
        status: t ? "ok" : "error"
      }), e;
    }
    yield function (t, n, a) {
      return __awaiter(this, void 0, void 0, function* () {
        var e;
        const {
            target: i
          } = n,
          s = {
            bundleIdentifier: i.bundleIdentifier,
            toolName: a
          },
          c = new Date().toISOString(),
          l = () => logComputerUseApprovalRequested(Object.assign(Object.assign({}, s), {
            eventCreatedAt: c
          })),
          u = getToolCallId();
        let p;
        try {
          p = yield waitForElicitation("app", () => t({
            message: `Allow Computer Use to use "${i.displayName}"?`,
            meta: Object.assign(Object.assign(Object.assign({
              codex_approval_kind: "mcp_tool_call",
              connector_id: "computer-use",
              connector_name: "Computer Use",
              persist: n.allowPersistentApproval ? ["session", "always"] : ["session"],
              riskLevel: i.risk
            }, null == i.warningSubtitle ? {} : {
              subtitle: i.warningSubtitle
            }), null == u ? {} : {
              tool_call_id: u
            }), {
              tool_name: a,
              tool_params: {
                app: i.bundleIdentifier
              },
              tool_params_display: [{
                name: "app",
                display_name: "App",
                value: i.displayName
              }]
            })
          }));
        } catch (e) {
          throw l(), e;
        }
        if (!function (e) {
          return null != e.content && "object" == typeof e.content && "computer-use-persisted-state" === e.content.source;
        }(p)) {
          l();
          const t = function (e) {
            switch (e) {
              case "accept":
                return "accepted";
              case "cancel":
                return "canceled";
              case "decline":
                return "declined";
              default:
                return;
            }
          }(p.action);
          null != t && logComputerUseApprovalResolved(Object.assign(Object.assign(Object.assign({}, s), {
            approvalResult: t
          }), "accepted" === t ? {
            approvalPersistence: "always" === (null === (e = p._meta) || void 0 === e ? void 0 : e.persist) ? "always" : "session"
          } : {}));
        }
        if ("accept" !== p.action) throw new Error(`Computer Use was not approved to use ${i.displayName}`);
      });
    }(c, u, t);
    const h = freezePlainInput(s, _.appPath);
    return withComputerUseToolTelemetry(t, _.bundleIdentifier, () => a(h));
  });
}
function requestComputerAudioApproval() {
  return __awaiter(this, void 0, void 0, function* () {
    const e = requireElicitation(),
      t = getToolCallId();
    if ("accept" !== (yield waitForElicitation("audio", () => e({
      message: "Allow Computer Use to record computer audio?",
      meta: Object.assign(Object.assign({
        codex_approval_kind: "mcp_tool_call",
        codex_request_type: "approval_request",
        connector_id: "computer-use",
        connector_name: "Computer Use",
        persist: ["session"],
        riskLevel: "high"
      }, null == t ? {} : {
        tool_call_id: t
      }), {
        tool_name: "start_audio_recording",
        tool_params: {},
        tool_params_display: []
      })
    }))).action) throw new Error("Computer Use was not approved to record computer audio");
  });
}
function withComputerUseToolTelemetry(o, r, i) {
  return __awaiter(this, void 0, void 0, function* () {
    const e = performance.now(),
      s = startSpan("computer_use.native.execute", {
        "computer_use.target": "mac"
      });
    let c = "completed";
    try {
      return yield i();
    } catch (e) {
      throw c = e instanceof SkyComputerUseError && (e.code === ServerErrorCode.userStoppedSession || e.code === ServerErrorCode.userIntervened) ? "cancelled" : "failed", e;
    } finally {
      endSpan(s, {
        attrs: {
          "computer_use.terminal_status": c
        },
        status: "failed" === c ? "error" : "ok"
      }), logComputerUseToolCalled({
        bundleIdentifier: r,
        durationMs: Math.min(2147483647, Math.max(0, Math.round(performance.now() - e))),
        terminalStatus: c,
        toolName: o
      });
    }
  });
}
function setComputerUseResponseMeta(e) {
  var t;
  const o = globalThis.nodeRepl;
  null === (t = null == o ? void 0 : o.setResponseMeta) || void 0 === t || t.call(o, Object.assign({
    [TOOL_SURFACE_META]: {
      app: null == e ? null : {
        appId: e,
        kind: "appId"
      },
      kind: "computerUse"
    }
  }, "com.google.Chrome" === e ? {
    [CHROME_META]: !0
  } : {}));
}
function waitForElicitation(t, o) {
  return __awaiter(this, void 0, void 0, function* () {
    const e = startSpan("computer_use.elicitation.wait", {
      "computer_use.approval.kind": t
    });
    try {
      const t = yield o(),
        r = "accept" === t.action || "decline" === t.action || "cancel" === t.action ? t.action : "invalid_response";
      return endSpan(e, {
        attrs: {
          "computer_use.approval.outcome": r
        },
        status: "invalid_response" === r ? "error" : "ok"
      }), t;
    } catch (t) {
      const o = t instanceof Error && "TimeoutError" === t.name ? "timed_out" : t instanceof Error && "AbortError" === t.name ? "cancel" : "invalid_response";
      throw endSpan(e, {
        attrs: {
          "computer_use.approval.outcome": o
        },
        status: "cancel" === o ? "ok" : "error"
      }), t;
    }
  });
}
function startSpan(e, t) {
  var o, r;
  try {
    return null === (r = null === (o = getNodeRepl()) || void 0 === o ? void 0 : o.telemetry) || void 0 === r ? void 0 : r.startSpan(e, t);
  } catch (e) {
    return;
  }
}
function endSpan(e, t) {
  try {
    null == e || e.end(t);
  } catch (e) {}
}
function getNodeRepl() {
  return globalThis.nodeRepl;
}
function getToolCallId() {
  var e;
  const t = getNodeRepl();
  let o = null === (e = null == t ? void 0 : t.requestMeta) || void 0 === e ? void 0 : e["x-codex-turn-metadata"];
  if ("string" == typeof o) try {
    o = JSON.parse(o);
  } catch (e) {
    return;
  }
  if (null != o && "object" == typeof o && !Array.isArray(o)) for (const e of ["call_id", "item_id"]) {
    const t = o[e];
    if ("string" == typeof t && "" !== t.trim()) return t.trim();
  }
}
function freezePlainInput(e, t) {
  if ("object" != typeof e || null == e) throw new Error("Computer Use app approval requires an object input");
  const o = Object.getOwnPropertyDescriptors(e),
    r = o.app;
  if (null == r || !("value" in r)) throw new Error("Computer Use app approval requires app to be a plain data property");
  const n = r.value;
  if ("string" != typeof n || "" === n.trim()) throw new Error("Computer Use app approval requires a non-empty app");
  const a = {};
  for (const [e, r] of Object.entries(o)) {
    if (!("value" in r)) throw new Error(`Computer Use app approval requires ${e} to be a plain data property`);
    Object.defineProperty(a, e, {
      configurable: !1,
      enumerable: r.enumerable,
      value: "app" === e ? null != t ? t : n : r.value,
      writable: !1
    });
  }
  return Object.freeze(a);
}
function requireElicitation() {
  const e = getNodeRepl(),
    t = null == e ? void 0 : e.createElicitation;
  if ("function" != typeof t) throw new Error("Computer Use requires nodeRepl.createElicitation");
  return t;
}
export { requestComputerAudioApproval, setComputerUseResponseMeta, withComputerUsePolicy, withComputerUseToolTelemetry };
