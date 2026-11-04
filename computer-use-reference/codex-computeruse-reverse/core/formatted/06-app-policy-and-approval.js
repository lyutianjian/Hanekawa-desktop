// C06: installed source, /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/computer-use-policy.js
// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.
import { __awaiter as e } from "../../../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { logComputerUseToolCalled as t, logComputerUseApprovalRequested as o, logComputerUseApprovalResolved as r } from "./computer-use-telemetry.js";
import { SkyComputerUseError as n, ServerErrorCode as a } from "./errors.js";
import { getClient as i } from "./lazy-client.js";
const s = "codex/toolSurface",
  c = "codex/computerUseChrome";
function l(t, n, a) {
  return e(this, void 0, void 0, function* () {
    d(null);
    const s = b(n),
      c = w(),
      l = f("computer_use.policy", {
        "computer_use.target": "mac"
      });
    let u, _;
    try {
      const e = yield i();
      u = yield e.getAppPolicy(s.app), d(u.target.bundleIdentifier), _ = function (e) {
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
      }(u), v(l, {
        attrs: {
          "computer_use.policy.result": "allowed"
        },
        status: "ok"
      });
    } catch (e) {
      const t = null != u && ("denied" === u.decision || "forbidden" === u.decision);
      throw v(l, {
        attrs: {
          "computer_use.policy.result": t ? "blocked" : "error"
        },
        status: t ? "ok" : "error"
      }), e;
    }
    yield function (t, n, a) {
      return e(this, void 0, void 0, function* () {
        var e;
        const {
            target: i
          } = n,
          s = {
            bundleIdentifier: i.bundleIdentifier,
            toolName: a
          },
          c = new Date().toISOString(),
          l = () => o(Object.assign(Object.assign({}, s), {
            eventCreatedAt: c
          })),
          u = y();
        let p;
        try {
          p = yield m("app", () => t({
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
          null != t && r(Object.assign(Object.assign(Object.assign({}, s), {
            approvalResult: t
          }), "accepted" === t ? {
            approvalPersistence: "always" === (null === (e = p._meta) || void 0 === e ? void 0 : e.persist) ? "always" : "session"
          } : {}));
        }
        if ("accept" !== p.action) throw new Error(`Computer Use was not approved to use ${i.displayName}`);
      });
    }(c, u, t);
    const h = b(s, _.appPath);
    return p(t, _.bundleIdentifier, () => a(h));
  });
}
function u() {
  return e(this, void 0, void 0, function* () {
    const e = w(),
      t = y();
    if ("accept" !== (yield m("audio", () => e({
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
function p(o, r, i) {
  return e(this, void 0, void 0, function* () {
    const e = performance.now(),
      s = f("computer_use.native.execute", {
        "computer_use.target": "mac"
      });
    let c = "completed";
    try {
      return yield i();
    } catch (e) {
      throw c = e instanceof n && (e.code === a.userStoppedSession || e.code === a.userIntervened) ? "cancelled" : "failed", e;
    } finally {
      v(s, {
        attrs: {
          "computer_use.terminal_status": c
        },
        status: "failed" === c ? "error" : "ok"
      }), t({
        bundleIdentifier: r,
        durationMs: Math.min(2147483647, Math.max(0, Math.round(performance.now() - e))),
        terminalStatus: c,
        toolName: o
      });
    }
  });
}
function d(e) {
  var t;
  const o = globalThis.nodeRepl;
  null === (t = null == o ? void 0 : o.setResponseMeta) || void 0 === t || t.call(o, Object.assign({
    [s]: {
      app: null == e ? null : {
        appId: e,
        kind: "appId"
      },
      kind: "computerUse"
    }
  }, "com.google.Chrome" === e ? {
    [c]: !0
  } : {}));
}
function m(t, o) {
  return e(this, void 0, void 0, function* () {
    const e = f("computer_use.elicitation.wait", {
      "computer_use.approval.kind": t
    });
    try {
      const t = yield o(),
        r = "accept" === t.action || "decline" === t.action || "cancel" === t.action ? t.action : "invalid_response";
      return v(e, {
        attrs: {
          "computer_use.approval.outcome": r
        },
        status: "invalid_response" === r ? "error" : "ok"
      }), t;
    } catch (t) {
      const o = t instanceof Error && "TimeoutError" === t.name ? "timed_out" : t instanceof Error && "AbortError" === t.name ? "cancel" : "invalid_response";
      throw v(e, {
        attrs: {
          "computer_use.approval.outcome": o
        },
        status: "cancel" === o ? "ok" : "error"
      }), t;
    }
  });
}
function f(e, t) {
  var o, r;
  try {
    return null === (r = null === (o = _()) || void 0 === o ? void 0 : o.telemetry) || void 0 === r ? void 0 : r.startSpan(e, t);
  } catch (e) {
    return;
  }
}
function v(e, t) {
  try {
    null == e || e.end(t);
  } catch (e) {}
}
function _() {
  return globalThis.nodeRepl;
}
function y() {
  var e;
  const t = _();
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
function b(e, t) {
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
function w() {
  const e = _(),
    t = null == e ? void 0 : e.createElicitation;
  if ("function" != typeof t) throw new Error("Computer Use requires nodeRepl.createElicitation");
  return t;
}
export { u as requestComputerAudioApproval, d as setComputerUseResponseMeta, l as withComputerUsePolicy, p as withComputerUseToolTelemetry };
