/**
 * The overlay panel the rail opens.
 *
 * One sheet, anchored to the same edge the rail is on, whose contents depend on
 * what was selected. A merged group opens the same sheet with tabs for the
 * buttons it swallowed, so nothing becomes unreachable when the rail collapses:
 * the route to a setting changes, the setting does not disappear.
 *
 * Panels are lazily rendered. The gamepad editor pulls in a graph library and
 * the keyboard builds a few hundred keys, and neither should cost anything on a
 * session where nobody opens them.
 */

import { Suspense, lazy, memo, useMemo } from "react"
import { Loader2 } from "lucide-react"
import { usePrefs, type NavItemId } from "@/lib/prefs"
import { NAV_GROUPS, NAV_ITEMS, type NavGroupId } from "@/nav/registry"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"

const AppearancePanel = lazy(() => import("@/panels/AppearancePanel"))
const SettingsPanel = lazy(() => import("@/panels/SettingsPanel"))
const SessionPanel = lazy(() => import("@/panels/SessionPanel"))
const ConnectionsPanel = lazy(() => import("@/panels/ConnectionsPanel"))
const AccessPanel = lazy(() => import("@/panels/AccessPanel"))
const AppsPanel = lazy(() => import("@/panels/AppsPanel"))
const WindowsPanel = lazy(() => import("@/panels/WindowsPanel"))
const KeyboardPanel = lazy(() => import("@/panels/KeyboardPanel"))
const GamepadPanel = lazy(() => import("@/panels/GamepadPanel"))

/**
 * Partial on purpose: not every rail button has a panel.
 *
 * `escape` fires and is done, and the input surfaces dock rather than opening
 * anything. See `NavItem.kind`.
 */
const PANELS: Partial<Record<NavItemId, React.LazyExoticComponent<React.ComponentType>>> = {
  theme: AppearancePanel,
  settings: SettingsPanel,
  info: SessionPanel,
  connections: ConnectionsPanel,
  access: AccessPanel,
  apps: AppsPanel,
  workspaces: WindowsPanel,
  keyboard: KeyboardPanel,
  gamepad: GamepadPanel,
}

export interface PanelHostProps {
  active: NavItemId | NavGroupId | null
  onClose: () => void
}

export const PanelHost = memo(function PanelHost({ active, onClose }: PanelHostProps) {
  const { nav } = usePrefs()

  // What the sheet is showing: one panel, or a tabbed set from a merged group.
  const view = useMemo(() => {
    if (!active) return null
    if (active in NAV_GROUPS) {
      const group = NAV_GROUPS[active as NavGroupId]
      const members = group.members.filter((id) => !nav.hidden.includes(id))
      // A group with nothing left in it should not have been rendered in the
      // rail at all, but guard rather than hand Tabs an undefined default.
      if (members.length === 0) return null
      return { kind: "group" as const, group, members, first: members[0]! }
    }
    return { kind: "item" as const, item: NAV_ITEMS[active as NavItemId] }
  }, [active, nav.hidden])

  const side = nav.edge
  const vertical = side === "left" || side === "right"

  // Inline, not Tailwind classes. The sheet's own variants set a width and the
  // insets, and fighting them from a `className` depends on merge order that is
  // easy to get subtly wrong; a style attribute simply wins. It also lets the
  // panel start where the rail ends, so switching panels does not mean closing
  // the one you are in.
  const geometry: React.CSSProperties = vertical
    ? { [side]: "var(--rail-size)", width: "min(26rem, calc(100vw - var(--rail-size)))", maxWidth: "none" }
    : { [side]: "var(--rail-size)", height: "min(30rem, calc(100dvh - var(--rail-size)))", maxHeight: "none" }

  return (
    // `modal={false}`: this is a side panel over a live desktop, not a dialog.
    // A modal sheet traps focus and lays a full-screen overlay over everything,
    // including the rail, so switching from one panel to another meant closing
    // the first one by hand. The overlay is also made non-blocking and much
    // fainter in index.css, because darkening a running desktop to show a
    // settings list is a heavy way to say "this is on top".
    <Sheet open={active !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
      <SheetContent
        side={side}
        className={cnPanel(vertical)}
        style={geometry}
        // A press on the rail is a *switch*, not a dismissal. Without this the
        // sheet closes on the pointer-down and the button's click then reopens
        // it, and the two race: the panel you asked for ends up selected in the
        // rail with nothing on screen.
        onPointerDownOutside={(event) => {
          if ((event.target as Element | null)?.closest?.("[data-shell-nav]")) {
            event.preventDefault()
          }
        }}
        // Same reasoning for the focus that follows it.
        onInteractOutside={(event) => {
          if ((event.target as Element | null)?.closest?.("[data-shell-nav]")) {
            event.preventDefault()
          }
        }}
      >
        {view === null ? null : view.kind === "item" ? (
          <>
            <SheetHeader className="shrink-0">
              <SheetTitle>{view.item.label}</SheetTitle>
              <SheetDescription>{view.item.hint}</SheetDescription>
            </SheetHeader>
            <PanelBody id={view.item.id} />
          </>
        ) : (
          <>
            <SheetHeader className="shrink-0">
              <SheetTitle>{view.group.label}</SheetTitle>
              <SheetDescription>{view.group.hint}</SheetDescription>
            </SheetHeader>
            <Tabs defaultValue={view.first} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-4 shrink-0 justify-start overflow-x-auto">
                {view.members.map((id) => (
                  <TabsTrigger key={id} value={id} className="gap-1.5">
                    {NAV_ITEMS[id].label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {view.members.map((id) => (
                <TabsContent key={id} value={id} className="mt-0 min-h-0 flex-1">
                  <PanelBody id={id} />
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
})

function cnPanel(vertical: boolean): string {
  return ["flex flex-col gap-4 p-0 pt-4", vertical ? "h-full" : "w-full"].join(" ")
}

const PanelBody = memo(function PanelBody({ id }: { id: NavItemId }) {
  const Panel = PANELS[id]
  if (!Panel) return null
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-4 pb-6" data-selectable>
        <Suspense fallback={<PanelPending />}>
          <Panel />
        </Suspense>
      </div>
    </ScrollArea>
  )
})

function PanelPending() {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Loading&hellip;
    </div>
  )
}
