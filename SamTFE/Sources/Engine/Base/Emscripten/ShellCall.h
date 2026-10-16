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

#ifndef SE_INCL_SHELLCALL_H
#define SE_INCL_SHELLCALL_H
#ifdef PRAGMA_ONCE
  #pragma once
#endif

// Calls a function declared to the shell with its real signature.
//
// WebAssembly checks the signature of every indirect call, so the shell can't
// call all functions through one generic function pointer type. At the machine
// level every shell argument is either a 32-bit integer (INDEX, or a pointer to
// a CTString) or a FLOAT, so the right function type is built from a bit mask
// that tells which arguments are floats.

#include <string.h>

#define SHELLCALL_MAXARGS 5

template<typename R, int N, typename... A>
struct CShellCaller {
  static R Call(void *pvFunction, ULONG ulFloatMask, const ULONG *pulArgs, A... a) {
    const int iArg = sizeof...(A);
    if (ulFloatMask & (1UL<<iArg)) {
      FLOAT f;
      memcpy(&f, pulArgs+iArg, sizeof(f));
      return CShellCaller<R, N-1, A..., FLOAT>::Call(pvFunction, ulFloatMask, pulArgs, a..., f);
    }
    return CShellCaller<R, N-1, A..., ULONG>::Call(pvFunction, ulFloatMask, pulArgs, a..., pulArgs[iArg]);
  }
};

template<typename R, typename... A>
struct CShellCaller<R, 0, A...> {
  static R Call(void *pvFunction, ULONG ulFloatMask, const ULONG *pulArgs, A... a) {
    return ((R (*)(A...))pvFunction)(a...);
  }
};

// ctArgs arguments are in pulArgs, bit i of ulFloatMask is set if argument i is a FLOAT
template<typename R>
inline R ShellCall(void *pvFunction, INDEX ctArgs, ULONG ulFloatMask, const ULONG *pulArgs)
{
  switch (ctArgs) {
  case 0:  return CShellCaller<R, 0>::Call(pvFunction, ulFloatMask, pulArgs);
  case 1:  return CShellCaller<R, 1>::Call(pvFunction, ulFloatMask, pulArgs);
  case 2:  return CShellCaller<R, 2>::Call(pvFunction, ulFloatMask, pulArgs);
  case 3:  return CShellCaller<R, 3>::Call(pvFunction, ulFloatMask, pulArgs);
  case 4:  return CShellCaller<R, 4>::Call(pvFunction, ulFloatMask, pulArgs);
  default: return CShellCaller<R, 5>::Call(pvFunction, ulFloatMask, pulArgs);
  }
}

#endif  /* include-once check. */
