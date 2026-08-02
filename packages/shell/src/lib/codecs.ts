/**
 * Asking the browser what it can actually decode.
 *
 * # Why this is asked rather than assumed
 *
 * The shell used to report one boolean, "can I do H.264", and answered it by
 * checking whether `VideoDecoder` existed at all. That is not the same
 * question. A browser can expose WebCodecs and still refuse a codec, and which
 * codecs it refuses depends on the machine, not on the browser: HEVC decoding
 * is a hardware feature, and two devices running identical Safari versions
 * differ on it.
 *
 * The tempting shortcut is to decide from the user agent, something like
 * "Apple devices get HEVC". It is wrong in both directions. An iPad older than
 * the A9 has no HEVC decoder; plenty of Windows and Android machines have had
 * one for a decade. Guessing produces a client that either gets a stream it
 * cannot play, which is a black window, or is denied one it could have used.
 *
 * `VideoDecoder.isConfigSupported()` answers the real question, so the client
 * asks it and tells the engine the answer.
 *
 * # Why the codec strings look like that
 *
 * They are RFC 6381 codec parameters, the same form a `<video>` element takes.
 * The probe uses a conservative profile and level for each: the aim is "can
 * this device decode this family at all", and a device that can do Main profile
 * can do everything the engine will send. The real level comes from the stream
 * itself once frames arrive.
 */

/** A codec the engine can encode and a browser might be able to decode. */
export type Codec = "hevc" | "h264"

/**
 * In the order the engine should prefer them.
 *
 * HEVC first: it is roughly a third fewer bits than H.264 for the same quality,
 * which over a phone connection is the difference between usable and not.
 *
 * AV1 is deliberately absent. It compresses better still, but hardware decode
 * needs an A17 Pro or M3 and Apple ships no software fallback, so on the
 * devices this project exists for it is mostly unavailable. It also needs an
 * Ada-generation card to encode, which this machine does not have. Worth
 * revisiting, not worth shipping.
 */
export const PREFERENCE: readonly Codec[] = ["hevc", "h264"]

/**
 * What to hand `isConfigSupported` for each family.
 *
 * `hvc1.1.6.L93.B0` is HEVC Main, level 3.1. `avc1.42E01E` is H.264
 * Constrained Baseline, level 3.0.
 */
const PROBE: Record<Codec, string> = {
  hevc: "hvc1.1.6.L93.B0",
  h264: "avc1.42E01E",
}

/**
 * A size to probe at.
 *
 * Some implementations answer differently for sizes their hardware cannot
 * manage, so asking at a plausible desktop size is more honest than asking at
 * 16 by 16 and discovering the truth later.
 */
const PROBE_SIZE = { codedWidth: 1920, codedHeight: 1080 }

/**
 * Which codecs this browser can decode, best first.
 *
 * Empty means WebCodecs is unavailable or nothing was accepted, and the caller
 * should fall back to JPEG. That is a real case rather than a defensive one:
 * `VideoDecoder` is secure-context only, so a tablet reaching this over plain
 * HTTP on a LAN address has no decoder at all.
 */
export async function decodable(): Promise<Codec[]> {
  const decoder = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder
  if (!decoder?.isConfigSupported) return []

  const answers = await Promise.all(
    PREFERENCE.map(async (codec) => {
      try {
        const support = await decoder.isConfigSupported({ codec: PROBE[codec], ...PROBE_SIZE })
        return support.supported === true ? codec : null
      } catch {
        // A rejected promise means the configuration was not merely
        // unsupported but malformed for this implementation. Same outcome.
        return null
      }
    }),
  )
  return answers.filter((codec): codec is Codec => codec !== null)
}

/**
 * Pick what to send, given what a client can take.
 *
 * Pure, and shared with the engine's own choice by being the same rule written
 * once: the first codec in preference order that the client accepts.
 */
export function choose(supported: readonly Codec[]): Codec | null {
  return PREFERENCE.find((codec) => supported.includes(codec)) ?? null
}

/**
 * Pick what to send to *everyone*, given several clients.
 *
 * The engine encodes a window once and fans the result out, so a mixed set of
 * clients has to agree. The best codec every one of them accepts, or nothing,
 * which means JPEG.
 *
 * Deliberately not "encode twice": a second encode is a second NVENC session
 * per window, and the session limit is what the whole streaming budget is
 * measured against.
 */
export function chooseForAll(clients: readonly (readonly Codec[])[]): Codec | null {
  if (clients.length === 0) return null
  return PREFERENCE.find((codec) => clients.every((client) => client.includes(codec))) ?? null
}

/**
 * Can this browser decode Opus?
 *
 * `AudioDecoder` is secure-context only, exactly like `VideoDecoder`, so a page
 * on plain HTTP over a LAN cannot however new the browser is. Asked rather than
 * assumed for the same reason the video codecs are.
 */
export async function decodesOpus(): Promise<boolean> {
  const decoder = (globalThis as { AudioDecoder?: typeof AudioDecoder }).AudioDecoder
  if (!decoder?.isConfigSupported) return false
  try {
    const support = await decoder.isConfigSupported({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
    })
    return support.supported === true
  } catch {
    return false
  }
}
