/**
 * Where the shell keeps the password between visits.
 *
 * The engine still receives it as a query parameter, because a browser cannot
 * set headers on a WebSocket handshake. The difference this makes is *who
 * types it*: the page reads it from storage and appends it, instead of the
 * person copying a token into an address bar.
 *
 * `localStorage`, not a cookie: nothing here is a same-site form post, cookies
 * would be sent on every asset request for no benefit, and this needs to
 * survive a tab close so a tablet can be picked up again later.
 */

const STORAGE_KEY = "lwfa.password"

/** The saved password, or null if none has been entered yet. */
export function loadPassword(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || null
  } catch {
    // Private browsing, or storage disabled. The user can still sign in each
    // time; they just will not stay signed in.
    return null
  }
}

export function savePassword(password: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, password)
  } catch {
    // Not fatal: the session still works, it just will not be remembered.
  }
}

export function clearPassword(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing useful to do.
  }
}

/**
 * Adopt a password passed in the URL, then scrub it from the address bar.
 *
 * The engine prints a `?token=…` link at startup, which is genuinely useful for
 * getting a new device signed in without typing 32 hex characters. Consuming it
 * once and rewriting the URL keeps that convenience without leaving the secret
 * in history, in a screenshot, or in whatever the address bar syncs to.
 *
 * Returns the password if one was taken from the URL.
 */
export function adoptPasswordFromUrl(): string | null {
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get("token")
  if (!fromUrl) return null

  savePassword(fromUrl)

  params.delete("token")
  const query = params.toString()
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`)

  return fromUrl
}
