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

// OpenGL driver for the web: SDL creates a WebGL 2 context, and the OpenGL 1.x
// functions the engine calls are emulated on top of it (see GL1Emulation.cpp).

#include <Engine/Engine.h>
#include <Engine/Graphics/Emscripten/GL1Emulation.h>
#include "SDL.h"

static void sdlCheckError(BOOL bRes, const char *strDescription)
{
  if( bRes) return;
  const char *sdlError = SDL_GetError();
  if( !sdlError) return; // ignore stupid 'successful' error
  WarningMessage("%s: %s", strDescription, sdlError);
}

static void ReportUnimplemented(const char *strName)
{
  static CTString _strReported;
  const CTString strTag = CTString(" ") + strName + " ";
  if (strstr(_strReported, strTag) != NULL) return;
  _strReported += strTag;
  CPrintF("WebGL: %s is not implemented\n", strName);
}

// functions that the emulation doesn't provide report themselves when they get called
#define DLLFUNCTION(dll, output, name, inputs, params, required) \
  static output stub_##name inputs { ReportUnimplemented(#name); return (output)0; }
#include "Engine/Graphics/gl_functions.h"
#undef DLLFUNCTION

static void OGL_SetFunctionPointers_t(HINSTANCE hiOGL)
{
  #define DLLFUNCTION(dll, output, name, inputs, params, required) \
    p##name = (output (__stdcall*) inputs) WebGL_GetProcAddress(#name); \
    if( p##name == NULL) p##name = &stub_##name;
  #include "Engine/Graphics/gl_functions.h"
  #undef DLLFUNCTION
}

BOOL CGfxLibrary::InitDriver_OGL(BOOL init3dfx)
{
  ASSERT( gl_hiDriver==NONE);  // there is no library to load
  return TRUE;
}


void CGfxLibrary::PlatformEndDriver_OGL(void)
{
  // shut the driver down
  SDL_GL_MakeCurrent(NULL, NULL);
  if (go_hglRC) {
    SDL_GL_DeleteContext(go_hglRC);
    go_hglRC = NULL;
  }
}

// creates OpenGL drawing context
BOOL CGfxLibrary::CreateContext_OGL(HDC hdc)
{
  SDL_Window *window = (SDL_Window *) hdc;
  if( !SetupPixelFormat_OGL( hdc, TRUE)) return FALSE;
  go_hglRC = SDL_GL_CreateContext(window);
  if( go_hglRC==NULL) {
    sdlCheckError(0, "WebGL context creation");
    return FALSE;
  }
  if (SDL_GL_MakeCurrent(window, go_hglRC) == -1) {
    sdlCheckError(0, "MakeCurrent after CreateContext");
    return FALSE;
  }
  int val = 0;
  if (SDL_GL_GetAttribute(SDL_GL_DEPTH_SIZE, &val) != -1) {  // keep depth bits
    gl_iCurrentDepth = val;
  } else {
    gl_iCurrentDepth = 24;
  }

  // prepare functions
  WebGL_InitContext();
  OGL_SetFunctionPointers_t(gl_hiDriver);

  return TRUE;
}

void *CGfxLibrary::OGL_GetProcAddress(const char *procname)
{
  return WebGL_GetProcAddress(procname);
}

// prepares pixel format for OpenGL context
BOOL CGfxLibrary::SetupPixelFormat_OGL( HDC hdc, BOOL bReport/*=FALSE*/)
{
  // WebGL 2 is OpenGL ES 3.0
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);

  // the canvas is always 24-bit color with 24-bit depth; no alpha, so the page doesn't show through
  extern INDEX gap_iDepthBits;
  extern INDEX gap_iStencilBits;
  gap_iDepthBits = 24;
  gap_iStencilBits = 0;
  SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 0);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
  SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 0);
  return TRUE;
}

// prepare current viewport for rendering thru OpenGL
BOOL CGfxLibrary::SetCurrentViewport_OGL(CViewPort *pvp)
{
  // if must init entire opengl
  if( gl_ulFlags & GLF_INITONNEXTWINDOW)
  {
    gl_ulFlags &= ~GLF_INITONNEXTWINDOW;
    // reopen window
    pvp->CloseCanvas();
    pvp->OpenCanvas();
    // init now
    if( !CreateContext_OGL((HDC) pvp->vp_hWnd)) return FALSE;
    gl_pvpActive = pvp; // remember as current viewport (must do that BEFORE InitContext)
    InitContext_OGL();
    gl_ulFlags |=  GLF_HASACCELERATION;
    pvp->vp_ctDisplayChanges = gl_ctDriverChanges;
    return TRUE;
  }

  // if window was not set for this driver
  if( pvp->vp_ctDisplayChanges<gl_ctDriverChanges)
  {
    // reopen window
    pvp->CloseCanvas();
    pvp->OpenCanvas();

    // set it
    pvp->vp_ctDisplayChanges = gl_ctDriverChanges;
  }

  // remember as current window
  gl_pvpActive = pvp;
  return TRUE;
}
