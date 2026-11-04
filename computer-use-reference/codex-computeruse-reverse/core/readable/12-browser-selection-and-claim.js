// C12: AST scope-aware renamed reading edition; not a source map or recovered author names.
// Runtime structure, operations, literal values and export names are retained.
// Read beside core/formatted/12-browser-selection-and-claim.js. Relative imports are intentionally not vendored.
import { __awaiter } from "../../../oai_js/node_modules/tslib/tslib.es6.js";
import { get_browser_tabs } from "../get_browser_tabs.js";
import { parse_tab_mention, get_mentioned_browser_id } from "./tab_reference.js";
function create_browser_api(t, n) {
  function l(i, r) {
    return __awaiter(this, void 0, void 0, function* () {
      let e;
      if (void 0 !== (null == i ? void 0 : i.browser)) e = yield t.get(i.browser);else if (void 0 !== r && void 0 !== t.getForUrl) e = yield t.getForUrl(r);else if (void 0 !== t.getDefault) e = yield t.getDefault();else {
        const i = (yield t.list())[0];
        if (void 0 === i) throw new Error("No browser is available.");
        e = yield t.get(i.id);
      }
      return yield n.load_browser_documentation(e), e;
    });
  }
  function d(i, r) {
    return __awaiter(this, void 0, void 0, function* () {
      const e = yield i.getAXState({
        disableDiffing: !0,
        emit: !1
      });
      return yield n.emit(e, {
        browser: r
      }), i;
    });
  }
  return {
    browsers: t,
    getBrowser(i) {
      return __awaiter(this, void 0, void 0, function* () {
        let e = null == i ? void 0 : i.id;
        if (void 0 !== (null == i ? void 0 : i.extensionInstanceId)) {
          if (void 0 !== e) throw new Error("Specify either id or extensionInstanceId, not both.");
          const r = (yield t.list()).filter(e => {
            var r;
            return "extension" === e.type && (null === (r = e.metadata) || void 0 === r ? void 0 : r.extensionInstanceId) === i.extensionInstanceId;
          });
          if (0 === r.length) throw new Error("The Chrome instance is unavailable.");
          if (1 !== r.length) {
            const e = JSON.stringify(r);
            throw new Error(`Multiple browsers match the Chrome instance: ${e}`);
          }
          e = r[0].id;
        }
        const r = null == i ? void 0 : i.url,
          o = void 0 === r || URL.canParse(r) ? r : `https://${r}`,
          s = yield l({
            browser: e
          }, o);
        return yield n.emit(void 0, {
          browser: s
        }), s;
      });
    },
    createBrowserTab(i, r, o) {
      return __awaiter(this, void 0, void 0, function* () {
        var e, t;
        if ("string" != typeof i || "" === i.trim()) throw new Error("createBrowserTab requires a browser ID. Select one with cua.getBrowser().");
        const s = void 0 === r || URL.canParse(r) ? r : `https://${r}`,
          n = yield l({
            browser: i
          });
        if (void 0 === n.tabs.new) throw new Error(`Browser ${n.browserId} does not support creating tabs.`);
        if (void 0 !== (null == o ? void 0 : o.sessionName)) {
          if ("function" != typeof n.nameSession) throw new Error(`Browser ${n.browserId} does not support sessionName.`);
          yield n.nameSession(o.sessionName);
        }
        if (void 0 !== (null == o ? void 0 : o.visible)) {
          if (void 0 === n.capabilities) throw new Error(`Browser ${n.browserId} does not support visibility control.`);
          const e = yield n.capabilities.get("visibility");
          yield e.set(o.visible);
        }
        const a = yield n.tabs.new();
        if (void 0 !== a.goto) {
          const i = null != s ? s : "about:blank",
            r = null === (e = URL.parse(i)) || void 0 === e ? void 0 : e.protocol;
          void 0 === a.ax || "https:" !== r && "http:" !== r ? yield a.goto(i) : yield a.goto(i, {
            prepareAccessibility: !0
          });
        } else if (void 0 !== s) throw yield null === (t = a.close) || void 0 === t ? void 0 : t.call(a), new Error(`Tab ${a.id} does not support navigation.`);
        return d(a, n);
      });
    },
    getTab(i, a) {
      return __awaiter(this, void 0, void 0, function* () {
        var e, b, c, u;
        let w, v, f;
        if ("string" == typeof i) {
          if ("" === i) throw new Error("getTab requires a tab reference");
          w = yield l(a), v = yield w.tabs.list(), f = yield s({
            browser: w,
            managed_tab_list: v,
            matches: e => e.id === i || e.providerTabId === i
          });
        } else if ("mention" in i) {
          const e = parse_tab_mention(i.mention);
          if (w = yield l({
            browser: yield get_mentioned_browser_id(t, e)
          }), void 0 !== (null == a ? void 0 : a.browser)) {
            if ((yield t.get(a.browser)).browserId !== w.browserId) throw new Error("The requested browser does not match the tab mention's browser/profile.");
          }
          v = yield w.tabs.list(), f = yield s({
            browser: w,
            managed_tab_list: v,
            matches: i => i.providerTabId === e.tab_id
          });
          const n = f[0];
          if (void 0 !== n && (n.title !== e.title || n.url !== e.url)) throw new Error("Stale tab mention: the tab's title or URL has changed.");
        } else {
          if (!URL.canParse(i.url)) throw new Error("getTab requires an absolute URL.");
          if (!(null == a ? void 0 : a.browser)) throw new Error("getTab({ url }) requires an explicit browser.");
          w = yield l(a), v = yield w.tabs.list();
          const r = null !== (c = yield null === (b = null === (e = w.user) || void 0 === e ? void 0 : e.openTabs) || void 0 === b ? void 0 : b.call(e)) && void 0 !== c ? c : [],
            o = new Map([...r, ...v].map(e => [e.id, e]));
          f = [...o.values()].filter(e => e.url === i.url);
        }
        const h = f[0];
        if (void 0 === h) throw new Error(`Tab not found in browser ${w.browserId}.`);
        if (1 !== f.length) {
          const e = w.browserId,
            i = f.map(i => Object.assign(Object.assign({}, i), {
              browserId: e
            })),
            r = JSON.stringify(i);
          throw new Error(`Multiple tabs match the reference in browser ${e}: ${r}`);
        }
        let m;
        if (v.some(e => e.id === h.id)) m = yield w.tabs.get(h.id);else {
          if (void 0 === (null === (u = w.user) || void 0 === u ? void 0 : u.claimTab)) throw new Error(`Tab ${h.id} cannot be claimed in browser ${w.browserId}.`);
          m = yield w.user.claimTab(h);
        }
        if ("chrome://newtab" === h.url || "chrome://newtab/" === h.url || "chrome-extension://njkekoimnfiafpgdgahjjnmhckkfojea/newtab.html" === h.url) {
          const e = w.browserId;
          return yield n.emit(Object.assign(Object.assign({}, h), {
            browserId: e
          }), {
            browser: w
          }), m;
        }
        return d(m, w);
      });
    },
    listBrowsers(i) {
      return __awaiter(this, void 0, void 0, function* () {
        const e = yield t.list();
        return yield n.emit(e, i), e;
      });
    },
    listTabs(r) {
      return __awaiter(this, void 0, void 0, function* () {
        let o, s;
        void 0 !== (null == r ? void 0 : r.browser) ? (o = yield l(r), s = [{
          id: o.browserId
        }]) : s = yield t.list();
        const d = yield Promise.all(s.map(r => __awaiter(this, void 0, void 0, function* () {
            const e = null != o ? o : yield t.get(r.id),
              s = yield get_browser_tabs(e),
              n = e.browserId;
            return s.map(e => Object.assign(Object.assign({}, e), {
              browserId: n
            }));
          }))),
          a = d.flat();
        return yield n.emit(a, Object.assign(Object.assign({}, r), {
          browser: o
        })), a;
      });
    }
  };
}
function s(i) {
  return __awaiter(this, void 0, void 0, function* () {
    var e, r, o;
    const t = i.managed_tab_list.filter(i.matches);
    if (0 !== t.length) return t;
    const s = null !== (o = yield null === (r = null === (e = i.browser.user) || void 0 === e ? void 0 : e.openTabs) || void 0 === r ? void 0 : r.call(e)) && void 0 !== o ? o : [],
      n = new Map();
    for (const e of s) n.set(e.id, e);
    const l = function (e, i) {
      const r = new Map(i.map(e => [e.id, e.providerTabId]));
      return e.map(e => {
        var i;
        const o = null !== (i = e.providerTabId) && void 0 !== i ? i : r.get(e.id);
        return Object.assign(Object.assign({}, e), {
          providerTabId: o
        });
      });
    }(i.managed_tab_list, s);
    for (const e of l) n.set(e.id, e);
    return [...n.values()].filter(i.matches);
  });
}
export { create_browser_api };
