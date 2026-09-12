import { useEffect, useState } from "react"
import { Copy, Download, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Field, FieldRow, PanelGroup, PanelSection } from "@/panels/parts"
import { useSessionActions, useSessionState } from "@/session"
import { requestGaming, useGaming, type GamingProfile } from "@/lib/gaming"

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
const DEFAULT_LSFG = { multiplier: 2, flow_scale: 1, performance_mode: false }
const DEFAULT_FRAMEGEN = { input: "dlssg", output: "fsrfg" }

export function GamingPanel({ component }: { component: "proton" | "lsfg" | "framegen" }) {
  const { account, status: connection } = useSessionState()
  const { send } = useSessionActions()
  const { status, pending, error } = useGaming()
  const [appid, setAppid] = useState("")
  const [draft, setDraft] = useState<GamingProfile>({ provider: "off" })
  const [notice, setNotice] = useState<string | null>(null)
  const owner = account === "owner"
  const busy = !!pending || connection !== "connected"

  useEffect(() => {
    if (owner && connection === "connected" && !status) requestGaming(send, "status")
  }, [owner, connection, send, status])
  useEffect(() => {
    if (status && !status.games.some(game => game.appid === appid)) setAppid(status.games[0]?.appid ?? "")
  }, [status, appid])
  useEffect(() => {
    setDraft(status?.profiles[appid] ?? { provider: "off" })
    setNotice(null)
  }, [appid, status])

  if (!owner) return <p className="text-sm text-muted-foreground">Gaming components are managed by the session owner.</p>

  const installed = component === "proton" ? !!status?.proton.tools.some(tool => tool.selfContained) : !!status?.[component].installed
  const enabled = draft.provider === component
  const ready = installed && (component === "lsfg" ? status?.lsfg.dll_compatible === true : component === "framegen" ? status?.framegen.overlaySupported === true : true)
  const lsfg = draft.lsfg ?? DEFAULT_LSFG
  const framegen = draft.framegen ?? DEFAULT_FRAMEGEN
  const selectProvider = (checked: boolean) => {
    if (component === "proton") return
    setDraft({ ...draft, provider: checked ? component : "off", [component]: component === "lsfg" ? lsfg : framegen })
  }
  const save = () => requestGaming(send, "saveProfile", { appid, profile: draft })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status!.launchOption)
      setNotice("Launch option copied.")
    } catch { setNotice("Copy the launch option shown below.") }
  }

  return <div className="space-y-[15px]">
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm font-medium">{component === "proton" ? "lwfa Proton" : component === "lsfg" ? "lwfa LSFG" : "lwfa Framegen"}</span>
      <Button size="icon" variant="ghost" aria-label="Refresh gaming components" disabled={busy} onClick={() => requestGaming(send, "status")}><RefreshCw className="size-4" /></Button>
    </div>
    {pending && <p role="status" className="text-sm text-muted-foreground">{pending}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status && <>
      <PanelGroup>
        <FieldRow>
          <Field label={component === "proton" ? "GE-Proton + Canvas" : component === "lsfg" ? `lsfg-vk ${status.lsfg.version}` : `OptiScaler ${status.framegen.version}`} hint={installed ? "Installed" : "Not installed"} />
          {!installed && <Button size="sm" variant="outline" disabled={busy} onClick={() => requestGaming(send, "install", { component })}><Download className="mr-1.5 size-3.5" />Install</Button>}
        </FieldRow>
      </PanelGroup>
      {component === "proton" ? <>
        <p className="text-xs text-muted-foreground">Includes the original GE runtime and lwfa's window sizing fixes. Host games use the original runtime. The base download is about 509 MiB.</p>
        {status.proton.tools.map(tool => <PanelGroup key={tool.path}><FieldRow><Field label={tool.name} hint={`${tool.selfContained ? "Self-contained" : "Uses a separate GE installation"}${tool.activePids.length ? " · In use" : ""}`} /></FieldRow></PanelGroup>)}
        <p className="text-xs text-muted-foreground">After installation, restart Steam when your games are closed. Choose the lwfa Canvas tool in the game's Properties → Compatibility.</p>
      </> : <>
        {component === "lsfg" && <p className="text-xs text-muted-foreground">Requires your purchased Lossless Scaling. Interpolates game images to make motion smoother. For a 60 FPS stream, start with a stable 30 FPS game limit and 2× generation.</p>}
        {component === "lsfg" && status.lsfg.dll_compatible !== true && <p role="status" className="text-sm text-muted-foreground">{typeof status.lsfg.error === "string" ? status.lsfg.error : "Install Lossless Scaling through Steam to provide its required DLL."}</p>}
        {component === "framegen" && <p className="text-xs text-muted-foreground">Experimental, for compatible games with frame-generation hooks. Uses an isolated game-file overlay and preserves native NVIDIA upscaling. Support varies by game and Steam Input setup.</p>}
        {component === "framegen" && status.framegen.overlaySupported !== true && <p role="status" className="text-sm text-muted-foreground">{typeof status.framegen.error === "string" ? status.framegen.error : "This host needs Bubblewrap with overlay support."}</p>}
        <PanelSection title="Game">
          <select aria-label="Game profile" className={selectClass} value={appid} disabled={busy || !status.games.length} onChange={event => setAppid(event.target.value)}>
            {!status.games.length && <option value="">No installed Steam games</option>}
            {status.games.map(game => <option key={game.appid} value={game.appid}>{game.name}</option>)}
          </select>
        </PanelSection>
        {appid && <>
          <PanelGroup><FieldRow><Field label={`Use ${component === "lsfg" ? "LSFG" : "Framegen"}`} hint={draft.provider !== "off" && !enabled ? `Currently set to ${draft.provider === "lsfg" ? "LSFG" : "Framegen"}.` : "One frame generation provider per game."} /><Switch aria-label={`Use ${component}`} checked={enabled} disabled={busy || (!enabled && !ready)} onCheckedChange={selectProvider} /></FieldRow></PanelGroup>
          {component === "lsfg" && enabled && <PanelGroup>
            <label className="block space-y-2 p-3 text-sm">Multiplier<select aria-label="Multiplier" disabled={busy} className={selectClass} value={lsfg.multiplier} onChange={event => setDraft({ ...draft, lsfg: { ...lsfg, multiplier: Number(event.target.value) } })}>{[2, 3, 4].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
            <label className="block space-y-2 p-3 text-sm">Motion detail<select aria-label="Motion detail" disabled={busy} className={selectClass} value={lsfg.flow_scale} onChange={event => setDraft({ ...draft, lsfg: { ...lsfg, flow_scale: Number(event.target.value) } })}><option value={1}>Full</option><option value={0.75}>Balanced</option><option value={0.5}>Reduced GPU load</option><option value={0.25}>Lowest GPU load</option></select></label>
            <FieldRow><Field label="Performance mode" hint="Reduces processing cost and image detail." /><Switch aria-label="LSFG performance mode" disabled={busy} checked={lsfg.performance_mode} onCheckedChange={value => setDraft({ ...draft, lsfg: { ...lsfg, performance_mode: value } })} /></FieldRow>
          </PanelGroup>}
          {component === "framegen" && enabled && <PanelGroup>
            <label className="block space-y-2 p-3 text-sm">Game integration<select aria-label="Game integration" disabled={busy} className={selectClass} value={framegen.input} onChange={event => setDraft({ ...draft, framegen: { input: event.target.value, output: event.target.value === "nukems" ? "nukems" : framegen.output === "nukems" ? "fsrfg" : framegen.output } })}><option value="dlssg">DLSS frame generation</option><option value="fsrfg">FSR 3.1 frame generation</option><option value="fsrfg30">FSR 3.0 frame generation</option><option value="upscaler">Upscaler integration</option><option value="nukems">DLSSG-to-FSR3</option></select></label>
            <label className="block space-y-2 p-3 text-sm">Frame generation backend<select aria-label="Frame generation backend" className={selectClass} value={framegen.output} disabled={busy || framegen.input === "nukems"} onChange={event => setDraft({ ...draft, framegen: { ...framegen, output: event.target.value } })}>{framegen.input === "nukems" ? <option value="nukems">DLSSG-to-FSR3</option> : <><option value="fsrfg">FSR</option><option value="xefg">XeSS</option></>}</select></label>
          </PanelGroup>}
          <Button className="w-full" disabled={busy || (enabled && !ready)} onClick={save}>Save for next launch</Button>
          {status.profiles[appid] && <p className="text-xs text-muted-foreground">Saved: {status.profiles[appid]!.provider === "off" ? "lwfa frame generation off" : status.profiles[appid]!.provider === "lsfg" ? "LSFG" : "Framegen"}. Applies on the next launch.</p>}
          <p className="text-xs text-muted-foreground">Close and relaunch the game to apply changes. Turn off other frame-generation layers first; keep native upscaling if supported.</p>
          <PanelSection title="Steam launch option">
            <p className="text-xs text-muted-foreground">Add this once in the game's Properties → General. The wrapper applies its profile only inside lwfa. Host launches pass through unchanged.</p>
            <code className="block break-all rounded-md bg-muted p-2 text-xs select-text">{status.launchOption}</code>
            <Button size="sm" variant="outline" onClick={copy}><Copy className="mr-1.5 size-3.5" />Copy launch option</Button>
          </PanelSection>
        </>}
      </>}
    </>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
  </div>
}
