/**
 * Machines this device knows how to reach.
 *
 * # Why this lives in the browser
 *
 * A connection is a bookmark, not a permission. Which machines *you* care about
 * is a property of the device in your hand: the tablet on the sofa wants the
 * desktop upstairs, the laptop wants the desktop and the media box. Storing
 * that on a machine would mean picking one to be authoritative, and then that
 * machine being switched off would lose you the list of the others.
 *
 * Accounts are the opposite and live in the engine's database, because "who may
 * connect to this machine" is emphatically the machine's business.
 *
 * # Passwords
 *
 * Kept alongside, so switching machines is one tap. That is the same trade the
 * shell already makes for the current connection, and the same one every VNC
 * client makes: `localStorage` is readable by anything running on this origin,
 * which on a LAN-only shell is the browser itself. It is not a secret store and
 * is not pretending to be one.
 */

import { useSyncExternalStore } from "react"

export interface Connection {
  id: string
  /** What to call it. Defaults to the host. */
  label: string
  /** `ws://host:port`, exactly what the shell will dial. */
  url: string
  password: string
  /** Epoch millis, so the list can be ordered by recency. */
  lastUsed: number
}

const STORAGE_KEY = "lwfa.connections"

function read(): Connection[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Validated rather than trusted: a half-written blob must not stop the
    // panel rendering, and a missing field must not produce a broken dial.
    return parsed.filter(
      (c): c is Connection =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Connection).id === "string" &&
        typeof (c as Connection).url === "string",
    )
  } catch {
    return []
  }
}

let current = read()
const listeners = new Set<() => void>()

function write(next: Connection[]): void {
  current = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Applies for this session even if it cannot be saved.
  }
  for (const listener of listeners) listener()
}

export function saveConnection(entry: Omit<Connection, "id" | "lastUsed"> & { id?: string }): void {
  const id = entry.id ?? crypto.randomUUID()
  const rest = current.filter((c) => c.id !== id)
  write([...rest, { ...entry, id, lastUsed: Date.now() }])
}

export function forgetConnection(id: string): void {
  write(current.filter((c) => c.id !== id))
}

export function touchConnection(id: string): void {
  write(current.map((c) => (c.id === id ? { ...c, lastUsed: Date.now() } : c)))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = () => current

export function useConnections(): Connection[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * Switch to another machine.
 *
 * A full navigation rather than swapping the socket in place. Everything the
 * shell holds (window ids, decoded frames, encoder sessions, the strip) belongs
 * to *one* engine, and unpicking that safely is far more code than a reload,
 * for a thing that happens a few times a day.
 */
export function connectTo(entry: Connection): void {
  touchConnection(entry.id)
  const url = new URL(location.href)
  url.searchParams.set("engine", entry.url)
  url.searchParams.set("token", entry.password)
  location.href = url.toString()
}
