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

/* rcg10072001 Moved stuff into this file. */
#define __STDC_LIMIT_MACROS 1

#include "SDL.h"
#include <Engine/Engine.h>
#include <Engine/Base/Timer.h>

#ifdef PLATFORM_EMSCRIPTEN
#include <emscripten.h>
#endif

void CTimer::Sleep(DWORD milliseconds)
{
#ifdef PLATFORM_EMSCRIPTEN
    // give the browser control while waiting
    extern double _dWebSleepTime;
    const double dStart = emscripten_get_now();
    emscripten_sleep(milliseconds);
    _dWebSleepTime += emscripten_get_now() - dStart;
#else
    SDL_Delay(milliseconds);
#endif
}

// end of SDLTimer.cpp ...


