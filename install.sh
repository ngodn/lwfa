#!/usr/bin/env bash
# lwfa installer.
#
#   ./install.sh              # ask about everything, with sensible defaults
#   ./install.sh --yes        # take every default, ask nothing
#   ./install.sh --uninstall  # undo it
#
# # What this does, and what it deliberately does not
#
# It writes three things: a config under ~/.config/lwfa, a systemd *user*
# service, and one file under /etc for the udev rule. Everything else it only
# looks at and reports.
#
# It does not install packages behind your back. When something is missing it
# says so, prints the exact command for the distribution it detected, and asks
# before running it. An installer that silently changes the system is one
# nobody can debug afterwards.
#
# It does not touch a reverse proxy, a firewall, or anything network-wide. It
# offers to set up TLS and tells you what each option costs; the doing is one
# command you can read first.
set -uo pipefail

# ---------------------------------------------------------------------------
# Where things go
# ---------------------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_HOME/lwfa"
CONFIG_FILE="$CONFIG_DIR/config.toml"
ENV_FILE="$CONFIG_DIR/env"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/lwfa"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_FILE="$UNIT_DIR/lwfa.service"
UDEV_RULE="/etc/udev/rules.d/60-lwfa-uinput.rules"
MODULE_CONF="/etc/modules-load.d/lwfa-uinput.conf"

DEFAULT_PORT=6733
DEFAULT_WORKSPACE=10

ASSUME_YES=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

say()   { printf '%s\n' "$*"; }
head2() { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s+%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
bad()   { printf '  %sx%s %s\n' "$RED" "$RESET" "$*"; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }

# Read one answer.
#
# From the terminal when there is one, so the script still works when its own
# stdin is a pipe (`curl ... | bash`). From stdin when there is not, so answers
# can be piped in for a scripted install or a test. Falling back rather than
# insisting on /dev/tty is the difference between testable and not.
read_answer() {
  local prompt="$1" reply=""
  if [ -r /dev/tty ] && [ -t 1 ]; then
    read -r -p "$prompt" reply </dev/tty || reply=""
  else
    printf '%s' "$prompt" >&2
    read -r reply || reply=""
  fi
  printf '%s' "$reply"
}

# Ask a yes/no question. Under --yes, take the default without asking.
confirm() {
  local prompt="$1" default="${2:-y}" reply
  if [ "$ASSUME_YES" = 1 ]; then
    [ "$default" = y ]
    return
  fi
  local hint="[Y/n]"; [ "$default" = y ] || hint="[y/N]"
  reply="$(read_answer "  $prompt $hint ")"
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# Ask for a value, offering a default.
ask() {
  local prompt="$1" default="$2" reply
  if [ "$ASSUME_YES" = 1 ]; then
    printf '%s' "$default"
    return
  fi
  reply="$(read_answer "  $prompt [$default] ")"
  printf '%s' "${reply:-$default}"
}

have() { command -v "$1" >/dev/null 2>&1; }

# 128 bits of hex from the kernel. Same shape as the engine's own generator.
generate_password() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# The address a tablet on the same network should type.
#
# Deliberately NOT `ip route get 1.1.1.1`. That follows the default route, and
# on a machine with a VPN the default route is the VPN: it answered with an
# ExpressVPN tunnel address, which no device on the house network can reach.
#
# So: real interfaces only, and RFC1918 only. Virtual interfaces are skipped by
# name, and 100.64.0.0/10 is skipped outright because that is CGNAT space where
# both Tailscale and several VPNs live. Bridges from Docker and libvirt are
# private but belong to the host alone, so they are skipped too.
#
# The engine does the same job more thoroughly at startup and prints a link
# with the token already in it; this is only for the line above that.
lan_address() {
  ip -4 -o addr show scope global 2>/dev/null | while read -r _ iface _ cidr _; do
    case "$iface" in
      tun*|tap*|wg*|ppp*|docker*|br-*|veth*|virbr*|vmnet*|zt*) continue ;;
    esac
    addr="${cidr%%/*}"
    case "$addr" in
      100.6[4-9].*|100.[7-9][0-9].*|100.1[0-2][0-7].*) continue ;;
      192.168.*|10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) printf '%s\n' "$addr"; return ;;
    esac
  done | head -1
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  head2 "Removing lwfa"
  if systemctl --user list-unit-files lwfa.service >/dev/null 2>&1; then
    systemctl --user disable --now lwfa.service >/dev/null 2>&1
    ok "stopped and disabled the service"
  fi
  [ -f "$UNIT_FILE" ] && rm -f "$UNIT_FILE" && ok "removed $UNIT_FILE"
  systemctl --user daemon-reload 2>/dev/null

  if [ -f "$UDEV_RULE" ] || [ -f "$MODULE_CONF" ]; then
    if confirm "Remove the /dev/uinput rule as well?" y; then
      pkexec sh -c "rm -f '$UDEV_RULE' '$MODULE_CONF'" && ok "removed the udev rule"
    fi
  fi

  # Asked, never assumed. This holds the accounts, and deleting it is the one
  # step here that loses something you cannot regenerate.
  if [ -e "$STATE_DIR/accounts.db" ]; then
    warn "$STATE_DIR/accounts.db holds your accounts"
    if confirm "Delete it?" n; then
      rm -rf "$STATE_DIR" && ok "removed $STATE_DIR"
    else
      note "kept, so reinstalling keeps your accounts"
    fi
  fi
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/lwfa"
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR" && ok "removed $INSTALL_DIR"
  fi

  if [ -d "$CONFIG_DIR" ]; then
    if confirm "Delete the config and password at $CONFIG_DIR?" n; then
      rm -rf "$CONFIG_DIR" && ok "removed $CONFIG_DIR"
    else
      note "kept"
    fi
  fi
  say ""
  say "Done. The lwfa binary itself was not installed by this script, so it is"
  say "still wherever you built or unpacked it."
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
say "${BOLD}lwfa${RESET} installer"
say "${DIM}Nothing is written until you have seen the summary and agreed.${RESET}"

head2 "This machine"

# --- distribution, for naming packages accurately --------------------------
DISTRO="unknown"; INSTALL_CMD=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="${ID:-unknown}"
fi
case "$DISTRO" in
  arch|cachyos|endeavouros|manjaro) INSTALL_CMD="pacman -S --needed" ;;
  debian|ubuntu|pop|linuxmint)      INSTALL_CMD="apt install -y" ;;
  fedora|rhel|centos)               INSTALL_CMD="dnf install -y" ;;
  opensuse*|sles)                   INSTALL_CMD="zypper install -y" ;;
esac
if [ -n "$INSTALL_CMD" ]; then
  ok "distribution: $DISTRO"
else
  warn "distribution: $DISTRO (unrecognised, so package names are only a guess)"
fi

# --- the engine binary ------------------------------------------------------
ENGINE=""
for candidate in "$ROOT/lwfa-engine" "$ROOT/target/release/lwfa-engine" "$ROOT/bin/lwfa-engine"; do
  [ -x "$candidate" ] && ENGINE="$candidate" && break
done
if [ -n "$ENGINE" ]; then
  ok "engine: $ENGINE"
else
  bad "no lwfa-engine binary found"
  note "build it with: cargo build -p lwfa-engine --release"
  exit 1
fi

# --- is this a release payload, and is it about to disappear? ---------------
#
# A .run unpacks to a temporary directory and deletes it on the way out. The
# systemd unit records an absolute path to the engine, so installing from
# where the payload happens to be sitting produces a service pointing at
# nothing the moment the installer exits.
#
# So a payload is copied somewhere permanent first. A checkout is not: there
# the binary already has a home, and copying it would leave a stale duplicate
# behind every time it was rebuilt.
#
# The tell is `libexec/`, which only the packaged layout has.
PAYLOAD=0
[ -d "$ROOT/libexec" ] && [ -d "$ROOT/lib" ] && PAYLOAD=1
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/lwfa"
if [ "$PAYLOAD" = 1 ]; then
  ok "release payload, so it will be copied to $INSTALL_DIR"
  # Where things will *end up*, decided now rather than after the copy.
  #
  # The summary, the config file and the systemd unit all record paths, and if
  # they are resolved at different moments they disagree: an earlier version
  # printed the temporary directory in the summary and wrote it into the
  # config, so the installed session pointed at a directory that no longer
  # existed. One decision, used everywhere.
  ENGINE="$INSTALL_DIR/libexec/lwfa-engine"
fi

# --- the built shell --------------------------------------------------------
SHELL_DIR=""
for candidate in "$ROOT/share/lwfa/shell" "$ROOT/packages/shell/dist" "$ROOT/shell"; do
  [ -f "$candidate/index.html" ] && SHELL_DIR="$candidate" && break
done
if [ -n "$SHELL_DIR" ]; then
  ok "shell: $SHELL_DIR"
  # Same reasoning as ENGINE above: name the destination, not the staging area.
  [ "$PAYLOAD" = 1 ] && SHELL_DIR="$INSTALL_DIR/share/lwfa/shell"
else
  bad "no built shell found"
  note "build it with: pnpm run build"
  note "without it the engine serves the protocol but no page"
fi

# --- host compositor --------------------------------------------------------
# The engine runs nested, so the host decides whether lwfa can be given a
# workspace of its own. That is where they differ, not in protocol support.
COMPOSITOR="unknown"; PLACEMENT="manual"
if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] || have hyprctl; then
  COMPOSITOR="Hyprland"; PLACEMENT="auto"
elif [ -n "${NIRI_SOCKET:-}" ] || have niri; then
  COMPOSITOR="niri"; PLACEMENT="auto"
elif [ "${XDG_CURRENT_DESKTOP:-}" = "KDE" ] || have kwin_wayland; then
  COMPOSITOR="KDE Plasma"; PLACEMENT="auto"
elif [ "${XDG_CURRENT_DESKTOP:-}" = "COSMIC" ] || have cosmic-comp; then
  COMPOSITOR="COSMIC"; PLACEMENT="partial"
elif [ "${XDG_CURRENT_DESKTOP:-}" = "GNOME" ] || have gnome-shell; then
  COMPOSITOR="GNOME"; PLACEMENT="none"
elif [ -n "${SWAYSOCK:-}" ] || have sway; then
  COMPOSITOR="sway"; PLACEMENT="auto"
fi

case "$PLACEMENT" in
  auto)    ok "compositor: $COMPOSITOR" ;;
  partial) warn "compositor: $COMPOSITOR (window rules exist but workspace assignment is limited)" ;;
  none)
    warn "compositor: $COMPOSITOR"
    note "GNOME has no native window rules, so lwfa cannot be given a workspace"
    note "of its own without the Auto Move Windows extension. It runs fine; its"
    note "window just sits in your normal workspace flow."
    ;;
  *)
    warn "compositor: could not tell"
    note "lwfa runs nested in whatever you use. If it is not one of Hyprland,"
    note "niri, KDE, COSMIC or sway, placement is yours to configure."
    ;;
esac

if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  ok "session: wayland"
else
  warn "session: ${XDG_SESSION_TYPE:-unknown} (lwfa needs a Wayland host compositor)"
fi

# --- GPU --------------------------------------------------------------------
# Hardware encode is NVENC only today. Everything else still works; the video
# path falls back to JPEG, which costs bandwidth rather than function.
GPU_OK=0
if have nvidia-smi && nvidia-smi >/dev/null 2>&1; then
  GPU_OK=1
  ok "gpu: NVIDIA ($(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1))"
else
  GPU_NAME="$(lspci 2>/dev/null | grep -iE 'vga|3d controller' | head -1 | cut -d: -f3- | sed 's/^ *//')"
  warn "gpu: ${GPU_NAME:-not detected}"
  note "hardware video is NVIDIA/NVENC only for now. Intel and AMD are coming;"
  note "until then those machines fall back to JPEG, which works but uses more"
  note "bandwidth and looks softer."
fi

# --- the rest ---------------------------------------------------------------
MISSING_PKGS=()
if have Xwayland; then
  ok "xwayland: present (Steam and anything under Proton need it)"
else
  bad "xwayland: missing"
  note "X11 clients do not degrade without it, they fail to start"
  MISSING_PKGS+=("xorg-xwayland")
fi

if have parec; then
  ok "audio capture: parec present"
else
  warn "audio capture: parec missing, so there will be no audio"
  MISSING_PKGS+=("libpulse")
fi

TERMINAL=""
for candidate in alacritty foot kitty ghostty wezterm gnome-terminal konsole xfce4-terminal xterm; do
  have "$candidate" && TERMINAL="$candidate" && break
done
if [ -n "$TERMINAL" ]; then
  ok "terminal: $TERMINAL"
else
  warn "terminal: none found"
  note "a session with no terminal opens empty and Alt+Return does nothing"
  MISSING_PKGS+=("foot")
fi

# --- /dev/uinput ------------------------------------------------------------
# The on-screen controller is a real device the whole machine can see, which is
# what makes Steam find it. That needs write access to /dev/uinput.
UINPUT_OK=0
if [ -w /dev/uinput ]; then
  UINPUT_OK=1
  ok "/dev/uinput: writable, so the virtual controller will work"
elif [ -e /dev/uinput ]; then
  warn "/dev/uinput: present but not writable by you"
else
  warn "/dev/uinput: not present (the module is probably not loaded)"
fi

# Existing gamepads matter: player order is decided by whatever consumes the
# devices, not by lwfa, so an idle pad can hold player one while lwfa's virtual
# one lands second and the game listens to the wrong device.
EXISTING_PADS=0
for js in /dev/input/js*; do [ -e "$js" ] && EXISTING_PADS=$((EXISTING_PADS + 1)); done
if [ "$EXISTING_PADS" -gt 0 ]; then
  warn "$EXISTING_PADS controller device(s) already present"
  note "lwfa creates its own controller but does not arbitrate order. A real"
  note "pad, or an idle wireless dongle, can hold player one and leave lwfa's"
  note "at player two, which looks like the on-screen pad not working."
fi

# --- existing install -------------------------------------------------------
if [ -f "$CONFIG_FILE" ]; then
  warn "an existing config is at $CONFIG_FILE and will be replaced"
fi
if [ -e "$STATE_DIR/accounts.db" ]; then
  ACCOUNTS="$(sqlite3 "$STATE_DIR/accounts.db" 'select count(*) from users;' 2>/dev/null || echo '?')"
  ok "existing accounts database kept ($ACCOUNTS account(s))"
fi

# ---------------------------------------------------------------------------
# Missing packages
# ---------------------------------------------------------------------------
if [ ${#MISSING_PKGS[@]} -gt 0 ] && [ -n "$INSTALL_CMD" ]; then
  head2 "Missing packages"
  say "  ${MISSING_PKGS[*]}"
  note "command: pkexec $INSTALL_CMD ${MISSING_PKGS[*]}"
  if confirm "Install them now?" y; then
    # shellcheck disable=SC2086
    if pkexec $INSTALL_CMD "${MISSING_PKGS[@]}"; then
      ok "installed"
    else
      warn "install failed or was cancelled; continuing without them"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------
head2 "Settings"

PORT="$(ask 'Port for the page and the socket' "$DEFAULT_PORT")"

say ""
say "  ${DIM}Loopback keeps lwfa on this machine. Opening it to the network is${RESET}"
say "  ${DIM}what lets a tablet connect, and the socket can spawn processes, so${RESET}"
say "  ${DIM}it is gated by a password either way.${RESET}"
if confirm "Reachable from other devices on your network?" y; then
  BIND="0.0.0.0:$PORT"
else
  BIND="127.0.0.1:$PORT"
fi

WORKSPACE="$DEFAULT_WORKSPACE"
if [ "$PLACEMENT" != "none" ]; then
  say ""
  say "  ${DIM}lwfa's window is a whole desktop, not an app: it runs full-screen${RESET}"
  say "  ${DIM}and takes the keyboard, so it wants a workspace of its own.${RESET}"
  WORKSPACE="$(ask 'Which workspace should lwfa take?' "$DEFAULT_WORKSPACE")"
fi

# --- password ---------------------------------------------------------------
say ""
say "  ${DIM}The password gates a socket that can spawn processes on this${RESET}"
say "  ${DIM}machine, so a generated one is offered rather than a default: a${RESET}"
say "  ${DIM}shared default would be the same on every install, and public.${RESET}"
AUTH_PASS=""
if [ -f "$ENV_FILE" ] && grep -q '^AUTH_PASS=' "$ENV_FILE" 2>/dev/null; then
  if confirm "Keep the existing password?" y; then
    AUTH_PASS="$(grep '^AUTH_PASS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  fi
fi
if [ -z "$AUTH_PASS" ]; then
  if confirm "Generate a random password?" y; then
    AUTH_PASS="$(generate_password)"
  else
    # Bounded, not `while [ -z ... ]`. An unbounded loop here spins forever the
    # moment stdin runs out, which is what happens under `--yes`, in a script,
    # or when answers are piped in. Falling back to a generated password beats
    # both hanging and installing without one.
    for _ in 1 2 3; do
      AUTH_PASS="$(ask 'Password' '')"
      [ -n "$AUTH_PASS" ] && break
    done
    if [ -z "$AUTH_PASS" ]; then
      AUTH_PASS="$(generate_password)"
      warn "no password given, so one was generated"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary, then write
# ---------------------------------------------------------------------------
head2 "About to write"
say "  config    $CONFIG_FILE"
say "  password  $ENV_FILE ${DIM}(mode 600)${RESET}"
say "  service   $UNIT_FILE ${DIM}(a user service, not a system one)${RESET}"
[ "$UINPUT_OK" = 0 ] && say "  udev rule $UDEV_RULE ${DIM}(needs pkexec)${RESET}"
say ""
[ "$PAYLOAD" = 1 ] && say "  files     $INSTALL_DIR"
say ""
say "  listening on   $BIND"
say "  shell from     ${SHELL_DIR:-<none built>}"
say "  terminal       ${TERMINAL:-<none>}"
[ "$PLACEMENT" != "none" ] && say "  host workspace $WORKSPACE"

if ! confirm "Write these?" y; then
  say "Nothing was written."
  exit 0
fi

mkdir -p "$CONFIG_DIR" "$UNIT_DIR" "$STATE_DIR"

# Give the payload a permanent home before anything records where it is.
if [ "$PAYLOAD" = 1 ]; then
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  # -a to keep the symlinks and the executable bits; the RPATH is relative to
  # the binary, so the tree has to move as a whole to keep resolving.
  cp -a "$ROOT/libexec" "$ROOT/lib" "$ROOT/share" "$INSTALL_DIR/" 2>/dev/null
  [ -d "$ROOT/bin" ] && cp -a "$ROOT/bin" "$INSTALL_DIR/"
  [ -d "$ROOT/deploy" ] && cp -a "$ROOT/deploy" "$INSTALL_DIR/"
  # The uninstaller has to outlive the temporary directory it ran from.
  cp -a "$ROOT/install.sh" "$INSTALL_DIR/install.sh"
  ok "installed to $INSTALL_DIR"
  # Check the copy resolves its libraries, without running it.
  #
  # Never execute the engine to test it. It is a compositor, not a tool: it has
  # no --help and no --version, so anything that looks like a probe just starts
  # a session and blocks the installer until it exits. `ldd` answers the only
  # question worth asking here, which is whether the move broke the RPATH.
  if ldd "$ENGINE" 2>&1 | grep -q "not found"; then
    warn "the installed engine has unresolved libraries:"
    ldd "$ENGINE" 2>&1 | grep "not found" | sed 's/^/    /'
    note "libdrm is usually the missing one; install your distribution's libdrm"
  fi
fi

# Only what is specific to this machine. Everything omitted falls through to
# the engine's built-in defaults, so this file keeps working across upgrades
# instead of freezing today's defaults forever. See config.rs.
{
  echo "# lwfa, written by install.sh on $(date -Iseconds)."
  echo "#"
  echo "# Deliberately minimal: only what is specific to this machine. Anything"
  echo "# not mentioned uses the engine's built-in default, so this file does not"
  echo "# go stale when those improve. Every setting is documented in the"
  echo "# configs/defaults.toml that ships with the source."
  echo ""
  echo "[net]"
  echo "shell_addr = \"$BIND\""
  [ -n "$SHELL_DIR" ] && echo "shell_dir = \"$SHELL_DIR\""
  echo ""
  echo "[host]"
  echo "workspace = $WORKSPACE"
  if [ -n "$TERMINAL" ]; then
    echo ""
    echo "[session]"
    echo "terminal = \"$TERMINAL\""
  fi
} > "$CONFIG_FILE"
ok "wrote $CONFIG_FILE"

# 600 before the secret goes in, not after, so it is never briefly readable.
touch "$ENV_FILE" && chmod 600 "$ENV_FILE"
printf '# lwfa secrets. Never commit or copy this file.\nAUTH_PASS=%s\n' "$AUTH_PASS" > "$ENV_FILE"
ok "wrote $ENV_FILE"

# A *user* service. A system one has no XDG_RUNTIME_DIR, starts before any
# session exists, cannot express "after this user's compositor came up"
# because the system manager has no graphical-session.target, and would have to
# hardcode a uid and a Wayland socket name that both change.
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=lwfa compositor
Documentation=https://github.com/ngodn/lwfa
# Dies with the session rather than respawning against a display that is gone.
PartOf=graphical-session.target
After=graphical-session.target
# Without a Wayland host there is nothing to nest in, so do not even try.
ConditionEnvironment=WAYLAND_DISPLAY

[Service]
Type=simple
ExecStart=$ENGINE
Restart=on-failure
RestartSec=2

[Install]
# Not default.target: that would start it outside a graphical session.
WantedBy=graphical-session.target
UNIT
ok "wrote $UNIT_FILE"
systemctl --user daemon-reload 2>/dev/null

# --- uinput -----------------------------------------------------------------
if [ "$UINPUT_OK" = 0 ]; then
  say ""
  if confirm "Set up /dev/uinput for the virtual controller?" y; then
    if pkexec sh -c "
      printf 'KERNEL==\"uinput\", SUBSYSTEM==\"misc\", MODE=\"0660\", GROUP=\"input\", OPTIONS+=\"static_node=uinput\"\n' > '$UDEV_RULE'
      printf 'uinput\n' > '$MODULE_CONF'
      modprobe uinput 2>/dev/null
      udevadm control --reload-rules 2>/dev/null
      udevadm trigger --name-match=uinput 2>/dev/null
      usermod -aG input '$USER'
    "; then
      ok "installed the udev rule and added you to the 'input' group"
      warn "log out and back in for the group to take effect"
      note "until then the controller falls back to keyboard mode"
    else
      warn "could not set up /dev/uinput; the controller will use keyboard mode"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# TLS
# ---------------------------------------------------------------------------
head2 "TLS"
say "  ${DIM}Only needed beyond this machine: localhost is already a secure${RESET}"
say "  ${DIM}context. Without it, other devices lose hardware video decoding${RESET}"
say "  ${DIM}and the low-latency audio path, which looks like lwfa being worse${RESET}"
say "  ${DIM}than advertised rather than like a missing certificate.${RESET}"
say ""

if have tailscale && tailscale status >/dev/null 2>&1; then
  TS_NAME="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName" *: *"\([^"]*\)\.".*/\1/p' | head -1)"
  ok "Tailscale is running${TS_NAME:+ as $TS_NAME}"
  note "This is the best option: a real Let's Encrypt certificate, and nothing"
  note "to install on the tablet."
  if confirm "Serve lwfa over Tailscale?" y; then
    if tailscale serve --bg "$PORT" 2>&1 | tail -2; then
      ok "serving"
    else
      warn "could not configure it; run 'tailscale serve $PORT' by hand"
    fi
  fi
elif have docker; then
  note "No Tailscale. A container can terminate TLS without installing nginx:"
  note "  cd deploy/docker && ./make-cert.sh <your-lan-ip> && docker compose up -d"
  note "The certificate is self-signed, so each device has to trust it once."
else
  note "Set up a reverse proxy with TLS in front of port $PORT."
  note "Templates for nginx and Traefik are in deploy/."
fi

# ---------------------------------------------------------------------------
# Autostart
# ---------------------------------------------------------------------------
head2 "Autostart"
if confirm "Start lwfa automatically when you log in?" y; then
  systemctl --user enable lwfa.service >/dev/null 2>&1 && ok "enabled"
  note "it starts with your graphical session and stops with it"
else
  note "start it by hand with: systemctl --user start lwfa"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
head2 "Done"
say "  password   ${BOLD}$AUTH_PASS${RESET}"
say "             ${DIM}also in $ENV_FILE${RESET}"
say ""
say "  start      systemctl --user start lwfa"
say "  logs       journalctl --user -u lwfa -f"
if [ "$PAYLOAD" = 1 ]; then
  say "  remove     $INSTALL_DIR/install.sh --uninstall"
else
  say "  remove     $ROOT/install.sh --uninstall"
fi
say ""
if [ "$BIND" = "127.0.0.1:$PORT" ]; then
  say "  open       http://localhost:$PORT/"
else
  say "  open       http://$(lan_address):$PORT/"
fi
say ""
say "  ${DIM}The engine prints a one-tap link with the password in it at startup.${RESET}"

# Only suggest a window rule that is not already there.
#
# Printing it unconditionally tells people who set it up months ago to go and
# do something they have already done, which trains them to skip the last
# section of the installer.
# Fixed strings, not a regex. The rule contains ^ ( ) and $, every one of
# which means something to grep and to the shell, and an earlier version
# quietly matched nothing because the trailing $ became end-of-line.
rule_present() {
  grep -rqsF -e 'class ^(lwfa)$' -e 'app-id="lwfa"' "$@" 2>/dev/null
}

if [ "$PLACEMENT" = "auto" ] && [ "$COMPOSITOR" = "Hyprland" ]; then
  if rule_present "$HOME/.config/hypr/"; then
    say ""
    ok "Hyprland already has a window rule for lwfa; nothing to add"
  else
    say ""
    say "  Add to ~/.config/hypr/hyprland.conf so lwfa lands on its own workspace:"
    say "    ${DIM}windowrule = workspace $WORKSPACE silent, match:class ^(lwfa)\$${RESET}"
    say "    ${DIM}windowrule = fullscreen true, match:class ^(lwfa)\$${RESET}"
  fi
elif [ "$COMPOSITOR" = "niri" ]; then
  if rule_present "$HOME/.config/niri/"; then
    say ""
    ok "niri already has a window rule for lwfa; nothing to add"
  else
    say ""
    say "  Add to ~/.config/niri/config.kdl:"
    say "    ${DIM}window-rule { match app-id=\"lwfa\"; open-on-workspace \"$WORKSPACE\"; open-fullscreen true }${RESET}"
  fi
fi
