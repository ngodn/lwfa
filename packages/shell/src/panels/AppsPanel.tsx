/**
 * The launcher.
 *
 * Reads the machine's freedesktop desktop entries, which is the same list every
 * other Linux launcher shows, so whatever is installed simply appears with no
 * per-app work here.
 *
 * # Icons
 *
 * A `.desktop` file names an icon, not a path, so the engine walks the
 * freedesktop theme chain to find a file and sends the bytes as a data URI.
 * They arrive in their own message *after* the list, so the launcher paints
 * immediately and fills in. Anything that does not resolve falls back to a
 * coloured initial rather than a broken-image glyph.
 */

import { memo, useDeferredValue, useEffect, useMemo, useState } from "react"
import { Loader2, Search, TerminalSquare } from "lucide-react"
import type { AppEntry } from "@lwfa/proto"
import { useSessionActions } from "@/session"
import { useApps } from "@/lib/apps"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PanelSection } from "@/panels/parts"
import { markPending, usePending } from "@/lib/pending"
import { cn } from "@/lib/utils"

function AppsPanel() {
  const actions = useSessionActions()
  const { apps, icons, loading } = useApps()
  const [query, setQuery] = useState("")

  // The list can be several hundred entries; deferring keeps typing responsive
  // by letting React drop intermediate filter results under load.
  const deferred = useDeferredValue(query)

  const matches = useMemo(() => filter(apps, deferred), [apps, deferred])

  // Ask once when the panel first opens.
  useEffect(() => {
    if (apps.length === 0 && !loading) actions.send({ type: "listApps" })
  }, [apps.length, loading, actions])

  return (
    <div className="space-y-4 pt-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search applications"
          className="pl-9"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Search applications"
        />
      </div>

      {loading && apps.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Reading installed applications&hellip;
        </div>
      ) : matches.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {query ? `Nothing matches “${query}”.` : "No applications found."}
          </p>
        </div>
      ) : (
        <PanelSection title={`${matches.length} application${matches.length === 1 ? "" : "s"}`}>
          <ul className="space-y-1">
            {matches.map((app) => (
              <AppRow
                key={app.id}
                app={app}
                icon={icons.get(app.id)}
                onLaunch={() => {
                  // Keyed on the command rather than the entry id, because
                  // that is what `windowOpened` can be matched back to. See
                  // `lib/pending` and the launch tracking in App.
                  markPending(launchKey(app.exec), LAUNCH_TIMEOUT_MS)
                  actions.spawn(app.exec, app.terminal)
                }}
              />
            ))}
          </ul>
        </PanelSection>
      )}

      <PanelSection title="Run a command">
        <RunBox
          onRun={(command) => {
            markPending(launchKey(command), LAUNCH_TIMEOUT_MS)
            actions.spawn(command)
          }}
        />
      </PanelSection>
    </div>
  )
}

/**
 * How long an application gets to put a window on screen.
 *
 * Generous on purpose. A cold Firefox on this machine took eight seconds from
 * launch to first frame, and a spinner that gives up before the thing it is
 * waiting for arrives is worse than none: it says the launch failed when it is
 * still going.
 */
const LAUNCH_TIMEOUT_MS = 20_000

/** The pending key for a command line. Shared with `App`, which clears it. */
export const launchKey = (command: string) => `launch:${command}`

const AppRow = memo(function AppRow({
  app,
  icon,
  onLaunch,
}: {
  app: AppEntry
  icon: string | undefined
  onLaunch: () => void
}) {
  const starting = usePending(launchKey(app.exec))

  return (
    // `content-visibility: auto` lets the browser skip layout and paint for
    // rows scrolled out of view. A hundred rows with an image each is enough
    // that this is measurable, and `contain-intrinsic-size` keeps the scrollbar
    // honest by telling it how tall a skipped row would be.
    <li style={{ contentVisibility: "auto", containIntrinsicSize: "auto 56px" }}>
      <button
        onClick={onLaunch}
        disabled={starting}
        aria-busy={starting || undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border border-transparent p-2 text-left",
          "transition-colors active:bg-accent [@media(hover:hover)]:hover:bg-accent",
          // Not `disabled:opacity-50`: a launching app should look busy, not
          // unavailable. Dimming it reads as "you cannot have this".
          starting && "bg-accent/60",
        )}
      >
        {icon ? (
          <img
            src={icon}
            alt=""
            // Decoded off the main thread and never lazy: the list is short and
            // a launcher that pops icons in as you scroll feels broken.
            decoding="async"
            className="size-9 shrink-0 rounded-lg object-contain"
          />
        ) : (
          // No icon resolved. A coloured initial beats a broken-image glyph,
          // and is stable per app so the list stays recognisable.
          <span
            className="grid size-9 shrink-0 place-items-center rounded-lg text-sm font-semibold text-white"
            style={{ background: tint(app.id) }}
            aria-hidden
          >
            {app.name.trim().charAt(0).toUpperCase() || "?"}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{app.name}</span>
          {app.description ? (
            <span className="block truncate text-xs text-muted-foreground">{app.description}</span>
          ) : null}
        </span>
        {starting ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : app.terminal ? (
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
            <TerminalSquare className="size-3" aria-hidden />
            term
          </Badge>
        ) : null}
      </button>
    </li>
  )
})

function RunBox({ onRun }: { onRun: (command: string) => void }) {
  const [command, setCommand] = useState("")
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = command.trim()
        if (!trimmed) return
        onRun(trimmed)
        setCommand("")
      }}
    >
      <Input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        placeholder="alacritty"
        className="font-mono text-sm"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Command to run"
      />
      <Button type="submit" variant="outline" disabled={!command.trim()}>
        Run
      </Button>
    </form>
  )
}

/**
 * Rank matches so a typed prefix finds the obvious thing first.
 *
 * A plain `includes` puts "Disk Usage Analyzer" above "Files" when you type
 * "fi", because it matches somewhere in the description. Prefix beats word
 * start beats substring, and the name always beats the description.
 */
function filter(apps: AppEntry[], query: string): AppEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return apps

  const scored: { app: AppEntry; score: number }[] = []
  for (const app of apps) {
    const name = app.name.toLowerCase()
    let score = -1
    if (name.startsWith(needle)) score = 0
    else if (name.split(/\s+/).some((word) => word.startsWith(needle))) score = 1
    else if (name.includes(needle)) score = 2
    else if (app.id.toLowerCase().includes(needle)) score = 3
    else if (app.description?.toLowerCase().includes(needle)) score = 4
    else if (app.categories.some((c) => c.toLowerCase().includes(needle))) score = 5
    if (score >= 0) scored.push({ app, score })
  }
  scored.sort((a, b) => a.score - b.score || a.app.name.localeCompare(b.app.name))
  return scored.map((entry) => entry.app)
}

/** A stable colour per app, so the tiles are distinguishable at a glance. */
function tint(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return `oklch(0.55 0.13 ${Math.abs(hash) % 360})`
}

export default memo(AppsPanel)
