#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as strip from '../packages/shell/src/strip.ts'
const source = await readFile(new URL('../clients/ios/NativeApp/Resources/layout.js', import.meta.url), 'utf8')
const make = () => {
  const context = vm.createContext({})
  vm.runInContext(source, context)
  return (message) => {
    const result = JSON.parse(context.LWFALayout.dispatch(JSON.stringify(message)))
    assert.equal(result.error, undefined, result.error)
    return result
  }
}
const output = { width: 1324, height: 838 }
const config = strip.DEFAULT_CONFIG
const windows = [1, 2, 3].map(id => ({ id: String(id), fullscreen: false }))
const send = make()
let result = send({ type: 'reconcile', windows, focused: '2', output, current: [] })
let state = [1, 2, 3].reduce((s, id) => strip.addWindow(s, id, output, config), strip.EMPTY)
state = strip.focusWindow(state, 2, output, config)
const check = (s = state, o = output, c = config) => {
  assert.deepEqual(result.placed, strip.layout(s, o, c).map(w => ({ ...w, id: String(w.id) })))
  assert.equal(result.focused, strip.focusedWindow(s)?.toString() ?? null)
  assert.deepEqual(result.activeStreams, strip.streamList(strip.layout(s, o, c), o, c, strip.focusedWindow(s), true, strip.fullscreenWindow(s), strip.liveWindows(s)).map(String))
}
check()
// Missing compositor keyboard focus must not disable an otherwise selected game.
result = send({ type: 'reconcile', windows, focused: null, output, current: result.placed })
check()
for (let i = 0; i < 20; i++) {
  const enlarged = { width: 1324, height: 970 }
  result = send({ type: 'resize', output: enlarged })
  check(strip.reflow(state, enlarged, config), enlarged)
  result = send({ type: 'resize', output })
  check()
}
result = send({ type: 'action', name: 'fullscreen' })
state = strip.toggleFullscreen(state, output, config)
check()
assert.deepEqual(result.placed[0].rect, { x: 0, y: 0, ...output })
const full = result.placed
for (let i = 0; i < 20; i++) {
  result = send({ type: 'action', name: 'fullscreenRequest', args: ['2', i % 2 === 0] })
  assert.deepEqual(result.placed, full, 'Application requests cannot reverse the user fullscreen choice')
}
result = send({ type: 'action', name: 'fullscreen' })
state = strip.toggleFullscreen(state, output, config)
check()
for (let i = 0; i < 10; i++) {
  result = send({ type: 'reconcile', windows: windows.map(w => ({ ...w, fullscreen: true })), focused: '2', output, current: result.placed })
  check()
}
result = send({ type: 'action', name: 'stack' })
state = strip.consumeIntoColumn(state, output, config)
check()
result = send({ type: 'action', name: 'live', args: ['2', true] })
state = strip.setColumnLive(state, 2, true)
check()
result = send({ type: 'action', name: 'width', args: ['2', 4] })
state = strip.setColumnWidth(state, 2, 4, output, config)
check()
result = send({ type: 'action', name: 'fit', args: [true] })
state = strip.setFit(state, true, output, config)
check()
result = send({ type: 'action', name: 'unstack' })
state = strip.expelFromColumn(state, output, config)
check()
result = send({ type: 'action', name: 'sendWorkspace', args: ['2', 1] })
state = strip.sendToWorkspace(state, 2, 1, output, config)
check()
result = send({ type: 'action', name: 'workspace', args: [1] })
state = strip.focusWorkspace(state, 1, output, config)
check()
result = send({ type: 'action', name: 'moveWorkspace', args: [-1] })
state = strip.moveToWorkspace(state, -1, output, config)
check()
result = send({ type: 'action', name: 'move', args: ['2', { kind: 'column', index: 0, row: 0 }] })
state = strip.moveWindow(state, 2, { kind: 'column', index: 0, row: 0 }, output, config)
check()
const portrait = { width: 838, height: 1324 }
result = send({ type: 'resize', output: portrait })
state = strip.reflow(state, portrait, config)
check(state, portrait)
const vertical = strip.configFrom({ orientation: 'vertical', defaultWidth: 1, centreFocused: false })
result = send({ type: 'configure', orientation: 'vertical', defaultWidth: 1, centreFocused: false })
state = strip.reflow(state, portrait, vertical)
check(state, portrait, vertical)

const requests = make()
requests({ type: 'reconcile', windows, focused: '2', output, current: [] })
const requestedFullscreen = requests({ type: 'action', name: 'fullscreenRequest', args: ['2', true] })
assert.equal(requestedFullscreen.fullscreen, true)
assert.deepEqual(requests({ type: 'action', name: 'fullscreenRequest', args: ['2', true] }).state, requestedFullscreen.state)
assert.equal(requests({ type: 'action', name: 'fullscreenRequest', args: ['2', false] }).fullscreen, false)

// Adjacent UInt64 values must never merge through IEEE-754 conversion.
const huge = ['9007199254740992', '9007199254740993', '18446744073709551615']
const largeSend = make()
let large = largeSend({ type: 'reconcile', windows: huge.map(id => ({ id, fullscreen: false })), focused: huge[1], output, current: [] })
assert.deepEqual(large.placed.map(w => w.id), huge)
assert.equal(large.focused, huge[1])
large = largeSend({ type: 'action', name: 'fullscreen', args: [] })
assert.deepEqual(large.placed.map(w => w.id), [huge[1]])
large = largeSend({ type: 'action', name: 'fullscreen', args: [] })
large = largeSend({ type: 'action', name: 'width', args: [huge[1], 0] })
const restoredSend = make()
restoredSend({ type: 'reset', saved: large.saved })
const restored = restoredSend({ type: 'reconcile', windows: huge.map(id => ({ id, fullscreen: false })), focused: huge[1], output, current: large.placed })
assert.deepEqual(restored.placed, large.placed)
assert.deepEqual(restored.state, large.state)
// A stale snapshot cannot overwrite geometry changed by another client.
const staleSend = make()
staleSend({ type: 'reset', saved: large.saved })
const stale = staleSend({ type: 'reconcile', windows: huge.map(id => ({ id, fullscreen: false })), focused: huge[1], output, current: [] })
assert.notDeepEqual(stale.state, large.state)
const malformedSend = make()
malformedSend({ type: 'reset', saved: { ...large.saved, aliases: [['1', 1], ['2', 1]] } })
const recovered = malformedSend({ type: 'reconcile', windows, focused: '2', output, current: [] })
assert.equal(recovered.focused, '2')
console.log('Native layout parity passed: canonical geometry, resize drift, fullscreen request loop, stacks, fit, workspaces, streams, orientation, UInt64 aliases, validated persistence.')
