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
  Permissions,
  ToShell,
  WindowId,
  WindowInfo,
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
import { FrameDecoder, supportsH264 } from "./decode.js";
import { clearFrames, dropFrame, publishFrame } from "@/lib/frames"
import { appsRequested, clearApps, setApps } from "@/lib/apps"
import { log } from "@/lib/log"
import {
  accountsRequested,
  clearAccounts,
  setAccountError,
  setAccounts,
} from "@/lib/accounts"
import { ShellChrome } from "@/components/ShellChrome";
import { Desktop } from "@/components/Desktop";
import { SessionBadge } from "@/components/SessionBadge";
import {
  SessionActionsProvider,
  SessionStateProvider,
  type SessionActions,
  type SessionState,
} from "./session.js";
import type { SurfaceInput } from "./WindowSurface.js";
import { evdevFromCode, isShellKey } from "./input.js";
import {
  DEFAULT_CONFIG,
  EMPTY,
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
  intersectsViewport,
  layout,
  moveToWorkspace,
  reflow,
  removeWindow,
} from "./strip.js";

/**
 * Spring for strip scrolling. Quick, with a touch of overshoot so it reads as
 * physical. The engine integrates it; this only names it.
 */
const SCROLL_SPRING = { stiffness: 220, damping: 26, mass: 1 };

/**
 * Where the engine is.
 *
 * Defaults to whatever host served this page, so opening the shell at
 * `http://192.168.1.x:6733` from a tablet finds the engine on the same machine
 * with nothing to configure. Override with `?engine=ws://host:port` when the
 * two are not co-located.
 */
const ENGINE_BASE =
  new URLSearchParams(location.search).get("engine") ??
  `ws://${location.hostname || "localhost"}:6734`;

/** The engine URL with the password attached, which is how it is authenticated. */
function engineUrl(password: string): string {
  const url = new URL(ENGINE_BASE);
  url.searchParams.set("token", password);
  return url.toString();
}

/**
 * Take a password from the URL if one was passed, then scrub it from the
 * address bar. Runs once at module load, before React mounts, so the address
 * bar is already clean by first paint.
 */
const ADOPTED = adoptPasswordFromUrl();

export function App(): React.ReactElement {
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
  const [streaming] = useState(true);

  const connection = useRef<Connection | null>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);
  // Refs so the message handler, which is created once, always reads current
  // values instead of the ones captured when the socket opened.
  const stripRef = useRef(strip);
  const outputRef = useRef(output);
  stripRef.current = strip;
  outputRef.current = output;

  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

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
    const windows = layout(next, out, DEFAULT_CONFIG);
    connection.current?.send({
      type: "setLayout",
      windows,
      animate: animate ? { spring: SCROLL_SPRING } : null,
    });
    const focused = focusedWindow(next);
    if (focused !== null) {
      connection.current?.send({ type: "focusWindow", id: focused });
    }

    // Ask for pixels only for columns the viewport can actually show. This is
    // what keeps the encoder budget bounded by viewport width rather than by
    // how many windows are open. See docs/architecture.md section 2.3.
    connection.current?.send({
      type: "setStreams",
      windows: streamingRef.current
        ? windows
            .filter((w) => intersectsViewport(w.rect, out.width))
            .map((w) => w.id)
        : [],
      // Tell the engine what this browser can actually decode. Over plain HTTP
      // there is no WebCodecs VideoDecoder, and asking for H.264 anyway would
      // mean permanently blank windows.
      h264: supportsH264(),
    });
  }, []);

  const update = useCallback(
    (fn: (state: StripState, out: Output) => StripState, animate = true) => {
      const out = outputRef.current;
      const next = fn(stripRef.current, out);
      stripRef.current = next;
      setStrip(next);
      push(next, out, animate);
    },
    [push],
  );

  useEffect(() => {
    if (!password) return;

    const handleMessage = (message: ToShell) => {
      switch (message.type) {
        case "hello": {
          setPermissions(message.permissions);
          setAccount(message.account);
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
            (state, w) => addWindow(state, w.id, out, DEFAULT_CONFIG),
            EMPTY,
          );
          if (message.focused !== null) {
            next = focusWindow(next, message.focused, out, DEFAULT_CONFIG);
          }
          stripRef.current = next;
          setStrip(next);
          // No animation on resync: windows should appear in place, not fly in.
          push(next, out, false);
          break;
        }

        case "outputChanged": {
          const out = {
            width: message.output.width,
            height: message.output.height,
          };
          outputRef.current = out;
          setOutput(out);
          update((state) => reflow(state, out, DEFAULT_CONFIG), false);
          break;
        }

        case "windowOpened":
          log("info", `window ${message.window.id} opened (${message.window.appId ?? "?"})`);
          setWindows((prev) =>
            new Map(prev).set(message.window.id, message.window),
          );
          update((state, out) =>
            addWindow(state, message.window.id, out, DEFAULT_CONFIG),
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
            removeWindow(state, message.id, out, DEFAULT_CONFIG),
          );
          break;

        case "apps":
          setApps(message.apps)
          break

        case "accounts":
          setAccounts(message.accounts)
          break

        case "error":
          // Only account administration reports errors so far. Routing by the
          // request name keeps this from becoming a global error bus that
          // every panel has to filter.
          log("error", `${message.request}: ${message.message}`);
          if (message.request.endsWith("Account") || message.request === "listAccounts") {
            setAccountError(message.message)
          }
          break

        case "focusChanged":
          // The engine tells us only about focus changes it did not get from
          // us (a click, or a window closing), so follow it.
          if (message.id !== null) {
            update((state, out) =>
              focusWindow(state, message.id!, out, DEFAULT_CONFIG),
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
              focusWorkspace(st, target - st.focus, o, DEFAULT_CONFIG),
            );
          } else if (key === "4") {
            update(cycleWidthAt);
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

    const conn = new Connection(engineUrl(password), {
      onMessage: handleMessage,
      onFrame: handleFrame,
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
    conn.connect();
    return () => {
      conn.close();
      decoder.close();
      clearFrames();
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

  const placed = useMemo(
    () => (output.width > 0 ? layout(strip, output, DEFAULT_CONFIG) : []),
    [strip, output],
  );

  // Stable across renders, so every WindowSurface keeps its memo. Building
  // these inline would hand each surface a fresh function on every frame and
  // undo the whole point of the per-window frame store.
  const focusById = useCallback(
    (id: WindowId) => update((s, o) => focusWindow(s, id, o, DEFAULT_CONFIG)),
    [update],
  );

  const streamedIds = useMemo(() => {
    if (!streaming) return new Set<WindowId>();
    return new Set(
      placed
        .filter((w) => intersectsViewport(w.rect, output.width))
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
        update((st, o) => focusWindow(st, id, o, DEFAULT_CONFIG)),
      closeWindow: (id) => send({ type: "closeWindow", id }),
      spawn: (command) => send({ type: "spawn", command }),
      focusColumn: (delta) => update(delta < 0 ? focusLeftAt : focusRightAt),
      focusInStack: (delta) => update(delta < 0 ? focusUpAt : focusDownAt),
      consume: () => update(consumeAt),
      expel: () => update(expelAt),
      cycleWidth: () => update(cycleWidthAt),
      focusWorkspace: (index) =>
        update((st, o) =>
          focusWorkspace(st, index - st.focus, o, DEFAULT_CONFIG),
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
    }),
    [status, statusDetail, output, windows, strip],
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
            placed={placed}
            windows={windows}
            focused={focusedId}
            streamedIds={streamedIds}
            onFocus={focusById}
            onInput={sendInput}
          />
          <SessionBadge
            status={status}
            detail={statusDetail}
            endpoint={ENGINE_BASE}
            workspace={strip.focus + 1}
            workspaces={strip.workspaces.length}
            streaming={streaming}
            hardwareDecode={supportsH264()}
            onSignOut={() => {
              clearPassword();
              setPassword(null);
            }}
          />
        </ShellChrome>
      </SessionStateProvider>
    </SessionActionsProvider>
  );
}

// Declared outside the component so `update` gets a stable reference.
const focusLeftAt = (s: StripState, o: Output) =>
  focusLeft(s, o, DEFAULT_CONFIG);
const focusRightAt = (s: StripState, o: Output) =>
  focusRight(s, o, DEFAULT_CONFIG);
const focusUpAt = (s: StripState) => focusUp(s);
const focusDownAt = (s: StripState) => focusDown(s);
const consumeAt = (s: StripState, o: Output) =>
  consumeIntoColumn(s, o, DEFAULT_CONFIG);
const expelAt = (s: StripState, o: Output) =>
  expelFromColumn(s, o, DEFAULT_CONFIG);
const cycleWidthAt = (s: StripState, o: Output) =>
  cycleWidth(s, o, DEFAULT_CONFIG);
const moveWorkspaceUpAt = (s: StripState, o: Output) =>
  moveToWorkspace(s, -1, o, DEFAULT_CONFIG);
const moveWorkspaceDownAt = (s: StripState, o: Output) =>
  moveToWorkspace(s, 1, o, DEFAULT_CONFIG);
