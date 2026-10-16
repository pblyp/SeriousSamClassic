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

#ifndef SE_INCL_GL1EMULATION_H
#define SE_INCL_GL1EMULATION_H
#ifdef PRAGMA_ONCE
  #pragma once
#endif

// OpenGL 1.x emulation on WebGL 2 (see GL1Emulation.cpp)

// returns the emulated OpenGL function with the given name, or NULL
void *WebGL_GetProcAddress(const char *strName);

// prepares a newly created WebGL context for emulation
void WebGL_InitContext(void);

// returns the last known visibility of a point (identified by iID) at window
// coordinates iX,iY with the given depth, and starts measuring it again
int WebGL_CheckDepthPoint(int iID, int iX, int iY, float fDepth, int iRasterWidth, int iRasterHeight);

#endif  /* include-once check. */
