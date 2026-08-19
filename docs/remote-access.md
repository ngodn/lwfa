# Reaching lwfa from another device

lwfa serves the shell and the protocol on **one port**, 6733. A WebSocket
upgrade is the protocol, everything else is a file from the built shell, so
there is one port to open, one to type, and nothing for the page to find.

## Setting it up

An install done with `install.sh` has already asked this and written the
answers, so there is nothing to do. From a checkout, settings live in `.env`,
which is gitignored:

```sh
cp .env.example .env
sed -i "s|^AUTH_PASS=.*|AUTH_PASS=$(openssl rand -hex 16)|" .env
sed -i "s|^LWFA_SHELL_ADDR=.*|LWFA_SHELL_ADDR=0.0.0.0:6733|" .env
chmod 600 .env
```

The engine reads the password from `.env` in the working directory first, then
`~/.config/lwfa/env`, so a checkout you are standing in wins over an install and
neither has to know about the other.

Build the shell once, then run the engine and open the link it prints:

```sh
pnpm run build
cargo run -p lwfa-engine
```

```
open the shell at:  http://192.168.1.x:6733/?token=…
```

The address is picked by filtering out virtual interfaces (Docker bridges,
VMware, VPN tunnels, Tailscale, loopback) and preferring a private range. If the
machine has several real interfaces the alternatives are printed too, since only
one of them is the network the tablet is on.

The shell connects to whatever host served the page, so nothing else needs
configuring. Bookmark that URL on the tablet; it keeps working as long as
`AUTH_PASS` stays the same.

Changing `AUTH_PASS` takes effect within a couple of seconds, with no restart,
which matters because restarting the compositor kills every window in the
session. Existing connections are left alone; only the next one is affected.

## Security, plainly

The shell protocol injects keystrokes and spawns processes, so whoever can open
the socket controls the session. A shared token is required on every connection,
which stops casual access.

The engine itself speaks **no TLS**. Over plain HTTP the token and everything
after it cross the network readable, and the browser refuses WebCodecs on an
insecure page, so you get the JPEG fallback too. On a home network you control
that can be an acceptable trade for a quick test. For anything more, put a
TLS-terminating reverse proxy in front, or tunnel over SSH or WireGuard. Never
expose the raw ports to the internet.

## TLS

Not optional beyond the machine itself. `VideoDecoder` and `AudioWorklet` are
secure-context APIs, so a plain-HTTP page silently loses hardware decode and the
low-latency audio path. That shows up as "it works, but the picture is worse
than it should be", which is a confusing way to find out you needed a
certificate.

HTTPS is not only transport security here. WebCodecs requires a secure context,
so the proxy is also what turns the stream from JPEG into hardware H.264 or
HEVC.

Locally you need nothing: `localhost` is already a secure context. For
everything else, three options, cheapest first.

### Tailscale, if you have it

One command, and the only option with nothing to install on the tablet:

```sh
tailscale serve 6733
```

Tailscale gets a real Let's Encrypt certificate for the machine's `*.ts.net`
name through a DNS-01 challenge it completes itself. Every device already trusts
that chain, so there is no CA to distribute, no profile to install and no trust
setting to find. It works away from home as a side effect.

### A container, if you would rather not install a proxy

Everything lives in [`deploy/docker/`](../deploy/docker/) and `docker compose
down` removes all of it:

```sh
cd deploy/docker
./make-cert.sh 192.168.1.51      # your machine's LAN address
docker compose up -d
```

Host networking, because nginx has to reach the engine on the host's own
loopback and because bridged networking puts NAT in front of every video frame.

The certificate is self-signed, so each device has to be told to trust it once,
and the container serves the public half over plain HTTP on 8880 for exactly
that: a device cannot fetch a certificate over the HTTPS that certificate is
for. On iOS that is two steps, and the second is the one people miss. Install
the profile, **then** enable it under Settings > General > About > Certificate
Trust Settings.

### Your own proxy

[`deploy/`](../deploy/) has a template for
[Traefik](../deploy/traefik-lwfa.yml) and one for
[nginx](../deploy/nginx-lwfa.conf). One hostname, one backend: the engine splits
page from socket by request, so there is nothing for the proxy to route.

Both carry placeholder values, `lwfa.example.com` and a TEST-NET-1 address, so
an unedited copy fails visibly instead of routing somewhere real. Fill one in
and keep it in `deploy/local/`, which is gitignored.

None of the three enables HTTP/2, deliberately. Safari on iPadOS 26.x sends
CONNECT instead of GET for a WebSocket upgrade over h2, so the socket fails on
the device this project is for.

## Installing it on an iPad

Open the HTTPS address and add it to the home screen. The shell ships the
manifest and icons from [brand/](../brand/), draws edge to edge under the iPad's
home indicator, and behaves as an installed app.

iOS never says goodbye when an app is swiped away, so the engine pings idle
sockets and reaps the ones that stop answering. A discarded client cannot hold
windows or the microphone.

## Giving lwfa a workspace of its own

lwfa's window is a whole desktop, not an app: it runs full-screen and takes the
keyboard, so it should not share a workspace with anything you were using. The
engine reports app id `lwfa`, so a host compositor can rule on it. On Hyprland
(0.53+ syntax):

```
# ~/.config/hypr/monitors.conf: a workspace of its own, kept alive when empty
workspace = 10, monitor:DP-1, persistent:true

# ~/.config/hypr/hyprland.conf
windowrule = workspace 10 silent, match:class ^(lwfa)$
windowrule = fullscreen true, match:class ^(lwfa)$
```

`silent` places the window there *without* switching your view to it, so
starting the engine never interrupts what you are doing. Keep the workspace
number in step with `[host].workspace` in
[`configs/defaults.toml`](../configs/defaults.toml), which is what
`scripts/dev-nested.sh` reads.

A window on a workspace you are not looking at gets no frame callbacks from the
host. The streaming path is driven from a timer so remote clients keep working
regardless, and for a session that is only ever used remotely, set `[window]
preview = false` (or `LWFA_NO_PREVIEW=1`) so the engine never touches the host's
swapchain at all.

`scripts/dev-nested.sh` does the same placement on a host without those rules
installed, and verifies it afterwards.

## Next

- [Configuration](configuration.md)
- [Accounts and permissions](accounts.md), for handing somebody a watch-only link
- [Streaming](streaming.md), and what the network actually carries
