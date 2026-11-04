const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Playwright's exported transform is a TS/JSX wrapper. Expose its bundled Babel core
// in a scratch copy so the reading edition uses a parser/printer only.
const babelBundlePath='/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/lib/transform/babelBundleImpl.js';
const shim=path.resolve('work/babel-core.cjs');
fs.mkdirSync(path.dirname(shim),{recursive:true});
fs.writeFileSync(shim,fs.readFileSync(babelBundlePath,'utf8')+'\nmodule.exports.rawBabel=nd;\n');
const {rawBabel} = require(shim);
const {transformSync:babelTransform,parseSync:babelParse,traverse}=rawBabel;
const root = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai';
const out = path.resolve(process.argv[2] || 'outputs/codex-computeruse-reverse');
fs.mkdirSync(path.join(out, 'core/formatted'), {recursive:true});
fs.mkdirSync(path.join(out, 'core/readable'), {recursive:true});
const cua = 'cua/dist/lib/js/oai_js_cua/src/';
const sky = 'sky/dist/project/cua/sky_js/src/';
const specs = [
 ['C01', cua+'tinysky_alt/globals.js','01-bootstrap'],
 ['C02', cua+'tinysky_alt/create_tinysky_alt.js','02-unified-api'],
 ['C03', cua+'tinysky_alt/bind_mac_app.js','03-mac-app-binding'],
 ['C04', sky+'sky.js','04-trusted-sky-proxy'],
 ['C05', sky+'service.js','05-trusted-service-dispatch'],
 ['C06', sky+'targets/mac/computer-use-policy.js','06-app-policy-and-approval'],
 ['C07', sky+'targets/mac/client.js','07-native-request-schema'],
 ['C08', sky+'targets/mac/native-pipe.js','08-native-pipe-transport'],
 ['C09', sky+'targets/mac/window_result.js','09-skyshot-result'],
 ['C10', sky+'targets/mac/errors.js','10-native-error-codes'],
 ['C11', cua+'tinysky_alt/bind_tab.js','11-browser-tab-binding'],
 ['C12', cua+'tinysky_alt/create_browser_api.js','12-browser-selection-and-claim'],
 ['C13', cua+'tinysky_alt/create_bootstrap_emitter.js','13-documentation-emitter'],
 ['C14', sky+'sky_service_rpc.js','14-sky-rpc-client'],
 ['C15', sky+'targets/mac/get_app_state.js','15-observation-entry'],
 ['C16', sky+'targets/mac/click.js','16-click-entry'],
 ['C17', 'cua-repl/dist/lib/js/oai_js_cua_repl/src/environment.js','17-repl-environment'],
 ['C18', cua+'tinysky_alt/setup_browser.js','18-browser-bootstrap'],
];
const renames = {
 C06:{s:'TOOL_SURFACE_META',c:'CHROME_META',l:'withComputerUsePolicy',u:'requestComputerAudioApproval',p:'withComputerUseToolTelemetry',d:'setComputerUseResponseMeta',m:'waitForElicitation',f:'startSpan',v:'endSpan',_:'getNodeRepl',y:'getToolCallId',b:'freezePlainInput',w:'requireElicitation'},
 C07:{p:'MacComputerUseClient',c:'defaultClient',r:'POLICY_REQUEST',o:'START_AUDIO_REQUEST',n:'STOP_AUDIO_REQUEST',i:'GET_SKYSHOT_REQUEST',s:'LIST_APPS_REQUEST',u:'PERFORM_ACTION_REQUEST',a:'START_APP_REQUEST',d:'currentTurnMetadata',m:'resolveMetadata',l:'policyInput',f:'appInput',h:'actionLocation',y:'point',x:'elementId',b:'mouseButton',g:'scrollDirection',w:'stripUndefined'},
 C08:{k:'MAX_FRAME_BYTES',U:'STARTUP_TIMEOUT_MS',E:'MacNativePipeTransport',P:'decodeMessageFrames',b:'encodeMessageFrame',j:'normalizeMetadata',T:'validateRpcResponse',O:'requireNodeRepl',_:'nonEmptyString',A:'asError',R:'sleep',M:'withTimeout',q:'PipeUnavailableError',D:'ApiVersionMismatchError',l:'privateMethods',f:'apiVersionSlot',p:'nextIdSlot',h:'bufferSlot',d:'pendingSlot',m:'queueSlot',y:'connectionSlot',v:'sendRpc',w:'receiveData',S:'receiveResponse',C:'failPending',g:'closeConnection'},
};
function transform(src, rename={}) {
 return babelTransform(src,{babelrc:false,configFile:false,sourceType:'module',compact:false,comments:true,
   plugins:[function(){return {visitor:{Program(p){
    const names={};
    for(const statement of p.node.body){
     if(statement.type==='ImportDeclaration') for(const sp of statement.specifiers) if(sp.type==='ImportSpecifier' && sp.imported.type==='Identifier') names[sp.local.name]=sp.imported.name;
     if(statement.type==='ExportNamedDeclaration') for(const sp of statement.specifiers||[]) if(sp.type==='ExportSpecifier'&&sp.exported.type==='Identifier') names[sp.local.name]=sp.exported.name;
    }
    Object.assign(names,rename);
    for(const [old,n] of Object.entries(names)) if(old!==n && p.scope.hasOwnBinding(old) && !p.scope.hasOwnBinding(n)) p.scope.rename(old,n);
   }}};}],generatorOpts:{jsescOption:{minimal:true}}}).code;
}
function format(src){return babelTransform(src,{babelrc:false,configFile:false,sourceType:'unambiguous',compact:false,comments:true,generatorOpts:{jsescOption:{minimal:true}}}).code;}
const manifest=[];
function astShape(src){return JSON.stringify(babelParse(src,{sourceType:'module'}),(k,v)=>['start','end','loc','extra','comments','leadingComments','trailingComments','innerComments','tokens'].includes(k)?undefined:v);}
const validation=[];
for(const [id,relative,name] of specs){
 const source=path.join(root,relative),raw=fs.readFileSync(source,'utf8');
 const header=`// ${id}: installed source, ${source}\n// Formatting only. Imports keep their original relative paths; this extracted copy is for reading.\n`;
 const formatted=header+format(raw)+'\n';
 const readable=`// ${id}: AST scope-aware renamed reading edition; not a source map or recovered author names.\n// Runtime structure, operations, literal values and export names are retained.\n// Read beside core/formatted/${name}.js. Relative imports are intentionally not vendored.\n`+transform(raw,renames[id])+'\n';
 if(astShape(raw)!==astShape(formatted))throw new Error('Formatting changed AST: '+id);
 babelParse(readable,{sourceType:'module'});
 validation.push({id,formattedAstMatchesOriginal:true,readableParses:true});
 fs.writeFileSync(path.join(out,'core/formatted',name+'.js'),formatted);
 fs.writeFileSync(path.join(out,'core/readable',name+'.js'),readable);
 manifest.push({id,source,bytes:Buffer.byteLength(raw),sha256:crypto.createHash('sha256').update(raw).digest('hex'),formatted:'core/formatted/'+name+'.js',readable:'core/readable/'+name+'.js',formattedLines:formatted.split('\n').length,readableLines:readable.split('\n').length});
}
const configs=[
 ['P01','/Users/lizhi/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1029.61003/.mcp.json'],
 ['P02','/Users/lizhi/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1029.61003/.codex-plugin/plugin.json'],
 ['P03','/Applications/ChatGPT.app/Contents/Resources/cua_node/manifest.json'],
 ['P04','/Applications/ChatGPT.app/Contents/Info.plist'],
 ['P05','/Users/lizhi/.codex/computer-use/Codex Computer Use.app/Contents/Info.plist'],
];
for(const[id,source]of configs){const raw=fs.readFileSync(source);manifest.push({id,source,bytes:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex')});}
const browser=path.join(root,'browser-desktop/scripts/browser-service.mjs');
const raw=fs.readFileSync(browser,'utf8');
const pretty=format(raw);
fs.writeFileSync('work/browser-service.pretty.js',pretty);
const ast=babelParse(pretty,{sourceType:'module'});
const selections=[
 ['B01','targetForElement(t, r)','元素索引解析与旧页面校验'],
 ['B02','async buildAXCandidate(t, r)','AX候选树构建'],
 ['B03','async captureDocuments(t, r, n)','多Frame的CDP AX捕获'],
 ['B04','identityForElement(t)','WASM索引到身份映射'],
];
const entries=[];
traverse(ast,{ClassMethod(p){const method=pretty.slice(p.node.start,p.node.end);for(const[id,needle,label]of selections)if(method.startsWith(needle))entries.push({id,label,start:p.node.start,end:p.node.end,code:method});}});
for(const name of ['Wo','cs','pb','Jh'])traverse(ast,{VariableDeclarator(p){if(p.node.id.name===name && p.node.init?.type==='ClassExpression')entries.push({id:'B-'+name,label:name,start:p.parentPath.node.start,end:p.parentPath.node.end,code:pretty.slice(p.parentPath.node.start,p.parentPath.node.end)});}});
const browserOut=path.join(out,'core/browser-excerpts.txt');
let snippets='Browser service AST-extracted excerpts. Method fragments are reading material, not standalone modules.\nSource: '+browser+'\nByte offsets in original source are recorded as anchors in evidence.json; ranges below refer to the reproducibly formatted source.\n\n';
for(const e of entries){snippets+=`===== ${e.id} ${e.label} | formatted chars ${e.start}-${e.end} =====\n${e.code}\n\n`;}
fs.writeFileSync(browserOut,snippets);
const anchors=['Accessibility.getFullAXTree','DOMSnapshot.captureSnapshot','Input.dispatchMouseEvent','Input.insertText','computer_use_browser_wasm_revision_create','targetForElement(t,r)','identityForElement(t)','c7e=8*1024*1024','cs=class'];
manifest.push({id:'B00',source:browser,bytes:Buffer.byteLength(raw),sha256:crypto.createHash('sha256').update(raw).digest('hex'),excerpts:'core/browser-excerpts.txt',anchors:anchors.map(key=>{const i=raw.indexOf(key);return{key,byteOffset:i<0?null:Buffer.byteLength(raw.slice(0,i))};})});
// Selected host functions from the ASAR archive, without extracting unrelated data.
const archive='/Applications/ChatGPT.app/Contents/Resources/app.asar';
const fd=fs.openSync(archive,'r'),header=Buffer.alloc(16);fs.readSync(fd,header,0,16,0);
const headerSize=header.readUInt32LE(4),jsonSize=header.readUInt32LE(12),indexBuffer=Buffer.alloc(jsonSize);
fs.readSync(fd,indexBuffer,0,jsonSize,16);const asarIndex=JSON.parse(indexBuffer.toString());
function* walk(tree,prefix=''){for(const[name,value]of Object.entries(tree.files||{})){const p=prefix+name;if(value.files)yield*walk(value,p+'/');else yield[p,value];}}
let hostText='Host ASAR excerpts. Original functions/classes, formatting only; external bundle symbols are unresolved.\n\n';
for(const[entry,meta]of walk(asarIndex)){
 if(!entry.startsWith('.vite/build/')||!entry.endsWith('.js')||meta.unpacked)continue;
 const bytes=Buffer.alloc(meta.size);fs.readSync(fd,bytes,0,bytes.length,8+headerSize+Number(meta.offset));const code=bytes.toString();
 if(!code.includes('browser-use-peer-authorization.node'))continue;
 const tree=babelParse(code,{sourceType:'unambiguous'});
 const record=(id,node,label)=>{const fragment=code.slice(node.start,node.end);hostText+=`===== ${id} ${label} | ${entry} | original byte ${Buffer.byteLength(code.slice(0,node.start))} =====\n${format(fragment)}\n\n`;manifest.push({id,source:archive+'::'+entry,entrySha256:crypto.createHash('sha256').update(bytes).digest('hex'),byteOffsetInEntry:Buffer.byteLength(code.slice(0,node.start)),excerpts:'core/host-excerpts.txt'});};
 traverse(tree,{FunctionDeclaration(p){if(p.node.id?.name==='cR'&&code.slice(p.node.start,p.node.end).includes('authorizeSocketPeer'))record('H01',p.node,'socket peer authorization');},ClassDeclaration(p){if(p.node.id?.name==='lO'&&code.slice(p.node.start,p.node.end).includes('SkyComputerUseService'))record('H02',p.node,'managed native service lifecycle');}});
}
fs.closeSync(fd);fs.writeFileSync(path.join(out,'core/host-excerpts.txt'),hostText);
fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify({capturedAt:'2026-11-04 Asia/Shanghai',host:'macOS arm64',method:'Read-only local installed artifacts; no author source maps assumed',files:manifest},null,2)+'\n');
fs.writeFileSync(path.join(out,'source-validation.json'),JSON.stringify({babelVersion:rawBabel.version,validation},null,2)+'\n');
console.log(JSON.stringify({output:out,modules:specs.length,lines:manifest.reduce((n,x)=>n+(x.readableLines||0),0),browserExcerpts:entries.map(x=>x.id)},null,2));
