# The lwfa shell

The browser side of lwfa: the navigation rail, the on-screen keyboard and
gamepad, audio, the clipboard, the launcher, and what happens when a tablet
loses its network.

The browser side is React 19 with [shadcn/ui](https://ui.shadcn.com/) on
Tailwind v4. Fonts are self-hosted: the machine is often not on the internet,
and a shell that waits on a font CDN before painting is a shell that never
paints.

## The navigation rail

One strip of buttons along an edge you choose, in **two clusters**. The ones
you reach for while working (windows, keyboard, gamepad) are anchored to the
far end where a thumb rests; the ones you touch once a week sit at the near
end, out of accidental reach, with the slack between them. That is a
reachability decision, not decoration, and it survives every edge and every
size.

The rail **measures itself** rather than trusting breakpoints, because "do
nine buttons fit" is a different question along the bottom of a phone than
down its side. When they stop fitting they merge rather than disappear:
keyboard and gamepad into **Input**, the management panels into **More**.
Nothing becomes unreachable, only differently routed.

Edge, order, visibility, which end each button is anchored to, and button size
are all in Settings, stored per device. They are per device on purpose: a
phone wants the bar where a thumb is, the same person on a 27" display wants
it down the side, and syncing them would make one device's ergonomics fight
the other's.

## Input

The keyboard and gamepad are **input devices, not settings screens**, so they
dock across the bottom rather than opening in a side panel. The keyboard takes
space from the desktop, because typing while the keyboard covers the line you
are editing is the failure it exists to prevent. The gamepad floats over the
game at reduced opacity: a game wants every pixel, and its interesting parts
are not under your thumbs.

- **Keyboard**: Escape and the function row are always on screen; the
  full-size tail (Insert, Home, Page Up…) is behind a toggle. Modifiers latch
  for one keypress in normal mode and stay held in **combo** mode, so one
  finger can build Ctrl+Alt+F2. Keys are sent as evdev keycodes, so the remote
  machine's own keymap decides what they mean.
- **Gamepad**: the [W3C standard mapping](https://w3c.github.io/gamepad/#remapping),
  and in controller mode it is not an on-screen abstraction: presses land on a
  virtual controller the engine creates through `/dev/uinput`, which Steam and
  games enumerate exactly like a plugged-in pad. Analog sticks carry real axis
  values with a 5% dead zone, coalesced to one send per animation frame so a
  moving thumb never floods the socket the video shares. Keyboard mode remains
  for emulators and older titles, quantising sticks to eight directions. Edit
  mode rearranges and resizes pads on a dot grid, "Copy layout" puts the
  arrangement on the clipboard as JSON, and skins (PlayStation, Xbox, neutral)
  change labels only.

## Audio

Off until a device asks: audio is a per-device switch in the shell, and the
engine captures nothing until someone flips it. What gets captured is the
default sink's monitor (whatever you would hear at the machine), or a source
you name in `[audio]`; the config shows the null-sink recipe for routing only
chosen programs. On the wire it is Opus, with its own send accounting so fifty
audio chunks a second can never crowd video out. Quality is Auto by default,
following the same budget as the video with sound degrading last, or pinned to
High, Medium or Low per device.

## Clipboard

One clipboard, not a transfer tool with two sides. Copy in a window in the
session, in an X11 program like Steam, on the machine's own desktop outside
lwfa, or on the tablet, and the other three have it. The panel shows the
history newest first, with a note on each row saying where that copy
happened, and putting an old row back puts it on all of them.

Text, images and **files of any type**. A file copied in a file manager can
be downloaded on the tablet; a file sent from the tablet lands in
`~/Uploads` and goes on the machine's clipboard as itself *and* as its path,
so it pastes into an image editor and drops into a file manager. Sends ride
the upload channel, so a large one never stalls the picture, and a send
interrupted by a network blip is re-queued rather than lost.

Sending **from** a browser needs a tap, and always will: `clipboard-read` is
a permission Safari does not implement and has said it will not. So the
panel has a button, which triggers the browser's own paste confirmation, and
a box beside it that catches what that route cannot reach. Nothing is

## Next

- [Streaming](streaming.md), and how the picture gets there
- [Playing games](gaming.md), including the virtual controller
- [Accounts and permissions](accounts.md)
