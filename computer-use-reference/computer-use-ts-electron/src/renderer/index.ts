import type { AutomationAPI, Observation, SessionInfo, Result, Target } from '../shared/contracts';
declare global { interface Window { automation: AutomationAPI } }
const api = window.automation;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const buttons = ['start', 'observe', 'cancel', 'press', 'set'].map(id => element<HTMLButtonElement>(id));
let targets: Target[] = [];
let session: SessionInfo | undefined;
let snapshot: Observation | undefined;
let busy = false;
let generation = 0;
function log(text: string) {
  const events = element('events'); events.textContent = `${new Date().toLocaleTimeString()}  ${text}\n${events.textContent}`.slice(0, 8000);
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}${result.error.outcome === 'unknown' ? '（结果可能已发生，请重新核验）' : ''}`);
  return result.value;
}
function refresh() {
  buttons[0].disabled = busy || !!session || !targets.length;
  buttons[1].disabled = busy || !session;
  buttons[2].disabled = !session;
  buttons[3].disabled = busy || !session || !snapshot;
  buttons[4].disabled = busy || !session || !snapshot;
  element<HTMLSelectElement>('target').disabled = busy || !!session;
  element<HTMLSelectElement>('element').disabled = busy || !snapshot;
}
function render(observation: Observation) {
  snapshot = observation;
  element('tree').textContent = observation.text + (observation.truncated ? '\n[已裁剪]' : '');
  element('revision').textContent = `revision ${observation.revision} · ${observation.snapshotId.slice(0, 8)}`;
  const select = element<HTMLSelectElement>('element');
  select.replaceChildren(...observation.nodes.map(node => {
    const option = document.createElement('option'); option.value = String(node.index);
    option.textContent = `${node.index} · ${node.role} ${node.label}`; return option;
  }));
  const pressable = observation.nodes.find(n => n.actions.includes('AXPress'));
  if (pressable) select.value = String(pressable.index);
}
async function run(work: (token: number) => Promise<void>) {
  const token = generation;
  busy = true; refresh();
  try { await work(token); if (token === generation) element('status').textContent = session ? '会话已就绪' : '会话已关闭'; }
  catch (error) { if (token === generation) { element('status').textContent = String(error); log(String(error)); } }
  finally { if (token === generation) { busy = false; refresh(); } }
}
element('start').onclick = () => void run(async token => {
  const target = targets[Number(element<HTMLSelectElement>('target').value)];
  const info = unwrap(await api.start({ driver: target.driver, bundleId: target.bundleId }));
  if (token !== generation) return;
  session = info; log(`已创建 ${info.target.displayName} 会话`);
});
element('observe').onclick = () => void run(async token => {
  const id = session!.id; snapshot = undefined;
  const observed = unwrap(await api.observe({ sessionId: id }));
  if (token === generation) { render(observed); log(`已读取 revision ${observed.revision}`); }
});
async function act(kind: 'press' | 'setValue') {
  await run(async token => {
    const id = session!.id;
    const ref = { snapshotId: snapshot!.snapshotId, index: Number(element<HTMLSelectElement>('element').value) };
    snapshot = undefined;
    unwrap(await api.act({ sessionId: id, action: kind === 'press' ? { kind, ref } : { kind, ref, value: element<HTMLInputElement>('value').value } }));
    if (token !== generation) return;
    const observed = unwrap(await api.observe({ sessionId: id }));
    if (token === generation) { render(observed); log(`${kind} 已返回成功；已重新观察，请核对实际结果`); }
  });
}
element('press').onclick = () => void act('press');
element('set').onclick = () => void act('setValue');
element('cancel').onclick = async () => {
  const id = session!.id;
  ++generation; busy = true; snapshot = undefined; refresh(); buttons[2].disabled = true;
  try { unwrap(await api.cancel({ sessionId: id })); session = undefined; element('status').textContent = '会话已取消'; log('已终止会话，旧快照已失效'); }
  catch (error) { element('status').textContent = String(error); }
  finally { busy = false; refresh(); }
};
void run(async () => {
  targets = unwrap(await api.targets());
  element<HTMLSelectElement>('target').replaceChildren(...targets.map((target, index) => {
    const option = document.createElement('option'); option.value = String(index); option.textContent = target.displayName; return option;
  }));
});
