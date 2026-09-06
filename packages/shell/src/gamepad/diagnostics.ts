import type { PadMessage } from "./physical"

const LIMIT = 4096

interface Sample {
  at: number
  live: boolean
  mode: "forwarding" | "suspended" | "offline" | "release"
  focused: boolean | null
  visible: boolean | null
  pads: {
    index: number
    id: string
    mapping: string
    timestamp: number
    buttons: { pressed: boolean; value: number }[]
    axes: number[]
  }[]
  messages: PadMessage[]
}

/** Opt-in and bounded. This records API samples, not physical hardware events. */
export class ControllerTrace {
  recording = false
  private rows: Sample[] = []
  private next = 0
  private total = 0
  private startedAt = ""

  start(): void {
    this.rows = []
    this.next = 0
    this.total = 0
    this.startedAt = new Date().toISOString()
    this.recording = true
  }

  sample(at: number, pads: readonly (Gamepad | null)[], live: boolean, messages: PadMessage[], mode: Sample["mode"] = "forwarding"): void {
    if (!this.recording) return
    this.rows[this.next] = {
      at,
      live,
      mode,
      focused: typeof document === "undefined" ? null : document.hasFocus(),
      visible: typeof document === "undefined" ? null : document.visibilityState === "visible",
      pads: pads.flatMap((pad) => pad ? [{
        index: pad.index,
        id: pad.id,
        mapping: pad.mapping,
        timestamp: pad.timestamp,
        buttons: pad.buttons.map(({ pressed, value }) => ({ pressed, value })),
        axes: [...pad.axes],
      }] : []),
      messages: messages.map((message) => ({ ...message })),
    }
    this.next = (this.next + 1) % LIMIT
    this.total++
  }

  stop() {
    this.recording = false
    const samples = this.total > LIMIT
      ? [...this.rows.slice(this.next), ...this.rows.slice(0, this.next)]
      : [...this.rows]
    let maxPollGapMs = 0
    let previousPoll: number | null = null
    for (const sample of samples) {
      if (sample.mode === "release") continue
      if (previousPoll !== null) maxPollGapMs = Math.max(maxPollGapMs, sample.at - previousPoll)
      previousPoll = sample.at
    }
    return {
      schemaVersion: 2,
      startedAt: this.startedAt,
      timeOrigin: performance.timeOrigin,
      totalSamples: this.total,
      maxPollGapMs,
      // These are calls to the shell send action, not delivery acknowledgments.
      sampledPresses: samples.reduce((n, s) => n + s.messages.filter(
        (m) => m.type === "gamepadButton" && m.pressed,
      ).length, 0),
      samples,
    }
  }
}

export const controllerTrace = new ControllerTrace()
