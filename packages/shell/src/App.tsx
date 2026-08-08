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
import { setPrefs, usePrefSection } from "@/lib/prefs"
import {
  appsRequested,
  clearApps,
  hydrateIcons,
  iconsRequested,
  setAppIcons,
  setApps,
} from "@/lib/apps"
import * as audio from "@/lib/audio"
import { engineFor } from "@/lib/engineUrl"
import { requestLeadership } from "@/lib/leader"
import { log } from "@/lib/log"
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
import { WINDOW_SPRING } from "@/generated/config"
import {
  accountsRequested,
  clearAccounts,
  setAccountError,
  setAccounts,
} from "@/lib/accounts"
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
  DEFAULT_CONFIG,
  EMPTY,
  WIDTH_PRESETS,
  type StripConfig,
  type WidthPreset,
  type Output,
  type StripState,
  addWindow,
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
  moveToWorkspace,
  moveWindow,
  reflow,
  removeWindow,
  sendToWorkspace,
  setFullscreen,
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
  const stripConfig = useMemo<StripConfig>(
    () => ({
      ...DEFAULT_CONFIG,
      orientation: layoutPrefs.orientation,
      centreFocused: layoutPrefs.centreFocused,
      // Stored as a plain number so a preferences blob written against a
      // shorter preset list cannot produce an out-of-range index.
      defaultWidth: Math.min(
        Math.max(0, layoutPrefs.defaultWidth),
        WIDTH_PRESETS.length - 1,
      ) as WidthPreset,
    }),
    [layoutPrefs],
  );
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
    // with `pauseInactive` on (the default) only the focused one of those.
    // This is what keeps the encoder budget bounded rather than growing with
    // how many windows are open. See `streamList` for the rules together.
    // Focus changes always come through `update`, so the list follows focus
    // without anything extra here.
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
          setPermissions(message.permissions);
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
          // starts with nothing fullscreen. Pushing that as-is tells the
          // engine to un-fullscreen the game, the game immediately asks
          // again, and the round trip costs two encoder rebuilds and a
          // visible flicker, in a loop while the connection is flapping.
          // This page reconnected rather than reloaded, so it still knows
          // what was fullscreen; carry it over while the window is alive.
          const before = stripRef.current.workspaces[stripRef.current.focus];
          const wasFullscreen = before?.fullscreen ?? null;
          if (
            wasFullscreen !== null &&
            message.windows.some((w) => w.id === wasFullscreen)
          ) {
            next = setFullscreen(next, wasFullscreen, true, out, configRef.current);
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

        case "windowClosed":
          setWindows((prev) => {
            const next = new Map(prev);
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

        case "appIcons":
          setAppIcons(message.icons)
          break

        case "accounts":
          setAccounts(message.accounts)
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
    const opusStream = new OpusStream((pcm) => audio.play(pcm));

    const conn = new Connection(engineUrl(password), {
      onMessage: handleMessage,
      onFrame: handleFrame,
      onAudio: (chunk, format, frames) => {
        // Opus is decoded into the PCM the player already takes, rather than
        // giving the player a second way to make sound. See `lib/opus`.
        if (format === AudioFormat.Opus) {
          opusStream.push(chunk, frames);
          return;
        }
        audio.play(chunk);
      },
      onStatus: (s, detail) => {
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
    return () => {
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
      // Another machine has a different set of applications and accounts.
      clearApps();
      clearAccounts();
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
  }, [streaming, placed, output.width]);

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
    }),
    [status, statusDetail, output, windows, strip, primary, peers, sessionId],
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
