#include "seide_cfg.h"

#include "buf.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SDE_BUF_MIN_CAP 64u

/*
 * va_copy() is C99, so the C89 build cannot use it.  __va_copy is the GNU
 * spelling and exists in every GCC/MinGW of interest, including under
 * -std=c89 -pedantic (double-underscore identifiers are not reserved to the
 * implementation, so -pedantic stays quiet).
 */
#if defined(__GNUC__)
#  define SDE_VA_COPY(dst, src) __va_copy(dst, src)
#else
#  define SDE_VA_COPY(dst, src) ((dst) = (src))
#endif

void sde_buf_init(sde_buf *b)
{
    b->data = (char *) 0;
    b->len = 0u;
    b->cap = 0u;
}

void sde_buf_free(sde_buf *b)
{
    if (b->data != (char *) 0) {
        free(b->data);
    }
    sde_buf_init(b);
}

void sde_buf_clear(sde_buf *b)
{
    b->len = 0u;
    if (b->data != (char *) 0) {
        b->data[0] = '\0';
    }
}

int sde_buf_reserve(sde_buf *b, size_t extra)
{
    size_t need;
    size_t cap;
    char  *grown;

    /*
     * len + extra + 1 has to be representable.  Nothing here can reach that
     * with a 64-bit size_t, but the arithmetic is the kind that wraps
     * silently, and a wrap would turn a size nobody has into a buffer that is
     * far too small.
     */
    if (extra > (size_t) -1 - b->len - 1u) {
        return -1;
    }
    need = b->len + extra + 1u;
    if (need <= b->cap) {
        return 0;
    }

    cap = (b->cap == 0u) ? SDE_BUF_MIN_CAP : b->cap;
    while (cap < need) {
        if (cap > ((size_t) -1) / 2u) {
            /* Doubling would wrap; the requirement itself still fits. */
            cap = need;
            break;
        }
        cap = cap * 2u;
        if (cap < SDE_BUF_MIN_CAP) {
            cap = SDE_BUF_MIN_CAP;
        }
    }

    grown = (char *) realloc(b->data, cap);
    if (grown == (char *) 0) {
        return -1;
    }
    b->data = grown;
    b->cap = cap;
    return 0;
}

int sde_buf_add(sde_buf *b, const char *data, size_t len)
{
    if (len == 0u) {
        return 0;
    }
    if (sde_buf_reserve(b, len) != 0) {
        return -1;
    }
    memcpy(b->data + b->len, data, len);
    b->len += len;
    b->data[b->len] = '\0';
    return 0;
}

int sde_buf_addc(sde_buf *b, char c)
{
    return sde_buf_add(b, &c, 1u);
}

int sde_buf_adds(sde_buf *b, const char *s)
{
    if (s == (const char *) 0) {
        return 0;
    }
    return sde_buf_add(b, s, strlen(s));
}

int sde_buf_addi(sde_buf *b, long v)
{
    char tmp[32];
    sprintf(tmp, "%ld", v);
    return sde_buf_adds(b, tmp);
}

int sde_buf_addf(sde_buf *b, const char *fmt, ...)
{
    va_list ap;
    va_list ap2;
    int     n;
    size_t  room;

    if (sde_buf_reserve(b, 128u) != 0) {
        return -1;
    }

    room = b->cap - b->len;
    va_start(ap, fmt);
    SDE_VA_COPY(ap2, ap);
    n = vsnprintf(b->data + b->len, room, fmt, ap);
    va_end(ap);

    if (n < 0) {
        va_end(ap2);
        return -1;
    }

    if ((size_t) n >= room) {
        if (sde_buf_reserve(b, (size_t) n) != 0) {
            va_end(ap2);
            return -1;
        }
        room = b->cap - b->len;
        n = vsnprintf(b->data + b->len, room, fmt, ap2);
        va_end(ap2);
        if (n < 0 || (size_t) n >= room) {
            return -1;
        }
    } else {
        va_end(ap2);
    }

    b->len += (size_t) n;
    return 0;
}

const char *sde_buf_cstr(sde_buf *b)
{
    if (b->data == (char *) 0) {
        if (sde_buf_reserve(b, 1u) != 0) {
            return "";
        }
        b->data[0] = '\0';
    }
    b->data[b->len] = '\0';
    return b->data;
}

char *sde_buf_take(sde_buf *b)
{
    char *out;

    (void) sde_buf_cstr(b);
    out = b->data;
    if (out == (char *) 0) {
        out = (char *) malloc(1u);
        if (out != (char *) 0) {
            out[0] = '\0';
        }
    }
    b->data = (char *) 0;
    b->len = 0u;
    b->cap = 0u;
    return out;
}
