/**
 * The account list, for the Access panel.
 *
 * A store rather than component state so the list survives the panel being
 * unmounted, which happens every time the sheet closes, and so an `error`
 * arriving from the engine reaches the panel that asked for it.
 */

import { useSyncExternalStore } from "react"
import type { AccountInfo } from "@lwfa/proto"

let accounts: AccountInfo[] = []
let error: string | null = null as string | null
let loading = false
let snapshot: { accounts: AccountInfo[]; error: string | null; loading: boolean } = {
  accounts,
  error,
  loading,
}
const listeners = new Set<() => void>()

function emit(): void {
  snapshot = { accounts, error, loading }
  for (const listener of listeners) listener()
}

export function setAccounts(next: AccountInfo[]): void {
  accounts = next
  loading = false
  error = null
  emit()
}

/** A failed request that had a visible result, so the panel can explain it. */
export function setAccountError(message: string): void {
  error = message
  loading = false
  emit()
}

export function accountsRequested(): void {
  loading = accounts.length === 0
  error = null
  emit()
}

export function clearAccounts(): void {
  accounts = []
  error = null
  loading = false
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const get = () => snapshot

export function useAccounts(): { accounts: AccountInfo[]; error: string | null; loading: boolean } {
  return useSyncExternalStore(subscribe, get, get)
}
