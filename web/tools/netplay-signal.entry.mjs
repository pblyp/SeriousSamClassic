// The page's WebRTC signaling (web/shell/netplay.js): Trystero's BitTorrent tracker,
// Nostr and self-hosted WebSocket relay strategies, bundled into netplay-signal.js by
// build_libs.mjs. (They share one peer id: the same player found through two of them
// is one peer.)
export { joinRoom as joinTorrentRoom } from '@trystero-p2p/torrent';
export { joinRoom as joinNostrRoom } from '@trystero-p2p/nostr';
export { joinRoom as joinRelayRoom } from '@trystero-p2p/ws-relay';
// this browser's id in all of them (netplay.js uses it on the page server's hub too)
export { selfId } from '@trystero-p2p/torrent';
