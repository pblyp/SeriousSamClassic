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

#include "Engine/StdH.h"

#include <emscripten.h>
#include <Engine/Base/CTString.h>
#include <Engine/Base/Emscripten/WebNet.h>

// the page's netplay object (Module.netplay, see web/shell/netplay.js) does the work

EM_JS(int, web_net_open, (int bServer), {
  const net = Module['netplay'];
  return net && net.open(!!bServer) ? 1 : 0;
});

EM_JS(void, web_net_close, (), {
  if (Module['netplay']) Module['netplay'].close();
});

EM_ASYNC_JS(unsigned int, web_net_join, (const char *pcCode, char *pcError, int ctErrorMax), {
  try {
    const net = Module['netplay'];
    if (!net) throw new Error('Network games are not available on this page.');
    return (await net.join(UTF8ToString(pcCode))) >>> 0;
  } catch (e) {
    stringToUTF8(String(e && e.message || e), pcError, ctErrorMax);
    return 0;
  }
});

EM_JS(void, web_net_send, (unsigned int ulHost, int iPort, const unsigned char *pub, int slSize), {
  const net = Module['netplay'];
  if (net) net.send(ulHost >>> 0, iPort, HEAPU8.slice(pub, pub + slSize));
});

EM_JS(int, web_net_receive, (unsigned char *pub, int slMax, unsigned int *pulHost, int *piPort), {
  const net = Module['netplay'];
  const packet = net && net.receive();
  if (!packet) return -1;
  const size = Math.min(packet.bytes.length, slMax);
  HEAPU8.set(packet.bytes.subarray(0, size), pub);
  HEAPU32[pulHost >> 2] = packet.ip;
  HEAP32[piPort >> 2] = packet.port;
  return size;
});

EM_JS(unsigned int, web_net_take_departed, (), {
  const net = Module['netplay'];
  return net ? net.takeDeparted() >>> 0 : 0;
});

ULONG Web_Net_TakeDeparted(void)
{
  return web_net_take_departed();
}

BOOL Web_Net_Open(BOOL bServer)
{
  return web_net_open(bServer);
}

void Web_Net_Close(void)
{
  web_net_close();
}

ULONG Web_Net_Join(const CTString &strCode, CTString &strError)
{
  char strBuffer[256] = "";
  const ULONG ulHost = web_net_join(strCode, strBuffer, sizeof(strBuffer));
  strError = strBuffer;
  return ulHost;
}

void Web_Net_Send(ULONG ulHost, UWORD uwPort, const UBYTE *pubData, SLONG slSize)
{
  web_net_send(ulHost, uwPort, pubData, slSize);
}

SLONG Web_Net_Receive(UBYTE *pubData, SLONG slMaxSize, ULONG &ulHost, UWORD &uwPort)
{
  unsigned int uiHost = 0;
  int iPort = 0;
  const int slSize = web_net_receive(pubData, slMaxSize, &uiHost, &iPort);
  ulHost = uiHost;
  uwPort = (UWORD)iPort;
  return slSize;
}
