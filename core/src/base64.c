#include "seide_cfg.h"

#include "base64.h"

#include <stdlib.h>

static const char b64_alpha[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *sde_base64_encode(const char *data, size_t len)
{
    size_t groups;
    size_t rem;
    size_t outlen;
    size_t i;
    size_t j;
    char  *out;

    if (len > 0u && data == (const char *) 0) {
        return (char *) 0;
    }
    groups = len / 3u;
    rem = len % 3u;
    /*
     * Four characters per group plus a byte for the terminator.  A length that
     * cannot be encoded without wrapping size_t is refused rather than
     * allocated: a caller that asks for 2^62 bytes has a bug, and the honest
     * answer is NULL.
     */
    if (groups > (((size_t) -1) - 8u) / 4u) {
        return (char *) 0;
    }
    /*
     * Four characters per group, and a partial group still costs four: the
     * padding is written, not implied.  Getting this wrong by counting a
     * partial group as `rem + 1` characters under-allocates by four bytes and
     * corrupts the heap, which is exactly what the round-trip test caught.
     */
    outlen = groups * 4u + (rem == 0u ? 0u : 4u);
    out = (char *) malloc(outlen + 1u);
    if (out == (char *) 0) {
        return (char *) 0;
    }

    j = 0u;
    for (i = 0u; i + 3u <= len; i += 3u) {
        unsigned long v = ((unsigned long) (unsigned char) data[i] << 16)
                        | ((unsigned long) (unsigned char) data[i + 1u] << 8)
                        | (unsigned long) (unsigned char) data[i + 2u];
        out[j++] = b64_alpha[(v >> 18) & 0x3Fu];
        out[j++] = b64_alpha[(v >> 12) & 0x3Fu];
        out[j++] = b64_alpha[(v >> 6) & 0x3Fu];
        out[j++] = b64_alpha[v & 0x3Fu];
    }
    if (rem == 1u) {
        unsigned long v = (unsigned long) (unsigned char) data[i] << 16;
        out[j++] = b64_alpha[(v >> 18) & 0x3Fu];
        out[j++] = b64_alpha[(v >> 12) & 0x3Fu];
        out[j++] = '=';
        out[j++] = '=';
    } else if (rem == 2u) {
        unsigned long v = ((unsigned long) (unsigned char) data[i] << 16)
                        | ((unsigned long) (unsigned char) data[i + 1u] << 8);
        out[j++] = b64_alpha[(v >> 18) & 0x3Fu];
        out[j++] = b64_alpha[(v >> 12) & 0x3Fu];
        out[j++] = b64_alpha[(v >> 6) & 0x3Fu];
        out[j++] = '=';
    }
    out[j] = '\0';
    return out;
}

static int b64_val(char c)
{
    if (c >= 'A' && c <= 'Z') {
        return c - 'A';
    }
    if (c >= 'a' && c <= 'z') {
        return c - 'a' + 26;
    }
    if (c >= '0' && c <= '9') {
        return c - '0' + 52;
    }
    if (c == '+') {
        return 62;
    }
    if (c == '/') {
        return 63;
    }
    return -1;
}

int sde_base64_decode(const char *s, size_t len, char **out, size_t *outlen)
{
    char  *buf;
    size_t cap;
    size_t i;
    size_t j;

    if (out != (char **) 0) {
        *out = (char *) 0;
    }
    if (outlen != (size_t *) 0) {
        *outlen = 0u;
    }
    if (s == (const char *) 0 || len % 4u != 0u || len / 4u > ((size_t) -1) / 3u) {
        return -1;
    }
    cap = len / 4u * 3u;
    buf = (char *) malloc(cap + 1u);
    if (buf == (char *) 0) {
        return -1;
    }

    j = 0u;
    for (i = 0u; i < len; i += 4u) {
        int v0 = b64_val(s[i]);
        int v1 = b64_val(s[i + 1u]);
        int v2;
        int v3;

        if (v0 < 0 || v1 < 0) {
            goto bad;
        }
        if (s[i + 2u] == '=') {
            /* Two pads: one byte, and nothing may follow this group. */
            if (s[i + 3u] != '=' || i + 4u != len) {
                goto bad;
            }
            if ((v1 & 0x0F) != 0) {
                goto bad;   /* those bits belong to no byte */
            }
            buf[j++] = (char) (unsigned char) ((v0 << 2) | (v1 >> 4));
            break;
        }
        if (s[i + 3u] == '=') {
            /* One pad: two bytes, and this group ends the string. */
            if (i + 4u != len) {
                goto bad;
            }
            v2 = b64_val(s[i + 2u]);
            if (v2 < 0) {
                goto bad;
            }
            if ((v2 & 0x03) != 0) {
                goto bad;
            }
            buf[j++] = (char) (unsigned char) ((v0 << 2) | (v1 >> 4));
            buf[j++] = (char) (unsigned char) (((v1 & 0x0F) << 4) | (v2 >> 2));
            break;
        }
        v2 = b64_val(s[i + 2u]);
        v3 = b64_val(s[i + 3u]);
        if (v2 < 0 || v3 < 0) {
            goto bad;
        }
        buf[j++] = (char) (unsigned char) ((v0 << 2) | (v1 >> 4));
        buf[j++] = (char) (unsigned char) (((v1 & 0x0F) << 4) | (v2 >> 2));
        buf[j++] = (char) (unsigned char) (((v2 & 0x03) << 6) | v3);
    }

    buf[j] = '\0';
    if (out != (char **) 0) {
        *out = buf;
    } else {
        free(buf);
    }
    if (outlen != (size_t *) 0) {
        *outlen = j;
    }
    return 0;

bad:
    free(buf);
    return -1;
}
