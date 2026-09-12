import { useSyncExternalStore } from "react"
import type { ToEngine, ToShell } from "@lwfa/proto"

export type GamingProfile = {
  provider: "off" | "lsfg" | "framegen"
  lsfg?: { multiplier: number; flow_scale: number; performance_mode: boolean }
  framegen?: { input: string; output: string }
}
export type GamingComponent = { installed: boolean; version: string; [key: string]: unknown }
export type GamingStatus = {
  games: { appid: string; name: string; directory: string }[]
  profiles: Record<string, GamingProfile>
  proton: { tools: { path: string; name: string; baseTool: string; selfContained: boolean; activePids: number[] }[] }
  lsfg: GamingComponent
  framegen: GamingComponent
  launchOption: string
  streamTargetFps: number
}
type State = { status: GamingStatus | null; pending: string | null; error: string | null }
let state: State = { status: null, pending: null, error: null }
let sequence = 0
let current: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
function publish(next: Partial<State>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function getGaming() { return state }
export function useGaming() { return useSyncExternalStore(subscribe, getGaming) }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function parseGamingStatus(value: unknown): GamingStatus {
  if (!object(value) || !Array.isArray(value.games) || !object(value.profiles) || !object(value.proton)
    || !Array.isArray(value.proton.tools) || !object(value.lsfg) || !object(value.framegen)
    || typeof value.launchOption !== "string" || typeof value.streamTargetFps !== "number") throw new Error("Invalid gaming inventory.")
  for (const game of value.games) {
    if (!object(game) || typeof game.appid !== "string" || typeof game.name !== "string" || typeof game.directory !== "string") throw new Error("Invalid game inventory entry.")
  }
  for (const profile of Object.values(value.profiles)) {
    if (!object(profile) || !["off", "lsfg", "framegen"].includes(String(profile.provider))) throw new Error("Invalid saved gaming profile.")
    if (profile.lsfg !== undefined && (!object(profile.lsfg) || ![2, 3, 4].includes(Number(profile.lsfg.multiplier))
      || typeof profile.lsfg.flow_scale !== "number" || typeof profile.lsfg.performance_mode !== "boolean")) throw new Error("Invalid LSFG profile.")
    if (profile.framegen !== undefined && (!object(profile.framegen) || typeof profile.framegen.input !== "string"
      || typeof profile.framegen.output !== "string")) throw new Error("Invalid Framegen profile.")
  }
  for (const tool of value.proton.tools) {
    if (!object(tool) || typeof tool.name !== "string" || typeof tool.path !== "string" || !Array.isArray(tool.activePids)) throw new Error("Invalid Proton inventory entry.")
  }
  for (const component of [value.lsfg, value.framegen]) {
    if (typeof component.installed !== "boolean" || typeof component.version !== "string") throw new Error("Invalid component inventory.")
  }
  return value as GamingStatus
}

type Request = Extract<ToEngine, { type: "gaming" }>
export function requestGaming(send: (message: ToEngine) => void, action: Request["action"], options: Partial<Pick<Request, "component" | "appid" | "profile">> = {}) {
  if (current !== null) return
  const request = ++sequence
  current = request
  publish({ pending: action === "install" ? `Installing ${options.component}…` : action === "saveProfile" ? "Saving profile…" : "Loading…", error: null })
  timer = setTimeout(() => {
    current = null
    timer = null
    publish({ pending: null, error: "No response from the engine. Refresh to check whether the operation completed." })
  }, action === "install" ? 1_810_000 : 35_000)
  send({ type: "gaming", request, action, component: null, appid: null, profile: null, ...options })
}

export function gamingReply(message: Extract<ToShell, { type: "gaming" }>) {
  if (message.request !== current) return
  current = null
  if (timer) clearTimeout(timer)
  timer = null
  if (message.error) { publish({ pending: null, error: message.error }); return }
  try { publish({ status: parseGamingStatus(message.data), pending: null, error: null }) }
  catch (error) { publish({ pending: null, error: error instanceof Error ? error.message : "Invalid gaming reply." }) }
}

export function resetGaming() {
  if (timer) clearTimeout(timer)
  timer = null
  current = null
  publish({ status: null, pending: null, error: null })
}
