import { afterEach, describe, expect, it, vi } from "vitest"
import { createKeyboardRouter } from "../src/lib/keyboardRouter.js"

class Element {
  isContentEditable = false
  type = "text"
  constructor(public tagName: string, private dialog = false) {}
  closest() { return this.dialog ? this : null }
}
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  vi.stubGlobal("HTMLElement", Element)
  const send = vi.fn()
  const router = createKeyboardRouter(send)
  const key = (target: Element, code = "KeyW") => ({
    code, target, repeat: false, preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent
  return { send, router, key, game: new Element("DIV"), dialog: new Element("BUTTON", true), field: new Element("INPUT") }
}

describe("remote keyboard ownership across shell focus changes", () => {
  it.each(["dialog", "field"] as const)("releases a game key when keyup arrives in a %s", target => {
    const f = fixture()
    f.router.forward(f.key(f.game), true)
    const up = f.key(f[target])
    f.router.forward(up, false)
    expect(f.send.mock.calls).toEqual([[17, true], [17, false]])
    expect(up.preventDefault).not.toHaveBeenCalled()
  })
  it.each(["dialog", "field"] as const)("releases held keys immediately when a %s takes focus", target => {
    const f = fixture()
    f.router.forward(f.key(f.game), true)
    f.router.focus(f[target] as unknown as EventTarget)
    f.router.forward(f.key(f[target]), false)
    expect(f.send.mock.calls).toEqual([[17, true], [17, false]])
  })
  it.each(["Tab", "Enter", "Escape"])("keeps %s local to the confirmation dialog", code => {
    const f = fixture()
    const event = f.key(f.dialog, code)
    f.router.forward(event, true)
    f.router.forward(event, false)
    expect(f.send).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    f.router.forward(f.key(f.game, code), true)
    expect(f.send).toHaveBeenCalledOnce()
  })
  it("releases once on blur and leaves subsequent keyup harmless", () => {
    const f = fixture()
    f.router.forward(f.key(f.game), true)
    f.router.releaseAll()
    f.router.releaseAll()
    f.router.forward(f.key(f.game), false)
    expect(f.send.mock.calls).toEqual([[17, true], [17, false]])
  })
})
