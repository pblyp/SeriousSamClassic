'use strict';

// Network games between browsers. The engine keeps its own architecture: the player
// who starts a network game runs the server, the others connect to it as clients,
// and the engine's UDP packets (with its own acks and resends) travel over WebRTC
// data channels set up like UDP: unordered, never resent.
//
// Players meet in a "room" named by a short code, which the host gets and shares
// (or a link with it). Signaling, which WebRTC needs to set up the connections, goes
// through the page's server if it relays it (web/test/server.mjs does), else through
// public BitTorrent WebSocket trackers and Nostr relays at the same time (with
// Trystero, bundled in netplay-signal.js).
//
// If the page's server has a packet hub (server.mjs does), players also connect through
// it: games then work when browsers can't connect to each other with WebRTC (some
// networks, sandboxed browsers), or without WebRTC at all ("No WebRTC"). WebRTC links
// are preferred when they work.
//
// The engine sees the other players as made up IPv4 addresses (Engine/Base/Emscripten/
// WebNet.cpp calls open(), join(), send(), receive() and close()).

(() => {
  const APP_ID = 'serioussam-tfe-web';
  // room codes: no 0/O or 1/I, which are easily mixed up
  const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const CODE_LENGTH = 6;
  // the server, as clients see it, and the clients, as the server sees them
  const HOST_IP = ip(10, 83, 0, 1);
  const FIRST_CLIENT_IP = ip(10, 83, 0, 2);
  const PORT = 25600;
  // how long joining waits for the host (finding each other through public signaling and
  // trying the ways to connect can take half a minute)
  const JOIN_TIMEOUT_MS = 90000;
  // a congested channel drops packets, like a full UDP buffer (the engine resends)
  const MAX_BUFFERED = 256 * 1024;
  // the game's channel next to Trystero's own on each connection, agreed on both sides
  // (an id far from the ones channels get automatically)
  const CHANNEL = { negotiated: true, id: 501, ordered: false, maxRetransmits: 0 };
  // how long a player whose connections all closed may take to come back on a new one
  // before they count as gone (signaling sometimes replaces connections)
  const LINK_GRACE_MS = 10000;
  const NO_HUB = 'This site can\'t relay network games: choose WebRTC under Connection type on the start page.';
  const randomId = () => Math.random().toString(36).slice(2);

  function ip(a, b, c, d) {
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  // "k7q 2mx", "K7Q-2MX" -> "K7Q2MX" (or null if it can't be a code)
  function normalizeCode(text) {
    const code = String(text).toUpperCase().replace(/[\s-]/g, '');
    return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : null;
  }

  const showCode = (code) => `${code.slice(0, 3)}-${code.slice(3)}`;

  // ------------------------------------------------------------------ diagnostics

  // an RTCPeerConnection that logs how it tries to connect (?netdebug): the addresses each
  // side offers ("host" ones are on the local network, hidden behind random .local names
  // that the other side resolves with multicast DNS; "srflx" ones are the public address,
  // found with STUN; "relay" ones go through a TURN server), and how the checks went
  function debugPeerConnection(log) {
    const Base = window.RTCPeerConnection;
    let count = 0;
    const describe = (line) => {
      // "candidate:1 1 UDP 2122252543 1f2e....local 51480 typ host ..."
      const p = String(line).replace(/^a=/, '').split(' ');
      return `${p[7] || '?'} ${p[4]}:${p[5]} ${(p[2] || '').toLowerCase()}`;
    };
    return class extends Base {
      constructor(...args) {
        super(...args);
        const id = ++count;
        this.debugId = id;
        log(`WebRTC #${id}: new connection (ICE servers: ${JSON.stringify((args[0] && args[0].iceServers || []).map((s) => s.urls))})`);
        this.addEventListener('icecandidate', (e) => {
          if (e.candidate && e.candidate.candidate) log(`WebRTC #${id}: this side offers ${describe(e.candidate.candidate)}`);
        });
        this.addEventListener('icegatheringstatechange', () => log(`WebRTC #${id}: gathering ${this.iceGatheringState}`));
        this.addEventListener('iceconnectionstatechange', () => {
          log(`WebRTC #${id}: ${this.iceConnectionState}`);
          if (this.iceConnectionState === 'failed') this.logChecks();
        });
      }

      async setLocalDescription(description) {
        const result = await super.setLocalDescription(description);
        for (const line of (this.localDescription && this.localDescription.sdp || '').match(/a=candidate:.*/g) || []) {
          log(`WebRTC #${this.debugId}: this side offers ${describe(line)} (in its ${this.localDescription.type})`);
        }
        return result;
      }

      async setRemoteDescription(description) {
        for (const line of (description && description.sdp || '').match(/a=candidate:.*/g) || []) {
          log(`WebRTC #${this.debugId}: the other side offers ${describe(line)} (in its ${description.type})`);
        }
        return super.setRemoteDescription(description);
      }

      async addIceCandidate(candidate) {
        if (candidate && candidate.candidate) log(`WebRTC #${this.debugId}: the other side offers ${describe(candidate.candidate)}`);
        return super.addIceCandidate(candidate);
      }

      // which address pairs were tried, and what came of them
      async logChecks() {
        try {
          const stats = await this.getStats();
          const candidates = {};
          stats.forEach((s) => {
            if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
              candidates[s.id] = `${s.candidateType} ${s.address || s.ip}:${s.port}`;
            }
          });
          stats.forEach((s) => {
            if (s.type === 'candidate-pair') {
              log(`WebRTC #${this.debugId}: tried ${candidates[s.localCandidateId]} -> ${candidates[s.remoteCandidateId]}: `
                + `${s.state}, ${s.requestsSent || 0} checks sent, ${s.responsesReceived || 0} answered`);
            }
          });
        } catch (e) {
          log(`WebRTC #${this.debugId}: no statistics (${e.message})`);
        }
      }
    };
  }

  // ------------------------------------------------------------------ transports

  // A transport joins a room and reports connections to other players ("links") as
  // they open and close, each with a channel to send bytes on; and messages saying who
  // is the host. A player may have more than one link (one per signaling network, and
  // one through the page's server), and a link may be replaced by a new one under the
  // same name. Links through the server are named "hub:...".
  //   on('link', (link, peerId, { channel, sendRole }) => ...)
  //   on('unlink', (link, peerId, { left }) => ...)    (left: the player said goodbye)
  //   on('role', (peerId, role) => ...)
  //   leave()
  //   selfId: this player's id (the same in all transports of a game)

  // a transport's events, kept until something listens (players may connect through one
  // transport while another is still being set up)
  function transportEvents() {
    const handlers = {};
    const pending = [];
    return {
      emit(event, ...args) {
        if (handlers[event]) handlers[event](...args);
        else pending.push([event, args]);
      },
      on(event, fn) {
        handlers[event] = fn;
        for (let i = 0; i < pending.length;) {
          if (pending[i][0] === event) fn(...pending.splice(i, 1)[0][1]);
          else i++;
        }
      },
    };
  }

  // WebRTC, with Trystero over trackers and Nostr relays (and/or self-hosted relays)
  async function webRtcTransport(code, { trackers, relays, turn, onJoinError, debug, log }) {
    // signaling encrypts with crypto.subtle, which browsers only have on https and localhost
    if (!crypto.subtle) {
      throw new Error('WebRTC needs this page on https (or a server that can pass games on).');
    }
    const signal = await import('./netplay-signal.js');
    // all of a browser's addresses go in its offer or answer (on a local network, the
    // ones trickled after it in separate messages didn't all arrive)
    const config = { trickleIce: false };
    if (turn) config.turnConfig = [turn];
    if (debug) config.rtcPolyfill = debugPeerConnection(log);
    const callbacks = { onJoinError };
    // (public relays come and go: no warnings for every one that fails)
    const quiet = { warnOnRelayFailure: false };
    // an app id for each signaling network: Trystero shares a connection between rooms
    // of the same app and room name, and closes it about two minutes after one of them
    // lets go of it, while the game still runs on it
    const rooms = relays && relays.length
      ? [['relay', signal.joinRelayRoom({ ...config, appId: `${APP_ID}/relay`, relayConfig: { ...quiet, urls: relays } }, code, callbacks)]]
      : [
        ['torrent', signal.joinTorrentRoom({ ...config, appId: `${APP_ID}/torrent`,
          relayConfig: { ...quiet, ...(trackers ? { urls: trackers } : {}) } }, code, callbacks)],
        ['nostr', signal.joinNostrRoom({ ...config, appId: `${APP_ID}/nostr`, relayConfig: quiet }, code, callbacks)],
      ];
    const events = transportEvents();
    // (the game's channel on each connection, made once: its id can only be used once)
    const channels = new WeakMap();
    for (const [network, room] of rooms) {
      const roleAction = room.makeAction('role');
      roleAction.onMessage = (role, { peerId }) => events.emit('role', peerId, role);
      room.onPeerJoin = (peerId) => {
        const connection = room.getPeers()[peerId];
        if (!connection) return;
        let channel = channels.get(connection);
        if (!channel) {
          channel = connection.createDataChannel('sam', CHANNEL);
          channel.binaryType = 'arraybuffer';
          channels.set(connection, channel);
        }
        events.emit('link', `${network}:${peerId}`, peerId, {
          channel,
          sendRole: (role) => roleAction.send(role, { target: peerId }).catch(() => {}),
        });
      };
      room.onPeerLeave = (peerId) => events.emit('unlink', `${network}:${peerId}`, peerId, { left: false });
    }
    return {
      on: events.on,
      leave() { for (const [, room] of rooms) room.leave(); },
      selfId: signal.selfId,
    };
  }

  // a WebSocket hub that passes every message on to the room's others (the page server's
  // /hub, see web/test/server.mjs), looking like a BroadcastChannel
  function hubBus(url, code) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const bus = { onmessage: null, postMessage: (m) => socket.send(JSON.stringify({ ...m, data: encode(m.data) })), close: () => socket.close() };
      socket.onopen = () => { socket.send(JSON.stringify({ room: code })); resolve(bus); };
      socket.onerror = () => reject(new Error(`Cannot reach ${url}`));
      socket.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (bus.onmessage) bus.onmessage({ data: { ...m, data: decode(m.data) } });
      };
    });
    function encode(data) {
      return data instanceof Uint8Array ? { bytes: btoa(String.fromCharCode(...data)) } : data;
    }
    function decode(data) {
      return data && data.bytes !== undefined ? Uint8Array.from(atob(data.bytes), (c) => c.charCodeAt(0)).buffer : data;
    }
  }

  // without WebRTC: browsers connected to a WebSocket hub (the page's server), or tabs of
  // the same browser (?net=local, a BroadcastChannel per room, for tests)
  async function localTransport(code, hubUrl, selfId = randomId()) {
    const bus = hubUrl ? await hubBus(hubUrl, code) : new BroadcastChannel(`sam-net-${code}`);
    const linkName = (peerId) => `${hubUrl ? 'hub' : 'local'}:${peerId}`;
    const events = transportEvents();
    const peers = new Map();
    const post = (to, type, data) => bus.postMessage({ from: selfId, to, type, data });
    function addPeer(peerId) {
      if (peers.has(peerId)) return;
      const channel = { readyState: 'open', bufferedAmount: 0, onmessage: null, onopen: null, onclose: null,
        send: (bytes) => post(peerId, 'data', bytes), close() {} };
      peers.set(peerId, channel);
      events.emit('link', linkName(peerId), peerId, { channel, sendRole: (role) => post(peerId, 'role', role) });
      setTimeout(() => channel.onopen && channel.onopen());
    }
    bus.onmessage = ({ data: m }) => {
      if (m.from === selfId || (m.to && m.to !== selfId)) return;
      // (the reply first: the peer must know us before anything else arrives)
      if (m.type === 'hello') { post(m.from, 'hello-back'); addPeer(m.from); }
      if (m.type === 'hello-back') addPeer(m.from);
      if (m.type === 'role') events.emit('role', m.from, m.data);
      if (m.type === 'data') { const channel = peers.get(m.from); if (channel && channel.onmessage) channel.onmessage({ data: m.data }); }
      // (a player who has another link, e.g. with WebRTC, stays: see linkGone())
      if (m.type === 'bye') { peers.delete(m.from); events.emit('unlink', linkName(m.from), m.from, { left: true }); }
    };
    setTimeout(() => post(null, 'hello'));
    return {
      on: events.on,
      leave() { post(null, 'bye'); bus.close(); },
      selfId,
    };
  }

  // several transports as one (WebRTC and the page server's hub)
  function combineTransports(parts) {
    return {
      on(event, fn) { for (const part of parts) part.on(event, fn); },
      leave() { for (const part of parts) part.leave(); },
      selfId: parts[0].selfId,
    };
  }

  // ------------------------------------------------------------------ netplay

  //   connection(): what the player chose under Connection type: 'webrtc' or 'none' (only
  //     through the page's server)
  //   services(): -> Promise<{ relays, hub }>: what the page's server offers (signaling
  //     relays, packet hub URL), if anything
  //   relays, hub: instead of the page server's (relays: [] for the public ones; hub: false
  //     for none)
  //   transport: 'local' for tests (a BroadcastChannel, or the hub), or a function
  //     (code, options) -> Promise<transport>
  //   trackers: BitTorrent trackers for public signaling
  //   turn: a TURN server ({ urls, username, credential }) for networks that need one
  //   debug: log how WebRTC connections are tried (see debugPeerConnection())
  //   linkGraceMs: see LINK_GRACE_MS
  //   log(text), onChange(netplay): to tell the player what is going on
  function create({ connection = () => 'webrtc', services = async () => ({}), relays = null, hub = null,
    transport = null, trackers = null, turn = null, debug = false, linkGraceMs = LINK_GRACE_MS,
    log = () => {}, onChange = () => {} } = {}) {
    let room = null;
    let roomStarting = null;
    let isHost = false;
    let nextClientIp = FIRST_CLIENT_IP;
    let lastJoinError = '';
    // the other players: peerId -> { peerId, ip, isHost, links: Map(link -> { channel, sendRole }), graceTimer }
    const peers = new Map();
    const byIp = new Map();     // ip -> player
    const inbox = [];
    const departed = [];        // addresses of players whose connection is gone

    const netplay = {
      active: false,   // a network game is on (hosted or joined)
      code: null,      // the room's code
      role: null,      // 'host' or 'client'
      state: '',       // what is going on, for the page: 'hosting', 'joining', 'joined', 'host-left',
                       // 'failed' (joining didn't work, see error), ''
      error: '',
      players: 0,      // other players connected
      joinStarted: 0,  // when joining started (Date.now())
      via: '',         // how a joined player reaches the host: 'with WebRTC', 'through this page's server'

      // the engine opens its "socket": the server starts a room, a client waits for join()
      open(server) {
        this.close();
        this.state = '';
        this.error = '';
        isHost = !!server;
        this.role = isHost ? 'host' : 'client';
        if (isHost) {
          this.code = newCode();
          this.active = true;
          this.state = 'hosting';
          log(`Hosting a network game, room code ${showCode(this.code)}`);
          startRoom(this.code).catch((e) => {
            // (the game goes on, but nobody can join: say why)
            this.state = 'failed';
            this.error = e.message || String(e);
            log(`Network game: ${this.error}`);
            onChange(this);
          });
          onChange(this);
        }
        return true;
      },

      // join the game hosted with that code: resolves to the host's address
      async join(text) {
        const code = normalizeCode(text);
        if (!code) {
          throw new Error(`"${text}" is not a room code. Room codes look like K7Q-2MX: ask the player who started the game.`);
        }
        this.code = code;
        this.active = true;
        this.state = 'joining';
        this.error = '';
        this.joinStarted = Date.now();
        lastJoinError = '';
        onChange(this);
        log(`Looking for the game in room ${showCode(code)}`);
        try {
          await startRoom(code);
          await new Promise((resolve, reject) => {
            const started = Date.now();
            let shownSeconds = 0;
            const check = setInterval(() => {
              const host = [...peers.values()].find((peer) => peer.isHost && openChannel(peer));
              // (the page shows how long it has been looking)
              const seconds = Math.floor((Date.now() - started) / 1000);
              if (seconds !== shownSeconds) {
                shownSeconds = seconds;
                onChange(netplay);
              }
              if (host) {
                clearInterval(check);
                resolve();
              } else if (Date.now() - started > JOIN_TIMEOUT_MS) {
                clearInterval(check);
                reject(new Error(lastJoinError
                  ? `The game in room ${showCode(code)} was found, but this browser can't connect to it. `
                    + 'One of the networks probably blocks direct connections (some mobile and company networks do): '
                    + 'try another network, or a TURN server (see the page\'s turn= option).'
                  : `No game was found in room ${showCode(code)}. Check the code, and that the game is still running.`));
              }
            }, 100);
          });
        } catch (e) {
          this.close();
          // (shown until the next game, though the engine closes its side now)
          this.state = 'failed';
          this.error = e.message || String(e);
          onChange(this);
          throw e;
        }
        this.state = 'joined';
        onChange(this);
        log(`Connected to the game in room ${showCode(code)}`);
        return HOST_IP;
      },

      send(toIp, port, bytes) {
        const peer = byIp.get(toIp);
        const channel = peer && openChannel(peer);
        if (!channel || channel.bufferedAmount > MAX_BUFFERED) return;
        try {
          channel.send(bytes);
        } catch (e) {
          // closing: lost, like a UDP packet
        }
      },

      receive() {
        return inbox.shift() || null;
      },

      // the address of a player who left (their connection closed), or 0
      takeDeparted() {
        return departed.shift() || 0;
      },

      close() {
        if (room) room.leave();
        room = null;
        roomStarting = null;
        for (const peer of peers.values()) clearTimeout(peer.graceTimer);
        peers.clear();
        byIp.clear();
        inbox.length = 0;
        departed.length = 0;
        nextClientIp = FIRST_CLIENT_IP;
        const wasActive = this.active;
        this.active = false;
        this.code = null;
        if (this.state !== 'failed') this.state = '';
        this.players = 0;
        this.via = '';
        if (wasActive) onChange(this);
      },

      showCode,
      normalizeCode,
    };

    // a channel that can carry the player's packets now, if any: WebRTC rather than the
    // page server's hub (it says when that changes)
    function openChannel(peer) {
      let route = null;
      for (const [link, { channel }] of peer.links) {
        if (channel.readyState !== 'open') continue;
        if (!link.startsWith('hub:')) {
          route = [link, channel];
          break;
        }
        route = route || [link, channel];
      }
      const via = route ? (route[0].startsWith('hub:') ? 'through this page\'s server' : 'with WebRTC') : null;
      if (via && via !== peer.via) {
        peer.via = via;
        log(`Network game: connected to ${peer.isHost ? 'the host' : 'a player'} ${via}`);
        if (peer.isHost) {
          netplay.via = via;
          onChange(netplay);
        }
      }
      return route ? route[1] : null;
    }

    function countPlayers() {
      netplay.players = [...peers.values()]
        .filter((peer) => (isHost ? peer.ip : peer.isHost) && (openChannel(peer) || peer.graceTimer))
        .length;
      onChange(netplay);
    }

    function startRoom(code) {
      if (!roomStarting) {
        const options = { trackers, turn, debug, log, onJoinError: (details) => {
          lastJoinError = details.error || String(details);
          log(`Network game: ${lastJoinError}`);
        } };
        const starting = typeof transport === 'function' ? transport(code, options)
          : transport === 'local' ? localTransport(code, hub) : openTransports(code, options);
        roomStarting = starting.then((r) => {
          room = r;
          r.on('link', onLink);
          r.on('unlink', (link, peerId, { left }) => {
            const peer = peers.get(peerId);
            if (peer) linkGone(peer, link, peer.links.get(link), left);
          });
          r.on('role', (peerId, role) => {
            const peer = getPeer(peerId);
            if (role === 'host' && !isHost && !peer.isHost) {
              peer.isHost = true;
              peer.ip = HOST_IP;
              byIp.set(HOST_IP, peer);
              countPlayers();
            }
          });
        });
      }
      return roomStarting;
    }

    // WebRTC, the page server's hub, or both, as the player chose and the server allows
    async function openTransports(code, options) {
      const found = (await services().catch(() => null)) || {};
      const relayList = relays !== null ? relays : found.relays || null;
      const hubUrl = hub === false ? null : hub || found.hub || null;
      const mode = connection();
      const parts = [];
      let webRtcError = null;
      if (mode !== 'none') {
        try {
          parts.push(await webRtcTransport(code, { ...options, relays: relayList && relayList.length ? relayList : null }));
        } catch (e) {
          webRtcError = e;
        }
      }
      if (hubUrl) {
        try {
          parts.push(await localTransport(code, hubUrl, parts.length ? parts[0].selfId : randomId()));
          log(webRtcError ? `Network game: without WebRTC (${webRtcError.message}), through this page's server only`
            : `Network game: also through this page's server (${hubUrl})`);
        } catch (e) {
          log(`Network game: ${e.message}`);
        }
      }
      if (!parts.length) {
        throw webRtcError || new Error(NO_HUB);
      }
      return parts.length > 1 ? combineTransports(parts) : parts[0];
    }

    function getPeer(peerId) {
      let peer = peers.get(peerId);
      if (!peer) {
        peer = { peerId, ip: 0, isHost: false, links: new Map(), graceTimer: 0, via: null };
        peers.set(peerId, peer);
        // (the server knows each player by an address of their own)
        if (isHost) {
          peer.ip = nextClientIp++;
          byIp.set(peer.ip, peer);
        }
      }
      return peer;
    }

    // a connection to a player opened: the first, another one (through another signaling
    // network), or one replacing a connection that is going away
    function onLink(link, peerId, conn) {
      const peer = getPeer(peerId);
      const old = peer.links.get(link);
      if (old && old.channel !== conn.channel) {
        old.channel.onclose = null;
        try { old.channel.close(); } catch (e) { /* gone already */ }
      }
      peer.links.set(link, conn);
      const { channel, sendRole } = conn;
      channel.onmessage = (e) => {
        // the host takes packets from everyone, clients only from the host
        if (!peer.ip || (!isHost && !peer.isHost)) return;
        inbox.push({ ip: peer.ip, port: PORT, bytes: new Uint8Array(e.data) });
        if (inbox.length > 4096) inbox.shift();
      };
      const opened = () => {
        if (peer.graceTimer) log('Network game: the connection to a player is back');
        clearTimeout(peer.graceTimer);
        peer.graceTimer = 0;
        if (isHost) sendRole('host');
        countPlayers();
      };
      if (channel.readyState === 'open') opened();
      else channel.onopen = opened;
      channel.onclose = () => linkGone(peer, link, conn, false);
    }

    // a connection to a player closed: they are gone when no other one is left, and none
    // comes back soon (or right away if they said goodbye)
    function linkGone(peer, link, conn, left) {
      if (!conn || peer.links.get(link) !== conn) return;
      peer.links.delete(link);
      if (openChannel(peer)) return;
      clearTimeout(peer.graceTimer);
      if (left) {
        playerGone(peer);
        return;
      }
      log(`Network game: lost the connection to a player (${link}), waiting ${linkGraceMs / 1000} s for it to come back`);
      peer.graceTimer = setTimeout(() => {
        peer.graceTimer = 0;
        if (!openChannel(peer)) playerGone(peer);
      }, linkGraceMs);
      countPlayers();
    }

    function playerGone(peer) {
      if (peers.get(peer.peerId) !== peer) return;
      peers.delete(peer.peerId);
      for (const { channel } of peer.links.values()) {
        channel.onclose = null;
        try { channel.close(); } catch (e) { /* gone already */ }
      }
      if (byIp.get(peer.ip) === peer) {
        byIp.delete(peer.ip);
        departed.push(peer.ip);
      }
      if (peer.isHost && netplay.state === 'joined') {
        netplay.state = 'host-left';
        log('The host has left the game');
      }
      countPlayers();
    }

    return netplay;
  }

  // "turn:user:password@host:3478" -> an ICE server for RTCPeerConnection
  function parseTurn(text) {
    const m = /^(turns?):(?:([^:@]*):([^@]*)@)?(.+)$/.exec(text || '');
    if (!m) return null;
    return { urls: `${m[1]}:${m[4]}`, username: m[2] ? decodeURIComponent(m[2]) : undefined, credential: m[3] ? decodeURIComponent(m[3]) : undefined };
  }

  window.NetPlay = { create, normalizeCode, showCode, parseTurn };
})();
