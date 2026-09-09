import { createContext, use, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { LogOut, Scan, X } from "lucide-react"
import { boundedPosition, browserFullscreen, createImmersive, type FloatingPosition } from "@/lib/immersive"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const Context = createContext<ReturnType<typeof createImmersive> | null>(null)

export function ImmersiveProvider({ children }: { children: React.ReactNode }) {
  const [controller] = useState(() => createImmersive(browserFullscreen()))
  useEffect(() => controller.start(), [controller])
  return <Context value={controller}>{children}</Context>
}

export function useImmersive() {
  const controller = use(Context)
  if (!controller) throw new Error("ImmersiveProvider is missing")
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  return { ...state, controller, active: state.mode !== "off" }
}

export function ImmersiveButton() {
  const { active, pending, controller } = useImmersive()
  const label = active ? "Exit immersive mode" : "Enter immersive mode"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant={active ? "default" : "outline"} className="size-11 shrink-0 [&>svg]:size-4"
          aria-label={label} aria-pressed={active} disabled={pending} onClick={() => void controller.toggle()}>
          <Scan aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

const POSITION_KEY = "lwfa.immersive.position"
const SIZE = 48
const readPosition = (): FloatingPosition => {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null")
    if (typeof saved?.x === "number" && typeof saved?.y === "number") return boundedPosition(saved)
  } catch { /* Storage may be unavailable in private browsing. */ }
  return { x: 1, y: 0.18 }
}

export function ImmersiveControls() {
  const { active, navigation, pending, error, controller } = useImmersive()
  const area = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const position = useRef<FloatingPosition>(readPosition())
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const place = () => {
    const box = area.current
    if (!box || !button.current) return
    button.current.style.transform = `translate(${position.current.x * Math.max(0, box.clientWidth - SIZE)}px, ${position.current.y * Math.max(0, box.clientHeight - SIZE)}px)`
  }
  useLayoutEffect(() => {
    if (!active || !area.current) return
    place()
    const observer = new ResizeObserver(place)
    observer.observe(area.current)
    return () => observer.disconnect()
  }, [active])

  return <>
    {error && <div role="alert" data-shell-control className="fixed inset-x-4 top-4 z-[70] mx-auto flex max-w-lg items-center gap-3 rounded-xl border bg-card p-3 text-sm shadow-lg">
      <span className="flex-1">{error}</span>
      <Button size="icon" variant="ghost" aria-label="Dismiss fullscreen message" onClick={controller.dismissError}><X aria-hidden /></Button>
    </div>}
    {active && <>
      <div ref={area} className="immersive-fab-area" data-immersive-bounds>
        <button ref={button} type="button" className="immersive-fab" data-shell-nav data-shell-control
          aria-label={navigation ? "Hide navigation" : "Show navigation"} aria-expanded={navigation} aria-controls="shell-navigation"
          title="Tap to toggle navigation. Drag to move."
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            const bounds = area.current!.getBoundingClientRect()
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left - bounds.left, top: rect.top - bounds.top, moved: false }
            suppressClick.current = false
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (!start || start.id !== event.pointerId || !area.current) return
            const dx = event.clientX - start.x, dy = event.clientY - start.y
            if (!start.moved && Math.hypot(dx, dy) < 6) return
            start.moved = true
            suppressClick.current = true
            position.current = boundedPosition({
              x: (start.left + dx) / Math.max(1, area.current.clientWidth - SIZE),
              y: (start.top + dy) / Math.max(1, area.current.clientHeight - SIZE),
            })
            place()
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return
            if (drag.current.moved) {
              try { localStorage.setItem(POSITION_KEY, JSON.stringify(position.current)) } catch { /* Position is optional. */ }
            }
            drag.current = null
          }}
          onPointerCancel={() => { drag.current = null; suppressClick.current = true }}
          onLostPointerCapture={() => { drag.current = null }}
          onClick={(event) => {
            event.stopPropagation()
            if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return }
            controller.toggleNavigation()
          }}>
          <img src="/brand/mark-on-dark.svg" alt="" draggable={false} className="size-7" />
        </button>
      </div>
      {navigation && <Button className="immersive-exit" data-shell-control variant="secondary" disabled={pending}
        onClick={() => void controller.toggle()}><LogOut aria-hidden className="size-4" />Exit immersive mode</Button>}
    </>}
  </>
}
