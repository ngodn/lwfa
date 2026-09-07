/**
 * Shared furniture for panels.
 *
 * Every panel is a stack of titled sections with labelled rows, and having each
 * one hand-roll that produces nine slightly different paddings. These are
 * deliberately dumb: no state, no logic, just the shapes.
 */

import { memo } from "react"
import { Slot } from "radix-ui"
import { cn } from "@/lib/utils"

export const PanelSection = memo(function PanelSection({
  title,
  description,
  children,
  className,
}: {
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("panel-section space-y-1.5", className)}>
      {title ? (
        <div className="space-y-1 px-0.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {title}
          </h3>
          {description ? (
            <p className="text-xs leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  )
})

/** One surface for related settings; asChild preserves list/readout semantics. */
export const PanelGroup = memo(function PanelGroup({
  children,
  className,
  asChild = false,
}: {
  children: React.ReactNode
  className?: string
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "div"
  return <Comp className={cn("panel-group", className)}>{children}</Comp>
})

/** A label-and-control row. The control is the second child. */
export const FieldRow = memo(function FieldRow({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("panel-row flex min-h-11 items-center justify-between gap-3.5 px-3 py-1.5", className)}>{children}</div>
  )
})

/** Static values stay compact without reducing the size of interactive rows. */
export const ReadoutRow = memo(function ReadoutRow({ children, className }: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn("panel-readout flex min-h-[38px] items-center justify-between gap-3.5 px-3 py-1.5 text-[13.5px]", className)}>{children}</div>
})

export const Field = memo(function Field({
  label,
  hint,
  htmlFor,
}: {
  label: string
  hint?: string
  htmlFor?: string
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <label
        htmlFor={htmlFor}
        className="block text-[13.5px] leading-snug font-medium text-foreground"
      >
        {label}
      </label>
      {hint ? <p className="text-xs leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  )
})

/** Placeholder for a panel whose feature has not landed yet. */
export const NotYet = memo(function NotYet({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <p className="text-sm font-medium">{what}</p>
      <p className="mt-1 text-xs text-muted-foreground">Not built yet.</p>
    </div>
  )
})
