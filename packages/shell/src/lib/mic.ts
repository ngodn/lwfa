/**
 * This device's microphone, fed to the desktop.
 *
 * # The pipeline
 *
 * `getUserMedia` → `AudioWorklet` (20ms s16 chunks, converted on the audio
 * thread, see `public/audio-worklet.js`) → Opus via WebCodecs when the
 * browser has an `AudioEncoder`, raw PCM when it does not → one tagged
 * binary WebSocket message per chunk. The engine decodes and plugs it into a
 * machine-visible virtual source, so anything on the desktop that asks for a
 * microphone hears this device. See `crates/lwfa-engine/src/mic.rs`.
 *
 * # Adapting to the network, in the same spirit as the downlink
 *
 * The socket's `bufferedAmount` is the uplink's honest backpressure signal:
 * bytes the kernel has not taken yet. When it is deep the right move is to
 * drop the chunk, not queue it: a mic running seconds behind the speaker is
 * broken in a way a missed syllable is not. Sustained pressure also steps the
 * Opus bitrate down, and a stretch of clean sends climbs it back, mirroring
 * the eager-climb/backoff shape of the video controller in miniature.
 *
 * # Why this is not a persisted preference
 *
 * A microphone that turns itself on because a page reloaded is a surprise no
 * saved setting is worth. The switch lives in session state: every session
 * starts muted and someone presses the button, which also happens to be the
 * user gesture the browser wants before it will run an `AudioContext`.
 */

import { useSyncExternalStore } from "react"
import { MIC_TAG_OPUS, MIC_TAG_PCM } from "@lwfa/proto"

/** What the rest of the shell needs to know about the microphone. */
export type MicState =
  | { phase: "off" }
  | { phase: "starting" }
  | { phase: "live"; opus: boolean }
  /** `reason` is already user-legible; the settings panel shows it as-is. */
  | { phase: "error"; reason: string }

/** The transport the capture feeds. `Connection`, without importing it. */
export interface MicSink {
  sendBinary(data: Uint8Array): void
  bufferedAmount(): number
}

let state: MicState = { phase: "off" }
/** Whether the user wants the mic on, distinct from whether it is running. */
let wanted = false
const listeners = new Set<() => void>()

function emit(next: MicState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getState = (): MicState => state
const getWanted = (): boolean => wanted

export function useMicState(): MicState {
  return useSyncExternalStore(subscribe, getState, getState)
}

export function useMicWanted(): boolean {
  return useSyncExternalStore(subscribe, getWanted, getWanted)
}

/** Flip the user's intent. The capture itself follows in `App`'s effect. */
export function setMicWanted(next: boolean): void {
  if (wanted === next) return
  wanted = next
  for (const listener of listeners) listener()
}

// --------------------------------------------------------------------------
// The capture

/** Matches the engine's decoder and the worklet's chunking. */
const SAMPLE_RATE = 48_000

/**
 * Opus bitrate steps, in bits per second. Voice is transparent well below
 * where music is; 32k is the comfortable default and 16k is still perfectly
 * intelligible speech, which is the point of the bottom step existing.
 */
const OPUS_STEPS = [16_000, 24_000, 32_000, 48_000] as const
const OPUS_START = 2

/**
 * Send-buffer depth that reads as congestion, in bytes. About 400ms of PCM
 * or several seconds of Opus: if this much is sitting unhanded to the
 * kernel, adding more only makes the mic later.
 */
const PRESSURE_BYTES = 32_768

/** Clean sends required before climbing a step: ten seconds' worth. */
const CLIMB_AFTER_CHUNKS = 500

/** A running capture. `stop` is idempotent. */
export interface RunningMic {
  stop(): void
}

/**
 * Start capturing and feeding the sink. Resolves once audio is flowing, or
 * rejects with a user-legible reason (permission refused, no device, no
 * secure context). State transitions are published to the store either way.
 */
export async function startMic(sink: MicSink): Promise<RunningMic> {
  emit({ phase: "starting" })

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "The browser refused microphone access. Allow it in the site settings."
        : error instanceof DOMException && error.name === "NotFoundError"
          ? "No microphone on this device."
          : "Could not open the microphone."
    emit({ phase: "error", reason })
    throw new Error(reason)
  }

  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" })
  // The same worklet file the playback path uses; it registers both
  // processors. Secure-context only, like everything else about the mic.
  if (!context.audioWorklet) {
    stream.getTracks().forEach((track) => track.stop())
    void context.close()
    const reason = "Microphone streaming needs HTTPS."
    emit({ phase: "error", reason })
    throw new Error(reason)
  }
  await context.audioWorklet.addModule("/audio-worklet.js")
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, "lwfa-mic", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  })
  source.connect(node)

  const encoder = makeEncoder(sink)
  node.port.onmessage = (event: MessageEvent) => {
    const pcm = (event.data as { pcm?: Int16Array }).pcm
    if (pcm) encoder.chunk(pcm)
  }

  let stopped = false
  emit({ phase: "live", opus: encoder.opus })

  return {
    stop() {
      if (stopped) return
      stopped = true
      node.port.onmessage = null
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      encoder.close()
      void context.close()
      emit({ phase: "off" })
    },
  }
}

interface Encoder {
  /** True when chunks go out as Opus rather than PCM. */
  opus: boolean
  chunk(pcm: Int16Array): void
  close(): void
}

/**
 * The Opus path, with the PCM fallback decided once at start.
 *
 * `AudioEncoder` is checked by existence rather than sniffed by UA: Safari
 * gained it late and partially, and the truthful question is "is it here".
 */
function makeEncoder(sink: MicSink): Encoder {
  if (typeof AudioEncoder === "undefined") return pcmEncoder(sink)
  try {
    return opusEncoder(sink)
  } catch {
    return pcmEncoder(sink)
  }
}

function pcmEncoder(sink: MicSink): Encoder {
  return {
    opus: false,
    chunk(pcm) {
      // PCM is heavy enough that the only adaptation that helps is dropping.
      if (sink.bufferedAmount() > PRESSURE_BYTES) return
      const out = new Uint8Array(1 + pcm.byteLength)
      out[0] = MIC_TAG_PCM
      out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1)
      sink.sendBinary(out)
    },
    close() {},
  }
}

function opusEncoder(sink: MicSink): Encoder {
  let step = OPUS_START
  let clean = 0
  let timestamp = 0

  const configure = (encoder: AudioEncoder) =>
    encoder.configure({
      codec: "opus",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: OPUS_STEPS[step] ?? OPUS_STEPS[OPUS_START],
    })

  let encoder = new AudioEncoder({
    output(packet) {
      const payload = new Uint8Array(packet.byteLength)
      packet.copyTo(payload)
      const out = new Uint8Array(1 + payload.byteLength)
      out[0] = MIC_TAG_OPUS
      out.set(payload, 1)
      sink.sendBinary(out)
    },
    error(error) {
      // A dead encoder mid-call is a mic that silently stopped; surface it.
      emit({ phase: "error", reason: `Microphone encoder failed: ${error.message}` })
    },
  })
  configure(encoder)

  const move = (next: number) => {
    if (next === step) return
    step = next
    clean = 0
    // Reconfiguring restarts the Opus stream; the engine's decoder rides
    // through it as a brief artifact at worst. Rare by construction: drops
    // are damped by the climb counter and the step bounds.
    configure(encoder)
  }

  return {
    opus: true,
    chunk(pcm) {
      if (encoder.state === "closed") return
      if (sink.bufferedAmount() > PRESSURE_BYTES) {
        // Drop this chunk and spend fewer bits on the ones that follow.
        move(Math.max(0, step - 1))
        return
      }
      clean++
      if (clean >= CLIMB_AFTER_CHUNKS) move(Math.min(OPUS_STEPS.length - 1, step + 1))

      const data = new AudioData({
        format: "s16",
        sampleRate: SAMPLE_RATE,
        numberOfFrames: pcm.length,
        numberOfChannels: 1,
        timestamp,
        // A fresh worklet transfer always sits on a plain ArrayBuffer; the
        // cast papers over TypeScript's SharedArrayBuffer-shaped doubt.
        data: pcm as Int16Array<ArrayBuffer>,
      })
      timestamp += Math.round((pcm.length / SAMPLE_RATE) * 1_000_000)
      encoder.encode(data)
      data.close()
    },
    close() {
      if (encoder.state !== "closed") encoder.close()
    },
  }
}
