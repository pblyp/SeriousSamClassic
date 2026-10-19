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

// touch screen controls of the page (web/shell/touch.js), in the same order there
// (the page moves with an analog stick, see Web_GetTouchMove(), not with the movement buttons)
enum WebTouchButton {
  WTB_FORWARD, WTB_BACKWARD, WTB_LEFT, WTB_RIGHT,
  WTB_JUMP, WTB_CROUCH, WTB_FIRE, WTB_USE,
  WTB_COUNT
};
// get the state of the touch buttons, and the look movement (in pixels) and
// weapon changes (+1 previous, -1 next) since the last call
ENGINE_API void Web_GetTouchInput(UBYTE aubButtons[WTB_COUNT], FLOAT &fLookX, FLOAT &fLookY, INDEX &iWheel);
// position of the touch move stick: -1..1 from left to right and from forward to backward
ENGINE_API void Web_GetTouchMove(FLOAT &fX, FLOAT &fY);

// gamepad of the page (web/shell/gamepad.js), read with the browser's Gamepad API:
// called once per frame; while playing it fills the state Web_GetPadInput() reads,
// in menus it presses keys (see Web_TakeKeyPress()) and moves the mouse
ENGINE_API void Web_PollGamepad(BOOL bGameInput);
// the gamepad's buttons, in the order of the browser's standard mapping (bit i: button i)
enum WebPadButton {
  WPB_A, WPB_B, WPB_X, WPB_Y, WPB_LB, WPB_RB, WPB_LT, WPB_RT, WPB_BACK, WPB_START,
  WPB_LSTICK, WPB_RSTICK, WPB_DPAD_UP, WPB_DPAD_DOWN, WPB_DPAD_LEFT, WPB_DPAD_RIGHT,
  WPB_COUNT
};
// the gamepad while playing: buttons held (bits as WebPadButton), and the sticks, each
// -1..1 (left to right, up to down) with the dead zone taken out; all 0 without one
ENGINE_API void Web_GetPadInput(ULONG &ulButtons, FLOAT &fMoveX, FLOAT &fMoveY, FLOAT &fLookX, FLOAT &fLookY);
// whether the player uses touch controls or a gamepad (aim assist is on for them by default)
ENGINE_API BOOL Web_AimAssistDevice(void);

// next key (SDL key code) pressed with the page's on screen buttons, or 0
ENGINE_API INDEX Web_TakeKeyPress(void);

// sound kept ready for the browser since the last call (average and minimum),
// and how many times the browser found none
ENGINE_API void Web_GetAudioStats(FLOAT &fAverageMs, FLOAT &fMinMs, INDEX &ctUnderruns);

// milliseconds since the page last saw the Escape key (pressed or released), a large number if never
ENGINE_API FLOAT Web_TimeSinceEscape(void);

// tell the page whether the game is taking input (playing), or menus are up
ENGINE_API void Web_SetGameInput(BOOL bGameInput);

#endif  /* include-once check. */
