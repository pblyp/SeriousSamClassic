# Serious Sam: The First Encounter in the browser

The engine compiled to WebAssembly with Emscripten, rendering with WebGL 2.
It runs the official Karnak demo out of the box, and the full game when the
player picks their own installation folder (the files never leave their computer).

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
  Settings are saved whenever the page is hidden, since a tab can be closed at any time.
- **Demo download.** `shell/demo-download.js` gets the demo with
  [WebTorrent](https://webtorrent.io): from other players who have the page open
  (found through public WebSocket trackers, connected with WebRTC), and from the site,
  whose `demo/` files are the torrent's web seed. The pieces are kept in IndexedDB, so
  later visits download nothing, and the page shares them (at most 1 MB/s) while the game
  runs. If WebTorrent can't be used, the files are downloaded one by one.
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
| `p2p=0` | download the demo only from the site, not from other players |
| `trackers=wss://…` | trackers (comma separated) to find other players with |

From the browser's console, `Module.webCommands = ['some_command;']` runs console
commands in the running game. `web_bFrameStats=1;` prints frame timing and how much
sound is buffered.

## Tests

```sh
cd web/test && npm install && npx playwright install chromium firefox webkit
npm test              # all of the following
node smoke.mjs        # plays Karnak in Chromium (both builds), Firefox and WebKit
node persistence.mjs  # settings survive reloading the page
node ownfiles.mjs     # "Use my game files" with the demo folder
node touch.mjs        # touch screen controls (--size 844x390 for a phone)
node mobile.mjs       # phone players' path on an emulated Android phone and iPhone
node torrent.mjs      # demo download: from the site, from IndexedDB, from another player, without WebTorrent
node escape.mjs       # Escape with the mouse captured (opens a browser window; not part of npm test)
node run.mjs --args "+level Levels/KarnakDemo.wld" --seconds 30 --shots 10,20 --out /tmp/shots
node demo-frames.mjs --frames 30,90 --native <native>/ScreenShots   # compare with a native build
```

`run.mjs` also profiles (`--profile 20,30`, use `--build asyncify`: Chrome doesn't
attribute WebAssembly running under JSPI) and counts WebGL calls (`--glstats`). The tests
download the demo from the local server only (`p2p=0`; `run.mjs --p2p` uses the public
trackers). The two-player part of `torrent.mjs` is skipped where WebRTC can't connect
(e.g. with some VPNs).

## Known differences

- No multiplayer.
- Demos recorded with other builds desynchronize after a while (floating point
  differences change the simulation), as they do between native builds.
- Native macOS builds look darker in places: macOS doesn't report
  `GL_EXT_texture_edge_clamp`, so they clamp shadow maps with `GL_CLAMP`; the web
  build clamps to the edge like the game does on Windows.
