/**
 * Password prompt.
 *
 * Shown when there is no stored password, or when the engine rejected the one
 * we had. Nothing else in the shell renders until this passes, so a bookmarked
 * `http://host:6733` is all anyone needs.
 */

import { useEffect, useRef, useState } from "react"

export interface LoginProps {
  /** Set when a previous attempt was rejected, so the reason can be shown. */
  error?: string | undefined
  onSubmit: (password: string) => void
}

export function Login({ error, onSubmit }: LoginProps): React.ReactElement {
  const [password, setPassword] = useState("")
  const input = useRef<HTMLInputElement>(null)

  // Focus on mount and after a rejection, so a retry is just typing. On iOS
  // this does not raise the keyboard by itself (that needs a user gesture),
  // but it does mean one tap rather than two.
  useEffect(() => {
    input.current?.focus()
  }, [error])

  return (
    <main className="login">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = password.trim()
          if (trimmed) onSubmit(trimmed)
        }}
      >
        <h1>lwfa</h1>
        <p className="login-sub">Enter the password from this machine&rsquo;s .env</p>

        <label htmlFor="password">Password</label>
        <input
          ref={input}
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          // A password manager entry for this is genuinely useful on a tablet.
          autoComplete="current-password"
          // The password is hex, and iOS would otherwise capitalise and
          // autocorrect it into something that never matches.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          required
        />

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={!password.trim()}>
          Connect
        </button>

        <p className="login-hint">
          The engine prints a one-tap link at startup if you would rather not type it.
        </p>
      </form>
    </main>
  )
}
