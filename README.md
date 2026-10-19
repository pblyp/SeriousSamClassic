## Serious Sam Classic: The First Encounter in the browser
[![Web version](https://github.com/pblyp/SeriousSamClassic/actions/workflows/web-pages.yml/badge.svg)](https://github.com/pblyp/SeriousSamClassic/actions/workflows/web-pages.yml)
[![License: GPL v2](https://img.shields.io/badge/License-GPL_v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)

Serious Engine 1.10 and *Serious Sam: The First Encounter*, compiled to WebAssembly and
rendering with WebGL 2, playable in a web browser on computers and phones.

**Play it: <https://pblyp.github.io/SeriousSamClassic/>**

- **The demo, out of the box.** The official Karnak demo level (about 80 MB) is downloaded
  once and kept in the browser. It comes from other players who have the page open
  (WebTorrent), and from the site when there are none.
- **The full game, with your own copy.** Zip the folder where *The First Encounter* is
  installed and pick the .zip on the start page. Your files never leave your device; they
  are kept in the browser, so next time *Play my game files* starts the game without the .zip.
- **Network games.** The player who starts a game gets a room code and a link to send to
  the others. Browsers connect directly (WebRTC), or through the page's server when it
  can pass games on.
- **Touch screens.** Phones and tablets get on-screen controls: an analog stick under the
  left thumb, dragging on the right to look, and buttons.
- **Settings and saved games** stay in the browser. *Clear my data* on the start page
  removes them; *Clear assets* removes the downloaded demo and your kept game files instead.

It runs in current Chrome, Edge, Firefox and Safari (desktop, Android and iOS).

This is a fork of [SeriousSamClassic](https://github.com/tx00100xt/SeriousSamClassic)
(the Linux, BSD and macOS port of Croteam's open source Serious Engine). The web version
is in the `web-port` branch; for native builds of both games, see the original repository.

Playing
-------

- **Keyboard and mouse:** click the game to capture the mouse. <kbd>Esc</kbd> opens the
  menu, <kbd>~</kbd> the console, and <kbd>F11</kbd> goes fullscreen.
- **Touch:** the left thumb moves, dragging on the right looks around, and there are
  buttons for Fire, Jump, Duck, Use, weapons and Esc. Taps work as clicks in the menus.
  The controls are on by default on touch screens, and can be switched on the start page.
- **Gamepad:** press a button on it once the page is open (browsers only show a pad after
  that). The left stick moves, the right stick looks, RT fires, LT or X uses, A jumps,
  B ducks, LB/RB (or the D-pad) change weapons, Y flips to the last weapon, Back opens
  NETRICSA and Start the menu. In the menus the D-pad or left stick moves, A chooses and
  B goes back.
- **Aim assist:** shots go to an enemy next to the crosshair. It is on with touch controls
  or a gamepad, and can be switched on or off for good in Options → Players and
  controls → Customize controls → Aim assist.
- **Your own game:** choose *Use my game files…* and pick a .zip of the installation folder
  (with its `.gro` files). On a computer you can also drop the folder itself on the page.
- **Network games:** in the game's menu, Network → Start. A badge shows the room code with
  *Copy link* and *Share*. The others open the link, or type the code under Network →
  Join → Specify server. The demo has a cooperative level (Karnak) and a deathmatch
  level (Desert Temple).
- **WebRTC** is off by default: the demo comes from the site (and its mirrors), and
  network games go through the page's server, if it can pass them on (GitHub Pages
  can't). Open the page with `?webrtc=true` to download the demo from other players too
  (your browser then shares it while you play: only the free demo) and to connect network
  games directly.

Running it yourself
-------------------

### Requirements

- [emsdk](https://emscripten.org/docs/getting_started/downloads.html), version 6.0.12
- CMake, Ninja, flex, bison, and a C++ compiler for the build machine
- SDL2, zlib, libogg and libvorbis development files (the build machine's CMake configure
  step looks for them)
- Node.js 20 or newer, Python 3, 7-Zip, rsync and curl

On macOS:
```sh
brew install cmake ninja bison flex sdl2 libogg libvorbis sevenzip node
```
On Debian or Ubuntu:
```sh
sudo apt install cmake ninja-build flex bison g++ libsdl2-dev zlib1g-dev libogg-dev libvorbis-dev 7zip rsync curl nodejs npm python3
```

### Building

```sh
git clone -b web-port https://github.com/pblyp/SeriousSamClassic.git
cd SeriousSamClassic

git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 6.0.12 && ~/emsdk/emsdk activate 6.0.12
source ~/emsdk/emsdk_env.sh

web/build.sh            # the site, in web/build/dist
```

The first build takes a while. It downloads the official demo and the 1.05 patch from
archive.org (checked against `web/demo_data.sha256`), builds the entity compiler for the
build machine, and builds the engine twice. Browsers with JavaScript Promise Integration
get one build, the others an Asyncify build.

### Serving it

`web/build/dist` is a static site. The included server also helps network games:

```sh
(cd web/test && npm install)       # once
node web/test/server.mjs 8080 0.0.0.0
```

Open <http://localhost:8080/>. Other devices on your network open
`http://<this computer's address>:8080/`.

- **Network games without the internet.** Players who open the page from this server find
  each other through it. The server also passes games on when browsers can't connect to
  each other directly (some networks, and sandboxed or locked-down browsers).
- **Plain http on the local network** (not localhost): browsers don't offer the
  cryptography WebRTC and WebTorrent need there. The demo then downloads directly from the
  server, and network games run through it.
- **Any other web server** works too. It must answer range requests, which the demo's
  files need as the torrent's web seed. Network games then use public signaling servers
  and WebRTC only.

### Hosting it on GitHub Pages

`.github/workflows/web-pages.yml` builds the site and publishes it on every push to
`main` or `web-port` (or when started by hand):

1. Fork this repository and push the `web-port` branch to your fork.
2. In the fork's **Actions** tab, enable workflows.
3. Settings → **Pages** → Source: **GitHub Actions**.
4. Settings → **Environments** → **github-pages**: allow the `web-port` branch to deploy.
5. Actions → **Web version (GitHub Pages)** → **Run workflow**.

The site is then at `https://<user>.github.io/SeriousSamClassic/`.

On Pages, the demo comes from other players first. The site is only asked when none are
found within 15 seconds, which spares its bandwidth (100 GB a month).

To take load off the site and help players get the demo, keep a seeder running somewhere
with a WebTorrent client that speaks WebRTC, for example:
```sh
npm install -g webtorrent-cli@6
webtorrent download https://<user>.github.io/SeriousSamClassic/demo.torrent --keep-seeding
```

### Tests

```sh
cd web/test && npm install && npx playwright install chromium firefox webkit
npm test
```

How the port works (rendering, threads, files, the demo download, network games), the
page's options and the individual tests are described in [web/README.md](web/README.md).

Troubleshooting
---------------

- **The page doesn't start, or the fullscreen option is missing:** some content blockers
  block scripts with "fullscreen" in their name. The game works without it.
- **Network games don't connect:** open the page with `?log&netdebug` to see how the
  browsers try to connect. Some networks need a TURN server (`?turn=turn:user:password@host:3478`).
  Some browsers can't do WebRTC at all: sandboxed Snap/Flatpak builds, strict privacy
  settings, proxies. On your own server they play through the server instead.
- **The game doesn't start with your files:** the page explains what is wrong (for example
  a damaged `.gro` file) and offers to start over or clear the stored data.

License
-------

* Serious Engine is licensed under the GNU GPL v2 (see LICENSE file).
* amp11lib is licensed under the GNU GPL v2 (see amp11lib/COPYING file).
* *Serious Sam* and the *Serious Sam: The First Encounter* demo are © Croteam. The page only
  shares the official demo, which to our knowledge is freely redistributable. The full
  game needs your own copy.

### Note:
The following applies only to the for Windows build. Because none of the following is used when building under (Linux, *BSD, macOS) systems.
<pre>

Some of the code included with the engine sources is not licensed under the GNU GPL v2:
</pre>

* zlib (located in `Sources/Engine/zlib`) by Jean-loup Gailly and Mark Adler
* LightWave SDK (located in `Sources/LWSkaExporter/SDK`) by NewTek Inc.
* libogg/libvorbis (located in `Sources/libogg` and `Sources/libvorbis`) by Xiph.Org Foundation
