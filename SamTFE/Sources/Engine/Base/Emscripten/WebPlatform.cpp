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
#include <Engine/Base/Console.h>
#include <Engine/Base/CTString.h>
#include <Engine/Base/Emscripten/WebPlatform.h>

// waits for the next animation frame, or until the page wakes the game up
// (animation frames stop while the page is hidden; in a network game the others
// still need this one, so then it goes on with timers)
EM_ASYNC_JS(void, web_wait_animation_frame, (), {
  await new Promise((resolve) => {
    let cancel;
    if (document.hidden && Module['netplay'] && Module['netplay'].active) {
      const id = setTimeout(resolve, 16);
      cancel = () => clearTimeout(id);
    } else {
      const id = requestAnimationFrame(() => resolve());
      cancel = () => cancelAnimationFrame(id);
    }
    Module['webWakeUp'] = () => {
      cancel();
      resolve();
    };
  });
  Module['webWakeUp'] = null;
});

EM_JS(int, web_take_save_request, (), {
  const bRequested = Module['webSaveRequested'] ? 1 : 0;
  Module['webSaveRequested'] = false;
  return bRequested;
});

BOOL Web_SaveRequested(void)
{
  return web_take_save_request();
}

// console commands queued by the page (Module.webCommands), or NULL
EM_JS(char *, web_take_commands, (), {
  const astr = Module['webCommands'];
  if (!astr || astr.length == 0) {
    return 0;
  }
  Module['webCommands'] = [];
  return stringToNewUTF8(astr.join(' '));
});

CTString Web_TakeCommands(void)
{
  char *str = web_take_commands();
  if (str == NULL) {
    return "";
  }
  CTString strCommands = str;
  free(str);
  return strCommands;
}

EM_JS(int, web_get_touch_input, (UBYTE *pubButtons, int ctButtons, float *pfLook), {
  const t = Module['webTouch'];
  if (!t) {
    HEAPU8.fill(0, pubButtons, pubButtons + ctButtons);
    HEAPF32[pfLook >> 2] = 0;
    HEAPF32[(pfLook >> 2) + 1] = 0;
    return 0;
  }
  for (let i = 0; i < ctButtons; i++) {
    HEAPU8[pubButtons + i] = t.buttons[i] ? 1 : 0;
  }
  HEAPF32[pfLook >> 2] = t.lookX;
  HEAPF32[(pfLook >> 2) + 1] = t.lookY;
  t.lookX = 0;
  t.lookY = 0;
  const iWheel = t.wheel;
  t.wheel = 0;
  return iWheel;
});

void Web_GetTouchInput(UBYTE aubButtons[WTB_COUNT], FLOAT &fLookX, FLOAT &fLookY, INDEX &iWheel)
{
  float afLook[2];
  iWheel = web_get_touch_input(aubButtons, WTB_COUNT, afLook);
  fLookX = afLook[0];
  fLookY = afLook[1];
}

EM_JS(void, web_get_touch_move, (float *pfMove), {
  const t = Module['webTouch'];
  HEAPF32[pfMove >> 2] = t ? t.moveX : 0;
  HEAPF32[(pfMove >> 2) + 1] = t ? t.moveY : 0;
});

void Web_GetTouchMove(FLOAT &fX, FLOAT &fY)
{
  float afMove[2];
  web_get_touch_move(afMove);
  fX = afMove[0];
  fY = afMove[1];
}

EM_JS(void, web_poll_gamepad, (int bGameInput), {
  // (gamepad.js may not have loaded)
  if (window['GamePad']) {
    window['GamePad']['poll'](Module, !!bGameInput);
  }
});

void Web_PollGamepad(BOOL bGameInput)
{
  web_poll_gamepad(bGameInput);
}

EM_JS(int, web_get_pad_input, (float *pfSticks), {
  const p = Module['webPad'];
  for (let i = 0; i < 4; i++) {
    HEAPF32[(pfSticks >> 2) + i] = p ? [p.moveX, p.moveY, p.lookX, p.lookY][i] : 0;
  }
  return p ? p.buttons : 0;
});

void Web_GetPadInput(ULONG &ulButtons, FLOAT &fMoveX, FLOAT &fMoveY, FLOAT &fLookX, FLOAT &fLookY)
{
  float afSticks[4];
  ulButtons = (ULONG)web_get_pad_input(afSticks);
  fMoveX = afSticks[0];
  fMoveY = afSticks[1];
  fLookX = afSticks[2];
  fLookY = afSticks[3];
}

EM_JS(int, web_aim_assist_device, (), {
  return (Module['webTouch'] || Module['webPadConnected']) ? 1 : 0;
});

BOOL Web_AimAssistDevice(void)
{
  return web_aim_assist_device();
}

EM_JS(float, web_time_since_escape, (), {
  const t = Module['webLastEscape'];
  return t === undefined ? 1e9 : performance.now() - t;
});

FLOAT Web_TimeSinceEscape(void)
{
  return web_time_since_escape();
}

EM_JS(int, web_take_key_press, (), {
  const aKeys = Module['webKeyPresses'];
  return (aKeys && aKeys.length) ? aKeys.shift() : 0;
});

INDEX Web_TakeKeyPress(void)
{
  return web_take_key_press();
}

EM_JS(void, web_set_game_input, (int bGameInput), {
  Module['webGameInput'] = !!bGameInput;
  if (Module['onWebGameInput']) {
    Module['onWebGameInput'](!!bGameInput);
  }
});

void Web_SetGameInput(BOOL bGameInput)
{
  static INDEX _iLast = -1;
  if (_iLast == (INDEX)bGameInput) return;
  _iLast = bGameInput;
  web_set_game_input(bGameInput);
}

static double _dLastYield = 0;

// frame timing statistics (printed when web_bFrameStats is set)
INDEX web_bFrameStats = FALSE;
static double _dStatsStart = 0;
static double _dWorkTime = 0, _dWaitTime = 0, _dMaxWork = 0;
static INDEX _ctStatFrames = 0;
double _dWebSleepTime = 0;

void Web_WaitFrame(void)
{
  const double dBefore = emscripten_get_now();
  web_wait_animation_frame();
  const double dAfter = emscripten_get_now();

  if (web_bFrameStats) {
    const double dWork = dBefore - _dLastYield;
    _dWorkTime += dWork;
    _dWaitTime += dAfter - dBefore;
    if (dWork > _dMaxWork) _dMaxWork = dWork;
    _ctStatFrames++;
    if (dAfter - _dStatsStart > 5000) {
      FLOAT fAudioAvg, fAudioMin;
      INDEX ctUnderruns;
      Web_GetAudioStats(fAudioAvg, fAudioMin, ctUnderruns);
      CPrintF("frames: %d in %.0fms, work avg %.1fms max %.1fms, wait avg %.1fms, sleep %.0fms, "
        "audio buffered avg %.0fms min %.0fms, underruns %d\n",
        _ctStatFrames, dAfter-_dStatsStart, _dWorkTime/_ctStatFrames, _dMaxWork,
        _dWaitTime/_ctStatFrames, _dWebSleepTime, fAudioAvg, fAudioMin, ctUnderruns);
      _dStatsStart = dAfter;
      _dWorkTime = _dWaitTime = _dMaxWork = _dWebSleepTime = 0;
      _ctStatFrames = 0;
    }
  }
  _dLastYield = dAfter;
}
