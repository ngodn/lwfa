/**
 * Measuring what the engine actually sent, from inside a running session.
 *
 * # Why this exists
 *
 * VS Code arrives with a black band down its right edge, full height, roughly
 * a twentieth of its width. The band is not the shell's doing: the canvas
 * backing store is sized to the frame and stretched to the box, so a frame of
 * any size fills its window and no part of the container can show through.
 * The black is therefore in the pixels the engine encoded.
 *
 * That points at capture. The engine sizes each buffer from
 * `window.geometry().size`, clears it, and paints the client's surface tree
 * into it. Anything the client has not painted stays the clear colour. A
 * window whose declared geometry is wider than the buffer it last committed
 * would produce exactly this: one unpainted strip, full height, on one side.
 *
 * That is a hypothesis, and the last capture bug looked obvious and was not.
 *
 * # Why it is measured here rather than in the engine
 *
 * The engine is a compositor, so restarting it to add a `tracing::info!` closes
 * every application running inside it, including the editor this is being
 * written in. The shell hot reloads. So the measurement is taken on the frames
 * as they are decoded, in the live session, at the cost of nothing when it is
 * switched off.
 *
 * # Cost
 *
 * Nothing at all unless `?debug=capture` is in the URL. When it is on, one
 * `getImageData` of a few pixel columns per *changed* window, at most once a
 * second per window. It reads a strip rather than the frame so the cost does
 * not scale with window size.
 */

/** What a single measurement found. */
export interface CaptureReading {
  /** Size of the frame the engine sent. */
  frame: { width: number; height: number }
  /** Size of the box the shell laid the window out in. */
  box: { width: number; height: number }
  /** Unpainted columns at each edge, in frame pixels. */
  dead: { left: number; right: number; top: number; bottom: number }
}

/** Is the probe switched on for this page? */
export function probeEnabled(search: string): boolean {
  return new URLSearchParams(search).get("debug") === "capture"
}

/**
 * A pixel counts as unpainted if it is fully black or fully transparent.
 *
 * Both, because it depends on the path the frame took. JPEG has no alpha, so an
 * area the client never painted arrives as black. A frame that keeps its alpha
 * arrives transparent. Testing only one of the two would miss the bug on
 * whichever path the session happens to be using.
 */
const UNPAINTED = (r: number, g: number, b: number, a: number) =>
  a === 0 || (r === 0 && g === 0 && b === 0)

/**
 * Count unpainted columns inward from the left and right edges.
 *
 * A column counts only if *every* pixel in it is unpainted, so a dark
 * background does not read as a dead edge. Terminals are nearly black and
 * would otherwise report their whole width.
 */
function deadColumns(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { left: number; right: number } {
  const columnIsDead = (x: number) => {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4
      if (!UNPAINTED(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!)) return false
    }
    return true
  }

  let left = 0
  while (left < width && columnIsDead(left)) left++
  // A frame that is entirely unpainted is a blank window, not a band. Reporting
  // it as "the whole width is dead" on both sides would be double counting.
  if (left === width) return { left: width, right: 0 }

  let right = 0
  while (right < width - left && columnIsDead(width - 1 - right)) right++
  return { left, right }
}

function deadRows(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { top: number; bottom: number } {
  const rowIsDead = (y: number) => {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (!UNPAINTED(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!)) return false
    }
    return true
  }

  let top = 0
  while (top < height && rowIsDead(top)) top++
  if (top === height) return { top: height, bottom: 0 }

  let bottom = 0
  while (bottom < height - top && rowIsDead(height - 1 - bottom)) bottom++
  return { top, bottom }
}

/**
 * Measure one decoded frame.
 *
 * Takes the already-drawn canvas rather than the frame, because reading back
 * from the canvas is one `getImageData` against pixels the GPU already holds,
 * whereas decoding the frame a second time to inspect it would double the work
 * the probe is trying to observe.
 *
 * Returns `null` if the pixels cannot be read, which is the ordinary outcome
 * for a canvas holding a frame from another origin.
 */
export function measure(
  canvas: HTMLCanvasElement,
  box: { width: number; height: number },
): CaptureReading | null {
  const { width, height } = canvas
  if (width === 0 || height === 0) return null

  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) return null

  try {
    const pixels = context.getImageData(0, 0, width, height)
    return {
      frame: { width, height },
      box: { width: Math.round(box.width), height: Math.round(box.height) },
      dead: {
        ...deadColumns(pixels.data, width, height),
        ...deadRows(pixels.data, width, height),
      },
    }
  } catch {
    return null
  }
}

/** One line, readable out loud, which is how this will be reported. */
export function describe(label: string, reading: CaptureReading): string {
  const { frame, box, dead } = reading
  const edges = (["left", "right", "top", "bottom"] as const)
    .filter((side) => dead[side] > 0)
    .map((side) => `${side} ${dead[side]}px`)
  const verdict =
    edges.length === 0
      ? "fully painted"
      : `unpainted: ${edges.join(", ")}`
  return `${label}: frame ${frame.width}x${frame.height}, box ${box.width}x${box.height}, ${verdict}`
}
