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

#ifndef SE_INCL_WEBPLATFORM_H
#define SE_INCL_WEBPLATFORM_H
#ifdef PRAGMA_ONCE
  #pragma once
#endif

// Browser integration for the WebAssembly build. The game keeps its blocking
// loops and yields to the browser from them (with JSPI or Asyncify).

// yield to the browser until it is time to draw the next frame
ENGINE_API void Web_WaitFrame(void);

// TRUE once after the page asked the game to save its settings (when it gets hidden or closed)
ENGINE_API BOOL Web_SaveRequested(void);

// console commands that the page queued for the game (empty if none)
ENGINE_API CTString Web_TakeCommands(void);

#endif  /* include-once check. */
