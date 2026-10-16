/*
 * base64.h - the encoding binary travels in.
 *
 * The protocol is one JSON object per line and a JSON string cannot carry a
 * NUL byte (the kernel's own reader stops at the first one), so a byte that is
 * not known to be text goes out as base64: the standard alphabet, `=` padding,
 * no line breaks.  The price is four characters per three bytes, paid only by
 * the binary path.
 */
#ifndef SEIDE_BASE64_H
#define SEIDE_BASE64_H

#include <stddef.h>

/*
 * Encodes `len` bytes.  Returns a malloc'd, NUL-terminated string -- `""` for
 * no bytes -- or NULL out of memory.  `data` may hold NUL bytes and any other
 * byte value; that is the whole point.
 */
char *sde_base64_encode(const char *data, size_t len);

/*
 * Decodes `len` characters, strictly.
 *
 * Anything outside the alphabet, `=` anywhere but at the end, a length that is
 * not a multiple of four and a final group whose unused bits are not zero are
 * all refused: a client that sends a malformed chunk is told so instead of
 * having silent garbage written to disk.  A NUL in `s` is not special: `len` is
 * the length.
 *
 * On success *out is malloc'd (NUL-terminated as a convenience for callers that
 * only ever handle text) and *outlen is the decoded length, which may be 0 for
 * an empty input.  Returns 0, or -1 with *out NULL.
 */
int sde_base64_decode(const char *s, size_t len, char **out, size_t *outlen);

#endif /* SEIDE_BASE64_H */
