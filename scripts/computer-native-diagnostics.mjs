// Diagnostic logs admit only numeric facts, booleans and exact decimal birth times.
// The fixture's input, secure fields, document text and executable paths stay out.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
function facts(value, keys, decimalKeys = []) {
  const source = object(value)
  return Object.fromEntries(keys.flatMap(key => {
    const field = source[key]
    return typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field)) ||
      (decimalKeys.includes(key) && typeof field === 'string' && /^\d{1,20}$/.test(field)) ? [[key, field]] : []
  }))
}
const birthKeys = ['kernelStartSeconds', 'kernelStartMicroseconds', 'bindStartSeconds', 'bindStartMicroseconds']
export function summarizeProcessSample(value) {
  return facts(value, ['pid', 'sampledAt', 'bsdBytes', 'bsdErrno', 'pathBytes', 'pathErrno', 'verifyBytes',
    'verifyErrno', 'verifyPathBytes', 'verifyPathErrno', 'kernelStatus', 'sampleStable', 'startMatches', 'executableMatches', 'executableMatch',
    'appKitRegistered', 'appKitTerminated', 'appKitLaunchMilliseconds', ...birthKeys], birthKeys)
}
export function summarizeFixtureState(value) {
  const state = object(value), windows = object(state.windows)
  return {
    ...facts(state, ['pid', 'sampledAt', 'kernelExecutableMatches']),
    processIdentity: summarizeProcessSample(state.processIdentity),
    menuDiagnostics: facts(state.menuDiagnostics, ['selectAllEnabled', 'modifiers', 'targetIsEditable']),
    keyboardEvents: (Array.isArray(state.keyboardEvents) ? state.keyboardEvents : []).slice(-12).map(event =>
      facts(event, ['type', 'keyCode', 'modifiers', 'timestamp', 'charactersUnits', 'ignoringModifiersUnits',
        'selectAllEquivalent', 'active', 'editableFocus'])),
    incrementEvents: Object.fromEntries(['A', 'B'].map(name => [name,
      (Array.isArray(object(state.incrementEvents)[name]) ? state.incrementEvents[name] : []).slice(-12)
        .map(event => facts(event, ['count', 'timestamp', 'currentEventType']))])),
    windows: Object.fromEntries(['A', 'B'].filter(name => windows[name]).map(name => {
      const window = object(windows[name])
      return [name, {
        ...facts(window, ['count', 'selectAllCalls']),
        textUnits: typeof window.text === 'string' ? window.text.length : 0,
        sheetTextUnits: typeof window.sheetText === 'string' ? window.sheetText.length : 0,
        ...facts(window, ['sheetVisible']),
        selection: facts(window.selection, ['start', 'length']),
        focus: facts(window.focus, ['keyWindow', 'mainWindow', 'editable', 'refusesFocus', 'secure']),
      }]
    })),
  }
}
