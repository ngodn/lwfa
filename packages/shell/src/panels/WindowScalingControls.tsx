import type { WindowInfo, WindowScaling } from "@lwfa/proto"
import { useSessionActions } from "@/session"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** The selection follows engine metadata, including rejected or limited requests. */
export function WindowScalingControls({ info }: { info: WindowInfo }) {
  const actions = useSessionActions()
  const scaling = info.scaling ?? { mode: "sharp", scale: 1 }
  const sharp = scaling.mode === "sharp"
  const unavailable = info.scaling === undefined
  const legacySharp = info.xwayland === true && sharp
  const change = (next: WindowScaling) => {
    if (next.mode === scaling.mode && next.scale === scaling.scale) return
    actions.send({ type: "setWindowScaling", id: info.id, scaling: next })
  }
  const hint = unavailable
    ? "Update the engine to enable scaling."
    : legacySharp
      ? "Xwayland supports 1× in Sharper mode. Use More space for other scales."
      : sharp
        ? scaling.scale !== null && scaling.scale < 1
          ? "Same-size controls, lower resolution."
          : "Same-size controls, more detail. Auto follows this display, up to 2×."
        : scaling.scale !== null && scaling.scale < 1
          ? "Less workspace, larger controls."
          : "More workspace, smaller controls."

  return (
    <fieldset disabled={unavailable} className="min-w-0 space-y-2 border-t pt-2">
      <legend className="sr-only">Window scaling</legend>
      <p className="text-xs font-medium">Window scaling</p>
      <div role="group" aria-label="Scaling mode" className="flex flex-wrap gap-1 rounded-xl bg-muted p-1">
        {(["sharp", "workspace"] as const).map((mode) => (
          <Button
            key={mode}
            type="button"
            variant="ghost"
            aria-pressed={scaling.mode === mode}
            className={cn("h-11 min-w-24 flex-1 rounded-lg px-3", scaling.mode === mode ? "bg-card font-semibold text-foreground shadow-sm hover:bg-card" : "text-muted-foreground")}
            onClick={() => {
              if (mode === scaling.mode) return
              change({
                mode,
                scale: mode === "sharp" && info.xwayland ? 1 : scaling.scale ?? 1,
              })
            }}
          >
            {mode === "sharp" ? "Sharper" : "More space"}
          </Button>
        ))}
      </div>
      <div role="group" aria-label="Render scale" className="flex flex-wrap gap-1.5">
        {sharp ? (
          <Button
            type="button"
            variant={scaling.scale === null ? "default" : "outline"}
            aria-pressed={scaling.scale === null}
            disabled={legacySharp}
            className="h-11 min-w-14 px-2 text-xs"
            onClick={() => change({ mode: "sharp", scale: null })}
          >
            Auto
          </Button>
        ) : null}
        {SCALES.map((scale) => (
          <Button
            key={scale}
            type="button"
            variant={scaling.scale === scale ? "default" : "outline"}
            aria-pressed={scaling.scale === scale}
            disabled={legacySharp && scale !== 1}
            className="h-11 min-w-14 px-2 text-xs tabular-nums"
            onClick={() => change({ mode: scaling.mode, scale })}
          >
            {scale}×
          </Button>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      {!unavailable && info.effectiveScale !== undefined ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {sharp ? "Capture density" : "Workspace request"}: {Number(info.effectiveScale.toFixed(2))}×.
          {!sharp ? " Apps may limit this size." : ""} Applies until this window closes.
        </p>
      ) : null}
    </fieldset>
  )
}
