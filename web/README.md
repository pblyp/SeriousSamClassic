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
- **When the game can't start**, the page says what happened (with the engine's message
  under "What the game said") and what to try, with *Start over* and *Clear stored data*.
  *Clear stored data…* (also on the start page) deletes, after asking, only what this page
  keeps: settings and saved games (`/user`), the cached base game package, the demo's
  pieces and the start page's options. Other sites on the same address (e.g. a
  `github.io` account's other projects) are left alone.
  Settings are saved whenever the page is hidden, since a tab can be closed at any time.
- **Demo download.** `shell/demo-download.js` gets the demo with
  [WebTorrent](https://webtorrent.io): from other players who have the page open
  (found through public WebSocket trackers, connected with WebRTC), and from the site,
  whose `demo/` files are the torrent's web seed. The pieces are kept in IndexedDB, so
  later visits download nothing, and the page shares them (at most 1 MB/s) while the game
  runs. If WebTorrent can't be used, the files are downloaded one by one. The start page's
  *Connection type* chooses how, for this and for network games (remembered in the browser):
  - *WebRTC*, the default: on https and localhost. Browsers only offer
    `crypto.subtle` (WebTorrent's SHA-1) there; on other plain http addresses (e.g. a
    computer on the local network) the files are downloaded one by one, and not kept.
  - *No WebRTC*: no other players (still through WebTorrent's web seed and cache).

  Only the official demo's files are shared, which to our knowledge may be freely
  redistributed; the start page explains this to players. Files from a player's own
  installation are never shared.
  `demo.torrent` lets BitTorrent clients that speak WebRTC (WebTorrent Desktop,
  `webtorrent-hybrid`) seed for the players; the build writes the site's URL into it as
  web seed when given `SITE_URL`.
- **Size.** The game renders at the size of the canvas (`web_fMaxPixelRatio`, 2 by
  default, limits the resolution on high density displays).
- **Touch screens.** `shell/touch.js` adds on screen controls (on by default on touch
  screens, or chosen on the start page): an analog stick under the left thumb, dragging
  on the right to look, and buttons. The engine reads them every frame: the stick as an
  analog movement axis (`Web_GetTouchMove()`, a short push walks), the rest as the keys
  and mouse of the default controls (`Web_GetTouchInput()`: Space, C, mouse buttons and
  wheel). In menus, NETRICSA and demos they hide, and taps work as mouse clicks.
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
  WebRTC at all (*No WebRTC*). When WebRTC connects too, the game moves to it (the page's
  log says which way each player is connected). `?nethub=off` leaves the hub out.
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
| `connection=secure` or `none` | the start page's Connection type (also `p2p=…`, and `1`, `0`, `off`) |
| `trackers=wss://…` | trackers (comma separated) to find other players with |
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
node mobile.mjs       # phone players' path on an emulated Android phone and iPhone
node torrent.mjs      # demo download: from the site, from IndexedDB, from another player, without WebTorrent
node netplay.mjs      # network games: hosting, joining by code, leaving, signaling from plain http
node netplay-browsers.mjs  # network games over WebRTC between WebKit, Firefox and Chromium
node escape.mjs       # Escape with the mouse captured (opens a browser window; not part of npm test)
node run.mjs --args "+level Levels/KarnakDemo.wld" --seconds 30 --shots 10,20 --out /tmp/shots
node demo-frames.mjs --frames 30,90 --native <native>/ScreenShots   # compare with a native build
```

`run.mjs` also profiles (`--profile 20,30`, use `--build asyncify`: Chrome doesn't
attribute WebAssembly running under JSPI) and counts WebGL calls (`--glstats`). The tests
download the demo from the local server only (`p2p=0`, i.e. No WebRTC; `run.mjs --p2p` uses the public
trackers). The two-player part of `torrent.mjs` is skipped where WebRTC can't connect
(e.g. with some VPNs); the network game tests connect through a local TURN server
(`node-turn`) there.

## Known differences

- No LAN or internet server lists: network games are joined by room code.
- Demos recorded with other builds desynchronize after a while (floating point
  differences change the simulation), as they do between native builds.
- Native macOS builds look darker in places: macOS doesn't report
  `GL_EXT_texture_edge_clamp`, so they clamp shadow maps with `GL_CLAMP`; the web
  build clamps to the edge like the game does on Windows.
