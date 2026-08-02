/**
 * Password prompt.
 *
 * Shown when there is no stored password, or when the engine rejected the one
 * we had. Nothing else in the shell renders until this passes, so a bookmarked
 * `http://host:6733` is all anyone needs.
 */

import { memo, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
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
        <header className="space-y-3 text-center">
          {/*
            * The mark, not a stock key icon.
            *
            * This is the one screen that is lwfa's own rather than a frame
            * around somebody else's application, so it is the one place the
            * brand belongs. The lockup carries the wordmark, so the heading
            * below it would repeat the name: the name is in the picture.
            *
            * Two files rather than one that adapts, because the mark is drawn
            * for its ground: `on-dark` and `on-light` are different artwork,
            * not the same artwork recoloured. Swapped by the `dark` class the
            * shell sets, not by a media query, since the theme is a preference
            * here and not the device's. See brand/README.md.
            */}
          <img
            src="/brand/lockup-horizontal-on-light.svg"
            alt="lwfa"
            className="mx-auto h-10 w-auto dark:hidden"
          />
          <img
            src="/brand/lockup-horizontal-on-dark.svg"
            alt=""
            aria-hidden
            className="mx-auto hidden h-10 w-auto dark:block"
          />
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
