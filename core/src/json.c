/*
 * json.c - JSON tree, recursive-descent parser and writer.
 *
 * Written to the C89 subset: no // comments, no declarations after
 * statements, no long long, no compound literals.
 */
#include "seide_cfg.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include "json.h"

/* ====================================================================== */
/* construction / destruction                                             */
/* ====================================================================== */

static sde_json *jw_new(sde_json_type t)
{
    sde_json *v;

    v = (sde_json *) malloc(sizeof(sde_json));
    if (v == NULL) {
        return NULL;
    }
    memset(v, 0, sizeof(*v));
    v->type = t;
    return v;
}

sde_json *sde_json_null(void)
{
    return jw_new(SDE_JSON_NULL);
}

sde_json *sde_json_bool(int b)
{
    sde_json *v;

    v = jw_new(SDE_JSON_BOOL);
    if (v != NULL) {
        v->bval = b ? 1 : 0;
    }
    return v;
}

sde_json *sde_json_int(long n)
{
    sde_json *v;

    v = jw_new(SDE_JSON_NUM);
    if (v != NULL) {
        v->inum = 1;
        v->ival = n;
        v->nval = (double) n;
    }
    return v;
}

sde_json *sde_json_num(double d)
{
    sde_json *v;

    v = jw_new(SDE_JSON_NUM);
    if (v != NULL) {
        v->inum = 0;
        v->nval = d;
        v->ival = (long) d;
    }
    return v;
}

sde_json *sde_json_str(const char *s)
{
    sde_json *v;
    size_t    n;
    char     *copy;

    if (s == NULL) {
        s = "";
    }
    n = strlen(s);
    copy = (char *) malloc(n + 1);
    if (copy == NULL) {
        return NULL;
    }
    memcpy(copy, s, n + 1);

    v = jw_new(SDE_JSON_STR);
    if (v == NULL) {
        free(copy);
        return NULL;
    }
    v->sval = copy;
    return v;
}

/*
 * String of exactly `len` bytes.  Needed because process output is arbitrary
 * bytes: it may contain NULs, and it is not necessarily NUL-terminated.
 */
sde_json *sde_json_str_n(const char *s, size_t len)
{
    sde_json *v;
    char     *copy;

    if (s == NULL) {
        s = "";
        len = 0;
    }
    copy = (char *) malloc(len + 1);
    if (copy == NULL) {
        return NULL;
    }
    if (len > 0) {
        memcpy(copy, s, len);
    }
    copy[len] = '\0';

    v = jw_new(SDE_JSON_STR);
    if (v == NULL) {
        free(copy);
        return NULL;
    }
    v->sval = copy;
    return v;
}

sde_json *sde_json_arr(void)
{
    return jw_new(SDE_JSON_ARR);
}

/*
 * The explicit double cast matters: `unsigned long` is 32 bits here, all of
 * them meaningful, and 2^32-1 is exactly representable as a double, so this
 * prints every revision as a plain positive integer.
 */
sde_json *sde_json_rev(unsigned long rev)
{
    return sde_json_num((double) rev);
}

sde_json *sde_json_clone(const sde_json *v)
{
    sde_json *n;
    size_t    i;

    if (v == NULL) {
        return NULL;
    }

    switch (v->type) {
    case SDE_JSON_NULL:
        return sde_json_null();
    case SDE_JSON_BOOL:
        return sde_json_bool(v->bval);
    case SDE_JSON_NUM:
        return v->inum ? sde_json_int(v->ival) : sde_json_num(v->nval);
    case SDE_JSON_STR:
        return sde_json_str_n(v->sval, v->sval == NULL ? 0 : strlen(v->sval));
    case SDE_JSON_ARR:
        n = sde_json_arr();
        if (n == NULL) {
            return NULL;
        }
        for (i = 0; i < v->nelems; i++) {
            sde_json *e = sde_json_clone(v->elems[i]);
            if (e == NULL || sde_json_push(n, e) != 0) {
                sde_json_free(e);
                sde_json_free(n);
                return NULL;
            }
        }
        return n;
    case SDE_JSON_OBJ:
        n = sde_json_obj();
        if (n == NULL) {
            return NULL;
        }
        for (i = 0; i < v->nvals; i++) {
            sde_json *e = sde_json_clone(v->vals[i]);
            if (e == NULL || sde_json_set(n, v->keys[i], e) != 0) {
                sde_json_free(e);
                sde_json_free(n);
                return NULL;
            }
        }
        return n;
    default:
        return NULL;
    }
}

sde_json *sde_json_obj(void)
{
    return jw_new(SDE_JSON_OBJ);
}

void sde_json_free(sde_json *v)
{
    size_t i;

    if (v == NULL) {
        return;
    }
    switch (v->type) {
    case SDE_JSON_STR:
        free(v->sval);
        break;
    case SDE_JSON_ARR:
        for (i = 0; i < v->nelems; i++) {
            sde_json_free(v->elems[i]);
        }
        free(v->elems);
        break;
    case SDE_JSON_OBJ:
        for (i = 0; i < v->nvals; i++) {
            free(v->keys[i]);
            sde_json_free(v->vals[i]);
        }
        free(v->keys);
        free(v->vals);
        break;
    default:
        break;
    }
    free(v);
}

/* ====================================================================== */
/* arrays and objects                                                     */
/* ====================================================================== */

int sde_json_push(sde_json *a, sde_json *v)
{
    sde_json **grown;

    if (a == NULL || a->type != SDE_JSON_ARR) {
        return -1;
    }
    if (a->nelems == a->cvals) {
        size_t want;

        if (a->cvals > ((size_t) -1) / 2u / sizeof(sde_json *)) {
            return -1;
        }
        want = (a->cvals == 0) ? 8 : a->cvals * 2;
        if (want > ((size_t) -1) / sizeof(sde_json *)) {
            return -1;
        }
        grown = (sde_json **) realloc(a->elems, want * sizeof(sde_json *));
        if (grown == NULL) {
            return -1;
        }
        a->elems = grown;
        a->cvals = want;
    }
    a->elems[a->nelems++] = v;
    return 0;
}

size_t sde_json_count(const sde_json *v)
{
    if (v == NULL) {
        return 0;
    }
    if (v->type == SDE_JSON_ARR) {
        return v->nelems;
    }
    if (v->type == SDE_JSON_OBJ) {
        return v->nvals;
    }
    return 0;
}

sde_json *sde_json_at(const sde_json *v, size_t i)
{
    if (v == NULL || v->type != SDE_JSON_ARR || i >= v->nelems) {
        return NULL;
    }
    return v->elems[i];
}

sde_json *sde_json_get(const sde_json *o, const char *key)
{
    size_t i;

    if (o == NULL || o->type != SDE_JSON_OBJ || key == NULL) {
        return NULL;
    }
    for (i = 0; i < o->nvals; i++) {
        if (strcmp(o->keys[i], key) == 0) {
            return o->vals[i];
        }
    }
    return NULL;
}

int sde_json_set(sde_json *o, const char *key, sde_json *v)
{
    size_t i;
    char  *kcopy;
    size_t n;

    if (o == NULL || o->type != SDE_JSON_OBJ || key == NULL) {
        return -1;
    }

    for (i = 0; i < o->nvals; i++) {
        if (strcmp(o->keys[i], key) == 0) {
            sde_json_free(o->vals[i]);
            o->vals[i] = v;
            return 0;
        }
    }

    if (o->nvals == o->cvals) {
        size_t        want;
        char       **gk;
        sde_json   **gv;

        if (o->cvals > ((size_t) -1) / 2u) {
            return -1;
        }
        want = (o->cvals == 0) ? 8 : o->cvals * 2;
        if (want > ((size_t) -1) / sizeof(char *)
            || want > ((size_t) -1) / sizeof(sde_json *)) {
            return -1;
        }
        gk = (char **) realloc(o->keys, want * sizeof(char *));
        if (gk == NULL) {
            return -1;
        }
        o->keys = gk;
        gv = (sde_json **) realloc(o->vals, want * sizeof(sde_json *));
        if (gv == NULL) {
            return -1;
        }
        o->vals = gv;
        o->cvals = want;
    }

    n = strlen(key);
    kcopy = (char *) malloc(n + 1);
    if (kcopy == NULL) {
        return -1;
    }
    memcpy(kcopy, key, n + 1);

    o->keys[o->nvals] = kcopy;
    o->vals[o->nvals] = v;
    o->nvals++;
    return 0;
}

/* ====================================================================== */
/* typed accessors                                                        */
/* ====================================================================== */

int sde_json_is_null(const sde_json *v)
{
    return (v == NULL || v->type == SDE_JSON_NULL) ? 1 : 0;
}

const char *sde_json_as_str(const sde_json *v)
{
    if (v == NULL || v->type != SDE_JSON_STR) {
        return NULL;
    }
    return v->sval;
}

long sde_json_as_int(const sde_json *v, long dflt)
{
    if (v == NULL || v->type != SDE_JSON_NUM) {
        return dflt;
    }
    if (v->inum) {
        return v->ival;
    }
    return (long) v->nval;
}

double sde_json_as_num(const sde_json *v, double dflt)
{
    if (v == NULL || v->type != SDE_JSON_NUM) {
        return dflt;
    }
    return v->inum ? (double) v->ival : v->nval;
}

int sde_json_as_bool(const sde_json *v, int dflt)
{
    if (v == NULL) {
        return dflt;
    }
    if (v->type == SDE_JSON_BOOL) {
        return v->bval;
    }
    if (v->type == SDE_JSON_NUM) {
        return (v->inum ? v->ival : (long) v->nval) != 0;
    }
    return dflt;
}

const char *sde_json_gets(const sde_json *o, const char *key, const char *dflt)
{
    const char *s;

    s = sde_json_as_str(sde_json_get(o, key));
    return (s == NULL) ? dflt : s;
}

long sde_json_geti(const sde_json *o, const char *key, long dflt)
{
    return sde_json_as_int(sde_json_get(o, key), dflt);
}

int sde_json_getb(const sde_json *o, const char *key, int dflt)
{
    return sde_json_as_bool(sde_json_get(o, key), dflt);
}

/* ====================================================================== */
/* parser                                                                 */
/* ====================================================================== */

typedef struct jp_state {
    const char *start;
    const char *p;
    const char *end;
    int         depth;
    int         failed;
    char       *err;
    size_t      errcap;
} jp_state;

static void jp_err(jp_state *j, const char *msg)
{
    size_t off;

    if (j->failed) {
        return;
    }
    j->failed = 1;
    if (j->err != NULL && j->errcap > 0) {
        off = (size_t) (j->p - j->start);
        snprintf(j->err, j->errcap, "offset %lu: %s",
                 (unsigned long) off, msg);
        j->err[j->errcap - 1] = '\0';
    }
}

static void jp_ws(jp_state *j)
{
    while (j->p < j->end) {
        char c = *j->p;
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            j->p++;
        } else {
            break;
        }
    }
}

static int jp_hex4(jp_state *j, unsigned long *out)
{
    unsigned long v = 0;
    int           i;

    for (i = 0; i < 4; i++) {
        char c;
        if (j->p >= j->end) {
            jp_err(j, "truncated \\u escape");
            return -1;
        }
        c = *j->p++;
        v <<= 4;
        if (c >= '0' && c <= '9') {
            v |= (unsigned long) (c - '0');
        } else if (c >= 'a' && c <= 'f') {
            v |= (unsigned long) (c - 'a' + 10);
        } else if (c >= 'A' && c <= 'F') {
            v |= (unsigned long) (c - 'A' + 10);
        } else {
            jp_err(j, "bad hex digit in \\u escape");
            return -1;
        }
    }
    *out = v;
    return 0;
}

static int jp_utf8(sde_buf *b, unsigned long cp)
{
    if (cp < 0x80UL) {
        return sde_buf_addc(b, (char) cp);
    }
    if (cp < 0x800UL) {
        if (sde_buf_addc(b, (char) (0xC0UL | (cp >> 6))) != 0) {
            return -1;
        }
        return sde_buf_addc(b, (char) (0x80UL | (cp & 0x3FUL)));
    }
    if (cp < 0x10000UL) {
        if (sde_buf_addc(b, (char) (0xE0UL | (cp >> 12))) != 0) {
            return -1;
        }
        if (sde_buf_addc(b, (char) (0x80UL | ((cp >> 6) & 0x3FUL))) != 0) {
            return -1;
        }
        return sde_buf_addc(b, (char) (0x80UL | (cp & 0x3FUL)));
    }
    if (sde_buf_addc(b, (char) (0xF0UL | (cp >> 18))) != 0) {
        return -1;
    }
    if (sde_buf_addc(b, (char) (0x80UL | ((cp >> 12) & 0x3FUL))) != 0) {
        return -1;
    }
    if (sde_buf_addc(b, (char) (0x80UL | ((cp >> 6) & 0x3FUL))) != 0) {
        return -1;
    }
    return sde_buf_addc(b, (char) (0x80UL | (cp & 0x3FUL)));
}

/* Reads one string body (the opening quote is at j->p) into `out`. */
static int jp_string(jp_state *j, sde_buf *out)
{
    j->p++; /* consume '"' */

    for (;;) {
        unsigned char c;

        if (j->p >= j->end) {
            jp_err(j, "unterminated string");
            return -1;
        }
        c = (unsigned char) *j->p++;

        if (c == '"') {
            return 0;
        }
        if (c < 0x20) {
            jp_err(j, "raw control character in string");
            return -1;
        }
        if (c != '\\') {
            if (sde_buf_addc(out, (char) c) != 0) {
                jp_err(j, "out of memory");
                return -1;
            }
            continue;
        }

        if (j->p >= j->end) {
            jp_err(j, "truncated escape");
            return -1;
        }
        c = (unsigned char) *j->p++;
        switch (c) {
        case '"':  if (sde_buf_addc(out, '"') != 0)  { goto oom; } break;
        case '\\': if (sde_buf_addc(out, '\\') != 0) { goto oom; } break;
        case '/':  if (sde_buf_addc(out, '/') != 0)  { goto oom; } break;
        case 'b':  if (sde_buf_addc(out, '\b') != 0) { goto oom; } break;
        case 'f':  if (sde_buf_addc(out, '\f') != 0) { goto oom; } break;
        case 'n':  if (sde_buf_addc(out, '\n') != 0) { goto oom; } break;
        case 'r':  if (sde_buf_addc(out, '\r') != 0) { goto oom; } break;
        case 't':  if (sde_buf_addc(out, '\t') != 0) { goto oom; } break;
        case 'u': {
            unsigned long cp;

            if (jp_hex4(j, &cp) != 0) {
                return -1;
            }
            if (cp >= 0xD800UL && cp <= 0xDBFFUL) {
                unsigned long lo;

                if (j->end - j->p >= 6 && j->p[0] == '\\' && j->p[1] == 'u') {
                    j->p += 2;
                    if (jp_hex4(j, &lo) != 0) {
                        return -1;
                    }
                    if (lo >= 0xDC00UL && lo <= 0xDFFFUL) {
                        cp = 0x10000UL + ((cp - 0xD800UL) << 10)
                                       + (lo - 0xDC00UL);
                    } else {
                        jp_err(j, "bad low surrogate");
                        return -1;
                    }
                } else {
                    jp_err(j, "lone high surrogate");
                    return -1;
                }
            } else if (cp >= 0xDC00UL && cp <= 0xDFFFUL) {
                jp_err(j, "lone low surrogate");
                return -1;
            }
            if (cp == 0UL) {
                /*
                 * Every string in this kernel is a NUL-terminated C string,
                 * so U+0000 is the one code point it cannot carry.  Accepting
                 * it would store a truncated value and report success -- a
                 * `file.write` of "a\u0000b" would quietly write one byte --
                 * so the transport refuses it instead.  The document is
                 * well-formed JSON, but it is not representable here, and
                 * that has to be an error rather than silent data loss.
                 */
                jp_err(j, "string contains U+0000, which cannot be carried");
                return -1;
            }
            if (jp_utf8(out, cp) != 0) {
                goto oom;
            }
            break;
        }
        default:
            jp_err(j, "unknown escape");
            return -1;
        }
    }

oom:
    jp_err(j, "out of memory");
    return -1;
}

static sde_json *jp_value(jp_state *j);

static sde_json *jp_strvalue(jp_state *j)
{
    sde_buf   b;
    sde_json *v;

    sde_buf_init(&b);
    if (jp_string(j, &b) != 0) {
        sde_buf_free(&b);
        return NULL;
    }
    v = sde_json_str(sde_buf_cstr(&b));
    sde_buf_free(&b);
    if (v == NULL) {
        jp_err(j, "out of memory");
    }
    return v;
}

static sde_json *jp_array(jp_state *j)
{
    sde_json *a;

    a = sde_json_arr();
    if (a == NULL) {
        jp_err(j, "out of memory");
        return NULL;
    }
    j->p++; /* '[' */
    jp_ws(j);

    if (j->p < j->end && *j->p == ']') {
        j->p++;
        return a;
    }
    for (;;) {
        sde_json *item;

        item = jp_value(j);
        if (item == NULL) {
            sde_json_free(a);
            return NULL;
        }
        if (sde_json_push(a, item) != 0) {
            sde_json_free(item);
            sde_json_free(a);
            jp_err(j, "out of memory");
            return NULL;
        }
        jp_ws(j);
        if (j->p >= j->end) {
            jp_err(j, "unterminated array");
            sde_json_free(a);
            return NULL;
        }
        if (*j->p == ',') {
            j->p++;
            continue;
        }
        if (*j->p == ']') {
            j->p++;
            return a;
        }
        jp_err(j, "expected ',' or ']'");
        sde_json_free(a);
        return NULL;
    }
}

static sde_json *jp_object(jp_state *j)
{
    sde_json *o;

    o = sde_json_obj();
    if (o == NULL) {
        jp_err(j, "out of memory");
        return NULL;
    }
    j->p++; /* '{' */
    jp_ws(j);

    if (j->p < j->end && *j->p == '}') {
        j->p++;
        return o;
    }
    for (;;) {
        sde_buf   kb;
        sde_json *item;
        char     *key;

        jp_ws(j);
        if (j->p >= j->end || *j->p != '"') {
            jp_err(j, "expected object key");
            sde_json_free(o);
            return NULL;
        }
        sde_buf_init(&kb);
        if (jp_string(j, &kb) != 0) {
            sde_buf_free(&kb);
            sde_json_free(o);
            return NULL;
        }
        key = sde_buf_take(&kb);
        sde_buf_free(&kb);
        if (key == NULL) {
            jp_err(j, "out of memory");
            sde_json_free(o);
            return NULL;
        }

        jp_ws(j);
        if (j->p >= j->end || *j->p != ':') {
            free(key);
            jp_err(j, "expected ':' after object key");
            sde_json_free(o);
            return NULL;
        }
        j->p++;

        item = jp_value(j);
        if (item == NULL) {
            free(key);
            sde_json_free(o);
            return NULL;
        }
        if (sde_json_set(o, key, item) != 0) {
            free(key);
            sde_json_free(item);
            sde_json_free(o);
            jp_err(j, "out of memory");
            return NULL;
        }
        free(key);

        jp_ws(j);
        if (j->p >= j->end) {
            jp_err(j, "unterminated object");
            sde_json_free(o);
            return NULL;
        }
        if (*j->p == ',') {
            j->p++;
            continue;
        }
        if (*j->p == '}') {
            j->p++;
            return o;
        }
        jp_err(j, "expected ',' or '}'");
        sde_json_free(o);
        return NULL;
    }
}

static sde_json *jp_literal(jp_state *j, const char *lit, sde_json *v)
{
    size_t n;

    n = strlen(lit);
    if ((size_t) (j->end - j->p) < n || strncmp(j->p, lit, n) != 0) {
        jp_err(j, "invalid literal");
        sde_json_free(v);
        return NULL;
    }
    j->p += n;
    return v;
}

static sde_json *jp_number(jp_state *j)
{
    char   tok[64];
    size_t n = 0;
    int    is_int = 1;
    size_t i;

    if (j->p < j->end && *j->p == '-') {
        tok[n++] = *j->p++;
    }
    if (j->p >= j->end || *j->p < '0' || *j->p > '9') {
        jp_err(j, "malformed number");
        return NULL;
    }
    if (*j->p == '0') {
        tok[n++] = *j->p++;
    } else {
        while (j->p < j->end && *j->p >= '0' && *j->p <= '9') {
            if (n >= sizeof(tok) - 1) {
                jp_err(j, "number literal too long");
                return NULL;
            }
            tok[n++] = *j->p++;
        }
    }
    if (j->p < j->end && *j->p == '.') {
        is_int = 0;
        if (n >= sizeof(tok) - 1) {
            jp_err(j, "number literal too long");
            return NULL;
        }
        tok[n++] = *j->p++;
        if (j->p >= j->end || *j->p < '0' || *j->p > '9') {
            jp_err(j, "malformed fraction");
            return NULL;
        }
        while (j->p < j->end && *j->p >= '0' && *j->p <= '9') {
            if (n >= sizeof(tok) - 1) {
                jp_err(j, "number literal too long");
                return NULL;
            }
            tok[n++] = *j->p++;
        }
    }
    if (j->p < j->end && (*j->p == 'e' || *j->p == 'E')) {
        is_int = 0;
        if (n >= sizeof(tok) - 1) {
            jp_err(j, "number literal too long");
            return NULL;
        }
        tok[n++] = *j->p++;
        if (j->p < j->end && (*j->p == '+' || *j->p == '-')) {
            if (n >= sizeof(tok) - 1) {
                jp_err(j, "number literal too long");
                return NULL;
            }
            tok[n++] = *j->p++;
        }
        if (j->p >= j->end || *j->p < '0' || *j->p > '9') {
            jp_err(j, "malformed exponent");
            return NULL;
        }
        while (j->p < j->end && *j->p >= '0' && *j->p <= '9') {
            if (n >= sizeof(tok) - 1) {
                jp_err(j, "number literal too long");
                return NULL;
            }
            tok[n++] = *j->p++;
        }
    }
    tok[n] = '\0';

    i = 0;
    while (i < n) {
        if (tok[i] == '.' || tok[i] == 'e' || tok[i] == 'E') {
            is_int = 0;
            break;
        }
        i++;
    }

    if (is_int) {
        char *end = NULL;
        long  v;

        errno = 0;
        v = strtol(tok, &end, 10);
        /*
         * `long` is 32 bits on Windows, but JSON integers are unbounded and
         * the kernel hands out 32-bit content revisions as plain numbers.
         * Without this check a revision like 3123124719 would come back as
         * LONG_MAX, so a client echoing it into `base_revision` would be told
         * its own file had changed.  Anything that does not fit becomes a
         * double, which is exact up to 2^53 and is what sde_json_as_num
         * already knows how to read.
         */
        if (errno != ERANGE && end != NULL && *end == '\0') {
            return sde_json_int(v);
        }
        errno = 0;
        return sde_json_num(strtod(tok, NULL));
    }
    return sde_json_num(strtod(tok, NULL));
}

static sde_json *jp_value(jp_state *j)
{
    sde_json *v;
    char      c;

    if (j->failed) {
        return NULL;
    }
    if (j->depth >= SDE_JSON_MAX_DEPTH) {
        jp_err(j, "nesting too deep");
        return NULL;
    }
    jp_ws(j);
    if (j->p >= j->end) {
        jp_err(j, "unexpected end of input");
        return NULL;
    }

    j->depth++;
    c = *j->p;
    v = NULL;

    if (c == '{') {
        v = jp_object(j);
    } else if (c == '[') {
        v = jp_array(j);
    } else if (c == '"') {
        v = jp_strvalue(j);
    } else if (c == 't') {
        v = jp_literal(j, "true", sde_json_bool(1));
    } else if (c == 'f') {
        v = jp_literal(j, "false", sde_json_bool(0));
    } else if (c == 'n') {
        v = jp_literal(j, "null", sde_json_null());
    } else if (c == '-' || (c >= '0' && c <= '9')) {
        v = jp_number(j);
    } else {
        jp_err(j, "unexpected character");
    }

    j->depth--;
    return v;
}

sde_json *sde_json_parse(const char *text, size_t len, char *err, size_t errcap)
{
    jp_state  j;
    sde_json *v;

    if (err != NULL && errcap > 0) {
        err[0] = '\0';
    }
    if (text == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "offset 0: null input");
        }
        return NULL;
    }

    j.start = text;
    j.p = text;
    j.end = text + len;
    j.depth = 0;
    j.failed = 0;
    j.err = err;
    j.errcap = errcap;

    v = jp_value(&j);
    if (v == NULL) {
        return NULL;
    }
    jp_ws(&j);
    if (j.p != j.end) {
        jp_err(&j, "trailing garbage");
        sde_json_free(v);
        return NULL;
    }
    return v;
}

/* ====================================================================== */
/* writer                                                                 */
/* ====================================================================== */

int sde_json_escape_n(sde_buf *out, const char *s, size_t len)
{
    size_t i;

    if (sde_buf_addc(out, '"') != 0) {
        return -1;
    }
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char) s[i];

        switch (c) {
        case '"':  if (sde_buf_adds(out, "\\\"") != 0) { return -1; } break;
        case '\\': if (sde_buf_adds(out, "\\\\") != 0) { return -1; } break;
        case '\b': if (sde_buf_adds(out, "\\b") != 0)  { return -1; } break;
        case '\f': if (sde_buf_adds(out, "\\f") != 0)  { return -1; } break;
        case '\n': if (sde_buf_adds(out, "\\n") != 0)  { return -1; } break;
        case '\r': if (sde_buf_adds(out, "\\r") != 0)  { return -1; } break;
        case '\t': if (sde_buf_adds(out, "\\t") != 0)  { return -1; } break;
        default:
            if (c < 0x20) {
                if (sde_buf_addf(out, "\\u%04x", (unsigned) c) != 0) {
                    return -1;
                }
            } else if (sde_buf_addc(out, (char) c) != 0) {
                return -1;
            }
            break;
        }
    }
    return sde_buf_addc(out, '"');
}

int sde_json_escape(sde_buf *out, const char *s)
{
    return sde_json_escape_n(out, s, strlen(s));
}

static int jw_indent(sde_buf *out, int indent, int level)
{
    int i;

    if (indent <= 0) {
        return 0;
    }
    if (sde_buf_addc(out, '\n') != 0) {
        return -1;
    }
    for (i = 0; i < indent * level; i++) {
        if (sde_buf_addc(out, ' ') != 0) {
            return -1;
        }
    }
    return 0;
}

static int jw_value(sde_buf *out, const sde_json *v, int indent, int level)
{
    size_t i;

    /*
     * The reader refuses a value sitting at SDE_JSON_MAX_DEPTH or deeper --
     * one check per value, so the deepest document it accepts nests
     * SDE_JSON_MAX_DEPTH - 1 containers.  The writer refuses at exactly the
     * same point, which is what keeps the two sides telling the same story
     * about what is a document.
     */
    if (level >= SDE_JSON_MAX_DEPTH) {
        return -1;
    }

    if (v == NULL) {
        return sde_buf_adds(out, "null");
    }

    switch (v->type) {
    case SDE_JSON_NULL:
        return sde_buf_adds(out, "null");

    case SDE_JSON_BOOL:
        return sde_buf_adds(out, v->bval ? "true" : "false");

    case SDE_JSON_NUM:
        if (v->inum) {
            return sde_buf_addi(out, v->ival);
        }
        return sde_buf_addf(out, "%.17g", v->nval);

    case SDE_JSON_STR:
        return sde_json_escape(out, v->sval);

    case SDE_JSON_ARR:
        if (sde_buf_addc(out, '[') != 0) {
            return -1;
        }
        for (i = 0; i < v->nelems; i++) {
            if (i > 0 && sde_buf_addc(out, ',') != 0) {
                return -1;
            }
            if (jw_indent(out, indent, level + 1) != 0) {
                return -1;
            }
            if (jw_value(out, v->elems[i], indent, level + 1) != 0) {
                return -1;
            }
        }
        if (indent > 0 && v->nelems > 0) {
            if (jw_indent(out, indent, level) != 0) {
                return -1;
            }
        }
        return sde_buf_addc(out, ']');

    case SDE_JSON_OBJ:
        if (sde_buf_addc(out, '{') != 0) {
            return -1;
        }
        for (i = 0; i < v->nvals; i++) {
            if (i > 0 && sde_buf_addc(out, ',') != 0) {
                return -1;
            }
            if (jw_indent(out, indent, level + 1) != 0) {
                return -1;
            }
            if (sde_json_escape(out, v->keys[i]) != 0) {
                return -1;
            }
            if (sde_buf_addc(out, ':') != 0) {
                return -1;
            }
            if (indent > 0 && sde_buf_addc(out, ' ') != 0) {
                return -1;
            }
            if (jw_value(out, v->vals[i], indent, level + 1) != 0) {
                return -1;
            }
        }
        if (indent > 0 && v->nvals > 0) {
            if (jw_indent(out, indent, level) != 0) {
                return -1;
            }
        }
        return sde_buf_addc(out, '}');
    }

    return -1;
}

int sde_json_write(sde_buf *out, const sde_json *v)
{
    return jw_value(out, v, 0, 0);
}

/*
 * Canonical form: equal values always serialise to equal bytes.  Object members
 * are written sorted by key; arrays keep their order, because an array is a
 * sequence and its order is part of the value.
 *
 * Revisions are content hashes, so they have to be taken over this form rather
 * than over whatever member order arrived on the wire.  Otherwise two clients
 * holding the same object, one of which wrote `version` first and the other
 * `links`, compute different revisions for it and hand each other a spurious
 * STALE_REVISION.
 */
static int jw_canonical_at(sde_buf *out, const sde_json *v, int level)
{
    size_t i;
    size_t j;

    /* Same promise as jw_value(): refuse a tree the reader would refuse. */
    if (level >= SDE_JSON_MAX_DEPTH) {
        return -1;
    }

    if (v == NULL) {
        return sde_buf_adds(out, "null");
    }

    switch (v->type) {
    case SDE_JSON_NULL:
        return sde_buf_adds(out, "null");

    case SDE_JSON_BOOL:
        return sde_buf_adds(out, v->bval ? "true" : "false");

    case SDE_JSON_NUM:
        if (v->inum) {
            return sde_buf_addi(out, v->ival);
        }
        return sde_buf_addf(out, "%.17g", v->nval);

    case SDE_JSON_STR:
        return sde_json_escape(out, v->sval);

    case SDE_JSON_ARR:
        if (sde_buf_addc(out, '[') != 0) {
            return -1;
        }
        for (i = 0; i < v->nelems; i++) {
            if (i > 0 && sde_buf_addc(out, ',') != 0) {
                return -1;
            }
            if (jw_canonical_at(out, v->elems[i], level + 1) != 0) {
                return -1;
            }
        }
        return sde_buf_addc(out, ']');

    case SDE_JSON_OBJ:
        {
            size_t *order;
            int     rc;

            if (v->nvals == 0) {
                return sde_buf_adds(out, "{}");
            }
            order = (size_t *) malloc(v->nvals * sizeof(size_t));
            if (order == NULL) {
                return -1;
            }
            for (i = 0; i < v->nvals; i++) {
                order[i] = i;
            }
            /* Insertion sort: objects have a handful of members, not thousands. */
            for (i = 1; i < v->nvals; i++) {
                size_t here = order[i];

                j = i;
                while (j > 0
                       && strcmp(v->keys[order[j - 1]], v->keys[here]) > 0) {
                    order[j] = order[j - 1];
                    j--;
                }
                order[j] = here;
            }

            rc = sde_buf_addc(out, '{');
            for (i = 0; rc == 0 && i < v->nvals; i++) {
                size_t at = order[i];

                if (i > 0) {
                    rc = sde_buf_addc(out, ',');
                }
                if (rc == 0) {
                    rc = sde_json_escape(out, v->keys[at]);
                }
                if (rc == 0) {
                    rc = sde_buf_addc(out, ':');
                }
                if (rc == 0) {
                    rc = jw_canonical_at(out, v->vals[at], level + 1);
                }
            }
            free(order);
            if (rc != 0) {
                return -1;
            }
            return sde_buf_addc(out, '}');
        }
    }

    return -1;
}

static int jw_canonical(sde_buf *out, const sde_json *v)
{
    return jw_canonical_at(out, v, 0);
}

int sde_json_write_canonical(sde_buf *out, const sde_json *v)
{
    return jw_canonical(out, v);
}

int sde_json_write_pretty(sde_buf *out, const sde_json *v, int indent)
{
    if (indent <= 0) {
        indent = 2;
    }
    return jw_value(out, v, indent, 0);
}
