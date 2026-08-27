/**
 * The shell.
 *
 * Owns layout policy and drives the engine. What it renders here is a control
 * surface, not the desktop: in milestone 3 the windows are still composited
 * natively and shown on the engine's own output. The browser starts compositing
 * window pixels in milestone 4, when per-surface streams arrive.
 *
 * So this page is deliberately a debug view of the strip. The chrome that will
 * eventually sit over the real windows is a later milestone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DecodedFrame,
  PeerInfo,
  Permissions,
  SessionId,
  ToShell,
  WindowId,
  WindowInfo,
  WindowLayout,
} from "@lwfa/proto";

/**
 * What the shell assumes before `Hello` arrives.
 *
 * The least it could be, not the most. Assuming interact and then discovering
 * otherwise would flash controls the session cannot use, and briefly send input
 * the engine will drop.
 */
const VIEW_ONLY: Permissions = { mode: "view", allowedApps: [] };
import { Connection, type Status } from "./connection.js";
import { Login } from "./Login.js";
import {
  adoptPasswordFromUrl,
  clearPassword,
  loadPassword,
  savePassword,
} from "./credentials.js";
import { FrameDecoder } from "./decode.js";
import { decodable, decodesOpus } from "@/lib/codecs";
import { OpusStream } from "@/lib/opus";
import { AudioFormat } from "@lwfa/proto";
import type { Codec } from "@lwfa/proto";
import { clearFrames, dropFrame, publishFrame } from "@/lib/frames"
import { clearFormat } from "@/lib/streamFormat"
import { clearStats } from "@/lib/streamStats"
import { setPrefs, usePrefSection } from "@/lib/prefs"
import {
  appsRequested,
  clearApps,
  hydrateIcons,
  iconsRequested,
  setAppIcons,
  setApps,
  setWindowless,
} from "@/lib/apps"
import * as audio from "@/lib/audio"
import { engineFor } from "@/lib/engineUrl"
import { requestLeadership } from "@/lib/leader"
import { log } from "@/lib/log"
import { takeCrashToReport } from "@/lib/crashLoop"
import { pendingKeys, resolvePending } from "@/lib/pending"
import { blocked, clearBlocked } from "@/lib/alreadyRunning"
import {
  closed as fileDialogClosed,
  described as fileDialogDescribed,
  listed as fileDialogListed,
  opened as fileDialogOpened,
} from "@/lib/fileDialog"
import { dropUploader } from "@/lib/upload"
import { motion } from "@/lib/motion"
import { SHELL_VERSION, WINDOW_SPRING } from "@/generated/config"
import {
  accountsRequested,
  clearAccounts,
  setAccountError,
  setAccounts,
} from "@/lib/accounts"
import {
  clipAdded,
  clipCleared,
  clipDropped,
  clipHistory,
  clipReady,
  clipReset,
} from "@/lib/clipboard"
import { ShellChrome } from "@/components/ShellChrome";
import { Desktop } from "@/components/Desktop";
import {
  SessionActionsProvider,
  SessionStateProvider,
  type SessionActions,
  type SessionState,
} from "./session.js";
import type { SurfaceInput } from "./WindowSurface.js";
import { evdevFromCode, isShellKey, isTextEntry } from "./input.js";
import {
  EMPTY,
  type StripConfig,
  type Output,
  type StripState,
  addWindow,
  configFrom,
  consumeIntoColumn,
  cycleWidth,
  expelFromColumn,
  focusDown,
  focusLeft,
  focusRight,
  focusUp,
  focusWindow,
  focusWorkspace,
  focusedWindow,
  fullscreenWindow,
  intersectsViewport,
  layout,
  liveWindows,
  moveToWorkspace,
  moveWindow,
  reflow,
  removeWindow,
  sendToWorkspace,
  setFit,
  setFullscreen,
  setColumnLive,
  setColumnWidth,
  streamList,
  toggleFullscreen,
} from "./strip.js";

/**
 * The spring windows move on, from `configs/defaults.toml`.
 *
 * Sent to the engine *and* used by the browser's own animator. The engine
 * integrates it for the physical display and `lib/motion` integrates it for
 * this page, both through `@lwfa/spring`, so a window scrolling past looks the
 * same whether you are sitting at the machine or holding a tablet.
 */
const SCROLL_SPRING = WINDOW_SPRING;

/**
 * Where the engine is.
 *
 * Defaults to whatever host served this page, so opening the shell from a
 * tablet finds the engine on the same machine with nothing to configure.
 * Override with `?engine=ws://host:port`, which is how a second engine is
 * tested without restarting the one hosting the session. See `engineUrl`.
 */
const ENGINE_BASE = engineFor(location, location.search);

/**
 * What to call this device in the list of connected sessions.
 *
 * Worked out here rather than from the `User-Agent`, because on the device this
 * project exists for the user agent is a lie: an iPad running Safari reports
 * `Macintosh; Intel Mac OS X` and mentions iPad nowhere. The tell is
 * `maxTouchPoints`, which a real Mac reports as 0.
 *
 * Only ever shown to the user so they can tell their own devices apart, so a
 * wrong guess costs a confusing label and nothing else.
 */
function describeDevice(): string {
  const ua = navigator.userAgent
  const touch = navigator.maxTouchPoints > 1

  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return "iPad"
  if (/iPhone/.test(ua)) return "iPhone"
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet"
  if (/CrOS/.test(ua)) return "Chromebook"
  if (/Macintosh/.test(ua)) return "Mac"
  if (/Windows/.test(ua)) return "Windows PC"
  if (/Linux/.test(ua)) return "Linux"
  return "Unknown device"
}

/**
 * Tell the engine about a crash the previous page load left behind.
 *
 * The whole point of the round trip through storage: the connection that saw
 * the crash was being torn down as the page went away, so the report has to
 * travel on the next one. A reloading shell closes its socket cleanly, and the
 * engine cannot tell that from somebody pressing reload, so without this the
 * only failure a user actually notices leaves no record anywhere.
 */
function reportAnyCrash(connection: Connection | null): void {
  if (!connection) return
  let store: Storage | null = null
  try {
    store = globalThis.sessionStorage ?? null
  } catch {
    return // storage blocked entirely; nothing was recorded either
  }
  if (!store) return
  const message = takeCrashToReport(store)
  if (message === null) return
  log("warn", `reported the last crash to the engine: ${message}`)
  connection.send({ type: "crashed", message })
}

/**
 * A stable id for this browser, so a reconnection can be recognised as one.
 *
 * Survives refreshes because it lives in `localStorage`, which is exactly the
 * point: without it the engine cannot tell a page reload from a second device
 * arriving, so it keeps the dead session around until the socket times out and
 * counts two viewers where there is one. That costs a full resync, a capture
 * invalidation, and a round of encoder rebuilds per reload.
 *
 * Not a credential and not trusted for anything. The token authenticates; this
 * only says "the connection you had a moment ago was also me".
 */
function clientId(): string {
  const key = "lwfa.client"
  try {
    const saved = localStorage.getItem(key)
    if (saved) return saved
    const fresh = crypto.randomUUID()
    localStorage.setItem(key, fresh)
    return fresh
  } catch {
    // Private browsing, or storage disabled. A per-load id is still better
    // than none: it at least collapses the double connection React makes on
    // mount, which is the noisiest case.
    return crypto.randomUUID()
  }
}

/** Stable for the life of the page, so every reconnect carries the same id. */
const CLIENT_ID = clientId()

/** The engine URL with the password attached, which is how it is authenticated. */
function engineUrl(password: string): string {
  const url = new URL(ENGINE_BASE);
  url.searchParams.set("token", password);
  url.searchParams.set("device", describeDevice());
  url.searchParams.set("client", CLIENT_ID);
  return url.toString();
}

/**
 * Take a password from the URL if one was passed, then scrub it from the
 * address bar. Runs once at module load, before React mounts, so the address
 * bar is already clean by first paint.
 */
const ADOPTED = adoptPasswordFromUrl();

export function App(): React.ReactElement {
  // Layout policy the user can change without a rebuild. Held in a ref as well
  // as read here, because the update callbacks are stable and must see the
  // current value rather than the one captured when they were created.
  //
  // Sections, not the whole store: this is the root of the tree, and a
  // subscription to everything meant every preference write re-rendered the
  // entire shell. The gamepad panel writes on every opacity-slider move and on
  // every skin tap, and each of those re-rendering the desktop under a live
  // stream is exactly the lag it looked like.
  const layoutPrefs = usePrefSection("layout");
  const streamPrefs = usePrefSection("stream");
  const motionPrefs = usePrefSection("motion");
  const stripConfig = useMemo<StripConfig>(() => configFrom(layoutPrefs), [layoutPrefs]);
  const configRef = useRef(stripConfig);
  configRef.current = stripConfig;

  // Null until a password is available, which is what gates the whole shell.
  const [password, setPassword] = useState<string | null>(
    () => ADOPTED ?? loadPassword(),
  );
  const [authError, setAuthError] = useState<string>();
  const [permissions, setPermissions] = useState<Permissions>(VIEW_ONLY);
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<Status>("connecting");
  const [statusDetail, setStatusDetail] = useState<string>();
  const [output, setOutput] = useState<Output>({ width: 0, height: 0 });
  const [windows, setWindows] = useState<Map<WindowId, WindowInfo>>(new Map());
  /**
   * Windows the engine has said have drawn nothing at all.
   *
   * Seen in production on a game's splash window: mapped, streamed, and never
   * painted once. The tile said "waiting for pixels" for the rest of the
   * session, which is the one thing that was certainly not happening.
   */
  const [blankIds, setBlankIds] = useState<ReadonlySet<WindowId>>(new Set());
  const [strip, setStrip] = useState<StripState>(EMPTY);
  // Streaming is a preference, not fixed state. See `Prefs.stream`.
  const streaming = streamPrefs.enabled;
  /**
   * What this browser can actually decode, best first.
   *
   * Probed with `VideoDecoder.isConfigSupported` rather than inferred, because
   * HEVC support is a property of the hardware and not of the browser: two
   * devices running the same Safari differ on it. Deciding from the user agent
   * gets it wrong in both directions. See `lib/codecs`.
   *
   * Empty until the probe answers, and empty forever where WebCodecs is
   * missing, which is any plain-HTTP origin. The engine reads that as JPEG.
   */
  const [decodes, setDecodes] = useState<Codec[]>([]);
  useEffect(() => {
    let live = true;
    void decodable().then((codecs) => {
      if (live) setDecodes(codecs);
    });
    return () => {
      live = false;
    };
  }, []);

  // The preference narrows what the hardware offers; it can never widen it.
  // "Auto" is everything the device can do, and naming one codec pins it, so
  // a JPEG preference is expressed by an empty list.
  const wantCodecs = useMemo<Codec[]>(() => {
    const choice = streamPrefs.codec;
    if (choice === "jpeg") return [];
    if (choice === "auto") return decodes;
    return decodes.filter((codec) => codec === choice);
  }, [streamPrefs.codec, decodes]);
  /**
   * Whether this connection decides layout.
   *
   * A session can have several devices attached at once, but a window has
   * exactly one size, so there is exactly one arrangement and exactly one
   * connection that chooses it. A follower still sends input and still asks
   * for the streams it needs; it just renders the arrangement it is sent
   * instead of computing one. See `ToShell.role`.
   */
  const [primary, setPrimary] = useState(true);
  const primaryRef = useRef(true);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  /**
   * What the engine says it is running. Null until it says, and from any
   * engine old enough not to send it. See `SHELL_VERSION`.
   */
  const [engineVersion, setEngineVersion] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<SessionId>(0);
  /** The arrangement a follower was sent, in the engine's output space. */
  const [followed, setFollowed] = useState<WindowLayout[]>([]);

  const connection = useRef<Connection | null>(null);
  /** The last box `Desktop` measured, whether or not it was sent. */
  const lastViewport = useRef<{ width: number; height: number; scale: number } | null>(null);
  /**
   * True between asking the engine to resize and being told it has.
   *
   * Layout is held back in that window, so windows are configured once for the
   * shape they will keep rather than once for the old shape and again for the
   * new one. See the `hello` handler.
   */
  const awaitingOutput = useRef(false);
  const decoderRef = useRef<FrameDecoder | null>(null);
  // Refs so the message handler, which is created once, always reads current
  // values instead of the ones captured when the socket opened.
  const stripRef = useRef(strip);
  const outputRef = useRef(output);
  stripRef.current = strip;
  outputRef.current = output;

  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const wantsAudio = streamPrefs.audio;
  const codecsRef = useRef(wantCodecs);
  codecsRef.current = wantCodecs;

  /**
   * Whether this browser can decode Opus: `null` until the probe answers.
   *
   * State, not a ref, and nullable, both deliberately. The probe is async,
   * and the audio effect used to read a ref that still held its `false`
   * placeholder when a saved preference switched audio on at page load. The
   * engine was then told this device cannot decode Opus and streamed raw PCM
   * at 1.5 Mbit/s for the whole session: audio that sounded perfect while
   * quietly eating the video's budget. Being state re-runs the effect when
   * the real answer lands, and being nullable lets the effect wait for it.
   */
  const [opusKnown, setOpusKnown] = useState<boolean | null>(null);
  useEffect(() => {
    void decodesOpus().then(setOpusKnown);
  }, []);
  const animateRef = useRef(motionPrefs.animate);
  animateRef.current = motionPrefs.animate;
  // Read by `push`, which is deliberately dependency-free; the effect keyed
  // on the preference below keeps it current and resends the list.
  const pauseInactiveRef = useRef(streamPrefs.pauseInactive);

  /** Forward input aimed at a window, tagging it with which window it hit. */
  const sendInput = useCallback((id: WindowId, event: SurfaceInput) => {
    const conn = connection.current;
    if (!conn) return;
    switch (event.kind) {
      case "motion":
        conn.send({
          type: "pointerMotion",
          window: id,
          x: event.x,
          y: event.y,
        });
        break;
      case "button":
        conn.send({
          type: "pointerButton",
          button: event.button,
          pressed: event.pressed,
        });
        break;
      case "axis":
        conn.send({
          type: "pointerAxis",
          horizontal: event.horizontal,
          vertical: event.vertical,
        });
        break;
      case "touchDown":
        conn.send({
          type: "touchDown",
          window: id,
          id: event.id,
          x: event.x,
          y: event.y,
        });
        break;
      case "touchMotion":
        conn.send({
          type: "touchMotion",
          window: id,
          id: event.id,
          x: event.x,
          y: event.y,
        });
        break;
      case "touchUp":
        conn.send({ type: "touchUp", id: event.id });
        break;
    }
  }, []);

  /** Push the current strip to the engine as a target plus a spring. */
  const push = useCallback((next: StripState, out: Output, animate = true) => {
    const windows = layout(next, out, configRef.current);
    // A follower's arrangement is not its own to declare. Sending it anyway
    // would be dropped by the engine, but it would also mean two devices
    // computing conflicting geometry and each briefly rendering its own.
    if (primaryRef.current) {
      connection.current?.send({
        type: "setLayout",
        windows,
        animate: animate ? { spring: SCROLL_SPRING } : null,
      });
    }
    // The same declaration, to the same effect, for the surfaces in this page.
    // Told here rather than in a render effect so the browser and the engine
    // are given one description of the move at one instant, instead of the
    // engine hearing about it now and the DOM finding out after React commits.
    if (primaryRef.current) motion.set(windows, animate && animateRef.current);
    const focused = focusedWindow(next);
    if (focused !== null) {
      connection.current?.send({ type: "focusWindow", id: focused });
    }

    // Ask for pixels only for columns the viewport can actually show, and
    // with `pauseInactive` on (the default) only the focused one of those,
    // plus the rest of its column when that column is marked live. This is
    // what keeps the encoder budget bounded rather than growing with how many
    // windows are open. See `streamList` for the rules together. Focus changes
    // always come through `update`, so the list follows focus without anything
    // extra here, and so does the live column, which is read from focus.
    connection.current?.send({
      type: "setStreams",
      windows: streamingRef.current
        ? streamList(
            windows,
            out,
            configRef.current,
            focused,
            pauseInactiveRef.current,
            fullscreenWindow(next),
            liveWindows(next),
          )
        : [],
      // What this browser can actually decode, asked of it rather than
      // guessed. Over plain HTTP there is no VideoDecoder at all, and claiming
      // a codec anyway would mean permanently blank windows.
      codecs: codecsRef.current,
    });
  }, []);

  const update = useCallback(
    (fn: Transition, animate = true) => {
      const out = outputRef.current;
      const next = fn(stripRef.current, out, configRef.current);
      stripRef.current = next;
      setStrip(next);
      push(next, out, animate);
    },
    [push],
  );

  // Flipping the pause-inactive preference takes effect when it is flipped,
  // not at the next reflow. The list is otherwise sent from `push`, which
  // runs on strip transitions, and a settings toggle is not one.
  const pauseInactive = streamPrefs.pauseInactive;
  useEffect(() => {
    pauseInactiveRef.current = pauseInactive;
    const out = outputRef.current;
    if (out.width <= 0) return;
    const state = stripRef.current;
    connection.current?.send({
      type: "setStreams",
      windows: streamingRef.current
        ? streamList(
            layout(state, out, configRef.current),
            out,
            configRef.current,
            focusedWindow(state),
            pauseInactive,
            fullscreenWindow(state),
            liveWindows(state),
          )
        : [],
      codecs: codecsRef.current,
    });
  }, [pauseInactive]);

  useEffect(() => {
    if (!password) return;

    const handleMessage = (message: ToShell) => {
      switch (message.type) {
        case "hello": {
          // Report a crash from the previous page load, now that there is a
          // session to report it to. Here rather than on the socket opening,
          // because the engine has to have a session for this connection
          // before it can attribute anything to it. See `takeCrashToReport`.
          reportAnyCrash(connection.current);
          setPermissions(message.permissions);
          // A `hello` also arrives when the owner changes what this session
          // may do. Losing the right to interact takes the clipboard with
          // it: the engine has already destroyed the ticket, so holding the
          // history here would leave rows nothing could fetch.
          if (message.permissions.mode !== "interact") clipReset();
          setAccount(message.account);
          setSessionId(message.session);
          setPrimary(message.primary);
          primaryRef.current = message.primary;
          setPeers(message.peers);
          const out = {
            width: message.output.width,
            height: message.output.height,
          };
          outputRef.current = out;
          setOutput(out);
          setWindows(new Map(message.windows.map((w) => [w.id, w])));

          // Rebuild the strip from the engine's view of the world rather than
          // trusting whatever this page had before. A reconnecting shell must
          // resync, not resurrect a stale layout.
          let next = message.windows.reduce(
            (state, w) => addWindow(state, w.id, out, configRef.current),
            EMPTY,
          );
          if (message.focused !== null) {
            next = focusWindow(next, message.focused, out, configRef.current);
          }

          // A socket flap must not yank a fullscreen game back to windowed.
          //
          // The engine's hello names windows and focus but not arrangement,
          // because arrangement is this side's job, so the rebuilt strip
          // starts with nothing fullscreen. Laying it out as-is tells the
          // engine to un-fullscreen the game, the game immediately asks
          // again, and the round trip costs an encoder rebuild and a visible
          // flicker on every reconnect. The engine now says which windows
          // fill the output (`WindowInfo.fullscreen`), so the fullscreen state
          // is restored from the wire rather than from this page's own memory:
          // that also covers a page that reloaded or a fresh device, where the
          // old carry-over from local state knew nothing.
          for (const w of message.windows) {
            if (w.fullscreen) {
              next = setFullscreen(next, w.id, true, out, configRef.current);
            }
          }

          stripRef.current = next;
          setStrip(next);

          // Do not lay windows out for an output that is about to change.
          //
          // The engine's output is whatever the last primary asked for, which
          // on a fresh connection is rarely this device's shape. Laying out
          // against it and *then* reporting the viewport resizes every window
          // twice, and a resize is an H.264 `configure`: the session cannot
          // change resolution mid-stream, so each one is torn down and rebuilt
          // at 90-160ms. A single reconnect was rebuilding every streamed
          // window two or three times over, which is most of what "the engine
          // freezes when I refresh" was.
          //
          // So when the shape is already wrong, ask for the right one and let
          // `outputChanged` drive the first layout.
          const measured = lastViewport.current;
          const mismatched =
            primaryRef.current &&
            measured !== null &&
            (measured.width !== out.width || measured.height !== out.height);

          if (mismatched) {
            awaitingOutput.current = true;
            connection.current?.send({ type: "setViewport", ...measured });
            // A backend that cannot resize (the TTY one owns a real display)
            // never answers, and the session must not sit there empty waiting.
            window.setTimeout(() => {
              if (!awaitingOutput.current) return;
              awaitingOutput.current = false;
              push(stripRef.current, outputRef.current, false);
            }, 1500);
          } else {
            // No animation on resync: windows should appear in place.
            push(next, out, false);
          }
          break;
        }

        case "outputChanged": {
          const out = {
            width: message.output.width,
            height: message.output.height,
          };
          outputRef.current = out;
          setOutput(out);
          // Whether this is the answer we were waiting for or an ordinary
          // resize, the response is the same: lay out for the shape we now
          // have. Clearing the flag stops the safety timer firing a second
          // layout on top of this one.
          awaitingOutput.current = false;
          update((state) => reflow(state, out, configRef.current), false);
          break;
        }

        case "role": {
          setPrimary(message.primary);
          primaryRef.current = message.primary;
          // Taking over means this page starts deciding again, so the
          // arrangement it was following is no longer what to render. The
          // engine sends a fresh `hello` alongside this, which rebuilds the
          // strip; clearing here stops one frame of the old one showing
          // through in between.
          if (message.primary) setFollowed([]);
          break;
        }

        case "layout": {
          // Only meaningful while following. The primary computes its own, and
          // a stale broadcast arriving after a handover must not overwrite it.
          if (primaryRef.current) break;
          const out = {
            width: message.output.width,
            height: message.output.height,
          };
          outputRef.current = out;
          setOutput(out);
          setFollowed(message.windows);
          break;
        }

        case "peers": {
          setPeers(message.peers);
          break;
        }

        case "windowOpened":
          log("info", `window ${message.window.id} opened (${message.window.appId ?? "?"})`);
          clearLaunchFor(message.window.appId);
          // A window appearing is the end of the "already open" story too: the
          // program was closed on the desktop and has opened in here.
          clearBlocked();
          setWindows((prev) =>
            new Map(prev).set(message.window.id, message.window),
          );
          update((state, out) =>
            addWindow(state, message.window.id, out, configRef.current),
          );
          break;

        case "windowChanged":
          setWindows((prev) =>
            new Map(prev).set(message.window.id, message.window),
          );
          break;

        case "engineVersion":
          setEngineVersion(message.version);
          if (message.version !== SHELL_VERSION) {
            log(
              "warn",
              `this page is running ${SHELL_VERSION}, the machine is running ${message.version}`,
            );
          }
          break;

        case "windowBlank":
          // The engine has watched this window produce nothing for several
          // seconds, or has watched it finally produce something. Only the
          // engine can tell: from here a window sending no frames and an idle
          // window whose picture has not changed look the same.
          setBlankIds((prev) => {
            if (prev.has(message.id) === message.blank) return prev;
            const next = new Set(prev);
            if (message.blank) {
              next.add(message.id);
              log("warn", `window ${message.id} has drawn nothing`);
            } else {
              next.delete(message.id);
            }
            return next;
          });
          break;

        case "windowClosed":
          setWindows((prev) => {
            const next = new Map(prev);
            next.delete(message.id);
            return next;
          });
          setBlankIds((prev) => {
            if (!prev.has(message.id)) return prev;
            const next = new Set(prev);
            next.delete(message.id);
            return next;
          });
          dropFrame(message.id);
          decoderRef.current?.forget(message.id);
          update((state, out) =>
            removeWindow(state, message.id, out, configRef.current),
          );
          break;

        case "apps": {
          setApps(message.apps)
          // Serve what this device already has, then ask only for the rest.
          // On a returning client that is usually an empty request.
          const ids = message.apps.filter((a) => a.icon !== null).map((a) => a.id)
          void hydrateIcons(ids).then((missing) => {
            if (missing.length > 0) {
              iconsRequested(missing)
              connection.current?.send({ type: "requestIcons", ids: missing })
            }
          })
          break
        }

        case "windowless":
          setWindowless(message.apps)
          break

        case "appIcons":
          setAppIcons(message.icons)
          break

        case "accounts":
          setAccounts(message.accounts)
          break

        case "clipReady":
          // Sent only to a session that may interact. Everything the panel
          // needs beyond the session socket rides on this: the credential
          // for fetching entry bytes and for sending files back.
          clipReady(message.channel, message.ticket)
          break

        case "clipAdded":
          clipAdded(message.item)
          break

        case "clipDropped":
          clipDropped(message.id)
          break

        case "clipCleared":
          clipCleared()
          break

        case "clipHistory":
          clipHistory(message.request, message.items, message.more)
          break

        case "fullscreenRequest":
          // The fullscreen button inside a video player. The engine forwards
          // it because the arrangement is decided here; see `setFullscreen`.
          update((st, o) =>
            setFullscreen(st, message.window, message.fullscreen, o, configRef.current),
          );
          break;

        case "alreadyRunning":
          // Not an error: the engine did exactly the right thing by refusing
          // to spawn. The dialog asks what to do about it.
          resolvePending(`launch:${message.command}`);
          blocked({
            command: message.command,
            terminal: message.terminal,
            program: message.program,
            pid: message.pid,
          });
          break;

        case "fileChooser":
          // An application on the desktop wants files, and this session is
          // the one being asked. State lives in lib/fileDialog; the modal
          // renders from it. A re-send after a reconnect is recognised by
          // its request id and keeps the local state, uploads included.
          fileDialogOpened(message);
          break;

        case "fileChooserClosed":
          // Over without our answer: withdrawn, expired, or answered by
          // another session. The engine already cleaned the machine up.
          dropUploader(message.request);
          fileDialogClosed(message.request);
          break;

        case "dirListing":
          fileDialogListed(message);
          break;

        case "pathInfo":
          fileDialogDescribed(message);
          break;

        case "error":
          // Routing by the request name keeps this from becoming a global
          // error bus that every panel has to filter.
          log("error", `${message.request}: ${message.message}`);
          if (message.request.endsWith("Account") || message.request === "listAccounts") {
            setAccountError(message.message)
          }
          if (message.request === "setGamepad") {
            // The machine would not give us a virtual controller, usually
            // because this user cannot write to /dev/uinput. Drop to sending
            // keycodes, or the pad would send button messages the engine has
            // nothing to deliver them to and every control would be dead.
            setPrefs((prev) => ({
              ...prev,
              gamepad: { ...prev.gamepad, mode: "keyboard" },
            }))
          }
          break

        case "focusChanged":
          // The engine tells us only about focus changes it did not get from
          // us (a click, or a window closing), so follow it.
          if (message.id !== null) {
            update((state, out) =>
              focusWindow(state, message.id!, out, configRef.current),
            );
          }
          break;

        case "keyBinding": {
          // Every one of these is layout policy, which is why the engine
          // forwards them rather than acting on them itself.
          const { key, modifiers } = message;
          const shifted = modifiers.shift;

          if (key === "h" || key === "Left") {
            update(shifted ? consumeAt : focusLeftAt);
          } else if (key === "l" || key === "Right") {
            update(shifted ? expelAt : focusRightAt);
          } else if (key === "k" || key === "Up") {
            update(shifted ? moveWorkspaceUpAt : focusUpAt);
          } else if (key === "j" || key === "Down") {
            update(shifted ? moveWorkspaceDownAt : focusDownAt);
          } else if (key === "1" || key === "2" || key === "3") {
            // Jump straight to a workspace by number.
            const target = Number(key) - 1;
            update((st, o) =>
              focusWorkspace(st, target - st.focus, o, configRef.current),
            );
          } else if (key === "4") {
            update(cycleWidthAt);
          } else if (key === "f") {
            update(toggleFullscreenAt);
          } else if (key === "w") {
            const focused = focusedWindow(stripRef.current);
            if (focused !== null)
              connection.current?.send({ type: "closeWindow", id: focused });
          }
          break;
        }
      }
    };

    // Straight into the frame store: no React state, so an arriving frame
    // re-renders exactly the one surface showing it. See lib/frames.ts.
    const decoder = new FrameDecoder(publishFrame);
    decoderRef.current = decoder;

    const handleFrame = (frame: DecodedFrame) => {
      void decoder.handle(frame);
    };

    // One decoder for the session: Opus predicts from previous packets, so it
    // has to persist across them.
    const opusStream = new OpusStream((left, right) => audio.playPlanar(left, right));

    const conn = new Connection(engineUrl(password), {
      onMessage: handleMessage,
      onFrame: handleFrame,
      onAudio: (payload, format, frames) => {
        // Opus is decoded into the float planes the player takes directly,
        // rather than giving the player a second way to make sound. See
        // `lib/opus`.
        if (format === AudioFormat.Opus) {
          audio.noteWire("opus", payload.byteLength);
          opusStream.push(payload, frames);
          return;
        }
        audio.noteWire("pcm", payload.byteLength);
        // A view over an even byte offset: the wire header is 16 bytes, and
        // Int16Array insists on alignment.
        audio.play(
          new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength >> 1),
        );
      },
      onStatus: (s, detail) => {
        // A socket that has just come up may have delivered its backlog in one
        // burst, and both audio players absorb a burst as permanent delay
        // rather than as a moment of catching up. Dropping what is held costs
        // a few tens of milliseconds of sound nobody was going to enjoy and
        // saves a fifth of a second of lag for the rest of the session. See
        // `lib/audio.flush`.
        if (s === "connected") audio.flush();
        setStatus(s);
        setStatusDetail(detail);
        log(
          s === "connected" ? "info" : s === "connecting" ? "info" : "warn",
          detail ? `${s}: ${detail}` : s,
        );
        // Deliberately does NOT clear the stored password. The shell cannot
        // tell a refused password from an engine that is not running (see
        // `connection.ts`), and wiping a correct password every time the
        // engine restarts is far worse than leaving a wrong one in place.
        // The badge shows the state, and "Forget password" is one tap away.
      },
    });
    connection.current = conn;

    // Connect only once this tab is the one that should hold the session.
    //
    // The engine identifies a browser by an id in `localStorage`, which every
    // tab of that browser shares, so two tabs present the same identity and
    // the engine treats each as the other reconnecting. Electing a leader is
    // what makes exactly one of them right, rather than leaving them to argue.
    // See `lib/leader`.
    // "Waiting", not "connecting": until this tab holds the lock there is no
    // attempt in flight, and a tab queued behind another would otherwise show
    // a spinner forever that looked exactly like a connection about to
    // succeed. See `lib/status`.
    setStatus("waiting");
    const leadership = requestLeadership(() => {
      setStatus("connecting");
      conn.connect();
    });

    // A reload is not an unmount, so the cleanup below never runs for one.
    //
    // React tears a component down when it leaves a live document; a document
    // being replaced skips every effect cleanup there is. That abandoned a
    // `VideoDecoder` per window and the `AudioContext` on every single reload,
    // and neither is ordinary garbage: WebKit keeps decoders in a GPU process
    // that outlives the page, and iOS Safari stops producing sound after about
    // four contexts. So reloading to fix a stuttering stream quietly made it
    // worse, and quitting the browser was the only thing that cleared it.
    //
    // `persisted` means the page is going into the back/forward cache and may
    // be shown again, in which case it must keep what it has; `connection.ts`
    // handles waking that up. Only a real teardown is torn down.
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      conn.close();
      decoder.close();
      clearFrames();
      opusStream.close();
      void audio.stop();
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      // Released before closing, so a waiting tab is promoted the moment this
      // one lets go rather than after its socket has finished dying.
      leadership.release();
      conn.close();
      decoder.close();
      clearFrames();
      opusStream.close();
      // The old answer would otherwise linger and claim a codec is in use
      // after the stream has stopped.
      clearFormat();
      clearStats();
      // Another machine has a different set of applications and accounts.
      clearApps();
      clearAccounts();
      // And a different clipboard, whose entry ids mean nothing here. The
      // ticket this session was given is dead the moment the socket is.
      clipReset();
      connection.current = null;
      decoderRef.current = null;
    };
  }, [password, push, update]);

  // Keyboard input is captured on the document rather than per element,
  // because keyboard focus lives in the compositor and there is nothing
  // focusable in the DOM that corresponds to it.
  useEffect(() => {
    if (status !== "connected") return;

    const forward = (event: KeyboardEvent, pressed: boolean) => {
      if (isShellKey(event)) return;
      // Typing into the shell's own text fields is not input for the machine.
      // Without this the capture-phase listener eats the keystroke before the
      // browser can insert it, so the search box never fills and the letters
      // arrive in whatever window has focus on the far end instead.
      if (isTextEntry(event.target)) return;
      // Drop browser autorepeat. Wayland tells clients the repeat rate and
      // they generate their own repeats, and the compositor's keyboard handle
      // repeats too. Forwarding the browser's as well means a held key repeats
      // two or three times over, which shows up as duplicated characters.
      if (pressed && event.repeat) return;
      const key = evdevFromCode(event.code);
      if (key === null) return;
      // Stop the browser acting on it too. Without this Ctrl+W closes the tab
      // instead of reaching the application, which is a very bad surprise.
      event.preventDefault();
      connection.current?.send({ type: "key", key, pressed });
    };

    const down = (event: KeyboardEvent) => forward(event, true);
    const up = (event: KeyboardEvent) => forward(event, false);
    // Capture phase, so React's own handlers do not swallow anything first.
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });

    const blur = () => {
      // Held keys would otherwise stay down in the compositor forever, which
      // shows up as a key repeating until you alt-tab back and press it again.
      connection.current?.send({ type: "pointerLeave" });
    };
    window.addEventListener("blur", blur);

    return () => {
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
      window.removeEventListener("blur", blur);
    };
  }, [status]);

  // What this page actually renders: its own arrangement when it is driving,
  // the one it was sent when it is not.
  const placed = useMemo(
    () =>
      primary
        ? output.width > 0
          ? layout(strip, output, configRef.current)
          : []
        : followed,
    [primary, strip, output, followed],
  );

  // A follower is not told about layout through `push`, so the animator has to
  // be told here instead. Same declaration, same instant, one frame later.
  useEffect(() => {
    if (!primary) motion.set(followed, motionPrefs.animate);
  }, [primary, followed, motionPrefs.animate]);

  // Stable across renders, so every WindowSurface keeps its memo. Building
  // these inline would hand each surface a fresh function on every frame and
  // undo the whole point of the per-window frame store.
  const focusById = useCallback(
    (id: WindowId) => update((s, o) => focusWindow(s, id, o, configRef.current)),
    [update],
  );

  // Stable, so the observer in Desktop is not torn down every render.
  const reportViewport = useCallback(
    (width: number, height: number, scale: number) => {
      // Remembered even when it is not sent, because this device may become
      // the primary later and will then have to resize the output to itself.
      // Measuring again at that point would mean reaching back into `Desktop`
      // for a box it already measured.
      lastViewport.current = { width, height, scale }
      // Only the primary resizes the compositor. Two devices reporting their
      // own viewports would resize the output back and forth forever, and
      // every window with it. A follower fits the output it is given into its
      // own screen instead; see `Desktop`.
      if (!primaryRef.current) return
      connection.current?.send({ type: "setViewport", width, height, scale })
    },
    [],
  )

  // Audio follows the preference, on both ends.
  //
  // Two things have to agree: this page has to have an audio graph running,
  // and the engine has to be capturing and sending. Tied to one effect so they
  // cannot drift apart into "playing silence" or "sending to nobody".
  //
  // Also keyed on the session id: a reconnect is a new session on the engine,
  // and it has never been told that this device wants sound.
  useEffect(() => {
    // Wait for the Opus probe. Telling the engine "no Opus" a moment before
    // learning better means a session of uncompressed audio; see `opusKnown`.
    if (opusKnown === null) return;
    if (!wantsAudio) {
      connection.current?.send({ type: "setAudio", enabled: false, local: streamPrefs.localPlayback, opus: opusKnown, quality: streamPrefs.audioQuality });
      void audio.stop();
      return;
    }

    let cancelled = false;
    void audio.start().then((ok) => {
      if (cancelled) return;
      if (!ok) {
        log("warn", "audio could not start on this device");
        return;
      }
      audio.setVolume(streamPrefs.volume);
      connection.current?.send({ type: "setAudio", enabled: true, local: streamPrefs.localPlayback, opus: opusKnown, quality: streamPrefs.audioQuality });
    });
    // Browsers hold a new AudioContext suspended until the page has been
    // touched. If audio was on from a saved preference, this is what starts it
    // at the first tap rather than leaving it silently muted.
    const release = audio.unlock();
    return () => {
      cancelled = true;
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsAudio, sessionId, opusKnown]);

  useEffect(() => {
    audio.setVolume(streamPrefs.volume);
  }, [streamPrefs.volume]);

  // Local playback and the quality choice are re-sent whenever they change
  // rather than only when audio is switched on.
  useEffect(() => {
    if (!wantsAudio || opusKnown === null) return;
    connection.current?.send({ type: "setAudio", enabled: true, local: streamPrefs.localPlayback, opus: opusKnown, quality: streamPrefs.audioQuality });
  }, [wantsAudio, opusKnown, streamPrefs.localPlayback, streamPrefs.audioQuality]);

  // Re-report the viewport whenever this device starts driving a session.
  //
  // Keyed on the session id as well as the role, because both are reasons the
  // engine may not know this device's shape:
  //
  // - Being handed the wheel. The measurement did not change, so nothing else
  //   would send it: `Desktop` reports on mount and on resize, and a handover
  //   is neither.
  // - Reconnecting. The engine restarted or the network dropped, and the
  //   session on the other side is a new one that has never been told. This
  //   was a real bug: the page stayed mounted across the reconnect, so the one
  //   report at mount had already happened and the compositor sat at its
  //   default size while the browser scaled the whole desktop down to fit.
  useEffect(() => {
    if (!primary) return
    const measured = lastViewport.current
    if (!measured) return
    connection.current?.send({ type: "setViewport", ...measured })
  }, [primary, sessionId])

  const streamedIds = useMemo(() => {
    if (!streaming) return new Set<WindowId>();
    return new Set(
      placed
        .filter((w) => intersectsViewport(w.rect, output, configRef.current))
        .map((w) => w.id),
    );
    // Both dimensions: a height-only viewport change moves windows in and out
    // of view exactly like a width change, and the deps used to say width
    // alone, leaving the streamed set stale until something else nudged it.
  }, [streaming, placed, output.width, output.height]);

  const focusedId = focusedWindow(strip);

  // Stable for the connection's lifetime: built once, reading live state from
  // refs rather than closing over this render's copies. A panel holding one of
  // these must not re-render because a window elsewhere blinked.
  const actions = useMemo<SessionActions>(() => {
    const send = (
      message: Parameters<NonNullable<typeof connection.current>["send"]>[0],
    ) => connection.current?.send(message);
    return {
      send: (message) => {
        if (message.type === "listApps") appsRequested()
        if (message.type === "listAccounts") accountsRequested()
        send(message)
      },
      focusWindow: (id) =>
        update((st, o) => focusWindow(st, id, o, configRef.current)),
      closeWindow: (id) => send({ type: "closeWindow", id }),
      quitApp: (id) => send({ type: "quitApp", id }),
      spawn: (command, terminal = false) => send({ type: "spawn", command, terminal }),
      closeAndSpawn: (command, terminal, pid, force) =>
        send({ type: "closeAndSpawn", command, terminal, pid, force }),
      focusColumn: (delta) => update(delta < 0 ? focusLeftAt : focusRightAt),
      focusInStack: (delta) => update(delta < 0 ? focusUpAt : focusDownAt),
      consume: () => update(consumeAt),
      expel: () => update(expelAt),
      moveWindow: (id, target) =>
        update((st, o) => moveWindow(st, id, target, o, configRef.current)),
      sendToWorkspace: (id, index) =>
        update((st, o) => sendToWorkspace(st, id, index, o, configRef.current)),
      cycleWidth: () => update(cycleWidthAt),
      setColumnWidth: (id, preset) =>
        update((st, o) => setColumnWidth(st, id, preset, o, configRef.current)),
      // Through `update` like every other transition, because the point of the
      // flag is the stream list and `push` is what re-sends it. Nothing moves,
      // so the layout that goes with it is the one already on screen.
      setColumnLive: (id, live) => update((st) => setColumnLive(st, id, live), false),
      setFit: (fit) => update((st, o) => setFit(st, fit, o, configRef.current)),
      takeControl: () => send({ type: "takeControl" }),
      listDir: (request, path) => send({ type: "listDir", request, path }),
      statPath: (request, path) => send({ type: "statPath", request, path }),
      fileChosen: (request, paths) => send({ type: "fileChosen", request, paths }),
      fileCancel: (request) => send({ type: "fileCancel", request }),
      signOut: () => {
        clearPassword();
        setPassword(null);
      },
      endSession: (target) => send({ type: "endSession", session: target }),
      setSessionMode: (target, mode) =>
        send({ type: "setSessionMode", session: target, mode }),
      toggleFullscreen: () => update(toggleFullscreenAt),
      focusWorkspace: (index) =>
        update((st, o) =>
          focusWorkspace(st, index - st.focus, o, configRef.current),
        ),
      moveToWorkspace: (delta) =>
        update(delta < 0 ? moveWorkspaceUpAt : moveWorkspaceDownAt),
    };
  }, [update]);

  const sessionState = useMemo<SessionState>(
    () => ({
      status,
      statusDetail,
      output,
      windows,
      strip,
      endpoint: ENGINE_BASE,
      permissions,
      account,
      session: sessionId,
      primary,
      peers,
      engineVersion,
    }),
    [status, statusDetail, output, windows, strip, primary, peers, sessionId, engineVersion],
  );

  if (!password) {
    return (
      <Login
        error={authError}
        onSubmit={(entered) => {
          savePassword(entered);
          setAuthError(undefined);
          setStatus("connecting");
          setPassword(entered);
        }}
      />
    );
  }

  return (
    <SessionActionsProvider value={actions}>
      <SessionStateProvider value={sessionState}>
        <ShellChrome>
          <Desktop
            output={output}
            onViewport={reportViewport}
        placed={placed}
            windows={windows}
            focused={focusedId}
            streamedIds={streamedIds}
            blankIds={blankIds}
            onFocus={focusById}
            onInput={sendInput}
          />
        </ShellChrome>
      </SessionStateProvider>
    </SessionActionsProvider>
  );
}

/**
 * A strip transition.
 *
 * Takes the config rather than closing over it: layout policy is now a
 * preference the user can change at runtime, and a helper defined at module
 * scope would capture whatever it was when the file loaded.
 */
type Transition = (state: StripState, out: Output, config: StripConfig) => StripState;

// Declared outside the component so `update` gets a stable reference.
const focusLeftAt: Transition = (s, o, c) => focusLeft(s, o, c);
const focusRightAt: Transition = (s, o, c) => focusRight(s, o, c);
const focusUpAt: Transition = (s) => focusUp(s);
const focusDownAt: Transition = (s) => focusDown(s);
const consumeAt: Transition = (s, o, c) => consumeIntoColumn(s, o, c);
const expelAt: Transition = (s, o, c) => expelFromColumn(s, o, c);
/**
 * Stop the launcher spinner for whichever launch this window belongs to.
 *
 * A guess, and knowingly so. Nothing on the wire ties a window back to the
 * `spawn` that caused it: there is no request id, and an application's app id
 * is its own choice, not its command line. So this matches on the command's
 * basename, which covers the common cases (`/usr/lib/firefox/firefox` against
 * `firefox`), and otherwise clears the oldest launch still waiting.
 *
 * Being wrong costs a spinner stopping a moment early on the wrong row, which
 * nobody will notice. The alternative, waiting for certainty, means a spinner
 * that runs for the full timeout every time an application picks an app id that
 * looks nothing like its binary, and that is very visible.
 */
function clearLaunchFor(appId: string | null): void {
  const waiting = pendingKeys("launch:");
  if (waiting.length === 0) return;

  const id = (appId ?? "").toLowerCase();
  const matched = id
    ? waiting.find((key) => {
        const command = key.slice("launch:".length);
        const binary = command.split(/\s+/)[0] ?? "";
        const base = (binary.split("/").pop() ?? "").toLowerCase();
        return base.length > 0 && (id.includes(base) || base.includes(id));
      })
    : undefined;

  resolvePending(matched ?? waiting[0]!);
}

const cycleWidthAt: Transition = (s, o, c) => cycleWidth(s, o, c);
const toggleFullscreenAt: Transition = (s, o, c) => toggleFullscreen(s, o, c);
const moveWorkspaceUpAt: Transition = (s, o, c) => moveToWorkspace(s, -1, o, c);
const moveWorkspaceDownAt: Transition = (s, o, c) => moveToWorkspace(s, 1, o, c);
