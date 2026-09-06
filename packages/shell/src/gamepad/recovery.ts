/** Explicit recovery must not immediately re-press a stale browser snapshot. */
export const RESET_PHYSICAL_GAMEPAD = "lwfa:reset-physical-gamepad"

export function resetPhysicalGamepad(): void {
  globalThis.dispatchEvent(new Event(RESET_PHYSICAL_GAMEPAD))
}

/** Each held control rearms independently when the browser reports neutral. */
export class GamepadRecovery {
  private blocked = new Map<number, { buttons: Set<number>; axes: Set<number> }>()

  reset(pads: readonly (Gamepad | null)[]): void {
    this.blocked.clear()
    for (const pad of pads) {
      if (!pad || pad.connected === false || pad.mapping !== "standard") continue
      this.blocked.set(pad.index, {
        buttons: new Set(pad.buttons.flatMap((b, i) => b.pressed || b.value > 0.02 ? [i] : [])),
        axes: new Set(pad.axes.flatMap((v, i) => Math.abs(v) >= 0.12 ? [i] : [])),
      })
    }
  }

  forget(index: number): void {
    this.blocked.delete(index)
  }

  filter(pads: readonly (Gamepad | null)[]): (Gamepad | null)[] {
    return pads.map((pad) => {
      if (!pad) return null
      const blocked = this.blocked.get(pad.index)
      if (!blocked) return pad
      const buttons = pad.buttons.map((button, i) => {
        if (!button.pressed && button.value <= 0.02) blocked.buttons.delete(i)
        return blocked.buttons.has(i) ? { pressed: false, touched: false, value: 0 } : button
      })
      const axes = pad.axes.map((value, i) => {
        if (Math.abs(value) < 0.12) blocked.axes.delete(i)
        return blocked.axes.has(i) ? 0 : value
      })
      if (!blocked.buttons.size && !blocked.axes.size) this.blocked.delete(pad.index)
      // Native Gamepad properties can be prototype getters, not own properties.
      return { ...pad, index: pad.index, mapping: pad.mapping, connected: pad.connected, buttons, axes }
    })
  }
}
