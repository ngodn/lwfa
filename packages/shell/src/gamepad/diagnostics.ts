import type { PadMessage } from "./physical"

const LIMIT = 4096

interface Sample {
  at: number
  live: boolean
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

  start(): void {
    this.rows = []
    this.next = 0
    this.total = 0
    this.recording = true
  }

  sample(at: number, pads: readonly (Gamepad | null)[], live: boolean, messages: PadMessage[]): void {
    if (!this.recording) return
    this.rows[this.next] = {
      at,
      live,
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
    for (let i = 1; i < samples.length; i++) {
      maxPollGapMs = Math.max(maxPollGapMs, samples[i]!.at - samples[i - 1]!.at)
    }
    return {
      schemaVersion: 1,
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
