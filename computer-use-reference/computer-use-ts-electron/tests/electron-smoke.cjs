// Trusted test harness for our own local app; never receives model code.
const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const output = path.resolve('build');
mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'smoke-profile'));
app.setAppLogsPath(path.join(output, 'logs'));
let finished = false;
const timer = setTimeout(() => finish({ passed: false, error: 'Electron smoke timeout' }, 1), 25000);
function finish(report, code) {
  if (finished) return; finished = true; clearTimeout(timer);
  writeFileSync(path.join(output, 'electron-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(code);
}
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const prefs = window.webContents.getLastWebPreferences();
      assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
      const report = await window.webContents.executeJavaScript(`(async () => {
        const wait = async predicate => { const deadline = Date.now()+5000; while(!predicate()) { if(Date.now()>deadline) throw Error('UI wait timeout'); await new Promise(r=>setTimeout(r,10)); } };
        await wait(()=>!document.getElementById('start').disabled);
        if(typeof window.require !== 'undefined' || typeof window.process !== 'undefined') throw Error('Node leaked to renderer');
        document.getElementById('start').click();
        await wait(()=>!document.getElementById('observe').disabled);
        document.getElementById('observe').click();
        await wait(()=>!document.getElementById('press').disabled);
        if(!document.getElementById('tree').textContent.includes('Count 0')) throw Error('Initial mock state missing');
        document.getElementById('press').click();
        await wait(()=>!document.getElementById('press').disabled);
        const tree=document.getElementById('tree').textContent;
        if(!tree.includes('Count 1')) throw Error('UI failed to verify increment');
        const malformed=await window.automation.start({driver:'mock',bundleId:'demo.counter',command:'sh'});
        if(malformed.ok || malformed.error.code!=='INVALID_INPUT') throw Error('Main failed to validate payload');
        const badTarget=await window.automation.start({driver:'macos',bundleId:'com.example.other'});
        if(badTarget.ok || badTarget.error.code!=='NOT_AUTHORIZED') throw Error('Main failed to enforce allowlist');
        return {tree, url:location.href, apiMethods:Object.keys(window.automation), rendererNodeAccess:false};
      })()`);
      // Ensure compositor has painted the newly verified state before exporting a screenshot.
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(path.join(output, 'electron-smoke.png'), (await window.webContents.capturePage()).toPNG());
      const other = new BrowserWindow({ show: false, webPreferences: {
        preload: path.resolve('dist/preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false
      } });
      try {
        await other.loadURL('cu-app://ui/index.html');
        const denied = await other.webContents.executeJavaScript('window.automation.targets()');
        assert.equal(denied.ok, false); assert.equal(denied.error.code, 'NOT_AUTHORIZED');
      } finally { other.destroy(); }
      const cancel = await window.webContents.executeJavaScript(`(async()=>{
        document.getElementById('cancel').click();
        const deadline=Date.now()+5000;
        while(document.getElementById('start').disabled) { if(Date.now()>deadline)throw Error('Cancel timeout'); await new Promise(r=>setTimeout(r,10)); }
        return document.getElementById('status').textContent;
      })()`);
      assert.equal(cancel, '会话已取消');
      finish({ passed: true, scope: 'real Electron renderer + preload + main + mock driver; no desktop AX',
        electron: process.versions.electron, preferences: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration }, ...report, otherWindowDenied: true, cancel }, 0);
    } catch (error) { finish({ passed: false, error: String(error) }, 1); }
  });
});
require('../dist/main/index.cjs');
