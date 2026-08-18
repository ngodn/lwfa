/**
 * Plays the PCM the engine sends, on the audio thread.
 *
 * # Why a worklet and not an AudioBufferSourceNode per chunk
 *
 * Chunks arrive every 20ms. Scheduling a node per chunk means creating and
 * garbage-collecting fifty objects a second on the main thread and relying on
 * `start(when)` to butt them together exactly; miss by a sample and you get a
 * click, miss by a frame and you get a gap. A worklet runs on the audio thread,
 * pulls from a ring buffer, and never has a seam to get wrong.
 *
 * # Why a ring buffer
 *
 * The two sides run at different rates and neither can wait for the other. The
 * network delivers 960 frames at a time, whenever the socket happens to wake;
 * the audio thread asks for 128 frames on a hard schedule and cannot block. A
 * ring buffer is the only structure that lets a producer and a consumer of
 * different sizes meet without one of them allocating on the audio thread,
 * which is forbidden: a garbage collection there is an audible dropout.
 *
 * # Latency, and why it is bounded rather than minimised
 *
 * Playing the instant a chunk arrives would mean the smallest possible delay
 * and a dropout on every jitter spike, because there would be nothing in hand
 * when the next chunk was late. So playback waits until a small cushion has
 * built up, and if the cushion grows past a ceiling (a burst after a stall, or
 * a client whose clock runs slow) the oldest audio is discarded rather than
 * played, because being a second behind is worse than a moment of silence: on a
 * desktop the sound is a response to something you did, and late is wrong.
 */

/** Frames of cushion to build before starting. About 60ms at 48kHz. */
const PREBUFFER_FRAMES = 2880

/**
 * Frames of cushion to allow before discarding. About 250ms.
 *
 * Generous enough to ride out normal wifi jitter, tight enough that nobody
 * perceives the delay as lag on a key press.
 */
const MAX_FRAMES = 12000

/**
 * Above this the cushion is bigger than it needs to be. About 120ms.
 *
 * The ceiling above is an emergency brake, and for a long time it was also the
 * only thing that ever removed a frame. That is not a jitter buffer, it is a
 * ratchet: a burst (the backlog arriving all at once when a stalled connection
 * comes back) fills the ring to the ceiling, and because sound is produced and
 * consumed at exactly the same rate, it then *stays* at the ceiling for the
 * rest of the session. Every recovered stall permanently added a fifth of a
 * second between what you press and what you hear.
 *
 * So there is a second, much lower mark that the buffer is actively brought
 * back down to. Twice the cushion, so ordinary jitter never reaches it.
 */
const DRIFT_CEILING = PREBUFFER_FRAMES * 2

/**
 * How loud a block may be and still be a place to drop samples.
 *
 * Discarding audio makes a click, unless it is discarded where there is
 * nothing to hear. A desktop is quiet most of the time (between keystrokes,
 * between notification sounds, in every gap in speech), so waiting for a
 * quiet block costs nothing and this converges within a second or two of
 * real use. If sound genuinely never stops, the extra cushion stays, which
 * is the right trade: continuous audio is also the case where a click is
 * most obvious.
 */
const QUIET_PEAK = 0.02

/** Capacity. Comfortably above the ceiling so the ring never wraps onto itself. */
const CAPACITY = 48000

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = 2
    // One Float32Array per channel, planar, because that is what `process`
    // hands out and converting per callback would be work on the audio thread.
    this.ring = [new Float32Array(CAPACITY), new Float32Array(CAPACITY)]
    this.read = 0
    this.write = 0
    this.available = 0
    /** Filling the cushion. No output until it is full. */
    this.priming = true
    /** Reported back so the UI can show whether audio is actually flowing. */
    this.underruns = 0

    this.port.onmessage = (event) => {
      const data = event.data
      if (data === "reset") {
        this.read = 0
        this.write = 0
        this.available = 0
        this.priming = true
        return
      }
      // What the ring is holding, so the page can show a number rather than
      // leaving somebody to guess whether the delay they can hear is the
      // network or this buffer. See `lib/audio`.
      if (data === "report") {
        this.port.postMessage({ buffered: this.available, underruns: this.underruns })
        return
      }
      // Decoded Opus arrives as float planes, which is what the ring already
      // stores, so it goes straight in with no per-sample conversion.
      if (data.planes) {
        this.#pushPlanes(data.planes[0], data.planes[1])
        return
      }
      // Wire PCM arrives as the whole socket message, transferred, with the
      // sample view's position in it. Sent that way so the main thread never
      // has to copy the payload out from behind the header.
      if (data.pcm) {
        this.#push(new Int16Array(data.pcm, data.at, data.length))
        return
      }
      if (data instanceof ArrayBuffer) this.#push(new Int16Array(data))
    }
  }

  /** Make room for this many frames, dropping the oldest when too far behind. */
  #reserve(frames) {
    // See the note on latency above: bounded, not minimised.
    if (this.available + frames > MAX_FRAMES) {
      const drop = this.available + frames - MAX_FRAMES
      this.read = (this.read + drop) % CAPACITY
      this.available -= drop
    }
  }

  #commit(frames) {
    this.write = (this.write + frames) % CAPACITY
    this.available += frames
    if (this.priming && this.available >= PREBUFFER_FRAMES) this.priming = false
  }

  /** Copy float planes into the planar ring. Already the ring's own format. */
  #pushPlanes(left, right) {
    const frames = left.length
    this.#reserve(frames)
    for (let i = 0; i < frames; i++) {
      const at = (this.write + i) % CAPACITY
      this.ring[0][at] = left[i]
      this.ring[1][at] = right[i]
    }
    this.#commit(frames)
  }

  /** Convert interleaved 16-bit samples into the planar ring. */
  #push(samples) {
    const frames = Math.floor(samples.length / this.channels)
    this.#reserve(frames)

    for (let i = 0; i < frames; i++) {
      const at = (this.write + i) % CAPACITY
      for (let c = 0; c < this.channels; c++) {
        // 32768 rather than 32767: signed 16-bit runs to -32768, so dividing by
        // 32767 lets a full-scale negative sample come out just past -1.0 and
        // clip. Inaudible on most material and wrong on all of it.
        this.ring[c][at] = samples[i * this.channels + c] / 32768
      }
    }
    this.#commit(frames)
  }

  /**
   * Drop the excess cushion, if the next block is quiet enough to hide it.
   *
   * Peak rather than RMS: a single loud sample either side of the cut is what
   * makes the click, and an average happily reports "quiet" for a block with
   * one spike in it.
   */
  #shed(frames) {
    let peak = 0
    for (let i = 0; i < frames; i++) {
      const at = (this.read + i) % CAPACITY
      for (let c = 0; c < this.channels; c++) {
        const sample = this.ring[c][at]
        const size = sample < 0 ? -sample : sample
        if (size > peak) peak = size
      }
    }
    if (peak > QUIET_PEAK) return

    // Only ever back to the mark, never below: dropping to the prime level
    // would leave nothing in hand for the next late chunk.
    const drop = Math.min(this.available - DRIFT_CEILING, frames)
    if (drop <= 0) return
    this.read = (this.read + drop) % CAPACITY
    this.available -= drop
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const frames = output[0].length

    // Give back any cushion that is not being used, when it can be done
    // silently. See `DRIFT_CEILING`.
    if (!this.priming && this.available > DRIFT_CEILING) this.#shed(frames)

    if (this.priming || this.available < frames) {
      // Silence, not stale audio. Repeating the last buffer to cover a gap is
      // a well-known trick and it sounds like a stutter; a short silence is
      // the honest version of the same thing.
      for (const channel of output) channel.fill(0)
      if (!this.priming) {
        this.underruns++
        // Re-prime, so one late chunk does not leave playback permanently
        // running on empty and clicking every callback.
        this.priming = true
        this.port.postMessage({ underruns: this.underruns })
      }
      return true
    }

    for (let i = 0; i < frames; i++) {
      const at = (this.read + i) % CAPACITY
      for (let c = 0; c < output.length; c++) {
        output[c][i] = this.ring[Math.min(c, this.channels - 1)][at]
      }
    }
    this.read = (this.read + frames) % CAPACITY
    this.available -= frames
    return true
  }
}

registerProcessor("lwfa-pcm", PcmPlayer)
