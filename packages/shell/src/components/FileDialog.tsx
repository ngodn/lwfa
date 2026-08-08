/**
 * "An application on the desktop is asking for files."
 *
 * The two answers a human can give are two sources: a file already on the
 * machine ("On the desktop"), or one on the device in their hands ("From
 * this device"), and the application cannot tell which was chosen. Saving
 * has no source question, only a place and a name, so save-shaped dialogs
 * skip the tabs entirely.
 *
 * Truly modal, unlike the panels: the application is genuinely blocked on
 * the answer, so pretending the desktop is interactive underneath would be
 * a lie. Dismissing is answering ("cancelled").
 *
 * Progress here is the engine's word, not ours: rows advance when bytes
 * are confirmed written on the machine, and "On the desktop" appears only
 * after the checksum matched. See `lib/upload.ts` for the transport and
 * `lib/fileDialog.ts` for the state.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUp,
  Check,
  CircleAlert,
  File as FileIcon,
  Folder,
  FolderOpen,
  Loader2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { useSessionActions } from "@/session"
import {
  type DialogState,
  type UploadRow,
  appDisplayName,
  closed,
  loadingListing,
  useActiveFileDialog,
  useQueuedFileDialogs,
} from "@/lib/fileDialog"
import { dropUploader, rowsFor, uploaderFor } from "@/lib/upload"
import * as store from "@/lib/fileDialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export const FileDialog = memo(function FileDialog() {
  const dialog = useActiveFileDialog()
  const queued = useQueuedFileDialogs()
  if (!dialog) return null
  // Keyed by request so a second dialog starts with clean local state
  // rather than inheriting the previous one's selection.
  return <OpenDialog key={dialog.request} dialog={dialog} queued={queued} />
})

function OpenDialog({ dialog, queued }: { dialog: DialogState; queued: number }) {
  const actions = useSessionActions()
  const saveShaped = dialog.mode !== "open"
  const [tab, setTab] = useState<"device" | "desktop">(saveShaped ? "desktop" : "device")
  const [selected, setSelected] = useState<string[]>([])
  const [saveName, setSaveName] = useState(dialog.suggestedName ?? "")
  const [showAll, setShowAll] = useState(false)

  const browse = (path: string) => {
    setSelected([])
    loadingListing(dialog.request)
    actions.listDir(dialog.request, path)
  }

  // The browse pane needs a first listing the moment it is relevant:
  // immediately for save-shaped dialogs, on first tab switch otherwise.
  const askedOnce = useRef(false)
  const desktopVisible = saveShaped || tab === "desktop"
  useEffect(() => {
    if (desktopVisible && !askedOnce.current) {
      askedOnce.current = true
      actions.listDir(dialog.request, "~")
    }
  }, [desktopVisible, actions, dialog.request])

  const doneUploads = dialog.uploads.filter((row) => row.status === "done").length
  const activeUploads = dialog.uploads.some(
    (row) => row.status === "sending" || row.status === "waiting" || row.status === "paused",
  )

  const finish = (paths: string[]) => {
    actions.fileChosen(dialog.request, paths)
    dropUploader(dialog.request)
    closed(dialog.request)
  }
  const cancel = () => {
    actions.fileCancel(dialog.request)
    dropUploader(dialog.request)
    closed(dialog.request)
  }

  const who = dialog.appId ? appDisplayName(dialog.appId) : "An app"
  const asking =
    dialog.mode === "save"
      ? `${who} wants to save a file`
      : dialog.mode === "saveFiles"
        ? `${who} wants to save ${dialog.names.length} files`
        : dialog.directory
          ? `${who} is asking for a folder`
          : dialog.multiple
            ? `${who} is asking for files`
            : `${who} is asking for a file`
  const filterNames = dialog.filters.map((f) => f.name).join(", ")

  const confirmReady =
    dialog.mode === "save"
      ? dialog.listing !== null && saveName.trim().length > 0
      : dialog.mode === "saveFiles"
        ? dialog.listing !== null
        : selected.length > 0 || (doneUploads > 0 && !activeUploads)

  const confirmLabel =
    dialog.mode === "save"
      ? (dialog.acceptLabel ?? "Save here")
      : dialog.mode === "saveFiles"
        ? (dialog.acceptLabel ?? "Save them here")
        : selected.length > 0
          ? (dialog.acceptLabel ??
            (selected.length === 1 ? "Choose selected" : `Choose ${selected.length} items`))
          : doneUploads > 0
            ? doneUploads === 1
              ? "Use upload"
              : `Use ${doneUploads} uploads`
            : (dialog.acceptLabel ?? "Choose")

  const confirm = () => {
    if (dialog.mode === "save") {
      const dir = dialog.listing?.path ?? "~"
      finish([joinPath(dir, saveName.trim())])
    } else if (dialog.mode === "saveFiles") {
      finish([dialog.listing?.path ?? "~"])
    } else {
      finish(selected)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent
        className={cn(
          "flex max-h-[85dvh] flex-col gap-4 overflow-hidden sm:max-w-xl",
          // On a phone the dialog sits at the bottom like a sheet, full
          // width, so the reachable half of the screen holds the buttons.
          "max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:border-b-0",
        )}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="pr-8">{dialog.title || defaultTitle(dialog)}</DialogTitle>
          <DialogDescription>
            {asking}
            {filterNames ? ` · ${filterNames}` : ""}
            {queued > 0 ? ` · ${queued} more waiting` : ""}
          </DialogDescription>
        </DialogHeader>

        {dialog.channel === "paused" ? (
          <div className="flex shrink-0 items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
            <span>Connection lost, upload paused. It resumes where it stopped.</span>
          </div>
        ) : null}

        {saveShaped ? null : (
          <Tabs
            value={tab}
            onValueChange={(next) => setTab(next as "device" | "desktop")}
            className="shrink-0"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="device" className="h-10">
                From this device
              </TabsTrigger>
              <TabsTrigger value="desktop" className="h-10">
                On the desktop
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {desktopVisible ? (
            <BrowsePane
              dialog={dialog}
              selected={selected}
              setSelected={setSelected}
              browse={browse}
              showAll={showAll}
              setShowAll={setShowAll}
              saveName={dialog.mode === "save" ? saveName : null}
            />
          ) : (
            <UploadPane dialog={dialog} />
          )}

          {dialog.mode === "save" ? (
            <div className="flex shrink-0 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Name</span>
                <Input
                  value={saveName}
                  onChange={(event) => setSaveName(event.target.value)}
                  className="h-11"
                  data-selectable
                />
              </div>
              {nameCollides(dialog, saveName) ? (
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden />A file with this
                  name already exists here and will be overwritten.
                </p>
              ) : null}
            </div>
          ) : null}

          {dialog.mode === "saveFiles" ? (
            <p className="shrink-0 text-xs text-muted-foreground">
              Saving into the folder above: {dialog.names.join(", ")}
            </p>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-2">
          <Button variant="outline" className="h-11" onClick={cancel}>
            Cancel
          </Button>
          <Button className="h-11" disabled={!confirmReady} onClick={confirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function defaultTitle(dialog: DialogState): string {
  if (dialog.mode === "save") return "Save file"
  if (dialog.mode === "saveFiles") return "Save files"
  return dialog.directory ? "Choose a folder" : "Choose files"
}

// ---------------------------------------------------------------------------
// From this device: pick, drop, watch it arrive
// ---------------------------------------------------------------------------

function UploadPane({ dialog }: { dialog: DialogState }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const accept = useMemo(() => acceptFor(dialog), [dialog])

  const takeFiles = (files: File[]) => {
    if (files.length === 0) return
    const take = dialog.multiple || dialog.directory ? files : files.slice(0, 1)
    const rows = rowsFor(take)
    store.addUploads(dialog.request, rows)
    uploaderFor(dialog.request, dialog.ticket).send(rows)
  }

  const uploading = dialog.uploads.some(
    (row) => row.status === "sending" || row.status === "waiting",
  )
  const totals = dialog.uploads.reduce(
    (sum, row) => ({ written: sum.written + row.written, size: sum.size + row.size }),
    { written: 0, size: 0 },
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        className={cn(
          "flex shrink-0 flex-col items-center gap-2 rounded-lg border border-dashed p-4 transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          takeFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <p className="text-sm text-muted-foreground">Drop files here, or</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            className="h-11"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            <Upload aria-hidden /> Pick files
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={uploading}
            onClick={() => folderInput.current?.click()}
          >
            <FolderOpen aria-hidden /> Pick a folder
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple={dialog.multiple}
          accept={accept || undefined}
          className="hidden"
          onChange={(event) => {
            takeFiles(Array.from(event.target.files ?? []))
            // Cleared so picking the same file again still fires change.
            event.target.value = ""
          }}
        />
        {/* webkitdirectory is a real attribute (Safari honours it since
            18.4) that React's input types never learned, hence the spread. */}
        <input
          ref={folderInput}
          type="file"
          multiple
          {...({ webkitdirectory: "" } as Record<string, string>)}
          className="hidden"
          onChange={(event) => {
            takeFiles(Array.from(event.target.files ?? []))
            event.target.value = ""
          }}
        />
      </div>

      {dialog.uploads.length > 0 ? (
        <ScrollArea className="min-h-0 flex-1 rounded-md border">
          <ul className="flex flex-col p-1">
            {dialog.uploads.map((row) => (
              <UploadRowView key={row.id} row={row} />
            ))}
          </ul>
        </ScrollArea>
      ) : null}

      {dialog.uploads.length > 1 && totals.size > 0 ? (
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Overall</span>
          <ProgressBar value={totals.written} max={totals.size} />
          <span className="shrink-0 tabular-nums">
            {prettySize(totals.written)} of {prettySize(totals.size)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

const UploadRowView = memo(function UploadRowView({ row }: { row: UploadRow }) {
  const pct = row.size > 0 ? Math.floor((row.written / row.size) * 100) : 0
  return (
    <li className="flex flex-col gap-1 px-2 py-2">
      <div className="flex items-center gap-2 text-sm">
        {row.status === "done" ? (
          <Check className="size-4 shrink-0 text-success" aria-hidden />
        ) : row.status === "failed" ? (
          <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
        ) : row.status === "sending" ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate" title={row.name}>
          {row.rel.length > 0 ? `${row.rel.join("/")}/` : ""}
          {row.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {row.status === "done"
            ? "On the desktop"
            : row.status === "failed"
              ? (row.error ?? "Failed")
              : row.status === "paused"
                ? `Paused at ${pct}%`
                : row.status === "sending"
                  ? `${prettySize(row.written)} of ${prettySize(row.size)} · ${pct}%` +
                    (row.speed ? ` · ${prettySize(row.speed)}/s` : "")
                  : "Waiting"}
        </span>
      </div>
      {row.status === "sending" || row.status === "paused" ? (
        <ProgressBar value={row.written} max={row.size} />
      ) : null}
    </li>
  )
})

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// On the desktop: the machine's own disk
// ---------------------------------------------------------------------------

function BrowsePane({
  dialog,
  selected,
  setSelected,
  browse,
  showAll,
  setShowAll,
  saveName,
}: {
  dialog: DialogState
  selected: string[]
  setSelected: (next: string[]) => void
  browse: (path: string) => void
  showAll: boolean
  setShowAll: (next: boolean) => void
  /** Non-null in save mode, where rows only navigate. */
  saveName: string | null
}) {
  const listing = dialog.listing
  const saveShaped = dialog.mode !== "open"
  const wantsDirs = dialog.mode === "open" && dialog.directory
  const extensions = useMemo(() => filterExtensions(dialog), [dialog])

  if (listing === null) {
    return (
      <div className="flex min-h-32 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading the desktop…
      </div>
    )
  }

  const parent = listing.path.replace(/\/[^/]+\/?$/, "") || "/"
  const atRoot = listing.path === "/"
  const visible = listing.entries.filter((entry) => {
    if (entry.dir) return true
    if (saveShaped || wantsDirs) return true
    if (showAll || extensions.length === 0) return true
    const lower = entry.name.toLowerCase()
    return extensions.some((ext) => lower.endsWith(ext))
  })
  const hiddenByFilter = listing.entries.length - visible.length

  const toggle = (path: string) => {
    if (selected.includes(path)) {
      setSelected(selected.filter((p) => p !== path))
    } else {
      setSelected(dialog.multiple ? [...selected, path] : [path])
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="size-9 shrink-0"
          disabled={atRoot}
          onClick={() => browse(parent)}
          aria-label="Up one folder"
        >
          <ArrowUp aria-hidden />
        </Button>
        {/* dir="rtl" keeps the tail of a long path visible; the tail is the
            part that says where you are. */}
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" dir="rtl">
          {listing.path}
        </span>
      </div>

      {listing.error ? (
        <div className="flex min-h-24 flex-1 items-center justify-center rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          {listing.error}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 rounded-md border">
          <ul className="flex flex-col p-1">
            {visible.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing here.
              </li>
            ) : (
              visible.map((entry) => {
                const path = joinPath(listing.path, entry.name)
                const selectable = entry.dir ? wantsDirs : !saveShaped && !wantsDirs
                const isSelected = selected.includes(path)
                return (
                  <BrowseRow
                    key={entry.name}
                    name={entry.name}
                    dir={entry.dir}
                    size={entry.size}
                    selected={isSelected}
                    onActivate={() => {
                      if (entry.dir && !wantsDirs) browse(path)
                      else if (selectable) toggle(path)
                    }}
                    onDescend={entry.dir ? () => browse(path) : undefined}
                  />
                )
              })
            )}
          </ul>
        </ScrollArea>
      )}

      <div className="flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {listing.truncated
            ? "Folder too large to list fully; showing the first 3000."
            : selected.length > 0
              ? `${selected.length} selected`
              : saveName !== null
                ? "Saving into this folder."
                : ""}
          {hiddenByFilter > 0 && !showAll
            ? `${selected.length > 0 || listing.truncated ? " · " : ""}${hiddenByFilter} hidden by filter`
            : ""}
        </span>
        {hiddenByFilter > 0 || showAll ? (
          <button
            type="button"
            className="shrink-0 underline-offset-2 hover:underline"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Apply filter" : "Show all"}
          </button>
        ) : null}
      </div>
    </div>
  )
}

const BrowseRow = memo(function BrowseRow({
  name,
  dir,
  size,
  selected,
  onActivate,
  onDescend,
}: {
  name: string
  dir: boolean
  size: number
  selected: boolean
  onActivate: () => void
  onDescend?: (() => void) | undefined
}) {
  return (
    // content-visibility keeps a 3000-row directory cheap: offscreen rows
    // skip layout and paint entirely, and the intrinsic size stops the
    // scrollbar from jumping as rows enter the viewport.
    <li className="[contain-intrinsic-size:auto_44px] [content-visibility:auto]">
      <div
        role="button"
        tabIndex={0}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onActivate()
          }
        }}
        className={cn(
          "flex h-11 w-full cursor-default items-center gap-2 rounded-md px-2 text-left text-sm",
          selected ? "bg-primary/15 text-foreground" : "hover:bg-accent",
        )}
      >
        {selected ? (
          <Check className="size-4 shrink-0 text-primary" aria-hidden />
        ) : dir ? (
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {dir ? (
          onDescend ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label={`Open ${name}`}
              onClick={(event) => {
                event.stopPropagation()
                onDescend()
              }}
            >
              <FolderOpen aria-hidden />
            </Button>
          ) : null
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {prettySize(size)}
          </span>
        )}
      </div>
    </li>
  )
})

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`
}

function nameCollides(dialog: DialogState, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || !dialog.listing) return false
  return dialog.listing.entries.some((entry) => !entry.dir && entry.name === trimmed)
}

/** What the app's filters mean for a browser `accept` attribute. */
function acceptFor(dialog: DialogState): string {
  const tokens = new Set<string>()
  for (const filter of dialog.filters) {
    for (const pattern of filter.patterns) {
      if (pattern.includes("/")) {
        tokens.add(pattern) // a MIME type, accepted verbatim
      } else if (pattern.startsWith("*.")) {
        tokens.add(pattern.slice(1).toLowerCase()) // "*.png" -> ".png"
      }
      // Anything fancier ("[Pp]*.txt") has no accept equivalent; skipped.
    }
  }
  return Array.from(tokens).join(",")
}

/** Lowercased extensions the filters name, for the browse pane. */
function filterExtensions(dialog: DialogState): string[] {
  const exts = new Set<string>()
  for (const filter of dialog.filters) {
    for (const pattern of filter.patterns) {
      if (pattern.startsWith("*.") && !pattern.slice(2).includes("*")) {
        exts.add(pattern.slice(1).toLowerCase())
      }
    }
  }
  return Array.from(exts)
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
