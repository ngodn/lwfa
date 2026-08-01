/**
 * Shared furniture for panels.
 *
 * Every panel is a stack of titled sections with labelled rows, and having each
 * one hand-roll that produces nine slightly different paddings. These are
 * deliberately dumb: no state, no logic, just the shapes.
 */

import { memo } from "react"
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
    <section className={cn("space-y-3", className)}>
      {title ? (
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          {description ? (
            <p className="text-sm leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  )
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
    <div className={cn("flex items-center justify-between gap-4 py-1", className)}>{children}</div>
  )
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
        className="block text-sm leading-none font-medium text-foreground"
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
