/** Runs only against an in-memory socket. It never connects to a desktop service. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {pathToFileURL} from 'node:url';
const runtime=process.env.CUA_MODULE_ROOT || '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai';
const mac=`${runtime}/sky/dist/project/cua/sky_js/src/targets/mac`;
const {encodeMessageFrame,decodeMessageFrames,MacNativePipeTransport}=await import(pathToFileURL(`${mac}/native-pipe.js`));
const {MacComputerUseClient}=await import(pathToFileURL(`${mac}/client.js`));
const {bind_mac_app}=await import(pathToFileURL(`${runtime}/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/bind_mac_app.js`));
const {withComputerUsePolicy}=await import(pathToFileURL(`${mac}/computer-use-policy.js`));
const checks=[];
function check(name,fn){return Promise.resolve().then(fn).then(()=>checks.push({name,status:'passed'}));}

await check('UTF-8 byte lengths, fragmented and concatenated frames',()=>{
 const values=['{"text":"中文🙂"}','{"id":2}',JSON.stringify({text:'x'.repeat(1200)})];
 const stream=Buffer.concat(values.map(encodeMessageFrame));
 for(const chunkSize of [1,2,3,4,7,31,4096]){
  let remainder=Buffer.alloc(0),result=[];
  for(let i=0;i<stream.length;i+=chunkSize){
   const decoded=decodeMessageFrames(Buffer.concat([remainder,stream.subarray(i,i+chunkSize)]));
   result.push(...decoded.messages);remainder=decoded.remainingData;
  }
  assert.deepEqual(result,values);assert.equal(remainder.length,0);
 }
 assert.equal(encodeMessageFrame('中文').readUInt32LE(0),6);
});
await check('8 MiB upper bound and incomplete header handling',()=>{
 const header=Buffer.alloc(4);header.writeUInt32LE(8*1024*1024+1);
 assert.throws(()=>decodeMessageFrames(header),/too large/);
 assert.throws(()=>encodeMessageFrame('x'.repeat(8*1024*1024+1)),/too large/);
 assert.equal(decodeMessageFrames(Buffer.from([1,0,0])).remainingData.length,3);
});

const requests=[];let active=0,maxActive=0;
class MockSocket extends EventEmitter {
 constructor(){super();this.ended=false;}
 write(bytes){
  for(const raw of decodeMessageFrames(bytes).messages){
   const message=JSON.parse(raw);requests.push(message);active++;maxActive=Math.max(maxActive,active);
   setTimeout(()=>{
    let result;
    if(message.method==='ping')result={serverApiVersion:message.params.clientApiVersion};
    else if(message.params.requestType==='ComputerUseIPCAppPolicyRequest')result={decision:message.params.request.app==='mock.denied'?'denied':'allowed',allowPersistentApproval:true,target:{bundleIdentifier:'mock.calculator',appPath:'/mock/Calculator.app',displayName:'Mock Calculator',risk:'low'}};
    else if(message.params.requestType==='ComputerUseIPCAppGetSkyshotRequest')result={skyshot:{text:'0 button Mock',screenshot:{url:'data:image/png;base64,'}}};
    else result={accepted:true};
    active--;const reply=encodeMessageFrame(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    // Deliberately split header and body across chunks.
    this.emit('data',reply.subarray(0,3));this.emit('data',reply.subarray(3));
   },2);
  }
 }
 end(){if(!this.ended){this.ended=true;this.emit('close');}}
}
const sockets=[];
const approvals=[];
globalThis.nodeRepl={
 env:{SKY_CUA_SERVICE_NATIVE_PIPE_PATH:'mock://in-memory-only'},
 nativePipe:{createConnection:async p=>{assert.equal(p,'mock://in-memory-only');const s=new MockSocket();sockets.push(s);return s;}},
 createElicitation:async request=>{approvals.push(request);return {action:'accept'};},
};
await check('Actual MacComputerUseClient: version ping, schema and serialized execution',async()=>{
 const client=new MacComputerUseClient({codexMetadata:{call_id:'mock-call',turn_id:'mock-turn'}});
 await Promise.all([
  client.click({app:'mock.calculator',elementIndex:18,clickCount:1}),
  client.pressKey({app:'mock.calculator',key:'Return'}),
  client.getAppState({app:'mock.calculator',disableDiff:true}),
 ]);
 assert.equal(requests[0].method,'ping');
 assert.equal(requests[0].params.clientApiVersion,'CodexComputerUseIPC-5');
 const calls=requests.filter(x=>x.method==='request');assert.equal(calls.length,3);
 assert.equal(maxActive,1);
 assert.deepEqual(calls[0].params.request.action.click.at,{elementID:{_0:'18'}});
 assert.equal(calls[0].params.request.action.click.mouseButton,0);
 assert.equal(calls[1].params.request.action.pressKey._0,'Return');
 assert.equal(calls[2].params.request.disableDiff,true);
 for(const call of calls){
  assert.equal(call.params.clientApiVersion,'CodexComputerUseIPC-5');
  assert.equal(call.params.codexTurnMetadata.call_id,'mock-call');
  assert.ok(call.params.deadlineUnixMilliseconds>Date.now());
 }
});
await check('App binding: milliseconds to seconds, app pinning and platform restrictions',async()=>{
 const calls=[];
 const target=bind_mac_app({click:async p=>calls.push(p),get_app_state:async p=>({text:'mock tree',screenshot:null}),scroll:async p=>calls.push(p)},'mock.calculator');
 await target.click(7,{durationMs:500});
 await target.click([10,20],{mouseButton:'right'});
 assert.equal(calls[0].duration,0.5);assert.equal(calls[0].app,'mock.calculator');
 assert.equal(calls[1].x,10);assert.equal(calls[1].y,20);
 assert.throws(()=>target.scroll(7,'down',{pixels:100}),/pages, not pixels/);
 assert.throws(()=>target.typeText('x',7),/only supported on Linux/);
});
await check('Actual policy wrapper: app canonicalization, frozen input and blocked app',async()=>{
 const result=await withComputerUsePolicy('click',{app:'Mock Calculator',element_index:7},async input=>{
  assert.equal(input.app,'/mock/Calculator.app');assert.equal(Object.isFrozen(input),true);return 'executed-in-memory';
 });
 assert.equal(result,'executed-in-memory');assert.equal(approvals.at(-1).meta.tool_params.app,'mock.calculator');
 const count=approvals.length;
 await assert.rejects(withComputerUsePolicy('click',{app:'mock.denied'},async()=>assert.fail('blocked callback ran')),/organization/);
 assert.equal(approvals.length,count);
});
await check('Actual policy wrapper rejects accessor input without invoking the getter',async()=>{
 let read=0;
 const input={get app(){read++;return 'mock.calculator';}};
 await assert.rejects(withComputerUsePolicy('click',input,async()=>assert.fail('callback ran')),/plain data property/);
 assert.equal(read,0);
});
await check('Transport close rejects an outstanding request',async()=>{
 const transport=await MacNativePipeTransport.create('CodexComputerUseIPC-5');
 const pending=transport.request({requestType:'MockPending',request:{},timeoutSeconds:1});
 const handled=assert.rejects(pending,/closed before response|closed/);
 await new Promise(resolve=>setTimeout(resolve,0));sockets.at(-1).end();await handled;
});
for(const socket of sockets)socket.end();
delete globalThis.nodeRepl;
console.log(JSON.stringify({scope:'original installed JS with in-memory mock transport; no OS control',checks,requestExample:requests.find(x=>x.method==='request')},null,2));
