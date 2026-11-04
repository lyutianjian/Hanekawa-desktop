// C08: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/08-native-pipe-transport.js. Relative imports are intentionally not vendored.
import { __awaiter, __classPrivateFieldGet, __classPrivateFieldSet } from "../../../../../../lib/js/oai_js/node_modules/tslib/tslib.es6.js";
import { Buffer } from "node:buffer";
import * as o from "node:fs";
import { homedir } from "node:os";
import s from "node:path";
import { SkyComputerUseTransportError, SkyComputerUseError, ServerErrorCode } from "./errors.js";
var privateMethods, apiVersionSlot, nextIdSlot, bufferSlot, pendingSlot, queueSlot, connectionSlot, sendRpc, receiveData, receiveResponse, failPending, closeConnection;
const MAX_FRAME_BYTES = 8388608,
  STARTUP_TIMEOUT_MS = 5e3;
class MacNativePipeTransport {
  static create(t) {
    return __awaiter(this, void 0, void 0, function* () {
      const n = requireNodeRepl().nativePipe;
      if (null == n || "function" != typeof n.createConnection) throw new SkyComputerUseTransportError("Sky Computer Use native pipe is unavailable");
      const a = null !== (l = nonEmptyString(null === (u = requireNodeRepl().env) || void 0 === u ? void 0 : u.SKY_CUA_SERVICE_NATIVE_PIPE_PATH)) && void 0 !== l ? l : s.join(homedir(), "Library", "Group Containers", "2DC432GLL2.com.openai.sky.CUAService", "IPC", "computeruse.sock");
      var u, l;
      try {
        return yield this.connect(n.createConnection, a, t, 250);
      } catch (i) {
        if (!(i instanceof PipeUnavailableError)) throw i;
        try {
          yield function (t) {
            return __awaiter(this, void 0, void 0, function* () {
              var e, n, i;
              const c = nonEmptyString(null === (e = t.env) || void 0 === e ? void 0 : e.NODE_REPL_HOST_SERVICES_PIPE_PATH);
              if (null != c) {
                const e = null === (n = t.nativePipe) || void 0 === n ? void 0 : n.createConnection;
                if ("function" != typeof e) throw new Error("Sky Computer Use requires nodeRepl.nativePipe support");
                const o = e(c);
                let i;
                try {
                  i = yield withTimeout(o, STARTUP_TIMEOUT_MS, "Sky Computer Use host service connection timed out");
                } catch (e) {
                  throw o.then(e => e.end(), () => {}), e;
                }
                try {
                  yield function (e) {
                    return new Promise((t, n) => {
                      const o = 0;
                      let i = Buffer.alloc(0),
                        s = !1;
                      const c = setTimeout(() => a(new Error("Sky Computer Use host service ensure timed out")), STARTUP_TIMEOUT_MS),
                        a = r => {
                          s || (s = !0, clearTimeout(c), e.off("data", u), e.off("error", l), e.off("close", f), null == r ? t() : n(r));
                        },
                        u = e => {
                          try {
                            i = Buffer.concat([i, Buffer.from(e)]);
                            const t = decodeMessageFrames(i);
                            i = t.remainingData;
                            for (const e of t.messages) {
                              const t = JSON.parse(e);
                              if ("object" == typeof t && null != t && "id" in t && t.id === o) if ("error" in t) {
                                const e = t.error,
                                  n = "object" == typeof e && null != e && "message" in e && "string" == typeof e.message ? e.message : "Sky Computer Use host service ensure failed";
                                a(new Error(n));
                              } else "result" in t ? a() : a(new Error("Sky Computer Use host service returned an invalid response"));
                            }
                          } catch (e) {
                            a(asError(e));
                          }
                        },
                        l = e => a(e),
                        f = () => a(new Error("Sky Computer Use host service connection closed before response"));
                      e.on("data", u), e.on("error", l), e.on("close", f);
                      try {
                        e.write(encodeMessageFrame(JSON.stringify({
                          id: o,
                          jsonrpc: "2.0",
                          method: "ensureService",
                          params: {
                            service: "computer-use"
                          }
                        })));
                      } catch (e) {
                        a(asError(e));
                      }
                    });
                  }(i);
                } finally {
                  i.end();
                }
                return;
              }
              const a = null === (i = t.launchServices) || void 0 === i ? void 0 : i.openApplication;
              if ("function" != typeof a) throw new Error("Sky Computer Use requires nodeRepl.launchServices support");
              yield a(function (e) {
                const t = nonEmptyString(null == e ? void 0 : e.SKY_CUA_SERVICE_PATH);
                if (null != t) return {
                  applicationPath: t
                };
                const n = nonEmptyString(null == e ? void 0 : e.CODEX_HOME);
                if (null != n) {
                  const e = s.join(n, "computer-use", "Codex Computer Use.app");
                  if (o.existsSync(e)) return {
                    applicationPath: e
                  };
                }
                return {
                  bundleIdentifier: "com.openai.sky.CUAService"
                };
              }(t.env));
            });
          }(requireNodeRepl());
        } catch (e) {
          throw new SkyComputerUseTransportError("Sky Computer Use service startup request failed", {
            cause: e
          });
        }
        try {
          return yield this.connect(n.createConnection, a, t, 5e3);
        } catch (e) {
          throw new SkyComputerUseTransportError("Sky Computer Use native pipe startup failed", {
            cause: e
          });
        }
      }
    });
  }
  static connect(n, r, o, i) {
    return __awaiter(this, void 0, void 0, function* () {
      const e = Date.now() + i;
      let s;
      for (;;) {
        const i = e - Date.now();
        if (i <= 0) throw new PipeUnavailableError(s);
        let c;
        const f = n(r);
        try {
          c = yield withTimeout(f, i, "Sky Computer Use native pipe connection timed out");
        } catch (e) {
          f.then(e => e.end(), () => {}), s = e;
        }
        if (null != c) {
          const n = new MacNativePipeTransport(c, o);
          try {
            return yield n.ping(Math.min(1e3, Math.max(1, e - Date.now()))), n;
          } catch (e) {
            if (__classPrivateFieldGet(n, privateMethods, "m", closeConnection).call(n), e instanceof ApiVersionMismatchError || e instanceof SkyComputerUseError && e.code === ServerErrorCode.incompatibleClientVersion) throw e;
            s = e;
          }
        }
        if (Date.now() >= e) throw new PipeUnavailableError(s);
        yield sleep(100);
      }
    });
  }
  constructor(e, o) {
    privateMethods.add(this), apiVersionSlot.set(this, void 0), nextIdSlot.set(this, 1), bufferSlot.set(this, Buffer.alloc(0)), pendingSlot.set(this, new Map()), queueSlot.set(this, Promise.resolve()), connectionSlot.set(this, void 0), __classPrivateFieldSet(this, apiVersionSlot, o, "f"), __classPrivateFieldSet(this, connectionSlot, e, "f"), e.on("data", n => {
      try {
        __classPrivateFieldGet(this, privateMethods, "m", receiveData).call(this, n);
      } catch (n) {
        __classPrivateFieldGet(this, privateMethods, "m", failPending).call(this, asError(n)), e.end();
      }
    }), e.on("error", e => __classPrivateFieldGet(this, privateMethods, "m", failPending).call(this, e)), e.on("close", () => __classPrivateFieldGet(this, privateMethods, "m", failPending).call(this, new Error("Sky Computer Use native pipe closed before response")));
  }
  get isClosed() {
    return null == __classPrivateFieldGet(this, connectionSlot, "f");
  }
  request(r) {
    return __awaiter(this, void 0, void 0, function* () {
      const e = 1e3 * r.timeoutSeconds,
        o = __classPrivateFieldGet(this, queueSlot, "f").then(() => __classPrivateFieldGet(this, privateMethods, "m", sendRpc).call(this, "request", {
          clientApiVersion: __classPrivateFieldGet(this, apiVersionSlot, "f"),
          codexTurnMetadata: normalizeMetadata(r.codexMetadata),
          deadlineUnixMilliseconds: Date.now() + e,
          request: r.request,
          requestType: r.requestType
        }, e));
      return __classPrivateFieldSet(this, queueSlot, o.then(() => {}, () => {}), "f"), yield o;
    });
  }
  ping(n) {
    return __awaiter(this, void 0, void 0, function* () {
      const e = yield __classPrivateFieldGet(this, privateMethods, "m", sendRpc).call(this, "ping", {
        clientApiVersion: __classPrivateFieldGet(this, apiVersionSlot, "f")
      }, n);
      if (e.serverApiVersion !== __classPrivateFieldGet(this, apiVersionSlot, "f")) throw new ApiVersionMismatchError(`Sky Computer Use API version mismatch: client=${__classPrivateFieldGet(this, apiVersionSlot, "f")} server=${String(e.serverApiVersion)}`);
    });
  }
}
function decodeMessageFrames(e) {
  const t = [];
  let n = 0;
  for (; e.length - n >= 4;) {
    const r = e.readUInt32LE(n);
    if (r > MAX_FRAME_BYTES) throw new SkyComputerUseTransportError(`Sky Computer Use native pipe frame is too large: ${r}`);
    const o = 4 + r;
    if (e.length - n < o) break;
    t.push(e.subarray(n + 4, n + o).toString("utf8")), n += o;
  }
  return {
    messages: t,
    remainingData: e.subarray(n)
  };
}
function encodeMessageFrame(e) {
  const t = Buffer.from(e, "utf8");
  if (t.length > MAX_FRAME_BYTES) throw new SkyComputerUseTransportError(`Sky Computer Use native pipe frame is too large: ${t.length}`);
  const n = Buffer.alloc(4 + t.length);
  return n.writeUInt32LE(t.length, 0), t.copy(n, 4), n;
}
function normalizeMetadata(e) {
  return null == e || "object" == typeof e && !ArrayBuffer.isView(e) ? e : JSON.parse(Buffer.from(e).toString("utf8"));
}
function validateRpcResponse(e) {
  if ("object" != typeof e || null == e || !("id" in e) || "number" != typeof e.id || !("jsonrpc" in e) || "2.0" !== e.jsonrpc) throw new SkyComputerUseTransportError("Sky Computer Use returned an invalid JSON-RPC response");
  const t = Object.prototype.hasOwnProperty.call(e, "result");
  if (t === Object.prototype.hasOwnProperty.call(e, "error")) throw new SkyComputerUseTransportError("Sky Computer Use returned an invalid JSON-RPC response");
  if (t) return {
    id: e.id,
    jsonrpc: "2.0",
    result: Reflect.get(e, "result")
  };
  const n = Reflect.get(e, "error");
  if ("object" != typeof n || null == n || !("code" in n) || "number" != typeof n.code || !("message" in n) || "string" != typeof n.message) throw new SkyComputerUseTransportError("Sky Computer Use returned an invalid JSON-RPC response");
  return {
    error: {
      code: n.code,
      message: n.message
    },
    id: e.id,
    jsonrpc: "2.0"
  };
}
function requireNodeRepl() {
  const e = globalThis.nodeRepl;
  if (null == e) throw new SkyComputerUseTransportError("Sky Computer Use requires the trusted nodeRepl runtime");
  return e;
}
function nonEmptyString(e) {
  return "string" == typeof e && "" !== e.trim() ? e.trim() : void 0;
}
function asError(e) {
  return e instanceof Error ? e : new Error(String(e));
}
function sleep(e) {
  return new Promise(t => setTimeout(t, e));
}
function withTimeout(t, n, r) {
  return __awaiter(this, void 0, void 0, function* () {
    let e;
    try {
      return yield Promise.race([t, new Promise((t, o) => {
        e = setTimeout(() => o(new Error(r)), n);
      })]);
    } finally {
      null != e && clearTimeout(e);
    }
  });
}
apiVersionSlot = new WeakMap(), nextIdSlot = new WeakMap(), bufferSlot = new WeakMap(), pendingSlot = new WeakMap(), queueSlot = new WeakMap(), connectionSlot = new WeakMap(), privateMethods = new WeakSet(), sendRpc = function (e, r, o) {
  var i, s;
  const a = __classPrivateFieldGet(this, connectionSlot, "f");
  if (null == a) throw new SkyComputerUseTransportError("Sky Computer Use native pipe is closed");
  const u = (__classPrivateFieldSet(this, nextIdSlot, (s = __classPrivateFieldGet(this, nextIdSlot, "f"), i = s++, s), "f"), i);
  return new Promise((n, i) => {
    __classPrivateFieldGet(this, pendingSlot, "f").set(u, {
      reject: i,
      resolve: n,
      timeout: setTimeout(() => {
        __classPrivateFieldGet(this, privateMethods, "m", failPending).call(this, new SkyComputerUseTransportError(`Sky Computer Use ${e} timed out`)), a.end();
      }, o)
    });
    try {
      a.write(encodeMessageFrame(JSON.stringify({
        id: u,
        jsonrpc: "2.0",
        method: e,
        params: r
      })));
    } catch (e) {
      const n = __classPrivateFieldGet(this, pendingSlot, "f").get(u);
      null != n && (__classPrivateFieldGet(this, pendingSlot, "f").delete(u), clearTimeout(n.timeout)), i(asError(e));
    }
  });
}, receiveData = function (e) {
  __classPrivateFieldSet(this, bufferSlot, Buffer.concat([__classPrivateFieldGet(this, bufferSlot, "f"), Buffer.from(e)]), "f");
  const o = decodeMessageFrames(__classPrivateFieldGet(this, bufferSlot, "f"));
  __classPrivateFieldSet(this, bufferSlot, o.remainingData, "f");
  for (const e of o.messages) __classPrivateFieldGet(this, privateMethods, "m", receiveResponse).call(this, validateRpcResponse(JSON.parse(e)));
}, receiveResponse = function (e) {
  const n = e.id,
    r = __classPrivateFieldGet(this, pendingSlot, "f").get(n);
  null != r && (__classPrivateFieldGet(this, pendingSlot, "f").delete(n), clearTimeout(r.timeout), "error" in e ? r.reject(new SkyComputerUseError({
    code: e.error.code,
    message: e.error.message,
    request: null,
    requestType: "jsonRPC"
  })) : r.resolve(e.result));
}, failPending = function (e) {
  if (null != __classPrivateFieldGet(this, connectionSlot, "f")) {
    __classPrivateFieldSet(this, connectionSlot, null, "f");
    for (const n of __classPrivateFieldGet(this, pendingSlot, "f").values()) clearTimeout(n.timeout), n.reject(e);
    __classPrivateFieldGet(this, pendingSlot, "f").clear();
  }
}, closeConnection = function () {
  const e = __classPrivateFieldGet(this, connectionSlot, "f");
  __classPrivateFieldSet(this, connectionSlot, null, "f"), null == e || e.end();
};
class PipeUnavailableError extends Error {
  constructor(e) {
    var t;
    super(`Sky Computer Use native pipe is unavailable: ${t = e, t instanceof Error ? t.message : String(t)}`);
  }
}
class ApiVersionMismatchError extends SkyComputerUseTransportError {}
export { MacNativePipeTransport, decodeMessageFrames, encodeMessageFrame };
