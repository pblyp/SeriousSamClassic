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

// CDynamicLoader for builds where the game, entities, shaders and sound decoders
// are all linked into the main binary (WebAssembly has no dlopen()).
// Symbols are looked up by name in static tables instead.

#include "Engine/StdH.h"

#include <Engine/Engine.h>
#include <Engine/Base/DynamicLoader.h>
#include <Engine/Base/Emscripten/StaticSymbols.h>

#include <vorbis/vorbisfile.h>
#include <amp11lib/amp11lib.h>

class CGame;
extern "C" CGame *GAME_Create(void);

static void *FindInTable(const SStaticSymbol *pss, const char *strName)
{
  for (; pss->ss_strName != NULL; pss++) {
    if (strcmp(pss->ss_strName, strName) == 0) {
      return pss->ss_pvAddress;
    }
  }
  return NULL;
}

// symbols of libraries that are linked in, but not generated from the entity/shader sources
static void *FindLibrarySymbol(const char *strName)
{
  #define DLLFUNCTION(dll, output, name, inputs, params, required) \
    if (strcmp(strName, #name) == 0) return (void *)&name;
  // vorbisfile
  #include <Engine/Sound/ov_functions.h>
  // amp11lib
  #include <Engine/Sound/al_functions.h>
  #undef DLLFUNCTION

  if (strcmp(strName, "GAME_Create") == 0) return (void *)&GAME_Create;
  return NULL;
}

class CStaticDynamicLoader : public CDynamicLoader
{
public:
  CStaticDynamicLoader(const char *strLibName);
  virtual ~CStaticDynamicLoader(void) {}
  virtual void *FindSymbol(const char *strSymbol);
  virtual const char *GetError(void);

protected:
  BOOL sdl_bAvailable;    // is the requested library linked in
  CTString sdl_strError;  // last error, empty if none
};

CStaticDynamicLoader::CStaticDynamicLoader(const char *strLibName)
{
  // NULL means "the main program"; vorbisfile and amp11lib are linked in as well
  sdl_bAvailable = strLibName == NULL || strcmp(strLibName, "vorbisfile") == 0 || strcmp(strLibName, "amp11lib") == 0;
  if (!sdl_bAvailable) {
    sdl_strError.PrintF("Library '%s' is not available in this build", strLibName);
  }
}

void *CStaticDynamicLoader::FindSymbol(const char *strSymbol)
{
  if (!sdl_bAvailable) {
    return NULL;
  }
  sdl_strError = "";
  void *pv = FindInTable(_assGeneratedSymbols, strSymbol);
  if (pv == NULL) {
    pv = FindLibrarySymbol(strSymbol);
  }
  if (pv == NULL) {
    sdl_strError.PrintF("Symbol '%s' not found", strSymbol);
  }
  return pv;
}

const char *CStaticDynamicLoader::GetError(void)
{
  return (sdl_strError == "") ? NULL : (const char *)sdl_strError;
}

CDynamicLoader *CDynamicLoader::GetInstance(const char *strLibName)
{
  return new CStaticDynamicLoader(strLibName);
}

CTFileName CDynamicLoader::ConvertLibNameToPlatform(const char *strLibName)
{
  return CTString(strLibName);
}
