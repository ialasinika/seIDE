/*
 * seide_cfg.h - include this FIRST, before any system header.
 *
 * seIDE's kernel is written to the C89 subset (ISO/IEC 9899:1990) with
 * -std=c89 -pedantic -Werror.  That choice is enforced by the compiler, which
 * rejects C++ comments, mid-block declarations, `long long` and variadic
 * macros.
 *
 * Two Windows-specific reasons force this header to exist:
 *
 *   1. MinGW hides the C99 `snprintf`/`vsnprintf` family when __STRICT_ANSI__
 *      is set (which -std=c89 does).  __USE_MINGW_ANSI_STDIO asks for the
 *      conforming implementations back.
 *   2. _WIN32_WINNT must be raised before <windows.h> so that condition
 *      variables / TryEnterCriticalSection are visible.
 *
 * Nothing here depends on anything else in seIDE, so a fork may replace it.
 */
#ifndef SEIDE_CFG_H
#define SEIDE_CFG_H

#if defined(_WIN32)

#  ifndef __USE_MINGW_ANSI_STDIO
#    define __USE_MINGW_ANSI_STDIO 1
#  endif

#  ifndef _WIN32_WINNT
#    define _WIN32_WINNT 0x0600
#  endif

#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN 1
#  endif

#  define SDE_PLATFORM_WIN32 1

#else
#  define SDE_PLATFORM_POSIX 1
#endif

/* The kernel's own version, reported by `hello` and `seide version`. */
#define SDE_VERSION "0.4.1-alpha.1"
#define SDE_PROTOCOL "seide/3"
/* The same version as a number, which is what machines compare. */
#define SDE_PROTOCOL_VERSION 3

/* Compile-time switches a fork flips to cut whole subsystems out. */
#ifndef SDE_WITH_PROC
#  define SDE_WITH_PROC 1
#endif
#ifndef SDE_WITH_VIEW
#  define SDE_WITH_VIEW 1
#endif

#endif /* SEIDE_CFG_H */
