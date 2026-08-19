/**
 * What has been copied, on this device and on the machine.
 *
 * # One list, three clipboards
 *
 * The engine keeps the session's windows, the desktop outside it and this
 * device on the same clipboard, so this panel is not a transfer tool with
 * two sides. It is one history, newest first, with a note on each row
 * saying where that copy happened. Putting an old row back on the clipboard
 * puts it on all three.
 *
 * # Why sending needs a button at all
 *
 * Because no browser will let a page read the clipboard without being
 * asked, and Safari never will. So "Send what I copied" is a tap that
 * triggers the browser's own paste confirmation, and the box under it
 * catches everything that route cannot reach: files of any kind, images
 * from apps that only paste, and a line of text somebody would rather type
 * than copy.
 *
 * # Weight, on a mobile connection
 *
 * Rows carry the start of a text entry and nothing else. Images are drawn
 * from a thumbnail the engine makes on demand, loaded lazily, so opening
 * this panel over tethering costs a few kilobytes rather than every
 * screenshot of the last hour. Full bytes are fetched only when something
 * is copied or downloaded. See `lib/clipboard.ts`.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  ClipboardPaste,
  Download,
  FileIcon,
  Image as ImageIcon,
  Loader2,
  Monitor,
  Send,
  SquareDashed,
  Trash2,
  Type,
  Upload,
} from "lucide-react"
import type { ClipItem } from "@lwfa/proto"
import { useSessionActions } from "@/session"
import {
  clipUrl,
  copyToDevice,
  dismissOutgoing,
  loadFirstPage,
  loadMore,
  sendDeviceClipboard,
  sendFiles,
  sendText,
  useClipboard,
  type Outgoing,
} from "@/lib/clipboard"
import { Button } from "@/components/ui/button"
import { PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

function ClipboardPanel() {
  const actions = useSessionActions()
  const { items, more, loading, paging, error, outgoing, channel } = useClipboard()

  // Once per opening. The engine pushes every change while the panel is
  // shut, but this device may have connected before the panel existed.
  useEffect(() => {
    if (channel) loadFirstPage(actions.send)
  }, [channel, actions.send])

  if (!channel) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        The clipboard needs a session that can interact with the machine. This
        one can only watch.
      </p>
    )
  }

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="Send from this device">
        <SendControls />
        {outgoing.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {outgoing.map((row) => (
              <OutgoingRow key={row.id} row={row} />
            ))}
          </ul>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </PanelSection>

      <PanelSection title="History">
        {loading ? (
          <Skeletons />
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Nothing has been copied yet. Copy something in a window here, on the
            machine&rsquo;s own desktop, or on this device.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, at) => (
              <EntryRow key={item.id} item={item} current={at === 0} />
            ))}
          </ul>
        )}

        {more ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={paging}
            onClick={() => loadMore(actions.send)}
          >
            {paging ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {paging ? "Loading" : "Show older"}
          </Button>
        ) : null}
      </PanelSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const SendControls = memo(function SendControls() {
  const actions = useSessionActions()
  const files = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState("")
  const [asking, setAsking] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const grab = useCallback(async () => {
    setAsking(true)
    setSaid(null)
    try {
      const what = await sendDeviceClipboard(actions.send)
      setSaid(
        what === "nothing"
          ? "Nothing on this device's clipboard."
          : what === "image"
            ? "Image sent."
            : "Text sent.",
      )
    } catch {
      // Declining the browser's paste prompt lands here, and is a choice
      // rather than a fault, so it reads as one.
      setSaid("This device would not share its clipboard. Use the box below.")
    } finally {
      setAsking(false)
    }
  }, [actions.send])

  const paste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Files first: a pasted image or document arrives here and nowhere
    // else, and letting it fall through would paste its filename instead.
    const dropped = Array.from(event.clipboardData.files)
    if (dropped.length > 0) {
      event.preventDefault()
      sendFiles(dropped)
      setDraft("")
    }
  }, [])

  const post = useCallback(() => {
    sendText(actions.send, draft)
    setDraft("")
    setSaid("Text sent.")
  }, [actions.send, draft])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void grab()} disabled={asking}>
          {asking ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ClipboardPaste className="size-4" aria-hidden />
          )}
          Send what I copied
        </Button>
        <Button variant="outline" onClick={() => files.current?.click()}>
          <Upload className="size-4" aria-hidden />
          Pick files
        </Button>
        <input
          ref={files}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            sendFiles(Array.from(event.target.files ?? []))
            // Cleared, so picking the same file twice in a row still fires.
            event.target.value = ""
          }}
        />
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={paste}
          rows={2}
          placeholder="Or paste here, then send"
          className="min-h-16 w-full resize-y rounded-lg border bg-transparent p-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button onClick={post} disabled={draft.trim().length === 0}>
          <Send className="size-4" aria-hidden />
          Send
        </Button>
      </div>

      {said ? <p className="text-xs text-muted-foreground">{said}</p> : null}
    </div>
  )
})

const OutgoingRow = memo(function OutgoingRow({ row }: { row: Outgoing }) {
  const done = row.status === "done"
  const failed = row.status === "failed"
  const pct = row.size > 0 ? Math.floor((row.written / row.size) * 100) : 0
  return (
    <li className="flex flex-col gap-1 px-2 py-2">
      <div className="flex items-center gap-2 text-sm">
        {done ? (
          <Check className="size-4 shrink-0 text-success" aria-hidden />
        ) : failed ? (
          <SquareDashed className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate" title={row.name}>
          {row.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {done
            ? "On the machine"
            : failed
              ? (row.error ?? "Failed")
              : row.status === "paused"
                ? `Paused at ${pct}%`
                : row.status === "sending"
                  ? `${pct}%${row.speed ? ` · ${prettySize(row.speed)}/s` : ""}`
                  : "Waiting"}
        </span>
        {done || failed ? (
          <button
            type="button"
            aria-label={`Dismiss ${row.name}`}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => dismissOutgoing(row.id)}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {row.status === "sending" || row.status === "paused" ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      ) : null}
    </li>
  )
})

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

const EntryRow = memo(function EntryRow({
  item,
  current,
}: {
  item: ClipItem
  current: boolean
}) {
  const actions = useSessionActions()
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    setCopying(true)
    try {
      await copyToDevice(item)
      setCopied(true)
      // Long enough to read, short enough that the button is a button again
      // before somebody wants it.
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    } finally {
      setCopying(false)
    }
  }, [item])

  const download = clipUrl(item.id, "download")
  const canDownload = download !== null && item.path !== null

  return (
    <li
      className={cn(
        "space-y-2 rounded-lg border p-3",
        current ? "border-primary/50 bg-primary/5" : null,
      )}
    >
      <div className="flex items-start gap-3">
        <Thumbnail item={item} />
        <div className="min-w-0 flex-1 space-y-1">
          {item.kind === "text" ? (
            <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-xs leading-snug">
              {item.preview}
              {item.whole ? "" : "…"}
            </p>
          ) : (
            <p className="truncate text-sm" title={item.preview}>
              {item.preview}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {current ? "On the clipboard now · " : ""}
            {whereFrom(item)} · {prettySize(item.bytes)}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ""} ·{" "}
            {ago(item.at)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()} disabled={copying}>
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : copying ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <ClipboardPaste className="size-3.5" aria-hidden />
          )}
          {copied ? "Copied here" : "Copy here"}
        </Button>
        {current ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.send({ type: "clipUse", id: item.id })}
          >
            <Monitor className="size-3.5" aria-hidden />
            Put back
          </Button>
        )}
        {canDownload ? (
          <Button size="sm" variant="outline" asChild>
            <a href={download} download>
              <Download className="size-3.5" aria-hidden />
              Download
            </a>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          aria-label="Forget this entry"
          onClick={() => actions.send({ type: "clipDrop", id: item.id })}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
    </li>
  )
})

/**
 * A picture for an image entry, an icon for anything else.
 *
 * `loading="lazy"` matters here rather than being a habit: a history of
 * fifty screenshots would otherwise fetch fifty thumbnails the moment the
 * panel opens, over whatever connection the tablet happens to be on.
 */
const Thumbnail = memo(function Thumbnail({ item }: { item: ClipItem }) {
  const [broken, setBroken] = useState(false)
  const source = item.kind === "image" ? clipUrl(item.id, "thumb") : null

  if (source && !broken) {
    return (
      <img
        src={source}
        alt={item.preview}
        loading="lazy"
        decoding="async"
        className="size-12 shrink-0 rounded border object-cover"
        onError={() => setBroken(true)}
      />
    )
  }
  const Icon = item.kind === "image" ? ImageIcon : item.kind === "files" ? FileIcon : Type
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded border border-dashed">
      <Icon className="size-5 text-muted-foreground" aria-hidden />
    </div>
  )
})

function Skeletons() {
  return (
    <ul className="space-y-2" aria-hidden>
      {[0, 1, 2].map((n) => (
        <li key={n} className="flex gap-3 rounded-lg border p-3">
          <div className="size-12 shrink-0 animate-pulse rounded bg-muted" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

/** Where a copy happened, in words somebody would use out loud. */
function whereFrom(item: ClipItem): string {
  switch (item.origin) {
    case "lwfa":
      return "Copied in a window here"
    case "desktop":
      return "Copied on the machine's desktop"
    default:
      return item.device ? `Sent from ${item.device}` : "Sent from a device"
  }
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default memo(ClipboardPanel)
