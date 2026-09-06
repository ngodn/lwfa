import { expect, it } from "vitest"
import { ControllerTrace } from "../src/gamepad/diagnostics"

it("only records on request and keeps the newest samples in time order", () => {
  const trace = new ControllerTrace()
  trace.sample(0, [], true, [])
  expect(trace.stop().totalSamples).toBe(0)
  trace.start()
  for (let i = 0; i < 5000; i++) trace.sample(i * 8, [], true, [])
  const saved = trace.stop()
  expect(saved.totalSamples).toBe(5000)
  expect(saved.samples).toHaveLength(4096)
  expect(saved.samples[0]?.at).toBe(904 * 8)
  expect(saved.samples.at(-1)?.at).toBe(4999 * 8)
  expect(saved.maxPollGapMs).toBe(8)
  trace.start()
  expect(trace.stop().samples).toEqual([])
})

it("copies raw API values independently of later gamepad mutation", () => {
  const trace = new ControllerTrace()
  const pad = { index: 0, id: "test", mapping: "standard", timestamp: 10,
    buttons: [{ pressed: false, value: 1 }], axes: [0.5] } as unknown as Gamepad
  trace.start()
  trace.sample(10, [pad], true, [])
  Object.assign(pad.buttons[0]!, { pressed: true, value: 0 })
  trace.sample(90, [pad], false, [])
  const saved = trace.stop()
  expect(saved.samples[0]?.pads[0]?.buttons[0]).toEqual({ pressed: false, value: 1 })
  expect(saved.maxPollGapMs).toBe(80)
  expect(saved.sampledPresses).toBe(0)
  expect(saved.samples[1]?.live).toBe(false)
})
