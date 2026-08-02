/**
 * This device's camera, fed to the desktop.
 *
 * The mic's twin (`mic.ts`): `getUserMedia` video, sampled into
 * `VideoFrame`s off a hidden `<video>` element (the one construction path
 * Safari and Chromium share), encoded H.264 Annex-B by WebCodecs, one tagged
 * binary message per frame. The engine decodes and lands it in a
 * machine-visible virtual camera; see `crates/lwfa-engine/src/camera.rs`.
 *
 * Adaptation mirrors the mic's: `bufferedAmount` is the backpressure, a deep
 * queue skips the frame (a camera behind the face in front of it is broken
 * in a way a dropped frame is not) and steps the bitrate down; a clean
 * stretch climbs it back. The camera degrades before the mic by design,
 * since broken audio ruins a call before choppy video does.
 *
 * Like the mic, deliberately session state rather than a preference: a
 * camera that turns itself on after a reload is worse than one that asks.
 */

import { useSyncExternalStore } from "react"
import { CAM_TAG } from "@lwfa/proto"

export type CameraState =
  | { phase: "off" }
  | { phase: "starting" }
  | { phase: "live" }
  | { phase: "error"; reason: string }

/** The transport, shaped like the mic's sink so `App` passes one object. */
export interface CameraSink {
  sendBinary(data: Uint8Array): void
  bufferedAmount(): number
}

let state: CameraState = { phase: "off" }
let wanted = false
const listeners = new Set<() => void>()

function emit(next: CameraState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getState = (): CameraState => state
const getWanted = (): boolean => wanted

export function useCameraState(): CameraState {
  return useSyncExternalStore(subscribe, getState, getState)
}

export function useCameraWanted(): boolean {
  return useSyncExternalStore(subscribe, getWanted, getWanted)
}

export function setCameraWanted(next: boolean): void {
  if (wanted === next) return
  wanted = next
  for (const listener of listeners) listener()
}

/** Modest on purpose: this is a meeting face, not a film. */
const WIDTH = 1280
const HEIGHT = 720
const FPS = 24

/** Bits per second, worst to best. 600k is fine 720p24 talking-head H.264. */
const RATE_STEPS = [300_000, 600_000, 1_200_000, 2_500_000] as const
const RATE_START = 1

/** A keyframe every 2 seconds, so the desktop side recovers fast. */
const KEYFRAME_EVERY = FPS * 2

/** Deeper than the mic's threshold: video frames are big and bursty. */
const PRESSURE_BYTES = 256 * 1024

/** Clean frames before climbing a step: ten seconds' worth. */
const CLIMB_AFTER = FPS * 10

export interface RunningCamera {
  stop(): void
}

/** Start capturing and feeding the sink, or reject with a legible reason. */
export async function startCamera(sink: CameraSink): Promise<RunningCamera> {
  emit({ phase: "starting" })

  if (typeof VideoEncoder === "undefined") {
    const reason = "Camera streaming needs a browser with WebCodecs, over HTTPS."
    emit({ phase: "error", reason })
    throw new Error(reason)
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: WIDTH, height: HEIGHT, frameRate: FPS },
    })
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "The browser refused camera access. Allow it in the site settings."
        : error instanceof DOMException && error.name === "NotFoundError"
          ? "No camera on this device."
          : "Could not open the camera."
    emit({ phase: "error", reason })
    throw new Error(reason)
  }

  // A parked <video> is the frame source both engines support; the track's
  // real dimensions come from it once playback starts.
  const video = document.createElement("video")
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play().catch(() => {})
  const width = video.videoWidth || WIDTH
  const height = video.videoHeight || HEIGHT

  let step = RATE_START
  let clean = 0
  let stopped = false

  const encoder = new VideoEncoder({
    output(chunk) {
      const payload = new Uint8Array(chunk.byteLength)
      chunk.copyTo(payload)
      const framed = new Uint8Array(1 + payload.byteLength)
      framed[0] = CAM_TAG
      framed.set(payload, 1)
      sink.sendBinary(framed)
    },
    error(error) {
      if (!stopped) emit({ phase: "error", reason: `Camera encoder failed: ${error.message}` })
    },
  })
  const configure = () =>
    encoder.configure({
      codec: "avc1.42E01F",
      width,
      height,
      bitrate: RATE_STEPS[step] ?? RATE_STEPS[RATE_START],
      framerate: FPS,
      latencyMode: "realtime",
      avc: { format: "annexb" },
    })
  configure()

  const move = (next: number) => {
    if (next === step) return
    step = next
    clean = 0
    configure()
  }

  let counter = 0
  let timestamp = 0
  const interval = globalThis.setInterval(() => {
    if (stopped || encoder.state === "closed") return
    // Backpressure first: skipping before encoding saves the whole cost.
    if (sink.bufferedAmount() > PRESSURE_BYTES) {
      move(Math.max(0, step - 1))
      return
    }
    clean++
    if (clean >= CLIMB_AFTER) move(Math.min(RATE_STEPS.length - 1, step + 1))
    // Encoder still swallowing earlier frames: feeding more only queues
    // stale pictures. Skip, exactly like a socket that is not draining.
    if (encoder.encodeQueueSize > 2) return

    const frame = new VideoFrame(video, { timestamp })
    timestamp += Math.round(1_000_000 / FPS)
    encoder.encode(frame, { keyFrame: counter % KEYFRAME_EVERY === 0 })
    counter++
    frame.close()
  }, 1000 / FPS)

  emit({ phase: "live" })

  return {
    stop() {
      if (stopped) return
      stopped = true
      globalThis.clearInterval(interval)
      if (encoder.state !== "closed") encoder.close()
      stream.getTracks().forEach((track) => track.stop())
      video.srcObject = null
      emit({ phase: "off" })
    },
  }
}
