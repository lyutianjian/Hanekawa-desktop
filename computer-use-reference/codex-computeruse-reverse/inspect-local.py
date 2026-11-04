#!/usr/bin/env python3
"""Read-only local installation inventory. Does not inspect credentials or chats."""
import argparse, hashlib, json, pathlib, plistlib, re, struct, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--app', default='/Applications/ChatGPT.app')
parser.add_argument('--out', default='local-inspection.json')
args = parser.parse_args()
app = pathlib.Path(args.app)
resources = app / 'Contents/Resources'
runtime = resources / 'cua_node/lib/node_modules/@oai'

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''): h.update(block)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': h.hexdigest()}

def plist(path):
    with path.open('rb') as f: return plistlib.load(f)

info = plist(app/'Contents/Info.plist')
result = {'app': {k: info.get(k) for k in ['CFBundleIdentifier','CFBundleDisplayName','CFBundleShortVersionString','CFBundleVersion']},
          'system': subprocess.run(['sw_vers'], capture_output=True, text=True, timeout=5).stdout,
          'runtime': json.loads((resources/'cua_node/manifest.json').read_text()), 'packages': {}}
for name in ['cua','cua-repl','sky','browser-desktop']:
    p = runtime/name/'package.json'
    package = json.loads(p.read_text())
    result['packages'][name] = {'version': package['version'], **digest(p)}

service = pathlib.Path.home()/'.codex/computer-use/Codex Computer Use.app'
if not service.exists(): service = runtime/'sky/Codex Computer Use.app'
result['nativeService'] = {'info': {k: plist(service/'Contents/Info.plist').get(k) for k in ['CFBundleIdentifier','CFBundleShortVersionString','CFBundleVersion','LSMinimumSystemVersion']}}
binary = service/'Contents/MacOS/SkyComputerUseService'
result['nativeService'].update(digest(binary))
data = binary.read_bytes()
if data[:4] == b'\xcf\xfa\xed\xfe':
    ncmds = struct.unpack_from('<I',data,16)[0]; pos = 32
    for _ in range(ncmds):
        command, size = struct.unpack_from('<II',data,pos)
        if command == 2:
            _,_,symoff,nsyms,stroff,strsize=struct.unpack_from('<6I',data,pos)
            strings=data[stroff:stroff+strsize]; imports=[]
            for i in range(nsyms):
                x,kind,section,desc,value=struct.unpack_from('<IBBHQ',data,symoff+16*i)
                name=strings[x:strings.find(b'\0',x)].decode(errors='replace')
                if (kind & 0xe) == 0 and any(k in name for k in ['AXUI','AXValue','SecCode','audit','CGWindow','SCScreenshot','SCContent']): imports.append(name)
            result['nativeService']['selectedUndefinedSymbols']=imports
        pos += size
keys=['postToPid','WithSkyLight','RefetchableSkyshotAXTree','DifferenceBaseline','needsUISettleBeforeSkyshot','createVirtualCursorIfNeeded','SAIComputerUseIPCXPCProtocol','SAILockScreenGuardianXPCProtocol','computer_use_ipc_has_trusted_ancestor']
result['nativeService']['selectedStringEvidence']=[{'byteOffset':m.start(),'text':m.group().decode('ascii')} for m in re.finditer(rb'[ -~]{6,}',data) if len(m.group())<260 and any(k.encode() in m.group() for k in keys)]
asar=resources/'app.asar'
with asar.open('rb') as f:
    _, header_size, _, json_size=struct.unpack('<4I',f.read(16)); index=json.loads(f.read(json_size))
    def entries(tree, prefix=''):
        for name, value in tree.get('files',{}).items():
            full=prefix+name
            if 'files' in value: yield from entries(value,full+'/')
            else: yield full,value
    host=[]
    for name,meta in entries(index):
        if not name.startswith('.vite/build/') or not name.endswith('.js') or meta.get('unpacked'): continue
        f.seek(8+header_size+int(meta['offset'])); b=f.read(meta['size'])
        anchors=[]
        for key in [b'authorizeSocketPeer',b'browser-use-peer-authorization.node',b'NODE_REPL_HOST_SERVICES_PIPE_PATH',b'Managed Computer Use service is not enabled']:
            p=b.find(key)
            if p>=0: anchors.append({'key':key.decode(),'byteOffsetInEntry':p,'context':b[max(0,p-60):p+100].decode(errors='replace')})
        if anchors: host.append({'entry':name,'sha256':hashlib.sha256(b).hexdigest(),'anchors':anchors})
    result['asarEvidence']={'archive':str(asar),'dataOffset':8+header_size,'entries':host}
output=pathlib.Path(args.out)
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(str(output.resolve()))
