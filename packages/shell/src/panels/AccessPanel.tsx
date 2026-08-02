/**
 * Who may connect to this machine, and what they may do.
 *
 * # The model
 *
 * Accounts belong to the machine, not to a central directory. A password is all
 * a browser sends, so an account *is* its password: there is no username field
 * on a bookmarked URL, and adding one would be another thing to mistype on a
 * tablet for no gain, since the password already identifies the row.
 *
 * The **owner** is whoever knows `AUTH_PASS`. That account is not in this list
 * and cannot be deleted from it, deliberately: it is the way back in when the
 * last named account is removed or misconfigured, and only it can open this
 * panel at all.
 *
 * # Enforcement is not here
 *
 * This panel writes permissions; the engine applies them. What the shell does
 * with them is grey out controls, which is a courtesy rather than a security
 * measure: anyone can open a socket and send whatever they like, so the check
 * that matters is the one in the engine.
 */

import { memo, useCallback, useEffect, useState } from "react"
import { Eye, Hand, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react"
import type { AccountInfo, Permissions, SessionMode } from "@lwfa/proto"
import { useSessionActions, useSessionState } from "@/session"
import { useAccounts } from "@/lib/accounts"
import { useApps } from "@/lib/apps"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Field, FieldRow, PanelSection } from "@/panels/parts"
import { cn } from "@/lib/utils"

function AccessPanel() {
  const { account, permissions } = useSessionState()
  const actions = useSessionActions()
  const { accounts, error, loading } = useAccounts()
  const isOwner = account === "owner"

  useEffect(() => {
    if (isOwner) actions.send({ type: "listAccounts" })
  }, [isOwner, actions])

  if (!isOwner) {
    return (
      <div className="space-y-4 pt-2">
        <PanelSection title="This session">
          <SelfSummary name={account} permissions={permissions} />
        </PanelSection>
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Only the owner can manage accounts. Sign in with the password from the
          machine&rsquo;s <code className="font-mono">.env</code> to do that.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6 pt-2">
      <PanelSection title="This session">
        <SelfSummary name={account} permissions={permissions} />
      </PanelSection>

      <PanelSection
        title="Accounts"
        description="Each account has its own password and permissions."
      >
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        {loading && accounts.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading&hellip;
          </div>
        ) : accounts.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No accounts yet. Only the owner password works.
          </p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((entry) => (
              <AccountRow key={entry.id} account={entry} />
            ))}
          </ul>
        )}
      </PanelSection>

      <NewAccount />
    </div>
  )
}

const SelfSummary = memo(function SelfSummary({
  name,
  permissions,
}: {
  name: string
  permissions: Permissions
}) {
  const count = permissions.allowedApps?.length ?? 0
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name || "not connected"}</p>
        <p className="text-xs text-muted-foreground">
          {permissions.mode === "interact" ? "Can interact" : "Can watch only"}
          {permissions.allowedApps === null
            ? " · any application"
            : ` · ${count} application${count === 1 ? "" : "s"}`}
        </p>
      </div>
    </div>
  )
})

const AccountRow = memo(function AccountRow({ account }: { account: AccountInfo }) {
  const actions = useSessionActions()
  const [open, setOpen] = useState(false)

  const setMode = useCallback(
    (mode: SessionMode) => {
      actions.send({
        type: "updateAccount",
        id: account.id,
        permissions: { ...account.permissions, mode },
        password: null,
      })
    },
    [actions, account],
  )

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 p-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{account.name}</span>
        <Badge variant="outline" className="gap-1 text-[10px]">
          {account.permissions.mode === "interact" ? (
            <Hand className="size-3" aria-hidden />
          ) : (
            <Eye className="size-3" aria-hidden />
          )}
          {account.permissions.mode}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Close" : "Edit"}
        </Button>
      </div>

      {open ? (
        <div className="space-y-3 border-t p-3">
          <ToggleGroup
            type="single"
            value={account.permissions.mode}
            onValueChange={(v) => v && setMode(v as SessionMode)}
            variant="outline"
            className="w-full"
          >
            <ToggleGroupItem value="view" className="flex-1 gap-1.5">
              <Eye className="size-3.5" aria-hidden />
              Watch only
            </ToggleGroupItem>
            <ToggleGroupItem value="interact" className="flex-1 gap-1.5">
              <Hand className="size-3.5" aria-hidden />
              Interact
            </ToggleGroupItem>
          </ToggleGroup>

          <AppAllowList account={account} />

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => actions.send({ type: "deleteAccount", id: account.id })}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
})

/**
 * Which applications an account may launch.
 *
 * "Any" is a distinct state rather than "every id ticked". An application
 * installed next week should be covered by "any" and should *not* quietly join
 * a list somebody curated on purpose.
 */
const AppAllowList = memo(function AppAllowList({ account }: { account: AccountInfo }) {
  const actions = useSessionActions()
  const { apps } = useApps()
  const allowed = account.permissions.allowedApps

  useEffect(() => {
    if (apps.length === 0) actions.send({ type: "listApps" })
  }, [apps.length, actions])

  const update = useCallback(
    (allowedApps: string[] | null) => {
      actions.send({
        type: "updateAccount",
        id: account.id,
        permissions: { ...account.permissions, allowedApps },
        password: null,
      })
    },
    [actions, account],
  )

  return (
    <div className="space-y-2">
      <FieldRow>
        <Field label="Applications" hint="What this account may launch." />
        <Button
          size="sm"
          variant={allowed === null ? "default" : "outline"}
          className="h-8"
          onClick={() => update(allowed === null ? [] : null)}
        >
          {allowed === null ? "Any" : "Choose"}
        </Button>
      </FieldRow>

      {allowed !== null ? (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1">
          {apps.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">Reading applications&hellip;</p>
          ) : (
            apps.map((app) => {
              const on = allowed.includes(app.id)
              return (
                <button
                  key={app.id}
                  onClick={() =>
                    update(on ? allowed.filter((id) => id !== app.id) : [...allowed, app.id])
                  }
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                    on ? "bg-primary/15 text-primary" : "hover:bg-accent",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  {on ? <span aria-hidden>&#10003;</span> : null}
                </button>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
})

const NewAccount = memo(function NewAccount() {
  const actions = useSessionActions()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [mode, setMode] = useState<SessionMode>("view")

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !password) return
    actions.send({
      type: "createAccount",
      name: name.trim(),
      password,
      // A new account starts able to launch nothing. Widening a permission
      // deliberately is a decision; discovering that a guest could already run
      // anything is a nasty surprise.
      permissions: { mode, allowedApps: [] },
    })
    setName("")
    setPassword("")
    setOpen(false)
  }

  if (!open) {
    return (
      <Button variant="outline" className="w-full gap-2" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        Add an account
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">New account</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setOpen(false)}
          aria-label="Cancel"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="new-name">Name</Label>
        <Input
          id="new-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="tablet"
          autoCapitalize="none"
          autoCorrect="off"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="new-password">Password</Label>
        <Input
          id="new-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          required
        />
        <p className="text-xs text-muted-foreground">
          Anyone with this password gets this account.
        </p>
      </div>

      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(v) => v && setMode(v as SessionMode)}
        variant="outline"
        className="w-full"
      >
        <ToggleGroupItem value="view" className="flex-1 gap-1.5">
          <Eye className="size-3.5" aria-hidden />
          Watch only
        </ToggleGroupItem>
        <ToggleGroupItem value="interact" className="flex-1 gap-1.5">
          <Hand className="size-3.5" aria-hidden />
          Interact
        </ToggleGroupItem>
      </ToggleGroup>

      <Button type="submit" className="w-full" disabled={!name.trim() || !password}>
        Create
      </Button>
    </form>
  )
})

export default memo(AccessPanel)
