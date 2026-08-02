/**
 * Playing the machine's audio.
 *
 * The buffering and the sample conversion live in `public/audio-worklet.js`,
 * on the audio thread, where they belong. This is the part that has to run on
 * the main thread: creating the graph, and dealing with the fact that a browser
 * will not make a sound until the user has touched the page.
 *
 * # Two playback paths, because of HTTPS
 *
 * `AudioWorklet` is a secure-context API: on plain HTTP `context.audioWorklet`
 * is simply undefined, so the worklet cannot be loaded at all. That is the
 * normal case here, since the shell is reached at `http://192.168.1.x` from a
 * tablet, and it is the same restriction that leaves the same browser without a
 * `VideoDecoder` for H.264.
 *
 * So there are two players and the same policy in both:
 *
 * - **Worklet**, when the page is secure. Buffering happens on the audio
 *   thread, which is where it belongs.
 * - **Scheduled buffers**, otherwise. Each chunk becomes an `AudioBuffer`
 *   started at an explicit time, butted against the previous one. Sample
 *   accurate because the times are computed rather than measured, and it needs
 *   no privileged API at all.
 *
 * The fallback's weakness is that it schedules from the main thread, so a long
 * task there can make it miss a start time. That is why it keeps a cushion
 * ahead of the clock rather than starting each chunk as it lands.
 *
 * # The iOS mute switch
 *
 * On iOS and iPadOS, Web Audio plays on the *ambient* audio session by
 * default, and the ambient session is silenced by the hardware ringer switch.
 * HTML5 `<audio>` elements are not. So an iPad with its mute switch on plays
 * nothing through an `AudioContext` while every other part of the pipeline
 * looks perfectly healthy: the socket is connected, the engine is capturing,
 * the worklet is receiving samples, and the speakers are silent.
 *
 * There is no way to detect this. Nothing reports "you are muted"; the audio
 * simply goes nowhere. Two things are done about it, both cheap:
 *
 * 1. `navigator.audioSession.type = "playback"`, which is Safari's own way of
 *    saying this is media rather than an incidental sound effect. Available
 *    from Safari 16.4 and ignored everywhere else.
 * 2. A silent looping `<audio>` element as a fallback for older versions.
 *    Playing *anything* through a media element moves the whole page onto the
 *    media channel, which the ringer switch does not silence. It is a trick,
 *    it is well known, and it costs one muted element.
 *
 * # Autoplay
 *
 * Every browser suspends a new `AudioContext` until a real user gesture. That
 * is not a bug to work around, it is the rule that stops pages making noise at
 * you, and lwfa is exactly the kind of page it exists for: a tab left open on a
 * desk connected to a live machine. So the context is created suspended, and
 * `resume()` is called from the press that turned audio on, which is a gesture
 * by definition. If it is turned on from a saved preference instead, on a page
 * nobody has touched yet, the resume is attempted and simply stays suspended
 * until the first tap anywhere, which `unlock` handles.
 */

const WORKLET_URL = "/audio-worklet.js"

let context: AudioContext | null = null
let node: AudioWorkletNode | null = null
let gain: GainNode | null = null
let loading: Promise<void> | null = null
let underruns = 0

/**
 * Where the next scheduled chunk starts, on the context clock. Fallback only.
 *
 * Zero means "not scheduling yet", which is also the state after an underrun.
 */
let playhead = 0

/** The silent element that keeps iOS on the media channel. See the header. */
let unmuter: HTMLAudioElement | null = null

/**
 * Ask iOS to treat this page's audio as media rather than ambient sound.
 *
 * Without it, everything works and nothing is audible whenever the hardware
 * mute switch is on, which is most of the time on a tablet.
 */
function claimMediaChannel(): void {
  // Safari 16.4+. Not in any type definition yet, hence the cast.
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
  if (session) {
    try {
      session.type = "playback"
      return
    } catch {
      // Fall through to the element trick.
    }
  }

  if (unmuter) return
  const element = document.createElement("audio")
  element.loop = true
  element.setAttribute("playsinline", "")
  // A minimal silent WAV. Inline rather than a file, because it must be
  // available before anything else loads and it is 200 bytes.
  element.src =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="
  element.volume = 0.001
  void element.play().catch(() => {
    // Blocked until a gesture, same as the context. `unlock` retries both.
  })
  unmuter = element
}

/** Cushion to keep between the clock and the next chunk, in seconds. */
const CUSHION = 0.06

/** Never let scheduled audio run further ahead than this, in seconds. */
const MAX_LEAD = 0.25

/** Listener for the underrun count, so the UI can say whether audio is healthy. */
let onUnderrun: ((count: number) => void) | null = null

export function watchUnderruns(listener: ((count: number) => void) | null): void {
  onUnderrun = listener
}

/**
 * Build the graph, once.
 *
 * Idempotent and safe to call from anywhere: several things can decide audio
 * should be running (a preference on load, a switch, a reconnect) and none of
 * them should have to know whether another already did it.
 */
export async function start(): Promise<boolean> {
  if (node) {
    await resume()
    return true
  }
  if (loading) {
    await loading
    return node !== null
  }

  loading = (async () => {
    try {
      // The rate the engine captures at. Asking for it explicitly avoids a
      // resample: a context defaulted to the output device's rate would have
      // the browser convert 48kHz to 44.1kHz for no reason, and resampling is
      // both work and a small loss.
      // Before the context exists, so the session type applies to it.
      claimMediaChannel()
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" })
      const volume = ctx.createGain()
      volume.connect(ctx.destination)

      // Secure context only. Absent over plain HTTP, which is the usual way
      // this page is reached, so the fallback is the common path rather than
      // the exotic one.
      if (ctx.audioWorklet) {
        try {
          await ctx.audioWorklet.addModule(WORKLET_URL)
          const player = new AudioWorkletNode(ctx, "lwfa-pcm", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          })
          player.port.onmessage = (event) => {
            const count = (event.data as { underruns?: number }).underruns
            if (typeof count === "number") {
              underruns = count
              onUnderrun?.(count)
            }
          }
          player.connect(volume)
          node = player
        } catch (error) {
          // Available but unusable: a stale service worker serving the wrong
          // MIME type, say. Scheduling still works, so degrade rather than go
          // silent.
          console.warn("audio worklet unavailable, scheduling buffers instead:", error)
          node = null
        }
      }

      context = ctx
      gain = volume
      playhead = 0
    } catch (error) {
      // No audio is a degraded session, not a broken one. Everything else
      // keeps working and the UI reports it.
      console.warn("audio unavailable:", error)
      context = null
      node = null
      gain = null
    }
  })()

  await loading
  loading = null
  if (context) await resume()
  // The context is what matters, not the worklet: without a worklet the
  // fallback plays perfectly well, and returning false here would mean the
  // engine was never asked to send anything.
  return context !== null
}

/** Tear the graph down and release the device. */
export async function stop(): Promise<void> {
  node?.port.postMessage("reset")
  node?.disconnect()
  gain?.disconnect()
  unmuter?.pause()
  unmuter?.remove()
  unmuter = null
  await context?.close().catch(() => {})
  context = null
  node = null
  gain = null
  playhead = 0
  underruns = 0
  chunksPlayed = 0
}

/** Hand a chunk of interleaved 16-bit PCM to whichever player is running. */
export function play(pcm: ArrayBuffer): void {
  chunksPlayed++
  if (node) {
    // Transferred, not copied: this buffer came straight off the socket and
    // nothing else refers to it, so moving it costs nothing and copying a
    // hundred kilobytes a second would.
    node.port.postMessage(pcm, [pcm])
    return
  }
  schedule(pcm)
}

/**
 * The no-worklet path: turn a chunk into a buffer and start it at a known time.
 *
 * The times are computed, not measured, so consecutive chunks butt together
 * exactly and there is no seam. Everything else here is about keeping the
 * playhead in a sensible relationship with the clock.
 */
function schedule(pcm: ArrayBuffer): void {
  const ctx = context
  const out = gain
  if (!ctx || !out || ctx.state !== "running") return

  const samples = new Int16Array(pcm)
  const channels = 2
  const frames = Math.floor(samples.length / channels)
  if (frames === 0) return

  const buffer = ctx.createBuffer(channels, frames, ctx.sampleRate)
  for (let c = 0; c < channels; c++) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < frames; i++) {
      // 32768, not 32767: signed 16-bit runs to -32768, and dividing by 32767
      // lets a full-scale negative sample come out past -1.0 and clip.
      channel[i] = samples[i * channels + c]! / 32768
    }
  }

  const now = ctx.currentTime

  // Behind the clock, or starting fresh. Anything scheduled in the past plays
  // immediately and overlaps whatever is already sounding, so re-anchor ahead
  // of the clock instead.
  if (playhead < now + 0.005) {
    if (playhead !== 0) {
      underruns++
      onUnderrun?.(underruns)
    }
    playhead = now + CUSHION
  }

  // Too far ahead: a burst after a stall, or a producer faster than this
  // clock. Playing all of it would mean drifting further behind the picture
  // every second, so drop rather than queue.
  if (playhead > now + MAX_LEAD) return

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(out)
  source.start(playhead)
  playhead += frames / ctx.sampleRate
}

/** Drop anything buffered. Used when the stream stops, so it does not resume stale. */
export function flush(): void {
  node?.port.postMessage("reset")
  // Scheduled sources already started cannot be unscheduled without tracking
  // every one of them, which for 20ms chunks means fifty objects a second of
  // bookkeeping to save 60ms of audio. Re-anchoring the playhead is enough:
  // what is already queued finishes, and nothing new is added behind it.
  playhead = 0
}

/** 0 to 1. */
export function setVolume(value: number): void {
  if (gain && context) {
    // Ramped rather than assigned: setting `value` directly steps the waveform
    // and a step is a click.
    gain.gain.setTargetAtTime(Math.min(Math.max(value, 0), 1), context.currentTime, 0.01)
  }
}

export function isRunning(): boolean {
  return context !== null && context.state === "running"
}

/** Which player is in use, for the UI to explain itself. */
export function playbackPath(): "worklet" | "scheduled" | "none" {
  if (!context) return "none"
  return node ? "worklet" : "scheduled"
}

export function underrunCount(): number {
  return underruns
}

/** Chunks handed to a player since the graph was built. */
let chunksPlayed = 0

/**
 * Everything needed to tell where audio stopped, without a debugger.
 *
 * Silence has half a dozen causes that look identical from the outside: the
 * context suspended by autoplay policy, an iOS mute switch, the engine not
 * sending, the socket not delivering, or a worklet that failed to load. On a
 * tablet none of those can be inspected. So the shell reports what it knows and
 * the person looking at it can tell in one glance which half is broken.
 */
export function diagnostics(): {
  contextState: string
  path: "worklet" | "scheduled" | "none"
  chunks: number
  underruns: number
  sampleRate: number
} {
  return {
    contextState: context?.state ?? "none",
    path: playbackPath(),
    chunks: chunksPlayed,
    underruns,
    sampleRate: context?.sampleRate ?? 0,
  }
}

async function resume(): Promise<void> {
  if (!context || context.state === "running") return
  try {
    await context.resume()
  } catch {
    // Blocked until a gesture. `unlock` picks it up.
  }
}

/**
 * Resume on the next user gesture, if the browser is still holding audio back.
 *
 * Registered once and self-removing. Without it, audio turned on from a saved
 * preference on a page that has not been touched stays silent with no
 * indication of why, and the fix (tap anything) is not one anybody guesses.
 */
export function unlock(): () => void {
  const events = ["pointerdown", "keydown", "touchstart"] as const
  const handler = () => {
    void resume()
    // The silent element is blocked by autoplay rules too, and it is the half
    // that decides whether anything is audible at all on a muted iPad.
    if (unmuter?.paused) void unmuter.play().catch(() => {})
    if (context?.state === "running") remove()
  }
  const remove = () => {
    for (const event of events) document.removeEventListener(event, handler)
  }
  for (const event of events) document.addEventListener(event, handler, { passive: true })
  return remove
}
