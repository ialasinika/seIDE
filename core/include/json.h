/*
 * json.h - a small JSON tree, its parser and its writer.
 *
 * seIDE's kernel talks to the outside world in exactly one wire format:
 * newline-delimited JSON.  This module is that format.  It is written as a
 * plain owned tree (no arena, no sharing) because the kernel's messages are
 * small and short-lived, and because a fork that wants a different serializer
 * can replace this single translation unit without touching anything else.
 *
 * Conventions, matching buf.h / vec.h:
 *   0  means success
 *  -1  means failure (out of memory, or a malformed document)
 *
 * Ownership: sde_json_set() and sde_json_push() take ownership of the value
 * they are handed.  sde_json_free() on the container frees the whole tree.
 */
#ifndef SEIDE_JSON_H
#define SEIDE_JSON_H

#include <stddef.h>
#include "buf.h"

/*
 * The nesting limit.  The reader checks it for every value it parses, so a
 * document may nest at most SDE_JSON_MAX_DEPTH - 1 containers; the writer
 * refuses a tree at exactly the same point, so what the reader accepts the
 * writer can write, and neither can be made to recurse without limit.
 */
#define SDE_JSON_MAX_DEPTH 64

typedef enum sde_json_type {
    SDE_JSON_NULL = 0,
    SDE_JSON_BOOL,
    SDE_JSON_NUM,
    SDE_JSON_STR,
    SDE_JSON_ARR,
    SDE_JSON_OBJ
} sde_json_type;

typedef struct sde_json sde_json;

struct sde_json {
    sde_json_type type;

    /* scalar payloads; which one is live is decided by `type` and `inum` */
    int           bval;
    int           inum;   /* NUM: 1 = ival is the exact value */
    long          ival;
    double        nval;
    char         *sval;

    /* ARR payload */
    sde_json    **elems;
    size_t        nelems;

    /* OBJ payload; keys[i] belongs with vals[i] */
    char        **keys;
    sde_json    **vals;
    size_t        nvals;
    size_t        cvals;
};

/* --- construction ------------------------------------------------------- */

sde_json    *sde_json_null(void);
sde_json    *sde_json_bool(int b);
sde_json    *sde_json_int(long v);
sde_json    *sde_json_num(double v);
sde_json    *sde_json_str(const char *s);

/*
 * A string of exactly `len` bytes.  Process output is arbitrary bytes and is
 * not necessarily NUL-terminated, so the writer of it must not guess.
 */
sde_json    *sde_json_str_n(const char *s, size_t len);
sde_json    *sde_json_arr(void);
sde_json    *sde_json_obj(void);
void         sde_json_free(sde_json *v);

/*
 * A content revision, as produced by sde_rev_of().  Emitted as a plain
 * non-negative number: a revision is a 32-bit hash, and printing it through
 * a signed long makes half of them negative, which reads as nonsense in the
 * UI and forces every client to hand back a negative number that the kernel
 * then converts to unsigned.  That conversion is undefined behaviour in C,
 * however reliably x86 wraps it, so the sign is dropped at the source.
 */
sde_json    *sde_json_rev(unsigned long rev);

/*
 * Deep copy.  Needed wherever a module hands out a tree it still owns -- a
 * view document is the case that forced it.
 */
sde_json    *sde_json_clone(const sde_json *v);

/* --- parsing ------------------------------------------------------------ */

/*
 * Parses `len` bytes of `text`.  On failure returns NULL and, when `err` is
 * non-NULL, writes a human-readable "offset N: reason" message into it.
 * Trailing whitespace is allowed; trailing garbage is not.
 */
sde_json    *sde_json_parse(const char *text, size_t len,
                            char *err, size_t errcap);

/* --- arrays ------------------------------------------------------------- */

int          sde_json_push(sde_json *a, sde_json *v);
size_t       sde_json_count(const sde_json *v);
sde_json    *sde_json_at(const sde_json *v, size_t i);

/* --- objects ------------------------------------------------------------ */

int          sde_json_set(sde_json *o, const char *key, sde_json *v);
sde_json    *sde_json_get(const sde_json *o, const char *key);

/* --- typed accessors ---------------------------------------------------- */

int          sde_json_is_null(const sde_json *v);
const char  *sde_json_as_str(const sde_json *v);
long         sde_json_as_int(const sde_json *v, long dflt);
double       sde_json_as_num(const sde_json *v, double dflt);
int          sde_json_as_bool(const sde_json *v, int dflt);

const char  *sde_json_gets(const sde_json *o, const char *key, const char *dflt);
long         sde_json_geti(const sde_json *o, const char *key, long dflt);
int          sde_json_getb(const sde_json *o, const char *key, int dflt);

/* --- writing ------------------------------------------------------------ */

int          sde_json_write(sde_buf *out, const sde_json *v);
int          sde_json_write_canonical(sde_buf *out, const sde_json *v);
int          sde_json_write_pretty(sde_buf *out, const sde_json *v, int indent);

/* Escaping helpers, also used to build raw protocol frames by hand. */
int          sde_json_escape_n(sde_buf *out, const char *s, size_t len);
int          sde_json_escape(sde_buf *out, const char *s);

#endif /* SEIDE_JSON_H */
