/**
 * Password prompt.
 *
 * Shown when there is no stored password, or when the engine rejected the one
 * we had. Nothing else in the shell renders until this passes, so a bookmarked
 * `http://host:6733` is all anyone needs.
 */

import { memo, useEffect, useRef, useState } from "react"
import { KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface LoginProps {
  /** Set when a previous attempt was rejected, so the reason can be shown. */
  error?: string | undefined
  busy?: boolean
  onSubmit: (password: string) => void
}

export const Login = memo(function Login({ error, busy, onSubmit }: LoginProps) {
  const [password, setPassword] = useState("")
  const input = useRef<HTMLInputElement>(null)

  // Focus on mount and after a rejection, so a retry is just typing. On iOS
  // this does not raise the keyboard by itself (that needs a user gesture),
  // but it does mean one tap rather than two.
  useEffect(() => {
    input.current?.focus()
  }, [error])

  return (
    <main className="grid min-h-full place-items-center bg-background p-6">
      <form
        className="w-full max-w-sm space-y-6"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = password.trim()
          if (trimmed) onSubmit(trimmed)
        }}
      >
        <header className="space-y-2 text-center">
          <div className="mx-auto grid size-11 place-items-center rounded-xl border bg-card">
            <KeyRound className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">lwfa</h1>
          <p className="text-sm text-muted-foreground">
            Enter the password from this machine&rsquo;s <code className="font-mono">.env</code>
          </p>
        </header>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            ref={input}
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            // A password manager entry for this is genuinely useful on a tablet.
            autoComplete="current-password"
            // iOS would otherwise capitalise and autocorrect it into something
            // that never matches.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "password-error" : undefined}
            required
          />
          {error ? (
            <p id="password-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" disabled={!password.trim() || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Connect
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          The engine prints a one-tap link at startup if you would rather not type it.
        </p>
      </form>
    </main>
  )
})
