# Serious Sam: The First Encounter in the browser

The engine compiled to WebAssembly with Emscripten, rendering with WebGL 2.
It runs the official Karnak demo out of the box, and the full game when the
player picks their own installation folder, zipped (the files never leave their device).

## Building

Requirements: [emsdk](https://emscripten.org/docs/getting_started/downloads.html)
(activated with `source <emsdk>/emsdk_env.sh`), CMake, Ninja, flex, bison
(on macOS, Homebrew's: `brew install bison flex`), a host C++ compiler, Node.js and
7-Zip (`brew install sevenzip` / `apt install 7zip`).

```sh
web/build.sh                       # Release build of both variants into web/build/dist
web/build.sh RelWithDebInfo jspi   # one variant, with DWARF debug info
```

The first build downloads the demo (`SeriousSamDemo.exe`) and the 1.05 patch
from archive.org, extracts them (`fetch_demo_data.sh`) and prepares the data
(`package_demo.sh`): the demo's files in `demo/` and a torrent of them
(`tools/make_torrent.mjs`), and a package of this repository's game files for
players who bring their own.

`web/build/dist` is a static site: serve it with any web server, e.g.

```sh
node web/test/server.mjs 8080      # add 0.0.0.0 to serve other devices on the network
                                   # (npm install in web/test first: it also lets network
                                   # games find each other without the internet)
```

and open <http://localhost:8080/>. The `.wasm` (about 4 MB) and `.data` files
compress well; let the server use brotli or gzip. The server must answer HTTP range
requests (the demo's files are the torrent's web seed).

## Hosting on GitHub Pages

`.github/workflows/web-pages.yml` builds the site and publishes it on every push to
`main` or `web-port` (or when started by hand from the Actions tab):

1. push the branch to your fork on GitHub;
2. in the fork's Settings → Pages, set Source to "GitHub Actions";
3. the game is at `https://<user>.github.io/<repository>/`.

All files are well below Pages' 100 MB limit (the largest is the demo's 54 MB
`1_00c_demo.gro`), and everything is loaded with relative URLs.

## How it works

- **Two builds.** The engine yields to the browser in the middle of its own loops
  (every frame, and while loading levels). `jspi/` uses JavaScript Promise
  Integration; `asyncify/` is for browsers without it (bigger and a bit slower).
  The page picks one by feature detection.
- **One binary.** The game, entity and shader libraries that are normally loaded
  with `dlopen()` are linked in. The engine still looks their symbols up by name,
  in a table generated at build time (`SamTFE/Sources/cmake/gen_static_symbols.cmake`,
  `Engine/Base/Emscripten/StaticDynamicLoader.cpp`).
- **Rendering.** The engine's OpenGL 1.x code runs unchanged: every `pgl*` function
  it calls is emulated on WebGL 2 by `Engine/Graphics/Emscripten/GL1Emulation.cpp`
  (fixed function state turned into generated shaders, client side vertex arrays
  streamed into buffers, occlusion queries instead of depth buffer reads for lens flares).
- **Files.** Game data is in `/data` (the demo's files, or the base package plus the
  player's files), settings and saved games in `/user`, which is stored in IndexedDB.
  Players give their installation as a .zip of its folder (picking folders doesn't work
  on phones); `shell/zip.js` reads only the zip's directory up front and unpacks the files
  the game needs one by one with the browser's `DecompressionStream`. Dropping the folder
  itself on the page works too. Each `.gro` file is checked on the way in (they are zip
  archives too), so a damaged or cut short one is named before the game starts.
  The player's files are also kept in IndexedDB (`sam-own-files`), and counted as kept
  only once the game has started with them; on later visits *Play my game files* uses them.
- **When the game can't start**, the page says what happened (with the engine's message
  under "What the game said") and what to try, with *Start over*, *Clear assets* and
  *Clear my data* (both also on the start page). Each deletes, after asking, only its part
  of what this page keeps. *Clear assets…*: the demo's pieces, the cached base game package
  and the player's kept game files. *Clear my data…*: settings and saved games (`/user`)
  and the start page's options. Other sites on the same address (e.g. a `github.io`
  account's other projects) are left alone.
  Settings are saved whenever the page is hidden, since a tab can be closed at any time.
- **Demo download.** `shell/demo-download.js` gets the demo with
  [WebTorrent](https://webtorrent.io) from its web seeds: [mirrors](#demo-mirrors) first,
  and the site itself, whose `demo/` files are a web seed too. The site is only asked when
  the mirrors give nothing within 5 s, or less than 1 MB/s (right away when there are
  none), which keeps the site's bandwidth (GitHub Pages: 100 GB a month) for those who need
  it. The pieces are kept in IndexedDB, so later visits download nothing. If WebTorrent
  can't be used, the files are downloaded one by one (from a mirror, else the site), and
  not kept: e.g. on plain http addresses other than localhost (a computer on the local
  network), where browsers don't offer `crypto.subtle` (WebTorrent's SHA-1).
- **WebRTC** is only used with `?webrtc=true` (on https and localhost), for the demo
  and for network games. The demo then also comes from other players who have the page
  open (found through public WebSocket trackers, connected with WebRTC); the site is asked
  when none are found within 15 s, or they give less than 1 MB/s. The page shares the
  pieces (at most 1 MB/s) while the game runs, and says so on the start page.

  Only the official demo's files are shared, which to our knowledge may be freely
  redistributed; the start page explains this to players. Files from a player's own
  installation are never shared.
  `demo.torrent` lets BitTorrent clients that speak WebRTC (WebTorrent Desktop,
  `webtorrent-hybrid`) seed for the players; the build writes the mirrors and the site's
  URL (when given `SITE_URL`) into it as web seeds.
- **Size.** The game renders at the size of the canvas (`web_fMaxPixelRatio`, 2 by
  default, limits the resolution on high density displays).
- **Touch screens.** `shell/touch.js` adds on screen controls (on by default on touch
  screens, or chosen on the start page): an analog stick under the left thumb, dragging
  on the right to look, and buttons. The engine reads them every frame: the stick as an
  analog movement axis (`Web_GetTouchMove()`, a short push walks), the rest as the keys
  and mouse of the default controls (`Web_GetTouchInput()`: Space, C, mouse buttons and
  wheel). In menus, NETRICSA and demos they hide, and taps work as mouse clicks.
- **Gamepads.** `shell/gamepad.js` reads the browser's Gamepad API once per frame
  (`Web_PollGamepad()`). While playing, the engine takes the sticks and buttons as a fixed
  layout like the console version's (`Web_GetPadInput()`, `CControls::CreateAction()`): the
  sticks are analog movement and turning (by the controls' sensitivity and invert look), the
  buttons set the controls' actions (`ctl_bFire`, …) directly, so changed key bindings don't
  matter. In menus, the console and NETRICSA the pad presses keys (arrows, Enter, Escape,
  Page Up/Down) and the right stick moves the mouse.
- **Aim assist.** A shot goes to the enemy nearest to the crosshair whose bounding box
  overlaps a square 150% the size of the crosshair (`CPlayerWeapons::AimAssistTarget()`;
  bullets, rockets and the laser fully, grenades and cannon balls only to the side). The
  square is fixed (not the player's crosshair size or view), and the setting travels with
  the player's settings (`PSF_AIMASSIST`), so all computers of a network game agree. It is
  chosen per player in the Controls menu (in place of iFeel): Auto (on with touch controls
  or a gamepad, `CGame::ResolveAimAssist()`), Yes or No. `dbg_bAimAssist=1` prints where
  shots are turned.
- **View bobbing** is speed-based, derived from the Quake engine's (`V_CalcBob`,
  `V_CalcRoll`, released under the GPL): the view goes up and down with the steps as much
  as the player moves (`CPlayerAnimator::StepBob()`), and tilts when moving sideways:
  nothing below 3 m/s, then gradually more up to 2° at full running speed, 10 m/s
  (`ViewRoll()`). The original
  bobbing, which rocks the view with every step whatever the speed and doesn't go well with
  gamepads, is still there: Options → Advanced options → Additional display parameters →
  Miscellaneous → Legacy view bobbing (`plr_bLegacyViewBobbing`, off by default). The
  weapon keeps its original sideways swaying by default (Legacy weapon bobbing,
  `plr_bLegacyWeaponBobbing`, on); switched off, it is pushed forward with the steps, as in
  the Quake engine. `plr_fViewBob` (0.02), `plr_fViewBobCycle` (0.6 s), `plr_fViewBobUp`
  (0.5), `plr_fViewRollAngle` (2°), `plr_fViewRollMinSpeed` (3 m/s) and
  `plr_fViewRollMaxSpeed` (10 m/s) tune it; the defaults are the Quake engine's, gentler values are e.g. 0.01 and
  0.8. The player profile's View bobbing turns off all of it.
- **Sound.** The game mixes sound every frame and keeps only about 70 ms ready for the
  browser, so it doesn't lag behind the picture.

Platform specific code is under `#ifdef PLATFORM_EMSCRIPTEN`.

## Network games

The engine's multiplayer works as it always has: the player who starts a network game
(Network → Start) runs the server, the others join it as clients. Their browsers
connect with WebRTC, and/or through the page's server (`shell/netplay.js`,
`Engine/Base/Emscripten/WebNet.cpp`):

- The engine's UDP packets travel over a data channel set up like UDP (unordered, never
  resent); the engine's own acknowledgements and resends do the rest. All the engine's
  socket calls are in `CCommunicationInterface::UpdateMasterBuffers()`, which sends and
  receives through the page instead; the other players get made up addresses (10.83.0.x).
- Players meet in a room: starting a network game gives a code like `K7Q-2MX` and a link
  (`index.html?join=K7Q2MX`), shown on the page with *Copy link* and *Share*. Joiners
  open the link, or type the code in Network → Join → Specify server ("Room code").
- WebRTC needs a way to find the other browser first (signaling), with
  [Trystero](https://github.com/dmotz/trystero) (`netplay-signal.js`, bundled by
  `tools/build_libs.mjs`). If the page's server relays it, as `test/server.mjs` does (at
  `/signal`, announced in `/lan-signal.json`), players who open the page from it find each
  other there: on a local network, games need no internet, and no STUN or TURN either.
  Otherwise (e.g. on GitHub Pages) the page uses the public BitTorrent WebSocket trackers
  and Nostr relays at the same time; `?signal=wss://…` names other Trystero relays, and
  `?signal=public` uses the public ones in any case.
  (BitTorrent's DHT can't help here: it needs UDP, which browsers don't have.)
- If the page's server can pass games on, as `test/server.mjs` does (a WebSocket hub at
  `/hub`, announced in `/lan-signal.json`), players also connect through it. Games then
  work when browsers can't connect with WebRTC (some networks, and browsers whose WebRTC
  is restricted: sandboxed Snap/Flatpak builds, privacy settings, proxies), and without
  WebRTC at all (the page without `?webrtc=true`). When WebRTC connects too, the game moves to it (the page's
  log says which way each player is connected). `?nethub=off` leaves the hub out.
- Without `?webrtc=true`, network games only go through the page's server: not on
  GitHub Pages, which can't pass them on. Room links carry `webrtc=true` when the host
  uses it.
- Signaling encrypts the connection offers with `crypto.subtle`, which browsers only have
  on https and localhost: on plain http (e.g. a computer on the local network), network
  games go through the page's server only.
- Finding each other and trying the ways to connect can take half a minute; joining waits
  up to 90 s, and the page counts the seconds.
- Most connections work directly. Some networks (some mobile carriers, company networks)
  need a TURN server to relay the traffic: `?turn=turn:user:password@host:3478`.
- The page tells the engine when a player is gone, so a player who leaves is dropped
  within seconds (UDP only notices after `net_tmDisconnectTimeout`), and the others are
  told when the host leaves. Players can have a connection through each signaling network,
  and Trystero sometimes replaces connections: a player only counts as gone when none is
  left for 10 s. Each network has its own Trystero app id, because Trystero shares (and
  later closes) connections between rooms of the same app.
- While a network game runs, the game goes on in a hidden tab (with timers instead of
  animation frames, which browsers stop there), so the others aren't stuck when the host
  switches tabs. Browsers slow timers down in background tabs that play no sound, and
  phones may suspend them altogether.
- The demo has one level for network games: Karnak, cooperative. In the browser the
  connection settings start at "5mb - Fiber Optics" (the game's defaults are for modems).

## Demo mirrors

Other web sites can serve the demo, so that players don't use up the site's bandwidth
(and the download goes on when the site is slow). A mirror is a copy of the built
`web/build/dist/demo/` folder anywhere on the web; its URL is the address of the folder
that *contains* `demo/` (for `https://cdn.example.org/sam/demo/Levels/…` it is
`https://cdn.example.org/sam/`). Players' browsers download pieces of the files from it
with range requests (each piece is checked against the torrent, so a broken mirror can't
spoil the download), which needs these CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Range
Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges
```

For example the CORS policy of an S3 or Cloudflare R2 bucket:

```json
[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"],
   "AllowedHeaders": ["Range"], "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"] }]
```

The build lists the mirrors in `demo-torrent.json` (and `demo.torrent`) from
`DEMO_MIRRORS` (comma separated URLs): `DEMO_MIRRORS=https://cdn.example.org/sam/ ./build.sh`.
The GitHub Pages workflow takes it from the repository variable `DEMO_MIRRORS`
(Settings → Secrets and variables → Actions → Variables). `?seed=…` adds mirrors for a
visit (for trying one out). A mirror must have exactly the files of the build's `demo/`,
which the torrent's pieces are made of; empty files are left out of the torrent and
needn't be there.

## Page options

`index.html?…`

| Parameter | |
|---|---|
| `autostart` | play the demo without clicks |
| `log` | show the engine's console output on the page |
| `args=+level%20Levels/KarnakDemo.wld` | command line |
| `exec=snd_iFormat=2;` | console commands to run at startup |
| `build=jspi` or `build=asyncify` | force a build |
| `touch=on`, `off` or `auto` | touch screen controls |
| `touchdebug` | show what the touch controls receive (for problems on devices) |
| `webrtc=true` | use WebRTC: the demo from other players too (and shared with them), network games directly between browsers |
| `seed=https://…` | more [demo mirrors](#demo-mirrors) (comma separated) |
| `trackers=wss://…` | trackers (comma separated) to find other players with (with `webrtc=true`) |
| `join=K7Q2MX` | join the network game in that room (`quickjoin` to skip the join menu) |
| `signal=wss://…` | self-hosted Trystero WebSocket relays for network games, instead of the public ones |
| `turn=turn:user:password@host:port` | a TURN server for network games |
| `netdebug` | log how network game connections are tried: addresses offered, checks, results (with `log`) |
| `nethub=ws://…`, `nethub=off` | network games through that hub instead of the page server's, or through none |
| `net=local` | network games between tabs of this browser, without WebRTC (for tests) |

From the browser's console, `Module.webCommands = ['some_command;']` runs console
commands in the running game. `web_bFrameStats=1;` prints frame timing and how much
sound is buffered.

## Tests

```sh
cd web/test && npm install && npx playwright install chromium firefox webkit
npm test              # all of the following
node smoke.mjs        # plays Karnak in Chromium (both builds), Firefox and WebKit
node persistence.mjs  # settings survive reloading the page
node ownfiles.mjs     # "Use my game files": zips made in several ways, broken game files, clearing stored data (--browser webkit)
node touch.mjs        # touch screen controls (--size 844x390 for a phone)
node gamepad.mjs      # gamepads (a stand-in for the Gamepad API) and aim assist
node mobile.mjs       # phone players' path on an emulated Android phone and iPhone
node torrent.mjs      # demo download: from the site, from IndexedDB, from another player, without WebTorrent, from mirrors
node netplay.mjs      # network games: hosting, joining by code, leaving, signaling from plain http
node netplay-browsers.mjs  # network games over WebRTC between WebKit, Firefox and Chromium
node escape.mjs       # Escape with the mouse captured (opens a browser window; not part of npm test)
node run.mjs --args "+level Levels/KarnakDemo.wld" --seconds 30 --shots 10,20 --out /tmp/shots
node demo-frames.mjs --frames 30,90 --native <native>/ScreenShots   # compare with a native build
                      # (needs the recorded demos, which the packaged demo leaves out)
```

`run.mjs` also profiles (`--profile 20,30`, use `--build asyncify`: Chrome doesn't
attribute WebAssembly running under JSPI) and counts WebGL calls (`--glstats`). The tests
download the demo from the local server only (without `webrtc=true`; `run.mjs --p2p` uses the public
trackers). The two-player part of `torrent.mjs` is skipped where WebRTC can't connect
(e.g. with some VPNs); the network game tests connect through a local TURN server
(`node-turn`) there.

## Known differences

- The game starts in the menu, without the intro flyover and the demos.
- No LAN or internet server lists: network games are joined by room code.
- Demos recorded with other builds desynchronize after a while (floating point
  differences change the simulation), as they do between native builds.
- Native macOS builds look darker in places: macOS doesn't report
  `GL_EXT_texture_edge_clamp`, so they clamp shadow maps with `GL_CLAMP`; the web
  build clamps to the edge like the game does on Windows.
