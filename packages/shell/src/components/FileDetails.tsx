/**
 * What one file or folder actually is: properties, and a look at it.
 *
 * # Why the preview is a URL and not a blob
 *
 * The engine serves the file over HTTP with range support, so `<img>`,
 * `<video>` and `<audio>` fetch exactly what they need and nothing more.
 * Reading the file into a blob first would mean holding a two-gigabyte
 * video in the tab's memory before showing a frame, and a `blob:` URL
 * cannot answer range requests, so seeking would be impossible. A plain
 * URL costs nothing and gets streaming and seeking for free.
 *
 * Text is the exception: it is fetched, because it has to be decoded and
 * rendered rather than handed to an element, and only the first slice is
 * asked for. A log file is not a preview target beyond its first screen.
 *
 * # What can be previewed
 *
 * Whatever browsers actually decode: PNG, JPEG, WebP, AVIF, GIF, BMP and
 * SVG; H.264 in MP4 and WebM; MP3, AAC, WAV, FLAC and Opus; PDF; and
 * anything textual. HEIC and JPEG XL are deliberately absent, since no
 * browser outside Safari decodes either, and a blank frame is worse than
 * an honest "no preview". The engine decides by extension and says so in
 * `mime`; an empty `mime` means properties only.
 */

import { memo, useEffect, useState } from "react"
import {
  CircleAlert,
  FileQuestion,
  Folder as FolderIcon,
  Link2,
  Loader2,
} from "lucide-react"
import type { PathInfo } from "@/lib/fileDialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

/** How much of a text file to read. One screenful and then some. */
const TEXT_SLICE = 128 * 1024

export const FileDetails = memo(function FileDetails({
  info,
  previewUrl,
  onClose,
}: {
  info: PathInfo | null
  /** Where the engine serves this file, already carrying the ticket. */
  previewUrl: string | null
  onClose: () => void
}) {
  if (info === null) {
    return (
      <aside className="flex w-72 shrink-0 items-center justify-center rounded-md border text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
        Reading…
      </aside>
    )
  }

  const previewable = info.kind === "file" && info.mime !== "" && previewUrl !== null

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-md border">
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={info.name}>
            {info.name}
          </p>
          <p className="text-xs text-muted-foreground">{describeKind(info)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
        >
          Close
        </button>
      </div>

      {info.error ? (
        <div className="flex flex-1 items-center gap-2 p-3 text-sm text-muted-foreground">
          <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
          {info.error}
        </div>
      ) : previewable ? (
        <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-2 mt-2 grid shrink-0 grid-cols-2">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="properties">Properties</TabsTrigger>
          </TabsList>
          <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col p-2">
            <Preview mime={info.mime} url={previewUrl} size={info.size} />
          </TabsContent>
          <TabsContent value="properties" className="min-h-0 flex-1 overflow-y-auto p-2">
            <Properties info={info} />
          </TabsContent>
        </Tabs>
      ) : (
        // A folder, or a file nothing can render: properties are the whole
        // panel rather than one tab of two, since the other would be empty.
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <Properties info={info} />
        </div>
      )}
    </aside>
  )
})

function Preview({ mime, url, size }: { mime: string; url: string; size: number }) {
  const kind = previewKind(mime)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (kind !== "text") return
    let live = true
    setText(null)
    setFailed(false)
    // Only the first slice: a range request, so a 2GB log costs 128KB.
    fetch(url, { headers: { Range: `bytes=0-${TEXT_SLICE - 1}` } })
      .then((response) => (response.ok ? response.text() : Promise.reject(response.status)))
      .then((body) => live && setText(body))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [kind, url])

  const frame = "flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded bg-muted/40"

  switch (kind) {
    case "image":
      return (
        <div className={frame}>
          {/* Sized to fit rather than scaled up: a 32px icon shown at 300px
              is a blurry lie about what the file contains. */}
          <img
            src={url}
            alt=""
            className="max-h-full max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        </div>
      )
    case "video":
      return (
        <div className={frame}>
          <video src={url} controls preload="metadata" className="max-h-full max-w-full" />
        </div>
      )
    case "audio":
      return (
        <div className={cn(frame, "p-3")}>
          <audio src={url} controls preload="metadata" className="w-full" />
        </div>
      )
    case "pdf":
      return (
        <div className={frame}>
          {/* An iframe, which is what browsers render PDFs in natively. The
              engine serves it under a sandbox CSP. */}
          <iframe src={url} title="Preview" className="h-full w-full border-0" />
        </div>
      )
    case "text":
      if (failed) return <NoPreview reason="This file could not be read." />
      if (text === null) {
        return (
          <div className={cn(frame, "text-sm text-muted-foreground")}>
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            Reading…
          </div>
        )
      }
      return (
        <div className="min-h-0 flex-1 overflow-auto rounded bg-muted/40 p-2">
          <pre className="font-mono text-xs whitespace-pre-wrap" data-selectable>
            {text}
          </pre>
          {size > TEXT_SLICE ? (
            <p className="pt-2 text-xs text-muted-foreground">
              Showing the first {prettySize(TEXT_SLICE)} of {prettySize(size)}.
            </p>
          ) : null}
        </div>
      )
    default:
      return <NoPreview reason="Nothing here can show this kind of file." />
  }
}

function NoPreview({ reason }: { reason: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded bg-muted/40 p-4 text-center">
      <FileQuestion className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-xs text-muted-foreground">{reason}</p>
    </div>
  )
}

function Properties({ info }: { info: PathInfo }) {
  const rows: [string, string][] = [
    ["Kind", describeKind(info)],
    info.kind === "dir"
      ? ["Items", info.items === null ? "—" : `${info.items}`]
      : ["Size", `${prettySize(info.size)} (${info.size.toLocaleString()} bytes)`],
    ["Modified", stamp(info.modified)],
    ["Created", stamp(info.created)],
    ["Opened", stamp(info.accessed)],
    ["Permissions", info.mode || "—"],
    ["Owner", info.owner || "—"],
  ]
  if (info.target) rows.push(["Links to", info.target])

  return (
    <dl className="flex flex-col gap-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 flex-1 break-words" data-selectable>
            {value}
          </dd>
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <dt className="w-24 shrink-0 text-muted-foreground">Where</dt>
        <dd className="min-w-0 flex-1 font-mono break-all" data-selectable>
          {info.path}
        </dd>
      </div>
    </dl>
  )
}

function describeKind(info: PathInfo): string {
  if (info.kind === "dir") return "Folder"
  if (info.kind === "symlink") return "Link"
  if (info.kind === "other") return "Special file"
  if (info.mime) return info.mime.split(";")[0] ?? "File"
  const ext = info.name.includes(".") ? info.name.split(".").pop() : null
  return ext ? `${ext.toUpperCase()} file` : "File"
}

type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none"

/** What element, if any, can show this. Keyed on what the engine sent. */
export function previewKind(mime: string): PreviewKind {
  const type = mime.split(";")[0]?.trim() ?? ""
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type === "application/pdf") return "pdf"
  if (type.startsWith("text/")) return "text"
  return "none"
}

function stamp(seconds: number | null): string {
  if (seconds === null) return "—"
  return new Date(seconds * 1000).toLocaleString()
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export { FolderIcon, Link2 }
