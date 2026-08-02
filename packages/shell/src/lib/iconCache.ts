/**
 * Application icons, cached on the device.
 *
 * # Why this exists
 *
 * A full set is well over a megabyte. Without a cache that megabyte crosses the
 * network on every connect and every reload, and on a tablet over wifi that is
 * the difference between the launcher opening instantly and opening in a
 * second. It is also pure waste: icons change when you install something, not
 * every time you look at them.
 *
 * # Why IndexedDB and not localStorage
 *
 * Two reasons, both disqualifying on their own. `localStorage` is synchronous,
 * so reading a megabyte of base64 blocks the main thread while frames are being
 * decoded. And its quota is around 5MB for the whole origin, which a few
 * hundred icons would eat, evicting the preferences and the saved connections
 * that actually matter.
 *
 * # Why blob URLs rather than the data URIs themselves
 *
 * A data URI in `src` is re-parsed and re-decoded per element, and repeats the
 * whole base64 payload inside the DOM. A blob URL is a handle: the browser
 * decodes once and reuses it, and the string in the attribute is forty
 * characters. They are revoked when the cache is cleared, because an
 * unrevoked blob URL keeps its bytes alive for the life of the document.
 */

const DB_NAME = "lwfa"
const STORE = "icons"
/**
 * Bumped to 2 to drop entries written before icons carried a timestamp.
 *
 * The old shape was a bare string, so a stored "no icon" answer had no age and
 * could never expire. Clearing once is cheaper than carrying a reader for both
 * shapes forever, and the cost is one slower launcher open.
 */
const VERSION = 2

/** Blob URLs handed out this session, so they can be revoked. */
const urls = new Map<string, string>()

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, VERSION)
    } catch {
      // Private browsing, or storage disabled entirely. Everything below
      // degrades to "ask the engine every time", which still works.
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      // A version bump means the stored shape changed, so whatever is there is
      // not readable by this code. See `VERSION`.
      const existing = request.result
      if (existing.objectStoreNames.contains(STORE)) {
        existing.deleteObjectStore(STORE)
      }
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

/** Read every cached icon for these ids. Missing ones are simply absent. */
/** A cached icon, with when it was written so a "missing" answer can expire. */
export interface CachedIcon {
  /** The data URI, or the empty string meaning "the engine had none". */
  data: string
  /** Epoch milliseconds. */
  at: number
}

export async function readCached(ids: string[]): Promise<Map<string, CachedIcon>> {
  const found = new Map<string, CachedIcon>()
  const db = await open()
  if (!db) return found

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readonly")
    const store = tx.objectStore(STORE)
    let pending = ids.length
    if (pending === 0) {
      resolve()
      return
    }
    for (const id of ids) {
      const request = store.get(id)
      request.onsuccess = () => {
        const value: unknown = request.result
        // Entries from before the timestamp existed are ignored rather than
        // adopted with a made-up date, which for a tombstone would mean
        // inventing an expiry that never arrives.
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as CachedIcon).data === "string" &&
          typeof (value as CachedIcon).at === "number"
        ) {
          found.set(id, value as CachedIcon)
        }
        if (--pending === 0) resolve()
      }
      request.onerror = () => {
        if (--pending === 0) resolve()
      }
    }
    tx.onerror = () => resolve()
  })

  db.close()
  return found
}

/** Store icons for next time. Failures are ignored: this is only a cache. */
export async function writeCached(icons: { id: string; data: string }[]): Promise<void> {
  if (icons.length === 0) return
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const at = Date.now()
    for (const icon of icons) store.put({ data: icon.data, at }, icon.id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
  db.close()
}

/**
 * A blob URL for a data URI, created once per id.
 *
 * Returns the data URI unchanged if the conversion fails, so a rendering path
 * never ends up with nothing to show.
 */
export function objectUrlFor(id: string, dataUri: string): string {
  const existing = urls.get(id)
  if (existing) return existing
  try {
    const [header, base64] = dataUri.split(",", 2)
    if (!header || base64 === undefined) return dataUri
    const mime = header.slice(5, header.indexOf(";"))
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    urls.set(id, url)
    return url
  } catch {
    return dataUri
  }
}

/** Release every blob URL. Called when the connection goes away. */
export function revokeAll(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}
