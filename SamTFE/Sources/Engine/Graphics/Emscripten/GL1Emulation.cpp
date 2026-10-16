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

// Emulation of the OpenGL 1.x subset that the engine uses, on top of WebGL 2.
//
// The engine talks to OpenGL only through the pgl* function pointers, so the
// fixed function state (matrices, texture environment, alpha test, clip plane,
// client side vertex arrays, immediate mode) is kept here in C++ and turned into
// generated shaders, uniforms and streamed vertex buffers at draw time.
//
// This file deliberately doesn't include engine headers: the engine's GL type
// and enum definitions would clash with the GLES 3 headers.

#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <emscripten.h>
#include <emscripten/html5_webgl.h>

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <unordered_map>

#include "GL1Emulation.h"

typedef double GLdouble;
typedef double GLclampd;

// OpenGL 1.x enums that GLES doesn't have
#define GL1_QUADS                        0x0007
#define GL1_QUAD_STRIP                   0x0008
#define GL1_POLYGON                      0x0009
#define GL1_ALPHA_TEST                   0x0BC0
#define GL1_CLIP_PLANE0                  0x3000
#define GL1_MODELVIEW                    0x1700
#define GL1_PROJECTION                   0x1701
#define GL1_TEXTURE                      0x1702
#define GL1_VERTEX_ARRAY                 0x8074
#define GL1_NORMAL_ARRAY                 0x8075
#define GL1_COLOR_ARRAY                  0x8076
#define GL1_TEXTURE_COORD_ARRAY          0x8078
#define GL1_TEXTURE_ENV                  0x2300
#define GL1_TEXTURE_ENV_MODE             0x2200
#define GL1_TEXTURE_ENV_COLOR            0x2201
#define GL1_MODULATE                     0x2100
#define GL1_DECAL                        0x2101
#define GL1_ADD                          0x0104
#define GL1_COMBINE                      0x8570
#define GL1_COMBINE_RGB                  0x8571
#define GL1_COMBINE_ALPHA                0x8572
#define GL1_RGB_SCALE                    0x8573
#define GL1_ALPHA_SCALE                  0x0D1C
#define GL1_TEXTURE_FILTER_CONTROL       0x8500
#define GL1_TEXTURE_LOD_BIAS             0x8501
#define GL1_MAX_TEXTURE_LOD_BIAS         0x84FD
#define GL1_CLAMP                        0x2900
#define GL1_MAX_TEXTURE_UNITS            0x84E2
#define GL1_CLIENT_ACTIVE_TEXTURE        0x84E1
#define GL1_POLYGON_OFFSET_POINT         0x2A01
#define GL1_POLYGON_OFFSET_LINE          0x2A02
#define GL1_POINT                        0x1B00
#define GL1_LINE                         0x1B01
#define GL1_FILL                         0x1B02
#define GL1_LUMINANCE8                   0x8040
#define GL1_LUMINANCE8_ALPHA8            0x8045
#define GL1_RGB4                         0x804F
#define GL1_RGB5                         0x8050
#define GL1_COMPRESSED_RGB               0x84ED
#define GL1_COMPRESSED_RGBA              0x84EE
#define GL1_COMPRESSED_RGB_S3TC_DXT1     0x83F0
#define GL1_COMPRESSED_RGBA_S3TC_DXT1    0x83F1
#define GL1_COMPRESSED_RGBA_S3TC_DXT3    0x83F2
#define GL1_COMPRESSED_RGBA_S3TC_DXT5    0x83F3
#define GL1_TEXTURE_WIDTH                0x1000
#define GL1_TEXTURE_HEIGHT               0x1001
#define GL1_TEXTURE_INTERNAL_FORMAT      0x1003
#define GL1_TEXTURE_RED_SIZE             0x805C
#define GL1_TEXTURE_GREEN_SIZE           0x805D
#define GL1_TEXTURE_BLUE_SIZE            0x805E
#define GL1_TEXTURE_ALPHA_SIZE           0x805F
#define GL1_TEXTURE_COMPRESSED_IMAGE_SIZE 0x86A0
#define GL1_TEXTURE_COMPRESSED           0x86A1
#define GL1_ARRAY_ELEMENT_LOCK_COUNT     0x81A9
#define GL1_DEPTH_RANGE                  0x0B70
#define GL1_BLEND_SRC                    0x0BE1
#define GL1_BLEND_DST                    0x0BE0
#define GL1_TEXTURE_MAX_ANISOTROPY       0x84FE
#define GL1_MAX_TEXTURE_MAX_ANISOTROPY   0x84FF

#define MAX_UNITS 4

// attribute locations
enum { ATTR_POS = 0, ATTR_COLOR = 1, ATTR_TC0 = 2, ATTR_COUNT = ATTR_TC0+MAX_UNITS };

// texture combine modes, as used in shader keys
enum TexMode {
  TM_MODULATE   = 0,
  TM_MODULATE2X = 1,
  TM_BLEND      = 2,
  TM_REPLACE    = 3,
  TM_ADD        = 4,
  TM_DECAL      = 5,
};

static void Warn(const char *strFormat, ...) __attribute__((format(printf, 1, 2)));
static void Warn(const char *strFormat, ...)
{
  char str[512];
  va_list arg;
  va_start(arg, strFormat);
  vsnprintf(str, sizeof(str), strFormat, arg);
  va_end(arg);
  // report each distinct warning only once
  static std::vector<std::string> _astrSeen;
  for (size_t i = 0; i < _astrSeen.size(); i++) {
    if (_astrSeen[i] == str) return;
  }
  _astrSeen.push_back(str);
  fprintf(stderr, "WebGL: %s\n", str);
}

// ------------------------------------------------------------------- matrices

struct Mat4 {
  float m[16];  // column major, like OpenGL
};

static void MatIdentity(Mat4 &r)
{
  memset(r.m, 0, sizeof(r.m));
  r.m[0] = r.m[5] = r.m[10] = r.m[15] = 1.0f;
}

static void MatMul(Mat4 &r, const Mat4 &a, const Mat4 &b)
{
  Mat4 t;
  for (int c = 0; c < 4; c++) {
    for (int row = 0; row < 4; row++) {
      t.m[c*4+row] = a.m[0*4+row]*b.m[c*4+0] + a.m[1*4+row]*b.m[c*4+1]
                   + a.m[2*4+row]*b.m[c*4+2] + a.m[3*4+row]*b.m[c*4+3];
    }
  }
  r = t;
}

static bool MatInverse(Mat4 &r, const Mat4 &mat)
{
  const float *m = mat.m;
  float inv[16];
  inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8]  =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9]  = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] =  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2]  =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
  inv[6]  = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
  inv[10] =  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];
  inv[3]  = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7]   + m[9]*m[3]*m[6];
  inv[7]  =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7]   - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8]*m[1]*m[7]   + m[8]*m[3]*m[5];
  inv[15] =  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8]*m[1]*m[6]   - m[8]*m[2]*m[5];
  float det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (det == 0) {
    return false;
  }
  det = 1.0f/det;
  for (int i = 0; i < 16; i++) {
    r.m[i] = inv[i]*det;
  }
  return true;
}

// --------------------------------------------------------------------- state

struct ArrayPointer {
  bool bEnabled;
  GLint iSize;
  GLenum eType;
  GLsizei iStride;
  const void *pvData;
};

struct TexUnit {
  bool bTexture2D;        // GL_TEXTURE_2D enabled
  GLuint uiBound;         // bound texture
  GLenum eEnvMode;
  GLenum eCombineRGB;
  GLenum eCombineAlpha;
  float fRGBScale;
  float fAlphaScale;
  float afEnvColor[4];
  float fLODBias;
  Mat4 mMatrix;
  unsigned uMatrixVersion;
  ArrayPointer apTexCoords;
  float afTexCoord[4];    // current texture coordinate (immediate mode / no array)
};

struct ImmVertex {
  float afPos[4];
  float afColor[4];
  float afTexCoord[4];
};

struct TexInfo {
  GLsizei iWidth, iHeight;
  GLenum eInternalFormat;  // as requested by the engine
  GLint iMaxLevel;         // last mip level that is defined
  bool bDefined;
};

static struct State {
  bool bInitialized;

  // matrices
  GLenum eMatrixMode;
  Mat4 mModelView;
  Mat4 mProjection;
  unsigned uModelViewVersion;
  unsigned uProjectionVersion;

  // texturing
  TexUnit atu[MAX_UNITS];
  int iActiveUnit;
  int iClientUnit;

  // vertex arrays
  ArrayPointer apVertex;
  ArrayPointer apColor;
  float afColor[4];
  bool bLocked;
  GLint iLockFirst;
  GLsizei ctLockCount;
  unsigned uLockGeneration;

  // emulated per fragment state
  bool bAlphaTest;
  GLenum eAlphaFunc;
  float fAlphaRef;
  bool bClipPlane;
  float afClipPlane[4];  // in eye space
  unsigned uClipVersion;
  GLenum ePolygonMode;
  float fPointSize;

  // immediate mode
  bool bInBeginEnd;
  GLenum eBeginMode;
  std::vector<ImmVertex> aimm;

  // real WebGL state that is cached here
  bool bBlend, bDepthTest, bCullFace, bScissorTest, bPolygonOffsetFill, bDither;
  GLenum eBlendSrc, eBlendDst, eDepthFunc, eCullFace, eFrontFace;
  GLboolean bDepthMask;
  GLboolean abColorMask[4];
  float fDepthNear, fDepthFar;
  GLint aiViewport[4];
  GLint aiScissor[4];
  bool abAttribArray[ATTR_COUNT];
  float aafAttribValue[ATTR_COUNT][4];
  GLuint uiProgram;

  // limits
  GLint iMaxTextureSize;
  bool bAnisotropy;
  GLint iMaxAnisotropy;
  float fMaxLODBias;

  std::unordered_map<GLuint, TexInfo> mapTextures;
} S;

// ---------------------------------------------------------- streaming buffers

// Vertex data is streamed with glBufferData into a rotating pool of buffers.
// Writing into a buffer that the GPU may still be reading (glBufferSubData into
// a ring buffer) makes some WebGL implementations copy the whole buffer, while
// replacing a buffer's contents completely never has to wait or copy.
struct BufferPool {
  GLenum eTarget;
  std::vector<GLuint> auiBuffers;
  size_t iNext;
};

#define POOL_SIZE 1024
static BufferPool _bpVertices = { GL_ARRAY_BUFFER, std::vector<GLuint>(), 0 };
static BufferPool _bpIndices  = { GL_ELEMENT_ARRAY_BUFFER, std::vector<GLuint>(), 0 };
static BufferPool _bpLocked   = { GL_ARRAY_BUFFER, std::vector<GLuint>(), 0 };
static GLuint _uiVAO = 0;

static void PoolCreate(BufferPool &bp, size_t ctBuffers)
{
  bp.auiBuffers.resize(ctBuffers);
  glGenBuffers((GLsizei)ctBuffers, &bp.auiBuffers[0]);
  bp.iNext = 0;
}

// upload data into the next buffer of the pool (leaves it bound) and return the buffer
static GLuint PoolUpload(BufferPool &bp, const void *pvData, GLsizeiptr slBytes)
{
  const GLuint uiBuffer = bp.auiBuffers[bp.iNext];
  bp.iNext = (bp.iNext + 1) % bp.auiBuffers.size();
  glBindBuffer(bp.eTarget, uiBuffer);
  glBufferData(bp.eTarget, slBytes, pvData, GL_STREAM_DRAW);
  return uiBuffer;
}

// ------------------------------------------------------------------- shaders

struct Program {
  GLuint uiProgram;
  bool bReady;  // linked and uniform locations known
  GLint iMVP, iModelView, iClipPlane, iPointSize, iAlphaRef;
  GLint aiTexMatrix[MAX_UNITS];
  GLint aiLODBias[MAX_UNITS];
  GLint aiEnvColor[MAX_UNITS];
  // versions of the uniform values last set to this program
  unsigned uMVPVersion, uModelViewVersion, uClipVersion;
  unsigned auTexMatrixVersion[MAX_UNITS];
  float afLODBias[MAX_UNITS];
  float aafEnvColor[MAX_UNITS][4];
  float fPointSize;
  float fAlphaRef;
};

static std::unordered_map<unsigned, Program> _mapPrograms;
static Mat4 _mMVP;
static unsigned _uMVPVersion = 1;
static unsigned _uMVPFromModelView = 0;
static unsigned _uMVPFromProjection = 0;
static unsigned _uVersionCounter = 100;

static GLuint CompileShader(GLenum eType, const std::string &strSource)
{
  GLuint ui = glCreateShader(eType);
  const char *pch = strSource.c_str();
  glShaderSource(ui, 1, &pch, NULL);
  glCompileShader(ui);
  GLint iOK = 0;
  glGetShaderiv(ui, GL_COMPILE_STATUS, &iOK);
  if (!iOK) {
    char strLog[2048];
    glGetShaderInfoLog(ui, sizeof(strLog), NULL, strLog);
    fprintf(stderr, "WebGL: shader compile error:\n%s\n%s\n", strLog, strSource.c_str());
  }
  return ui;
}

static const char *TexModeName(int iMode)
{
  switch (iMode) {
  case TM_MODULATE:   return "modulate";
  case TM_MODULATE2X: return "modulate2x";
  case TM_BLEND:      return "blend";
  case TM_REPLACE:    return "replace";
  case TM_ADD:        return "add";
  case TM_DECAL:      return "decal";
  }
  return "?";
}

// shader key: bits 0-3 unit enabled, 4-15 combine mode of each unit (3 bits), 16 alpha test, 17 clip plane
#define KEY_UNIT(i)        (1u<<(i))
#define KEY_MODE_SHIFT(i)  (4+(i)*3)
#define KEY_ALPHATEST      (1u<<16)
#define KEY_CLIPPLANE      (1u<<17)

// create and link the program for a shader key (without waiting for the result,
// so the browser can compile it in the background)
static Program &StartProgram(unsigned uKey)
{
  const bool bClip = (uKey & KEY_CLIPPLANE) != 0;
  const bool bAlphaTest = (uKey & KEY_ALPHATEST) != 0;

  std::string strVS =
    "#version 300 es\n"
    "in vec4 a_pos;\n"
    "in vec4 a_color;\n"
    "uniform mat4 u_mvp;\n"
    "uniform float u_pointSize;\n"
    "out vec4 v_color;\n";
  std::string strFS =
    "#version 300 es\n"
    "precision highp float;\n"
    "in vec4 v_color;\n"
    "out vec4 o_color;\n";
  std::string strVSMain =
    "void main() {\n"
    "  gl_Position = u_mvp * a_pos;\n"
    "  gl_PointSize = u_pointSize;\n"
    "  v_color = a_color;\n";
  std::string strFSMain =
    "void main() {\n"
    "  vec4 c = v_color;\n"
    "  vec4 t;\n";
  if (bClip) {
    strVS += "uniform mat4 u_modelView;\nuniform vec4 u_clipPlane;\nout float v_clip;\n";
    strVSMain += "  v_clip = dot(u_clipPlane, u_modelView * a_pos);\n";
    strFS += "in float v_clip;\n";
    strFSMain += "  if (v_clip < 0.0) discard;\n";
  }
  for (int i = 0; i < MAX_UNITS; i++) {
    if (!(uKey & KEY_UNIT(i))) continue;
    const int iMode = (uKey >> KEY_MODE_SHIFT(i)) & 7;
    char str[1024];
    snprintf(str, sizeof(str),
      "in vec4 a_tc%d;\nuniform mat4 u_texMatrix%d;\nout vec4 v_tc%d;\n", i, i, i);
    strVS += str;
    snprintf(str, sizeof(str), "  v_tc%d = u_texMatrix%d * a_tc%d;\n", i, i, i);
    strVSMain += str;
    snprintf(str, sizeof(str),
      "in vec4 v_tc%d;\nuniform sampler2D u_tex%d;\nuniform float u_lodBias%d;\n", i, i, i);
    strFS += str;
    if (iMode == TM_BLEND) {
      snprintf(str, sizeof(str), "uniform vec4 u_envColor%d;\n", i);
      strFS += str;
    }
    // projective texture lookup (q is 1 for ordinary 2D coordinates)
    snprintf(str, sizeof(str), "  t = textureProj(u_tex%d, v_tc%d.xyw, u_lodBias%d);  // %s\n",
      i, i, i, TexModeName(iMode));
    strFSMain += str;
    switch (iMode) {
    case TM_MODULATE:   strFSMain += "  c *= t;\n"; break;
    case TM_MODULATE2X: strFSMain += "  c = vec4(clamp(c.rgb * t.rgb * 2.0, 0.0, 1.0), c.a * t.a);\n"; break;
    case TM_REPLACE:    strFSMain += "  c = t;\n"; break;
    case TM_ADD:        strFSMain += "  c = vec4(clamp(c.rgb + t.rgb, 0.0, 1.0), c.a * t.a);\n"; break;
    case TM_DECAL:      strFSMain += "  c = vec4(mix(c.rgb, t.rgb, t.a), c.a);\n"; break;
    case TM_BLEND:
      snprintf(str, sizeof(str), "  c = vec4(mix(c.rgb, u_envColor%d.rgb, t.rgb), c.a * t.a);\n", i);
      strFSMain += str;
      break;
    }
  }
  if (bAlphaTest) {
    strFS += "uniform float u_alphaRef;\n";
    strFSMain += "  if (c.a < u_alphaRef) discard;\n";
  }
  strVS += strVSMain + "}\n";
  strFS += strFSMain + "  o_color = c;\n}\n";

  GLuint uiVS = CompileShader(GL_VERTEX_SHADER, strVS);
  GLuint uiFS = CompileShader(GL_FRAGMENT_SHADER, strFS);
  GLuint uiProgram = glCreateProgram();
  glAttachShader(uiProgram, uiVS);
  glAttachShader(uiProgram, uiFS);
  glBindAttribLocation(uiProgram, ATTR_POS, "a_pos");
  glBindAttribLocation(uiProgram, ATTR_COLOR, "a_color");
  for (int i = 0; i < MAX_UNITS; i++) {
    char str[16];
    snprintf(str, sizeof(str), "a_tc%d", i);
    glBindAttribLocation(uiProgram, ATTR_TC0+i, str);
  }
  glLinkProgram(uiProgram);
  glDeleteShader(uiVS);
  glDeleteShader(uiFS);

  Program &pr = _mapPrograms[uKey];
  memset(&pr, 0, sizeof(pr));
  pr.uiProgram = uiProgram;
  return pr;
}

// get ready to use a program (waits for it to be linked)
static void FinishProgram(Program &pr, unsigned uKey)
{
  const double dStart = emscripten_get_now();
  const GLuint uiProgram = pr.uiProgram;
  GLint iOK = 0;
  glGetProgramiv(uiProgram, GL_LINK_STATUS, &iOK);
  if (!iOK) {
    char strLog[2048];
    glGetProgramInfoLog(uiProgram, sizeof(strLog), NULL, strLog);
    fprintf(stderr, "WebGL: program link error: %s\n", strLog);
  }
  pr.iMVP = glGetUniformLocation(uiProgram, "u_mvp");
  pr.iModelView = glGetUniformLocation(uiProgram, "u_modelView");
  pr.iClipPlane = glGetUniformLocation(uiProgram, "u_clipPlane");
  pr.iPointSize = glGetUniformLocation(uiProgram, "u_pointSize");
  pr.iAlphaRef = glGetUniformLocation(uiProgram, "u_alphaRef");
  pr.fPointSize = -1;
  pr.fAlphaRef = -1;
  glUseProgram(uiProgram);
  S.uiProgram = uiProgram;
  for (int i = 0; i < MAX_UNITS; i++) {
    char str[32];
    snprintf(str, sizeof(str), "u_texMatrix%d", i);
    pr.aiTexMatrix[i] = glGetUniformLocation(uiProgram, str);
    snprintf(str, sizeof(str), "u_lodBias%d", i);
    pr.aiLODBias[i] = glGetUniformLocation(uiProgram, str);
    snprintf(str, sizeof(str), "u_envColor%d", i);
    pr.aiEnvColor[i] = glGetUniformLocation(uiProgram, str);
    snprintf(str, sizeof(str), "u_tex%d", i);
    GLint iSampler = glGetUniformLocation(uiProgram, str);
    if (iSampler >= 0) {
      glUniform1i(iSampler, i);
    }
    pr.afLODBias[i] = -1000;
    pr.aafEnvColor[i][0] = -1;
  }
  pr.bReady = true;
  const double dTime = emscripten_get_now()-dStart;
  if (dTime > 50) {
    fprintf(stderr, "WebGL: shader 0x%05x took %.0fms to compile\n", uKey, dTime);
  }
}

static Program &GetProgram(unsigned uKey)
{
  std::unordered_map<unsigned, Program>::iterator it = _mapPrograms.find(uKey);
  Program &pr = (it != _mapPrograms.end()) ? it->second : StartProgram(uKey);
  if (!pr.bReady) {
    FinishProgram(pr, uKey);
  }
  return pr;
}

// shader variants the game is known to use (see GetProgram), compiled up front
static const unsigned _auCommonKeys[] = {
  0x00000, 0x00001, 0x00083, 0x00487, 0x0248f, 0x10001,
  0x20001, 0x20083, 0x20487, 0x2248f, 0x30001,
};


// ----------------------------------------------------------------- helpers

static TexInfo *FindTexInfo(GLuint uiTex)
{
  if (uiTex == 0) return NULL;
  std::unordered_map<GLuint, TexInfo>::iterator it = S.mapTextures.find(uiTex);
  return it == S.mapTextures.end() ? NULL : &it->second;
}

static Mat4 &CurrentMatrix(void)
{
  switch (S.eMatrixMode) {
  case GL1_PROJECTION: return S.mProjection;
  case GL1_TEXTURE:    return S.atu[S.iActiveUnit].mMatrix;
  default:             return S.mModelView;
  }
}

static void MatrixChanged(void)
{
  switch (S.eMatrixMode) {
  case GL1_PROJECTION: S.uProjectionVersion = ++_uVersionCounter; break;
  case GL1_TEXTURE:    S.atu[S.iActiveUnit].uMatrixVersion = ++_uVersionCounter; break;
  default:             S.uModelViewVersion = ++_uVersionCounter; break;
  }
}

static void MultCurrent(const Mat4 &m)
{
  Mat4 &cur = CurrentMatrix();
  MatMul(cur, cur, m);
  MatrixChanged();
}

static void SetCap(GLenum eCap, bool &bCached, bool bEnable)
{
  if (bCached == bEnable) return;
  bCached = bEnable;
  if (bEnable) glEnable(eCap);
  else glDisable(eCap);
}

static void SetAttribArray(int iAttr, bool bEnable)
{
  if (S.abAttribArray[iAttr] == bEnable) return;
  S.abAttribArray[iAttr] = bEnable;
  if (bEnable) glEnableVertexAttribArray(iAttr);
  else glDisableVertexAttribArray(iAttr);
}

static void SetAttribValue(int iAttr, const float *pf)
{
  SetAttribArray(iAttr, false);
  float *pfOld = S.aafAttribValue[iAttr];
  if (pfOld[0] == pf[0] && pfOld[1] == pf[1] && pfOld[2] == pf[2] && pfOld[3] == pf[3]) return;
  memcpy(pfOld, pf, sizeof(float)*4);
  glVertexAttrib4fv(iAttr, pf);
}

static int TexMode(const TexUnit &tu)
{
  switch (tu.eEnvMode) {
  case GL1_MODULATE: return TM_MODULATE;
  case GL_BLEND:     return TM_BLEND;
  case GL_REPLACE:   return TM_REPLACE;
  case GL1_ADD:      return TM_ADD;
  case GL1_DECAL:    return TM_DECAL;
  case GL1_COMBINE:
    if (tu.eCombineRGB == GL1_MODULATE) return tu.fRGBScale > 1.5f ? TM_MODULATE2X : TM_MODULATE;
    if (tu.eCombineRGB == GL_REPLACE) return TM_REPLACE;
    if (tu.eCombineRGB == GL1_ADD) return TM_ADD;
    Warn("unsupported combine mode 0x%x", tu.eCombineRGB);
    return TM_MODULATE;
  }
  Warn("unsupported texture env mode 0x%x", tu.eEnvMode);
  return TM_MODULATE;
}

static size_t TypeSize(GLenum eType)
{
  switch (eType) {
  case GL_UNSIGNED_BYTE: case GL_BYTE: return 1;
  case GL_UNSIGNED_SHORT: case GL_SHORT: return 2;
  default: return 4;
  }
}

// ------------------------------------------------------------------- drawing

// where the vertex data of a draw comes from
struct DrawSources {
  const ArrayPointer *papPos;
  const ArrayPointer *papColor;
  const ArrayPointer *apapTexCoord[MAX_UNITS];
};

// positions uploaded while arrays are locked (compiled vertex arrays), reused by later passes
struct LockedUpload {
  const void *pvData;
  GLint iSize;
  GLenum eType;
  GLsizei iStride;
  GLint iFirst;
  GLint iLast;
  GLuint uiBuffer;
};
static std::vector<LockedUpload> _aluLocked;

static std::vector<GLuint> _auiIndices;

// vertex data of one draw, packed together for one upload
static std::vector<GLubyte> _aubStaging;

struct AttributeUpload {
  int iAttr;
  const ArrayPointer *pap;
  GLsizei iStride;
  size_t slOffset;   // in the staging buffer, or -1 if in a locked buffer
  GLuint uiLockedBuffer;
};

// add one attribute's data for vertices iFirst..iLast to the staging buffer
static void StageAttribute(AttributeUpload &au, int iAttr, const ArrayPointer &ap, GLint iFirst, GLint iLast)
{
  const GLsizei iElementSize = ap.iSize * (GLsizei)TypeSize(ap.eType);
  au.iAttr = iAttr;
  au.pap = &ap;
  au.iStride = ap.iStride ? ap.iStride : iElementSize;
  au.uiLockedBuffer = 0;
  au.slOffset = 0;
  const char *pchStart = (const char *)ap.pvData + (size_t)iFirst * au.iStride;
  const size_t slBytes = (size_t)(iLast - iFirst) * au.iStride + iElementSize;

  // positions of locked arrays are uploaded once into their own buffer
  if (S.bLocked && iAttr == ATTR_POS) {
    for (size_t i = 0; i < _aluLocked.size(); i++) {
      const LockedUpload &lu = _aluLocked[i];
      if (lu.pvData == ap.pvData && lu.iSize == ap.iSize && lu.eType == ap.eType && lu.iStride == au.iStride
       && lu.iFirst == iFirst && lu.iLast == iLast) {
        au.uiLockedBuffer = lu.uiBuffer;
        return;
      }
    }
    LockedUpload lu = { ap.pvData, ap.iSize, ap.eType, au.iStride, iFirst, iLast, 0 };
    lu.uiBuffer = PoolUpload(_bpLocked, pchStart, slBytes);
    _aluLocked.push_back(lu);
    au.uiLockedBuffer = lu.uiBuffer;
    return;
  }

  // keep the data 4-byte aligned
  au.slOffset = (_aubStaging.size() + 3) & ~(size_t)3;
  _aubStaging.resize(au.slOffset + slBytes);
  memcpy(&_aubStaging[au.slOffset], pchStart, slBytes);
}

static void SetAttributePointer(const AttributeUpload &au, GLuint uiBuffer)
{
  const ArrayPointer &ap = *au.pap;
  const GLboolean bNormalize = (ap.eType == GL_UNSIGNED_BYTE) ? GL_TRUE : GL_FALSE;
  SetAttribArray(au.iAttr, true);
  if (au.uiLockedBuffer != 0) {
    glBindBuffer(GL_ARRAY_BUFFER, au.uiLockedBuffer);
    glVertexAttribPointer(au.iAttr, ap.iSize, ap.eType, bNormalize, au.iStride, (const void *)0);
  } else {
    glBindBuffer(GL_ARRAY_BUFFER, uiBuffer);
    glVertexAttribPointer(au.iAttr, ap.iSize, ap.eType, bNormalize, au.iStride, (const void *)au.slOffset);
  }
}

static void UpdateUniforms(Program &pr, unsigned uKey)
{
  // combined model-view-projection matrix
  if (_uMVPFromModelView != S.uModelViewVersion || _uMVPFromProjection != S.uProjectionVersion) {
    MatMul(_mMVP, S.mProjection, S.mModelView);
    _uMVPFromModelView = S.uModelViewVersion;
    _uMVPFromProjection = S.uProjectionVersion;
    _uMVPVersion = ++_uVersionCounter;
  }
  if (pr.uMVPVersion != _uMVPVersion) {
    pr.uMVPVersion = _uMVPVersion;
    glUniformMatrix4fv(pr.iMVP, 1, GL_FALSE, _mMVP.m);
  }
  if (uKey & KEY_CLIPPLANE) {
    if (pr.uModelViewVersion != S.uModelViewVersion) {
      pr.uModelViewVersion = S.uModelViewVersion;
      glUniformMatrix4fv(pr.iModelView, 1, GL_FALSE, S.mModelView.m);
    }
    if (pr.uClipVersion != S.uClipVersion) {
      pr.uClipVersion = S.uClipVersion;
      glUniform4fv(pr.iClipPlane, 1, S.afClipPlane);
    }
  }
  if ((uKey & KEY_ALPHATEST) && pr.fAlphaRef != S.fAlphaRef) {
    pr.fAlphaRef = S.fAlphaRef;
    glUniform1f(pr.iAlphaRef, S.fAlphaRef);
  }
  if (pr.fPointSize != S.fPointSize) {
    pr.fPointSize = S.fPointSize;
    glUniform1f(pr.iPointSize, S.fPointSize);
  }
  for (int i = 0; i < MAX_UNITS; i++) {
    if (!(uKey & KEY_UNIT(i))) continue;
    const TexUnit &tu = S.atu[i];
    if (pr.auTexMatrixVersion[i] != tu.uMatrixVersion) {
      pr.auTexMatrixVersion[i] = tu.uMatrixVersion;
      glUniformMatrix4fv(pr.aiTexMatrix[i], 1, GL_FALSE, tu.mMatrix.m);
    }
    if (pr.afLODBias[i] != tu.fLODBias) {
      pr.afLODBias[i] = tu.fLODBias;
      glUniform1f(pr.aiLODBias[i], tu.fLODBias);
    }
    if (pr.aiEnvColor[i] >= 0 && memcmp(pr.aafEnvColor[i], tu.afEnvColor, sizeof(tu.afEnvColor)) != 0) {
      memcpy(pr.aafEnvColor[i], tu.afEnvColor, sizeof(tu.afEnvColor));
      glUniform4fv(pr.aiEnvColor[i], 1, tu.afEnvColor);
    }
  }
}

// convert primitives that WebGL can't draw into triangles or lines;
// returns the mode to draw with, and fills _auiIndices
static GLenum ConvertPrimitives(GLenum eMode, GLsizei ctIndices, const GLuint *puiIn)
{
  std::vector<GLuint> &aui = _auiIndices;
  aui.clear();
  switch (eMode) {
  case GL1_QUADS:
    for (GLsizei i = 0; i+3 < ctIndices; i += 4) {
      GLuint a = puiIn[i], b = puiIn[i+1], c = puiIn[i+2], d = puiIn[i+3];
      aui.push_back(a); aui.push_back(b); aui.push_back(c);
      aui.push_back(c); aui.push_back(d); aui.push_back(a);
    }
    eMode = GL_TRIANGLES;
    break;
  case GL1_QUAD_STRIP:
    for (GLsizei i = 0; i+3 < ctIndices; i += 2) {
      GLuint a = puiIn[i], b = puiIn[i+1], c = puiIn[i+2], d = puiIn[i+3];
      aui.push_back(a); aui.push_back(b); aui.push_back(d);
      aui.push_back(d); aui.push_back(c); aui.push_back(a);
    }
    eMode = GL_TRIANGLES;
    break;
  case GL1_POLYGON:
    for (GLsizei i = 1; i+1 < ctIndices; i++) {
      aui.push_back(puiIn[0]); aui.push_back(puiIn[i]); aui.push_back(puiIn[i+1]);
    }
    eMode = GL_TRIANGLES;
    break;
  default:
    aui.assign(puiIn, puiIn+ctIndices);
    break;
  }

  // wireframe and point rendering of filled primitives
  if (S.ePolygonMode != GL1_FILL && eMode == GL_TRIANGLES) {
    if (S.ePolygonMode == GL1_POINT) {
      return GL_POINTS;
    }
    std::vector<GLuint> auiTris;
    auiTris.swap(aui);
    for (size_t i = 0; i+2 < auiTris.size(); i += 3) {
      aui.push_back(auiTris[i]);   aui.push_back(auiTris[i+1]);
      aui.push_back(auiTris[i+1]); aui.push_back(auiTris[i+2]);
      aui.push_back(auiTris[i+2]); aui.push_back(auiTris[i]);
    }
    return GL_LINES;
  }
  return eMode;
}

// draw indexed primitives from the given sources (indices are already in _auiIndices)
static void Draw(GLenum eMode, const DrawSources &ds)
{
  const size_t ctIndices = _auiIndices.size();
  if (ctIndices == 0) return;
  if (ds.papPos == NULL || !ds.papPos->bEnabled || ds.papPos->pvData == NULL) {
    Warn("draw without vertex array");
    return;
  }

  // find the range of used vertices
  GLuint uiMin = 0xFFFFFFFF, uiMax = 0;
  for (size_t i = 0; i < ctIndices; i++) {
    const GLuint ui = _auiIndices[i];
    if (ui < uiMin) uiMin = ui;
    if (ui > uiMax) uiMax = ui;
  }
  // with locked arrays, upload the whole locked range so it can be reused by later passes
  if (S.bLocked && (GLint)uiMin >= S.iLockFirst && (GLint)uiMax < S.iLockFirst+S.ctLockCount) {
    uiMin = S.iLockFirst;
    uiMax = S.iLockFirst + S.ctLockCount - 1;
  }

  // shader key from the current state
  unsigned uKey = 0;
  for (int i = 0; i < MAX_UNITS; i++) {
    const TexUnit &tu = S.atu[i];
    if (!tu.bTexture2D) continue;
    const TexInfo *pti = FindTexInfo(tu.uiBound);
    // like in OpenGL, texturing with an incomplete texture is the same as no texturing
    if (pti == NULL || !pti->bDefined) continue;
    uKey |= KEY_UNIT(i) | (TexMode(tu) << KEY_MODE_SHIFT(i));
  }
  if (S.bAlphaTest) uKey |= KEY_ALPHATEST;
  if (S.bClipPlane) uKey |= KEY_CLIPPLANE;

  // vertex attributes: gather all arrays into one upload
  AttributeUpload aau[ATTR_COUNT];
  int ctUploads = 0;
  _aubStaging.clear();
  StageAttribute(aau[ctUploads++], ATTR_POS, *ds.papPos, uiMin, uiMax);
  if (ds.papColor != NULL && ds.papColor->bEnabled && ds.papColor->pvData != NULL) {
    StageAttribute(aau[ctUploads++], ATTR_COLOR, *ds.papColor, uiMin, uiMax);
  } else {
    SetAttribValue(ATTR_COLOR, S.afColor);
  }
  for (int i = 0; i < MAX_UNITS; i++) {
    if (!(uKey & KEY_UNIT(i))) {
      SetAttribArray(ATTR_TC0+i, false);
      continue;
    }
    const ArrayPointer *pap = ds.apapTexCoord[i];
    if (pap != NULL && pap->bEnabled && pap->pvData != NULL) {
      StageAttribute(aau[ctUploads++], ATTR_TC0+i, *pap, uiMin, uiMax);
    } else {
      SetAttribValue(ATTR_TC0+i, S.atu[i].afTexCoord);
    }
  }
  GLuint uiVertexBuffer = 0;
  if (!_aubStaging.empty()) {
    uiVertexBuffer = PoolUpload(_bpVertices, &_aubStaging[0], _aubStaging.size());
  }
  for (int i = 0; i < ctUploads; i++) {
    SetAttributePointer(aau[i], uiVertexBuffer);
  }

  // indices, relative to the first uploaded vertex
  if (uiMin != 0) {
    for (size_t i = 0; i < ctIndices; i++) {
      _auiIndices[i] -= uiMin;
    }
  }
  PoolUpload(_bpIndices, &_auiIndices[0], ctIndices*sizeof(GLuint));
  const GLintptr iIndexOffset = 0;  // each draw has its own index buffer

  // program
  Program &pr = GetProgram(uKey);
  if (S.uiProgram != pr.uiProgram) {
    S.uiProgram = pr.uiProgram;
    glUseProgram(pr.uiProgram);
  }
  UpdateUniforms(pr, uKey);

  glDrawElements(eMode, (GLsizei)ctIndices, GL_UNSIGNED_INT, (const void *)iIndexOffset);
}

static void ClientSources(DrawSources &ds)
{
  ds.papPos = &S.apVertex;
  ds.papColor = &S.apColor;
  for (int i = 0; i < MAX_UNITS; i++) {
    ds.apapTexCoord[i] = &S.atu[i].apTexCoords;
  }
}

// ------------------------------------------------------- emulated functions

static void emu_glEnable(GLenum eCap);
static void emu_glDisable(GLenum eCap);

static void SetEnabled(GLenum eCap, bool bEnable)
{
  switch (eCap) {
  case GL_TEXTURE_2D:          S.atu[S.iActiveUnit].bTexture2D = bEnable; break;
  case GL1_ALPHA_TEST:         S.bAlphaTest = bEnable; break;
  case GL1_CLIP_PLANE0:        S.bClipPlane = bEnable; break;
  case GL_BLEND:               SetCap(GL_BLEND, S.bBlend, bEnable); break;
  case GL_DEPTH_TEST:          SetCap(GL_DEPTH_TEST, S.bDepthTest, bEnable); break;
  case GL_CULL_FACE:           SetCap(GL_CULL_FACE, S.bCullFace, bEnable); break;
  case GL_SCISSOR_TEST:        SetCap(GL_SCISSOR_TEST, S.bScissorTest, bEnable); break;
  case GL_POLYGON_OFFSET_FILL: SetCap(GL_POLYGON_OFFSET_FILL, S.bPolygonOffsetFill, bEnable); break;
  case GL_DITHER:              SetCap(GL_DITHER, S.bDither, bEnable); break;
  case GL1_POLYGON_OFFSET_POINT:
  case GL1_POLYGON_OFFSET_LINE:
    break;  // no equivalent, rarely matters
  default:
    Warn("glEnable/glDisable(0x%x) ignored", eCap);
    break;
  }
}

static void emu_glEnable(GLenum eCap)  { SetEnabled(eCap, true); }
static void emu_glDisable(GLenum eCap) { SetEnabled(eCap, false); }

static GLboolean emu_glIsEnabled(GLenum eCap)
{
  switch (eCap) {
  case GL_TEXTURE_2D:          return S.atu[S.iActiveUnit].bTexture2D;
  case GL1_ALPHA_TEST:         return S.bAlphaTest;
  case GL1_CLIP_PLANE0:        return S.bClipPlane;
  case GL_BLEND:               return S.bBlend;
  case GL_DEPTH_TEST:          return S.bDepthTest;
  case GL_CULL_FACE:           return S.bCullFace;
  case GL_SCISSOR_TEST:        return S.bScissorTest;
  case GL_POLYGON_OFFSET_FILL: return S.bPolygonOffsetFill;
  case GL_DITHER:              return S.bDither;
  case GL1_VERTEX_ARRAY:       return S.apVertex.bEnabled;
  case GL1_COLOR_ARRAY:        return S.apColor.bEnabled;
  case GL1_TEXTURE_COORD_ARRAY: return S.atu[S.iClientUnit].apTexCoords.bEnabled;
  case GL1_NORMAL_ARRAY:       return GL_FALSE;
  }
  return GL_FALSE;
}

static void SetClientState(GLenum eArray, bool bEnable)
{
  switch (eArray) {
  case GL1_VERTEX_ARRAY:        S.apVertex.bEnabled = bEnable; break;
  case GL1_COLOR_ARRAY:         S.apColor.bEnabled = bEnable; break;
  case GL1_TEXTURE_COORD_ARRAY: S.atu[S.iClientUnit].apTexCoords.bEnabled = bEnable; break;
  case GL1_NORMAL_ARRAY:        break;  // no lighting, normals are never needed
  default: Warn("client state 0x%x ignored", eArray); break;
  }
}

static void emu_glEnableClientState(GLenum eArray)  { SetClientState(eArray, true); }
static void emu_glDisableClientState(GLenum eArray) { SetClientState(eArray, false); }

static void emu_glVertexPointer(GLint iSize, GLenum eType, GLsizei iStride, const GLvoid *pv)
{
  ArrayPointer &ap = S.apVertex;
  ap.iSize = iSize; ap.eType = eType; ap.iStride = iStride; ap.pvData = pv;
}

static void emu_glColorPointer(GLint iSize, GLenum eType, GLsizei iStride, const GLvoid *pv)
{
  ArrayPointer &ap = S.apColor;
  ap.iSize = iSize; ap.eType = eType; ap.iStride = iStride; ap.pvData = pv;
}

static void emu_glTexCoordPointer(GLint iSize, GLenum eType, GLsizei iStride, const GLvoid *pv)
{
  ArrayPointer &ap = S.atu[S.iClientUnit].apTexCoords;
  ap.iSize = iSize; ap.eType = eType; ap.iStride = iStride; ap.pvData = pv;
}

static void emu_glNormalPointer(GLenum eType, GLsizei iStride, const GLvoid *pv)
{
  // no lighting, so normals are never used
}

static void emu_glLockArraysEXT(GLint iFirst, GLsizei ctCount)
{
  S.bLocked = true;
  S.iLockFirst = iFirst;
  S.ctLockCount = ctCount;
  _aluLocked.clear();
}

static void emu_glUnlockArraysEXT(void)
{
  S.bLocked = false;
  _aluLocked.clear();
}

static void emu_glDrawElements(GLenum eMode, GLsizei ctIndices, GLenum eType, const GLvoid *pvIndices)
{
  if (S.bInBeginEnd || ctIndices <= 0) return;
  // the engine uses 32-bit indices, but be safe
  static std::vector<GLuint> _auiTemp;
  const GLuint *pui;
  if (eType == GL_UNSIGNED_INT) {
    pui = (const GLuint *)pvIndices;
  } else {
    _auiTemp.resize(ctIndices);
    for (GLsizei i = 0; i < ctIndices; i++) {
      _auiTemp[i] = (eType == GL_UNSIGNED_SHORT) ? ((const GLushort *)pvIndices)[i] : ((const GLubyte *)pvIndices)[i];
    }
    pui = &_auiTemp[0];
  }
  const GLenum eDrawMode = ConvertPrimitives(eMode, ctIndices, pui);
  DrawSources ds;
  ClientSources(ds);
  Draw(eDrawMode, ds);
}

static void emu_glDrawArrays(GLenum eMode, GLint iFirst, GLsizei ctCount)
{
  if (S.bInBeginEnd || ctCount <= 0) return;
  static std::vector<GLuint> _auiTemp;
  _auiTemp.resize(ctCount);
  for (GLsizei i = 0; i < ctCount; i++) {
    _auiTemp[i] = iFirst + i;
  }
  const GLenum eDrawMode = ConvertPrimitives(eMode, ctCount, &_auiTemp[0]);
  DrawSources ds;
  ClientSources(ds);
  Draw(eDrawMode, ds);
}

// immediate mode

static void emu_glBegin(GLenum eMode)
{
  S.bInBeginEnd = true;
  S.eBeginMode = eMode;
  S.aimm.clear();
}

static void PushVertex(float x, float y, float z, float w)
{
  ImmVertex v;
  v.afPos[0] = x; v.afPos[1] = y; v.afPos[2] = z; v.afPos[3] = w;
  memcpy(v.afColor, S.afColor, sizeof(v.afColor));
  memcpy(v.afTexCoord, S.atu[0].afTexCoord, sizeof(v.afTexCoord));
  S.aimm.push_back(v);
}

static void emu_glVertex2f(GLfloat x, GLfloat y)          { PushVertex(x, y, 0, 1); }
static void emu_glVertex3f(GLfloat x, GLfloat y, GLfloat z) { PushVertex(x, y, z, 1); }

static void emu_glTexCoord2f(GLfloat s, GLfloat t)
{
  float *pf = S.atu[0].afTexCoord;
  pf[0] = s; pf[1] = t; pf[2] = 0; pf[3] = 1;
}

static void emu_glColor4f(GLfloat r, GLfloat g, GLfloat b, GLfloat a)
{
  S.afColor[0] = r; S.afColor[1] = g; S.afColor[2] = b; S.afColor[3] = a;
}

static void emu_glColor4ubv(const GLubyte *pub)
{
  emu_glColor4f(pub[0]/255.0f, pub[1]/255.0f, pub[2]/255.0f, pub[3]/255.0f);
}

static float FetchFloat(const ArrayPointer &ap, GLint iVertex, int iComponent, float fDefault)
{
  if (iComponent >= ap.iSize) return fDefault;
  const GLsizei iStride = ap.iStride ? ap.iStride : ap.iSize*(GLsizei)TypeSize(ap.eType);
  const char *pch = (const char *)ap.pvData + (size_t)iVertex*iStride;
  if (ap.eType == GL_UNSIGNED_BYTE) return ((const GLubyte *)pch)[iComponent] / 255.0f;
  return ((const float *)pch)[iComponent];
}

static void emu_glArrayElement(GLint i)
{
  if (!S.apVertex.bEnabled || S.apVertex.pvData == NULL) return;
  ImmVertex v;
  for (int c = 0; c < 4; c++) {
    v.afPos[c] = FetchFloat(S.apVertex, i, c, c == 3 ? 1.0f : 0.0f);
    v.afColor[c] = (S.apColor.bEnabled && S.apColor.pvData) ? FetchFloat(S.apColor, i, c, 1.0f) : S.afColor[c];
    const ArrayPointer &apTex = S.atu[0].apTexCoords;
    v.afTexCoord[c] = (apTex.bEnabled && apTex.pvData) ? FetchFloat(apTex, i, c, c == 3 ? 1.0f : 0.0f) : S.atu[0].afTexCoord[c];
  }
  S.aimm.push_back(v);
}

static void emu_glEnd(void)
{
  S.bInBeginEnd = false;
  const GLsizei ctVertices = (GLsizei)S.aimm.size();
  if (ctVertices == 0) return;

  static std::vector<GLuint> _auiTemp;
  _auiTemp.resize(ctVertices);
  for (GLsizei i = 0; i < ctVertices; i++) {
    _auiTemp[i] = i;
  }
  const GLenum eDrawMode = ConvertPrimitives(S.eBeginMode, ctVertices, &_auiTemp[0]);

  const GLsizei iStride = sizeof(ImmVertex);
  ArrayPointer apPos   = { true, 4, GL_FLOAT, iStride, &S.aimm[0].afPos[0] };
  ArrayPointer apColor = { true, 4, GL_FLOAT, iStride, &S.aimm[0].afColor[0] };
  ArrayPointer apTex   = { true, 4, GL_FLOAT, iStride, &S.aimm[0].afTexCoord[0] };
  DrawSources ds;
  ds.papPos = &apPos;
  ds.papColor = &apColor;
  ds.apapTexCoord[0] = &apTex;
  for (int i = 1; i < MAX_UNITS; i++) {
    ds.apapTexCoord[i] = NULL;  // other units use their current coordinate
  }
  // immediate data must not be mistaken for locked arrays
  const bool bLocked = S.bLocked;
  S.bLocked = false;
  Draw(eDrawMode, ds);
  S.bLocked = bLocked;
}

// matrices

static void emu_glMatrixMode(GLenum eMode) { S.eMatrixMode = eMode; }

static void emu_glLoadIdentity(void)
{
  MatIdentity(CurrentMatrix());
  MatrixChanged();
}

static void emu_glLoadMatrixf(const GLfloat *pf)
{
  memcpy(CurrentMatrix().m, pf, sizeof(float)*16);
  MatrixChanged();
}

static void emu_glMultMatrixf(const GLfloat *pf)
{
  Mat4 m;
  memcpy(m.m, pf, sizeof(float)*16);
  MultCurrent(m);
}

static void emu_glOrtho(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f)
{
  Mat4 m;
  MatIdentity(m);
  m.m[0]  = (float)(2.0/(r-l));
  m.m[5]  = (float)(2.0/(t-b));
  m.m[10] = (float)(-2.0/(f-n));
  m.m[12] = (float)(-(r+l)/(r-l));
  m.m[13] = (float)(-(t+b)/(t-b));
  m.m[14] = (float)(-(f+n)/(f-n));
  MultCurrent(m);
}

static void emu_glFrustum(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f)
{
  Mat4 m;
  memset(m.m, 0, sizeof(m.m));
  m.m[0]  = (float)(2.0*n/(r-l));
  m.m[5]  = (float)(2.0*n/(t-b));
  m.m[8]  = (float)((r+l)/(r-l));
  m.m[9]  = (float)((t+b)/(t-b));
  m.m[10] = (float)(-(f+n)/(f-n));
  m.m[11] = -1.0f;
  m.m[14] = (float)(-2.0*f*n/(f-n));
  MultCurrent(m);
}

static void emu_glScalef(GLfloat x, GLfloat y, GLfloat z)
{
  Mat4 m;
  MatIdentity(m);
  m.m[0] = x; m.m[5] = y; m.m[10] = z;
  MultCurrent(m);
}

static void emu_glTranslatef(GLfloat x, GLfloat y, GLfloat z)
{
  Mat4 m;
  MatIdentity(m);
  m.m[12] = x; m.m[13] = y; m.m[14] = z;
  MultCurrent(m);
}

static void emu_glClipPlane(GLenum ePlane, const GLdouble *pdEquation)
{
  if (ePlane != GL1_CLIP_PLANE0) {
    Warn("only one clip plane is supported");
    return;
  }
  // the plane is given in object space and kept in eye space: p_eye = p * inverse(modelview)
  Mat4 mInv;
  if (!MatInverse(mInv, S.mModelView)) {
    MatIdentity(mInv);
  }
  for (int c = 0; c < 4; c++) {
    S.afClipPlane[c] = (float)(pdEquation[0]*mInv.m[c*4+0] + pdEquation[1]*mInv.m[c*4+1]
                             + pdEquation[2]*mInv.m[c*4+2] + pdEquation[3]*mInv.m[c*4+3]);
  }
  S.uClipVersion = ++_uVersionCounter;
}

// fixed state

static void emu_glAlphaFunc(GLenum eFunc, GLclampf fRef)
{
  if (eFunc != GL_GEQUAL) Warn("alpha function 0x%x is treated as GL_GEQUAL", eFunc);
  S.eAlphaFunc = eFunc;
  S.fAlphaRef = fRef;
}

static void emu_glBlendFunc(GLenum eSrc, GLenum eDst)
{
  if (S.eBlendSrc == eSrc && S.eBlendDst == eDst) return;
  S.eBlendSrc = eSrc; S.eBlendDst = eDst;
  glBlendFunc(eSrc, eDst);
}

static void emu_glDepthFunc(GLenum eFunc)
{
  if (S.eDepthFunc == eFunc) return;
  S.eDepthFunc = eFunc;
  glDepthFunc(eFunc);
}

static void emu_glDepthMask(GLboolean bFlag)
{
  bFlag = bFlag ? GL_TRUE : GL_FALSE;
  if (S.bDepthMask == bFlag) return;
  S.bDepthMask = bFlag;
  glDepthMask(bFlag);
}

static void emu_glDepthRange(GLclampd dNear, GLclampd dFar)
{
  if (S.fDepthNear == (float)dNear && S.fDepthFar == (float)dFar) return;
  S.fDepthNear = (float)dNear; S.fDepthFar = (float)dFar;
  glDepthRangef((float)dNear, (float)dFar);
}

static void emu_glCullFace(GLenum eMode)
{
  if (S.eCullFace == eMode) return;
  S.eCullFace = eMode;
  glCullFace(eMode);
}

static void emu_glFrontFace(GLenum eMode)
{
  if (S.eFrontFace == eMode) return;
  S.eFrontFace = eMode;
  glFrontFace(eMode);
}

static void emu_glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a)
{
  S.abColorMask[0] = r; S.abColorMask[1] = g; S.abColorMask[2] = b; S.abColorMask[3] = a;
  glColorMask(r, g, b, a);
}
static void emu_glPolygonOffset(GLfloat fFactor, GLfloat fUnits) { glPolygonOffset(fFactor, fUnits); }
static void emu_glPolygonMode(GLenum eFace, GLenum eMode) { S.ePolygonMode = eMode; }
static void emu_glPointSize(GLfloat fSize) { S.fPointSize = fSize; }
static void emu_glShadeModel(GLenum eMode) {}
static void emu_glHint(GLenum eTarget, GLenum eMode) {}
static void emu_glDrawBuffer(GLenum eMode) {}
static void emu_glFinish(void) {}
static void emu_glFlush(void) {}
static GLenum emu_glGetError(void) { return GL_NO_ERROR; }

static void emu_glViewport(GLint x, GLint y, GLsizei w, GLsizei h)
{
  GLint *pi = S.aiViewport;
  if (pi[0] == x && pi[1] == y && pi[2] == w && pi[3] == h) return;
  pi[0] = x; pi[1] = y; pi[2] = w; pi[3] = h;
  glViewport(x, y, w, h);
}

static void emu_glScissor(GLint x, GLint y, GLsizei w, GLsizei h)
{
  GLint *pi = S.aiScissor;
  if (pi[0] == x && pi[1] == y && pi[2] == w && pi[3] == h) return;
  pi[0] = x; pi[1] = y; pi[2] = w; pi[3] = h;
  glScissor(x, y, w, h);
}

static void emu_glClearColor(GLclampf r, GLclampf g, GLclampf b, GLclampf a) { glClearColor(r, g, b, a); }
static void emu_glClearDepth(GLclampd d) { glClearDepthf((float)d); }
static void emu_glClearStencil(GLint s) { glClearStencil(s); }
static void emu_glClear(GLbitfield mask) { glClear(mask); }

static void emu_glPixelStorei(GLenum ePName, GLint iParam)
{
  if (ePName == GL_PACK_ALIGNMENT || ePName == GL_UNPACK_ALIGNMENT) {
    glPixelStorei(ePName, iParam);
  }
}

// texturing

static void emu_glActiveTextureARB(GLenum eUnit)
{
  const int iUnit = (int)(eUnit - GL_TEXTURE0);
  if (iUnit < 0 || iUnit >= MAX_UNITS || iUnit == S.iActiveUnit) return;
  S.iActiveUnit = iUnit;
  glActiveTexture(eUnit);
}

static void emu_glClientActiveTextureARB(GLenum eUnit)
{
  const int iUnit = (int)(eUnit - GL_TEXTURE0);
  if (iUnit < 0 || iUnit >= MAX_UNITS) return;
  S.iClientUnit = iUnit;
}

static void emu_glGenTextures(GLsizei n, GLuint *pui)
{
  glGenTextures(n, pui);
  for (GLsizei i = 0; i < n; i++) {
    TexInfo ti = { 0, 0, GL_RGBA8, -1, false };
    S.mapTextures[pui[i]] = ti;
  }
}

static void emu_glDeleteTextures(GLsizei n, const GLuint *pui)
{
  for (GLsizei i = 0; i < n; i++) {
    S.mapTextures.erase(pui[i]);
    for (int u = 0; u < MAX_UNITS; u++) {
      if (S.atu[u].uiBound == pui[i]) S.atu[u].uiBound = 0;
    }
  }
  // the engine frees textures after closing the window when it shuts down;
  // like OpenGL, ignore that instead of failing without a context
  if (emscripten_webgl_get_current_context() == 0) return;
  glDeleteTextures(n, pui);
}

static void emu_glBindTexture(GLenum eTarget, GLuint uiTex)
{
  TexUnit &tu = S.atu[S.iActiveUnit];
  if (tu.uiBound == uiTex) return;
  tu.uiBound = uiTex;
  glBindTexture(GL_TEXTURE_2D, uiTex);
}

static void emu_glTexEnvi(GLenum eTarget, GLenum ePName, GLint iParam)
{
  TexUnit &tu = S.atu[S.iActiveUnit];
  if (eTarget == GL1_TEXTURE_FILTER_CONTROL) {
    if (ePName == GL1_TEXTURE_LOD_BIAS) tu.fLODBias = (float)iParam;
    return;
  }
  switch (ePName) {
  case GL1_TEXTURE_ENV_MODE: tu.eEnvMode = iParam; break;
  case GL1_COMBINE_RGB:      tu.eCombineRGB = iParam; break;
  case GL1_COMBINE_ALPHA:    tu.eCombineAlpha = iParam; break;
  case GL1_RGB_SCALE:        tu.fRGBScale = (float)iParam; break;
  case GL1_ALPHA_SCALE:      tu.fAlphaScale = (float)iParam; break;
  default: Warn("glTexEnv(0x%x) ignored", ePName); break;
  }
}

static void emu_glTexEnvf(GLenum eTarget, GLenum ePName, GLfloat fParam)
{
  TexUnit &tu = S.atu[S.iActiveUnit];
  if (eTarget == GL1_TEXTURE_FILTER_CONTROL) {
    if (ePName == GL1_TEXTURE_LOD_BIAS) tu.fLODBias = fParam;
    return;
  }
  switch (ePName) {
  case GL1_RGB_SCALE:   tu.fRGBScale = fParam; break;
  case GL1_ALPHA_SCALE: tu.fAlphaScale = fParam; break;
  default: emu_glTexEnvi(eTarget, ePName, (GLint)fParam); break;
  }
}

static void emu_glGetTexEnviv(GLenum eTarget, GLenum ePName, GLint *pi)
{
  const TexUnit &tu = S.atu[S.iActiveUnit];
  switch (ePName) {
  case GL1_TEXTURE_ENV_MODE: *pi = tu.eEnvMode; break;
  case GL1_COMBINE_RGB:      *pi = tu.eCombineRGB; break;
  case GL1_COMBINE_ALPHA:    *pi = tu.eCombineAlpha; break;
  default: *pi = 0; break;
  }
}

static GLint WrapMode(GLint iParam)
{
  return iParam == GL1_CLAMP ? GL_CLAMP_TO_EDGE : iParam;
}

static void emu_glTexParameteri(GLenum eTarget, GLenum ePName, GLint iParam)
{
  switch (ePName) {
  case GL_TEXTURE_WRAP_S:
  case GL_TEXTURE_WRAP_T:
    glTexParameteri(GL_TEXTURE_2D, ePName, WrapMode(iParam));
    break;
  case GL1_TEXTURE_MAX_ANISOTROPY:
    if (S.bAnisotropy) glTexParameterf(GL_TEXTURE_2D, ePName, (float)iParam);
    break;
  default:
    glTexParameteri(GL_TEXTURE_2D, ePName, iParam);
    break;
  }
}

static void emu_glTexParameterf(GLenum eTarget, GLenum ePName, GLfloat fParam)
{
  if (ePName == GL1_TEXTURE_MAX_ANISOTROPY) {
    if (S.bAnisotropy) glTexParameterf(GL_TEXTURE_2D, ePName, fParam);
    return;
  }
  emu_glTexParameteri(eTarget, ePName, (GLint)fParam);
}

// what has to be done to the RGBA source pixels to get the requested format
enum PixelConversion { PC_NONE, PC_OPAQUE, PC_LUMINANCE, PC_LUMINANCE_ALPHA };

static PixelConversion ConversionFor(GLenum eInternalFormat)
{
  switch (eInternalFormat) {
  case 3: case GL_RGB: case GL_RGB8: case GL1_RGB5: case GL1_RGB4: case GL_RGB565:
  case GL1_COMPRESSED_RGB: case GL1_COMPRESSED_RGB_S3TC_DXT1:
    return PC_OPAQUE;
  case 1: case GL_LUMINANCE: case GL1_LUMINANCE8:
    return PC_LUMINANCE;
  case 2: case GL_LUMINANCE_ALPHA: case GL1_LUMINANCE8_ALPHA8:
    return PC_LUMINANCE_ALPHA;
  default:
    return PC_NONE;
  }
}

static std::vector<GLubyte> _aubConverted;

// textures are always stored as RGBA8; convert the engine's RGBA source if the requested format differs
static const void *ConvertPixels(PixelConversion pc, GLsizei w, GLsizei h, GLenum eFormat, const void *pvPixels)
{
  if (pvPixels == NULL || pc == PC_NONE) return pvPixels;
  if (eFormat != GL_RGBA) {
    Warn("texture source format 0x%x not supported", eFormat);
    return pvPixels;
  }
  const size_t ctPixels = (size_t)w*h;
  _aubConverted.resize(ctPixels*4);
  const GLubyte *pubSrc = (const GLubyte *)pvPixels;
  GLubyte *pubDst = &_aubConverted[0];
  for (size_t i = 0; i < ctPixels; i++, pubSrc += 4, pubDst += 4) {
    switch (pc) {
    case PC_OPAQUE:
      pubDst[0] = pubSrc[0]; pubDst[1] = pubSrc[1]; pubDst[2] = pubSrc[2]; pubDst[3] = 255;
      break;
    case PC_LUMINANCE:
      pubDst[0] = pubDst[1] = pubDst[2] = pubSrc[0]; pubDst[3] = 255;
      break;
    case PC_LUMINANCE_ALPHA:
      pubDst[0] = pubDst[1] = pubDst[2] = pubSrc[0]; pubDst[3] = pubSrc[3];
      break;
    default:
      break;
    }
  }
  return &_aubConverted[0];
}

static void emu_glTexImage2D(GLenum eTarget, GLint iLevel, GLint iInternalFormat, GLsizei w, GLsizei h,
                             GLint iBorder, GLenum eFormat, GLenum eType, const GLvoid *pvPixels)
{
  TexInfo *pti = FindTexInfo(S.atu[S.iActiveUnit].uiBound);
  if (pti == NULL) {
    Warn("texture upload without a bound texture");
    return;
  }
  const void *pv = ConvertPixels(ConversionFor(iInternalFormat), w, h, eFormat, pvPixels);
  glTexImage2D(GL_TEXTURE_2D, iLevel, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pv);

  // keep track of defined mip levels, so the texture is always complete
  if (iLevel == 0) {
    pti->iWidth = w;
    pti->iHeight = h;
    pti->eInternalFormat = iInternalFormat;
    pti->bDefined = true;
    if (pti->iMaxLevel != 0) {
      pti->iMaxLevel = 0;
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, 0);
    }
  } else if (iLevel == pti->iMaxLevel+1) {
    pti->iMaxLevel = iLevel;
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, iLevel);
  }
}

static void emu_glTexSubImage2D(GLenum eTarget, GLint iLevel, GLint x, GLint y, GLsizei w, GLsizei h,
                                GLenum eFormat, GLenum eType, const GLvoid *pvPixels)
{
  const TexInfo *pti = FindTexInfo(S.atu[S.iActiveUnit].uiBound);
  const GLenum eInternalFormat = pti ? pti->eInternalFormat : GL_RGBA8;
  const void *pv = ConvertPixels(ConversionFor(eInternalFormat), w, h, eFormat, pvPixels);
  glTexSubImage2D(GL_TEXTURE_2D, iLevel, x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pv);
}

static void emu_glGetTexLevelParameteriv(GLenum eTarget, GLint iLevel, GLenum ePName, GLint *pi)
{
  const TexInfo *pti = FindTexInfo(S.atu[S.iActiveUnit].uiBound);
  *pi = 0;
  if (pti == NULL || !pti->bDefined) return;
  const GLsizei w = pti->iWidth >> iLevel ? pti->iWidth >> iLevel : 1;
  const GLsizei h = pti->iHeight >> iLevel ? pti->iHeight >> iLevel : 1;
  switch (ePName) {
  case GL1_TEXTURE_WIDTH:           *pi = w; break;
  case GL1_TEXTURE_HEIGHT:          *pi = h; break;
  case GL1_TEXTURE_INTERNAL_FORMAT: *pi = pti->eInternalFormat; break;
  case GL1_TEXTURE_RED_SIZE:
  case GL1_TEXTURE_GREEN_SIZE:
  case GL1_TEXTURE_BLUE_SIZE:
  case GL1_TEXTURE_ALPHA_SIZE:      *pi = 8; break;
  case GL1_TEXTURE_COMPRESSED:      *pi = 0; break;
  case GL1_TEXTURE_COMPRESSED_IMAGE_SIZE: *pi = w*h*4; break;
  default: Warn("glGetTexLevelParameteriv(0x%x) not supported", ePName); break;
  }
}

static void emu_glReadPixels(GLint x, GLint y, GLsizei w, GLsizei h, GLenum eFormat, GLenum eType, GLvoid *pv)
{
  if (eFormat == GL_DEPTH_COMPONENT) {
    // WebGL can't read the depth buffer; report everything as far away
    Warn("depth buffer reads are not supported");
    float *pf = (float *)pv;
    for (GLsizei i = 0; i < w*h; i++) pf[i] = 1.0f;
    return;
  }
  if (eFormat == GL_RGBA && eType == GL_UNSIGNED_BYTE) {
    glReadPixels(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pv);
    return;
  }
  if (eFormat == GL_RGB && eType == GL_UNSIGNED_BYTE) {
    std::vector<GLubyte> aub((size_t)w*h*4);
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glReadPixels(x, y, w, h, GL_RGBA, GL_UNSIGNED_BYTE, &aub[0]);
    GLubyte *pubDst = (GLubyte *)pv;
    for (size_t i = 0; i < (size_t)w*h; i++) {
      pubDst[i*3+0] = aub[i*4+0];
      pubDst[i*3+1] = aub[i*4+1];
      pubDst[i*3+2] = aub[i*4+2];
    }
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    return;
  }
  Warn("glReadPixels format 0x%x/0x%x not supported", eFormat, eType);
}

// queries

static std::string _strExtensions;
static std::string _strVendor, _strRenderer, _strVersion;

static const GLubyte *emu_glGetString(GLenum eName)
{
  switch (eName) {
  case GL_VENDOR:     return (const GLubyte *)_strVendor.c_str();
  case GL_RENDERER:   return (const GLubyte *)_strRenderer.c_str();
  case GL_VERSION:    return (const GLubyte *)_strVersion.c_str();
  case GL_EXTENSIONS: return (const GLubyte *)_strExtensions.c_str();
  }
  return (const GLubyte *)"";
}

static void emu_glGetIntegerv(GLenum ePName, GLint *pi)
{
  switch (ePName) {
  case GL1_MAX_TEXTURE_UNITS:          *pi = MAX_UNITS; return;
  case GL_MAX_TEXTURE_SIZE:            *pi = S.iMaxTextureSize; return;
  case GL1_MAX_TEXTURE_MAX_ANISOTROPY: *pi = S.iMaxAnisotropy; return;
  case GL_ACTIVE_TEXTURE:              *pi = GL_TEXTURE0 + S.iActiveUnit; return;
  case GL1_CLIENT_ACTIVE_TEXTURE:      *pi = GL_TEXTURE0 + S.iClientUnit; return;
  case GL_DEPTH_WRITEMASK:             *pi = S.bDepthMask; return;
  case GL1_BLEND_SRC:                  *pi = S.eBlendSrc; return;
  case GL1_BLEND_DST:                  *pi = S.eBlendDst; return;
  case GL_DEPTH_FUNC:                  *pi = S.eDepthFunc; return;
  case GL_CULL_FACE_MODE:              *pi = S.eCullFace; return;
  case GL_FRONT_FACE:                  *pi = S.eFrontFace; return;
  case GL1_ARRAY_ELEMENT_LOCK_COUNT:   *pi = S.bLocked ? S.ctLockCount : 0; return;
  case GL_VIEWPORT:                    memcpy(pi, S.aiViewport, sizeof(S.aiViewport)); return;
  case GL_SCISSOR_BOX:                 memcpy(pi, S.aiScissor, sizeof(S.aiScissor)); return;
  }
  Warn("glGetIntegerv(0x%x) not emulated", ePName);
  *pi = 0;
}

static void emu_glGetFloatv(GLenum ePName, GLfloat *pf)
{
  switch (ePName) {
  case GL1_MAX_TEXTURE_LOD_BIAS: *pf = S.fMaxLODBias; return;
  case GL1_DEPTH_RANGE:          pf[0] = S.fDepthNear; pf[1] = S.fDepthFar; return;
  }
  Warn("glGetFloatv(0x%x) not emulated", ePName);
  *pf = 0;
}

// ------------------------------------------------------- depth point checks

// WebGL can't read the depth buffer, so the visibility of points (lens flares) is
// measured by drawing them with occlusion queries. Results arrive a frame or more
// later, which the engine's delayed checking is designed for anyway.
struct DepthPoint {
  GLuint uiQuery;
  bool bPending;
  bool bVisible;
};
static std::unordered_map<unsigned long long, DepthPoint> _mapDepthPoints;
static GLuint _uiDepthProgram = 0;
static GLint _iDepthPointLocation = -1;
static GLuint _uiDepthVAO = 0;

static void InitDepthPoints(void)
{
  _mapDepthPoints.clear();
  const char *strVS =
    "#version 300 es\n"
    "uniform vec3 u_point;\n"
    "void main() { gl_Position = vec4(u_point, 1.0); gl_PointSize = 1.0; }\n";
  const char *strFS =
    "#version 300 es\n"
    "precision mediump float;\n"
    "out vec4 o_color;\n"
    "void main() { o_color = vec4(1.0); }\n";
  GLuint uiVS = CompileShader(GL_VERTEX_SHADER, strVS);
  GLuint uiFS = CompileShader(GL_FRAGMENT_SHADER, strFS);
  _uiDepthProgram = glCreateProgram();
  glAttachShader(_uiDepthProgram, uiVS);
  glAttachShader(_uiDepthProgram, uiFS);
  glLinkProgram(_uiDepthProgram);
  glDeleteShader(uiVS);
  glDeleteShader(uiFS);
  _iDepthPointLocation = glGetUniformLocation(_uiDepthProgram, "u_point");
  glGenVertexArrays(1, &_uiDepthVAO);
}

int WebGL_CheckDepthPoint(int iID, int iX, int iY, float fDepth, int iRasterWidth, int iRasterHeight)
{
  DepthPoint &dp = _mapDepthPoints[(unsigned long long)(unsigned)iID];
  if (dp.uiQuery == 0) {
    glGenQueries(1, &dp.uiQuery);
    dp.bPending = false;
    dp.bVisible = false;
  }

  // pick up the result of the last query when it is ready
  if (dp.bPending) {
    GLuint uiAvailable = 0;
    glGetQueryObjectuiv(dp.uiQuery, GL_QUERY_RESULT_AVAILABLE, &uiAvailable);
    if (!uiAvailable) {
      return dp.bVisible;
    }
    GLuint uiPassed = 0;
    glGetQueryObjectuiv(dp.uiQuery, GL_QUERY_RESULT, &uiPassed);
    dp.bVisible = uiPassed != 0;
    dp.bPending = false;
  }

  // draw the point where it is visible if nothing is nearer in the depth buffer
  glBindVertexArray(_uiDepthVAO);
  glUseProgram(_uiDepthProgram);
  glViewport(0, 0, iRasterWidth, iRasterHeight);
  glDepthRangef(0, 1);
  glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_FALSE);
  glDepthMask(GL_FALSE);
  if (!S.bDepthTest) glEnable(GL_DEPTH_TEST);
  if (S.bScissorTest) glDisable(GL_SCISSOR_TEST);
  if (S.bBlend) glDisable(GL_BLEND);
  glDepthFunc(GL_LESS);
  glUniform3f(_iDepthPointLocation,
    (iX + 0.5f) * 2.0f / iRasterWidth - 1.0f, (iY + 0.5f) * 2.0f / iRasterHeight - 1.0f, fDepth * 2.0f - 1.0f);
  glBeginQuery(GL_ANY_SAMPLES_PASSED_CONSERVATIVE, dp.uiQuery);
  glDrawArrays(GL_POINTS, 0, 1);
  glEndQuery(GL_ANY_SAMPLES_PASSED_CONSERVATIVE);
  dp.bPending = true;

  // restore the emulated state
  glBindVertexArray(_uiVAO);
  glUseProgram(S.uiProgram);
  glViewport(S.aiViewport[0], S.aiViewport[1], S.aiViewport[2], S.aiViewport[3]);
  glDepthRangef(S.fDepthNear, S.fDepthFar);
  glColorMask(S.abColorMask[0], S.abColorMask[1], S.abColorMask[2], S.abColorMask[3]);
  glDepthMask(S.bDepthMask);
  if (!S.bDepthTest) glDisable(GL_DEPTH_TEST);
  if (S.bScissorTest) glEnable(GL_SCISSOR_TEST);
  if (S.bBlend) glEnable(GL_BLEND);
  glDepthFunc(S.eDepthFunc);
  return dp.bVisible;
}

// ---------------------------------------------------------------- interface

struct ProcEntry {
  const char *strName;
  void *pvFunction;
};

#define PROC(name) { #name, (void *)&emu_##name }
static const ProcEntry _apeProcs[] = {
  PROC(glEnable), PROC(glDisable), PROC(glIsEnabled),
  PROC(glEnableClientState), PROC(glDisableClientState),
  PROC(glVertexPointer), PROC(glColorPointer), PROC(glTexCoordPointer), PROC(glNormalPointer),
  PROC(glDrawElements), PROC(glDrawArrays),
  PROC(glBegin), PROC(glEnd), PROC(glVertex2f), PROC(glVertex3f), PROC(glTexCoord2f),
  PROC(glColor4f), PROC(glColor4ubv), PROC(glArrayElement),
  PROC(glMatrixMode), PROC(glLoadIdentity), PROC(glLoadMatrixf), PROC(glMultMatrixf),
  PROC(glOrtho), PROC(glFrustum), PROC(glScalef), PROC(glTranslatef), PROC(glClipPlane),
  PROC(glAlphaFunc), PROC(glBlendFunc), PROC(glDepthFunc), PROC(glDepthMask), PROC(glDepthRange),
  PROC(glCullFace), PROC(glFrontFace), PROC(glColorMask), PROC(glPolygonOffset), PROC(glPolygonMode),
  PROC(glPointSize), PROC(glShadeModel), PROC(glHint), PROC(glDrawBuffer), PROC(glFinish), PROC(glFlush),
  PROC(glGetError), PROC(glViewport), PROC(glScissor),
  PROC(glClearColor), PROC(glClearDepth), PROC(glClearStencil), PROC(glClear), PROC(glPixelStorei),
  PROC(glGenTextures), PROC(glDeleteTextures), PROC(glBindTexture),
  PROC(glTexEnvi), PROC(glTexEnvf), PROC(glGetTexEnviv), PROC(glTexParameteri), PROC(glTexParameterf),
  PROC(glTexImage2D), PROC(glTexSubImage2D), PROC(glGetTexLevelParameteriv), PROC(glReadPixels),
  PROC(glGetString), PROC(glGetIntegerv), PROC(glGetFloatv),
  PROC(glActiveTextureARB), PROC(glClientActiveTextureARB),
  PROC(glLockArraysEXT), PROC(glUnlockArraysEXT),
  { NULL, NULL }
};
#undef PROC

void *WebGL_GetProcAddress(const char *strName)
{
  for (const ProcEntry *pe = _apeProcs; pe->strName != NULL; pe++) {
    if (strcmp(pe->strName, strName) == 0) {
      return pe->pvFunction;
    }
  }
  return NULL;
}

void WebGL_InitContext(void)
{
  // reset all emulated state to OpenGL defaults
  S.mapTextures.clear();
  S.aimm.clear();
  S.bInitialized = true;
  S.eMatrixMode = GL1_MODELVIEW;
  MatIdentity(S.mModelView);
  MatIdentity(S.mProjection);
  S.uModelViewVersion = ++_uVersionCounter;
  S.uProjectionVersion = ++_uVersionCounter;
  for (int i = 0; i < MAX_UNITS; i++) {
    TexUnit &tu = S.atu[i];
    memset(&tu, 0, sizeof(tu));
    tu.eEnvMode = GL1_MODULATE;
    tu.eCombineRGB = GL1_MODULATE;
    tu.eCombineAlpha = GL1_MODULATE;
    tu.fRGBScale = 1;
    tu.fAlphaScale = 1;
    MatIdentity(tu.mMatrix);
    tu.uMatrixVersion = ++_uVersionCounter;
    tu.afTexCoord[3] = 1;
  }
  S.iActiveUnit = 0;
  S.iClientUnit = 0;
  memset(&S.apVertex, 0, sizeof(S.apVertex));
  memset(&S.apColor, 0, sizeof(S.apColor));
  S.afColor[0] = S.afColor[1] = S.afColor[2] = S.afColor[3] = 1;
  S.bLocked = false;
  S.bAlphaTest = false;
  S.eAlphaFunc = GL_ALWAYS;
  S.fAlphaRef = 0;
  S.bClipPlane = false;
  memset(S.afClipPlane, 0, sizeof(S.afClipPlane));
  S.uClipVersion = ++_uVersionCounter;
  S.ePolygonMode = GL1_FILL;
  S.fPointSize = 1;
  S.bInBeginEnd = false;

  // WebGL defaults
  S.bBlend = S.bDepthTest = S.bCullFace = S.bScissorTest = S.bPolygonOffsetFill = false;
  S.bDither = true;
  S.eBlendSrc = GL_ONE; S.eBlendDst = GL_ZERO;
  S.eDepthFunc = GL_LESS;
  S.eCullFace = GL_BACK;
  S.eFrontFace = GL_CCW;
  S.bDepthMask = GL_TRUE;
  S.abColorMask[0] = S.abColorMask[1] = S.abColorMask[2] = S.abColorMask[3] = GL_TRUE;
  S.fDepthNear = 0; S.fDepthFar = 1;
  glGetIntegerv(GL_VIEWPORT, S.aiViewport);
  glGetIntegerv(GL_SCISSOR_BOX, S.aiScissor);
  S.uiProgram = 0;
  _mapPrograms.clear();
  _aluLocked.clear();

  // the vertex array object that holds all attribute setup
  glGenVertexArrays(1, &_uiVAO);
  glBindVertexArray(_uiVAO);
  for (int i = 0; i < ATTR_COUNT; i++) {
    S.abAttribArray[i] = false;
    S.aafAttribValue[i][0] = S.aafAttribValue[i][1] = S.aafAttribValue[i][2] = 0;
    S.aafAttribValue[i][3] = 1;
  }
  PoolCreate(_bpVertices, POOL_SIZE);
  PoolCreate(_bpIndices, POOL_SIZE);
  PoolCreate(_bpLocked, 64);
  InitDepthPoints();
  for (size_t i = 0; i < sizeof(_auCommonKeys)/sizeof(_auCommonKeys[0]); i++) {
    StartProgram(_auCommonKeys[i]);
  }
  glBindVertexArray(_uiVAO);

  // limits and extensions
  glGetIntegerv(GL_MAX_TEXTURE_SIZE, &S.iMaxTextureSize);
  glGetFloatv(GL1_MAX_TEXTURE_LOD_BIAS, &S.fMaxLODBias);
  if (S.fMaxLODBias <= 0) S.fMaxLODBias = 2;
  S.bAnisotropy = false;
  S.iMaxAnisotropy = 1;
  const char *strWebGLExtensions = (const char *)glGetString(GL_EXTENSIONS);
  if (strWebGLExtensions != NULL && strstr(strWebGLExtensions, "EXT_texture_filter_anisotropic") != NULL) {
    S.bAnisotropy = true;
    float fMax = 1;
    glGetFloatv(GL1_MAX_TEXTURE_MAX_ANISOTROPY, &fMax);
    S.iMaxAnisotropy = (GLint)fMax;
  }
  _strVendor = (const char *)glGetString(GL_VENDOR);
  _strRenderer = (const char *)glGetString(GL_RENDERER);
  _strVersion = (const char *)glGetString(GL_VERSION);
  _strExtensions = "GL_ARB_multitexture GL_ARB_texture_env_combine GL_EXT_texture_env_combine"
                   " GL_EXT_texture_lod_bias GL_EXT_texture_edge_clamp GL_EXT_compiled_vertex_array";
  if (S.bAnisotropy) {
    _strExtensions += " GL_EXT_texture_filter_anisotropic";
  }
}
