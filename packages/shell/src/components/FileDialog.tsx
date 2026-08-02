/**
 * The dialog an application's file request becomes.
 *
 * An app on the desktop pressed "upload" or "save as"; the engine, being the
 * machine's portal backend, sent the request here instead of drawing a
 * dialog on a screen nobody is sitting at. This answers it with either:
 *
 * - **This device**: the browser's own file picker, streamed up the socket
 *   and landed in `~/Uploads` on the machine, handed to the app as ordinary
 *   paths. The whole point of the feature: "upload to this website" picks a
 *   photo from the tablet in your hands.
 * - **On the desktop**: a small file browser over the machine's own disk.
 *   For saves this is the only pane, plus a filename.
 *
 * Modal, unlike the panels: the application is genuinely blocked on the
 * answer, so pretending the desktop is interactive underneath would be a
 * lie. Dismissing is a real answer (the app sees a cancelled dialog).
 */

import { memo, useCallback, useEffect, useRef, useState } from "react"
import { ArrowUp, File as FileIcon, Folder, Loader2, Upload } from "lucide-react"
import type { DirEntry } from "@lwfa/proto"
import { useSessionActions } from "@/session"
import {
  clearFileRequest,
  uploadFile,
  useFileRequest,
  type ActiveFileRequest,
  type UploadSink,
} from "@/lib/files"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export const FileDialog = memo(function FileDialog({ sink }: { sink: UploadSink }) {
  const request = useFileRequest()
  if (request === null) return null
  return <OpenDialog key={request.request} request={request} sink={sink} />
})

function OpenDialog({ request, sink }: { request: ActiveFileRequest; sink: UploadSink }) {
  const actions = useSessionActions()
  const send = actions.send

  const cancel = useCallback(() => {
    send({ type: "fileCancel", request: request.request })
    clearFileRequest()
  }, [send, request.request])

  // The browser pane's state lives here, not in the store: which directory
  // is showing and what is selected are this dialog's business alone.
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState(request.suggestedName ?? "")

  // First listing: the home directory, asked for once when the dialog opens.
  useEffect(() => {
    send({ type: "listDir", request: request.request, path: "~" })
  }, [send, request.request])

  const listing = request.listing
  const browse = useCallback(
    (path: string) => {
      setSelected([])
      send({ type: "listDir", request: request.request, path })
    },
    [send, request.request],
  )

  const finish = useCallback(
    (paths: string[]) => {
      send({ type: "fileChosen", request: request.request, paths })
      clearFileRequest()
    },
    [send, request.request],
  )

  // Uploads land in ~/Uploads on the machine and become part of the answer
  // automatically; finishing with no browsed paths is the pure-upload case.
  const doneUploads = request.uploads.filter((row) => row.ok).length
  const canFinishUploads = doneUploads > 0 && !request.uploading

  const pick = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const chosen = request.multiple ? Array.from(files) : [files[0]!]
      for (const file of chosen) {
        await uploadFile(sink, send, request.request, file)
      }
    },
    [sink, send, request.request, request.multiple],
  )

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{request.title || (request.save ? "Save file" : "Choose files")}</DialogTitle>
          <DialogDescription>
            {request.save
              ? "An app on the desktop wants to save a file."
              : "An app on the desktop is asking for " +
                (request.directory
                  ? "a folder."
                  : request.multiple
                    ? "files."
                    : "a file.")}
          </DialogDescription>
        </DialogHeader>

        {request.save || request.directory ? (
          // Saving (or picking a folder) only makes sense against the
          // machine's own disk, so there is no upload pane to choose.
          <BrowsePane
            listing={listing}
            selectable={request.directory ? "dir" : "none"}
            selected={selected}
            multiple={false}
            onBrowse={browse}
            onSelect={(paths) => setSelected(paths)}
          />
        ) : (
          <Tabs defaultValue="device" className="flex min-h-0 flex-1 flex-col gap-3">
            <TabsList className="w-full shrink-0">
              <TabsTrigger value="device" className="flex-1">
                This device
              </TabsTrigger>
              <TabsTrigger value="desktop" className="flex-1">
                On the desktop
              </TabsTrigger>
            </TabsList>
            <TabsContent value="device" className="mt-0 min-h-0 flex-1">
              <UploadPane request={request} onPick={pick} />
            </TabsContent>
            <TabsContent value="desktop" className="mt-0 min-h-0 flex-1">
              <BrowsePane
                listing={listing}
                selectable="file"
                selected={selected}
                multiple={request.multiple}
                onBrowse={browse}
                onSelect={setSelected}
              />
            </TabsContent>
          </Tabs>
        )}

        {request.save ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="File name"
              className="h-11"
            />
          </div>
        ) : null}

        <DialogFooter className="shrink-0 gap-2">
          <Button variant="outline" className="h-11" onClick={cancel}>
            Cancel
          </Button>
          {request.save ? (
            <Button
              className="h-11"
              disabled={!listing || name.trim() === ""}
              onClick={() => listing && finish([join(listing.path, name.trim())])}
            >
              Save here
            </Button>
          ) : (
            <Button
              className="h-11"
              disabled={selected.length === 0 && !canFinishUploads}
              onClick={() => finish(selected)}
            >
              {selected.length > 0
                ? `Choose ${selected.length > 1 ? `${selected.length} items` : "selected"}`
                : `Use ${doneUploads > 1 ? `${doneUploads} uploads` : "upload"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The "This device" pane: pick, watch it stream, done. */
function UploadPane({
  request,
  onPick,
}: {
  request: ActiveFileRequest
  onPick: (files: FileList | null) => void
}) {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <div className="flex h-full flex-col gap-2">
      <input
        ref={input}
        type="file"
        multiple={request.multiple}
        className="hidden"
        onChange={(event) => {
          onPick(event.target.files)
          // Same file pickable twice: a re-selection must re-fire change.
          event.target.value = ""
        }}
      />
      <Button
        variant="outline"
        className="h-14 w-full gap-2 border-dashed"
        disabled={request.uploading}
        onClick={() => input.current?.click()}
      >
        {request.uploading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Upload className="size-4" aria-hidden />
        )}
        {request.uploading ? "Uploading…" : "Pick from this device"}
      </Button>
      {request.uploads.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {request.uploads.map((row, index) => (
            <li key={index} className="space-y-1.5 rounded-md border px-2.5 py-2">
              <div className="flex items-center gap-2">
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {row.ok === undefined
                    ? row.size > 0
                      ? `${Math.floor((row.sent / row.size) * 100)}%`
                      : "Sending…"
                    : row.ok
                      ? "On the desktop"
                      : "Failed"}
                </span>
              </div>
              {/* A visible bar, because a large file over wifi takes real
                * minutes and a spinner-shaped word reads as a hang. */}
              {row.ok === undefined && row.size > 0 ? (
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${Math.min(100, (row.sent / row.size) * 100)}%` }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** The "On the desktop" pane: a small honest file browser. */
function BrowsePane({
  listing,
  selectable,
  selected,
  multiple,
  onBrowse,
  onSelect,
}: {
  listing: ActiveFileRequest["listing"]
  /** What clicking selects: files, directories, or nothing (saves). */
  selectable: "file" | "dir" | "none"
  selected: string[]
  multiple: boolean
  onBrowse: (path: string) => void
  onSelect: (paths: string[]) => void
}) {
  if (!listing) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading the desktop&hellip;
      </div>
    )
  }

  const parent = listing.path.replace(/\/[^/]+$/, "") || "/"
  const toggle = (path: string) => {
    if (selected.includes(path)) onSelect(selected.filter((p) => p !== path))
    else onSelect(multiple ? [...selected, path] : [path])
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="icon"
          variant="outline"
          className="size-9 shrink-0"
          disabled={listing.path === "/"}
          aria-label="Up one folder"
          onClick={() => onBrowse(parent)}
        >
          <ArrowUp className="size-4" aria-hidden />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="rtl">
          {listing.path}
        </span>
      </div>
      {listing.error ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          {listing.error}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1 rounded-lg border">
          <ul className="max-h-[40dvh]">
            {listing.entries.map((entry) => (
              <Row
                key={entry.name}
                entry={entry}
                path={join(listing.path, entry.name)}
                selectable={selectable}
                selected={selected.includes(join(listing.path, entry.name))}
                onBrowse={onBrowse}
                onToggle={toggle}
              />
            ))}
            {listing.entries.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                Nothing here.
              </li>
            ) : null}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}

const Row = memo(function Row({
  entry,
  path,
  selectable,
  selected,
  onBrowse,
  onToggle,
}: {
  entry: DirEntry
  path: string
  selectable: "file" | "dir" | "none"
  selected: boolean
  onBrowse: (path: string) => void
  onToggle: (path: string) => void
}) {
  const pickable = selectable === (entry.dir ? "dir" : "file")
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        className={cn(
          "flex min-h-10 w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          selected && "bg-accent",
        )}
        onClick={() => {
          if (entry.dir && selectable !== "dir") onBrowse(path)
          else if (pickable) onToggle(path)
        }}
        // Directories are selectable *and* enterable when a folder is what
        // is being chosen; double-press enters.
        onDoubleClick={() => entry.dir && onBrowse(path)}
      >
        {entry.dir ? (
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {!entry.dir ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {prettySize(entry.size)}
          </span>
        ) : null}
      </button>
    </li>
  )
})

function join(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
