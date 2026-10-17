/* Copyright (c) 2002-2012 Croteam Ltd. 
This program is free software; you can redistribute it and/or modify
it under the terms of version 2 of the GNU General Public License as published by
the Free Software Foundation


This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA. */

#ifndef SE_INCL_WEBNET_H
#define SE_INCL_WEBNET_H
#ifdef PRAGMA_ONCE
  #pragma once
#endif

// Network games in the browser: the engine's UDP packets travel over WebRTC data
// channels (web/shell/netplay.js), between the player who hosts (the server) and
// the players who join (clients). Each other player has a made up IPv4 address.

// start (server: create a room for others to join) or stop the network transport
ENGINE_API BOOL Web_Net_Open(BOOL bServer);
ENGINE_API void Web_Net_Close(void);

// join the room of a game hosted with that code; returns the address of its server,
// or 0 with the reason in strError
ENGINE_API ULONG Web_Net_Join(const CTString &strCode, CTString &strError);

// send a packet to an address (dropped, as with UDP, if nobody is there)
ENGINE_API void Web_Net_Send(ULONG ulHost, UWORD uwPort, const UBYTE *pubData, SLONG slSize);

// the address of a player whose connection is gone (one per call), or 0
ENGINE_API ULONG Web_Net_TakeDeparted(void);

// the next received packet: its size (or -1 if none) and where it came from
ENGINE_API SLONG Web_Net_Receive(UBYTE *pubData, SLONG slMaxSize, ULONG &ulHost, UWORD &uwPort);

#endif  /* include-once check. */
