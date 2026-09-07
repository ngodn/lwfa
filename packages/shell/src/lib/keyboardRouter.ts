import { evdevFromCode, isDialogControl, isShellKey, isTextEntry } from "../input.js"

/** Own forwarded keys until release, even when a shell dialog takes focus. */
export function createKeyboardRouter(send: (key: number, pressed: boolean) => void) {
  const held = new Set<number>()
  const local = (target: EventTarget | null) => isTextEntry(target) || isDialogControl(target)
  const releaseAll = () => {
    for (const key of held) send(key, false)
    held.clear()
  }
  return {
    forward(event: KeyboardEvent, pressed: boolean) {
      const key = evdevFromCode(event.code)
      if (key === null) return
      if (!pressed) {
        if (!held.delete(key)) return
        // Let a focused dialog still handle its own navigation on keyup.
        if (!local(event.target)) event.preventDefault()
        send(key, false)
        return
      }
      if (isShellKey(event) || event.repeat || local(event.target)) return
      event.preventDefault()
      held.add(key)
      send(key, true)
    },
    focus(target: EventTarget | null) {
      if (local(target)) releaseAll()
    },
    releaseAll,
  }
}
