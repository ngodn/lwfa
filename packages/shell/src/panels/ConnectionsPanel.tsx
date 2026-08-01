/**
 * The machines this device can reach.
 *
 * Saved on the device, not on any machine: see `lib/connections.ts` for why.
 * The one you are on is shown first and is not offered as somewhere to go.
 */

import { memo, useState } from "react"
import { Check, Monitor, Plus, Trash2, X } from "lucide-react"
import {
  connectTo,
  forgetConnection,
  saveConnection,
  useConnections,
  type Connection,
} from "@/lib/connections"
import { useSessionState } from "@/session"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

function ConnectionsPanel() {
  const { endpoint, account, status } = useSessionState()
  const connections = useConnections()
  const [adding, setAdding] = useState(false)

  const here = connections.find((c) => c.url === endpoint)
  const others = connections.filter((c) => c.url !== endpoint)

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="Connected to">
        <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              status === "connected" ? "bg-success" : "bg-destructive",
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{here?.label ?? hostOf(endpoint)}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{endpoint}</p>
          </div>
          {account ? (
            <span className="shrink-0 text-xs text-muted-foreground">{account}</span>
          ) : null}
        </div>
        {!here ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={() =>
              saveConnection({
                label: hostOf(endpoint),
                url: endpoint,
                password: readCurrentPassword(),
              })
            }
          >
            <Plus className="size-3.5" aria-hidden />
            Save this machine
          </Button>
        ) : null}
      </PanelSection>

      <PanelSection
        title="Saved machines"
        description="Stored on this device only. Switching reloads the shell, because window ids, frames and encoder sessions all belong to one engine."
      >
        {others.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            Nothing saved yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {[...others]
              .sort((a, b) => b.lastUsed - a.lastUsed)
              .map((entry) => (
                <ConnectionRow key={entry.id} entry={entry} />
              ))}
          </ul>
        )}
      </PanelSection>

      {adding ? (
        <AddConnection onDone={() => setAdding(false)} />
      ) : (
        <Button variant="outline" className="w-full gap-2" onClick={() => setAdding(true)}>
          <Plus className="size-4" aria-hidden />
          Add a machine
        </Button>
      )}
    </div>
  )
}

const ConnectionRow = memo(function ConnectionRow({ entry }: { entry: Connection }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border bg-card p-2">
      <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <button className="min-w-0 flex-1 text-left" onClick={() => connectTo(entry)}>
        <span className="block truncate text-sm font-medium">{entry.label}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{entry.url}</span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Forget ${entry.label}`}
        onClick={() => forgetConnection(entry.id)}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    </li>
  )
})

function AddConnection({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("")
  const [host, setHost] = useState("")
  const [password, setPassword] = useState("")

  return (
    <form
      className="space-y-3 rounded-lg border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault()
        const url = normalise(host)
        if (!url) return
        saveConnection({ label: label.trim() || hostOf(url), url, password })
        onDone()
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Add a machine</h3>
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onDone} aria-label="Cancel">
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="conn-host">Address</Label>
        <Input
          id="conn-host"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="192.168.1.51"
          className="font-mono text-sm"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <p className="text-xs text-muted-foreground">
          Port {DEFAULT_PORT} is assumed. A full <code className="font-mono">ws://host:port</code> works too.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="conn-password">Password</Label>
        <Input
          id="conn-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="conn-label">Name (optional)</Label>
        <Input
          id="conn-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="desktop"
        />
      </div>

      <Button type="submit" className="w-full gap-2" disabled={!host.trim()}>
        <Check className="size-4" aria-hidden />
        Save
      </Button>
    </form>
  )
}

/** The engine's port, matching `[net].shell_addr` in configs/defaults.toml. */
const DEFAULT_PORT = 6734

/**
 * Turn what somebody typed into a URL the shell can dial.
 *
 * People type "192.168.1.51". Requiring `ws://192.168.1.51:6734` would be
 * correct and would also be the reason nobody adds a second machine.
 */
function normalise(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed
  return `ws://${trimmed.includes(":") ? trimmed : `${trimmed}:${DEFAULT_PORT}`}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/**
 * The password this session is using, so "save this machine" does not ask for
 * something the user has already typed once.
 */
function readCurrentPassword(): string {
  try {
    return globalThis.localStorage?.getItem("lwfa.password") ?? ""
  } catch {
    return ""
  }
}

export default memo(ConnectionsPanel)
