/*
 * test_core.c - self-checks for the containers everything else is built on
 * (buf, vec) and for the depth promise the JSON codec makes on both sides.
 *
 * The reader refuses a document nested deeper than SDE_JSON_MAX_DEPTH and the
 * writer refuses a tree that deep, so a hand-built document cannot walk off
 * the stack on the way out of the codec.  Neither side had a test that sat on
 * the boundary; the fuzz loop at the bottom is what checks that the reader
 * survives input nobody wrote on purpose.
 *
 * Not part of the shipped kernel.  Run by `make test`.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "buf.h"
#include "json.h"
#include "vec.h"

static int failures = 0;

static void ok(int cond, const char *what)
{
    if (!cond) {
        failures++;
        printf("FAIL %s\n", what);
    } else {
        printf("ok   %s\n", what);
    }
}

/* ---------------------------------------------------------------------- */
/* buf: a growth request that cannot be represented is refused              */
/* ---------------------------------------------------------------------- */

static void test_buf_limits(void)
{
    sde_buf b;
    char   *before;

    sde_buf_init(&b);
    b.len = 16u;

    /* len + extra + 1 would wrap; the request must come back as a refusal. */
    ok(sde_buf_reserve(&b, (size_t) -1) != 0,
       "buf: an unrepresentable request is refused");
    ok(b.data == NULL && b.cap == 0u, "buf: a refused request changes nothing");

    /* Ordinary growth still works after a refusal. */
    b.len = 0u;
    ok(sde_buf_reserve(&b, 8u) == 0, "buf: growth after a refusal");
    ok(sde_buf_adds(&b, "abc") == 0 && b.len == 3u, "buf: append");
    ok(strcmp(sde_buf_cstr(&b), "abc") == 0, "buf: NUL-terminated");

    /*
     * A capacity past the point where doubling would wrap.  The branch that
     * matters is the one that stops doubling: without it this loop never ends
     * (cap doubles to 0, wraps back to the minimum, and spins forever).
     */
    before = b.data;
    b.cap = ((size_t) -1) / 2u + 1u;
    b.len = 0u;
    ok(sde_buf_reserve(&b, ((size_t) -1) / 2u + 1u) != 0,
       "buf: a doubling wrap is refused instead of spinning");
    ok(b.data == before && b.cap == ((size_t) -1) / 2u + 1u,
       "buf: the failed growth left the buffer alone");
    b.cap = 0u;   /* do not let free() see a capacity that never existed */
    sde_buf_free(&b);
}

/* ---------------------------------------------------------------------- */
/* vec: the same guard, and it must not ask for the impossible             */
/* ---------------------------------------------------------------------- */

static void test_vec_limits(void)
{
    sde_vec v;
    sde_vec *vp = &v;

    sde_vec_init(vp);
    ok(sde_vec_push(vp, (void *) "one") == 0, "vec: first push");
    ok(vp->count == 1, "vec: count follows the push");

    /*
     * A count that has reached the largest capacity the byte arithmetic can
     * hold.  realloc() must never be asked for it: the guard has to fire
     * before the multiply, or the size wraps and we allocate a small buffer
     * that the next push writes past.
     */
    vp->count = ((size_t) -1) / 2u / sizeof(void *) + 1u;
    vp->cap = vp->count;
    ok(sde_vec_push(vp, (void *) "two") != 0, "vec: an impossible growth is refused");

    vp->count = 1u;
    vp->cap = 1u;
    sde_vec_free(vp);
}

/* ---------------------------------------------------------------------- */
/* json: the depth boundary, both directions                               */
/* ---------------------------------------------------------------------- */

static char *nested_doc(int depth)
{
    size_t n = (size_t) depth * 2u + 1u;
    char  *s = (char *) malloc(n + 1u);
    int    i;

    if (s == NULL) {
        return NULL;
    }
    for (i = 0; i < depth; i++) {
        s[i] = '[';
        s[n - 1u - (size_t) i] = ']';
    }
    s[depth] = '7';
    s[n] = '\0';
    return s;
}

static sde_json *nested_tree(int depth)
{
    sde_json *v = sde_json_int(7);
    int       i;

    for (i = 0; i < depth; i++) {
        sde_json *parent = sde_json_arr();

        if (parent == NULL) {
            sde_json_free(v);
            return NULL;
        }
        if (sde_json_push(parent, v) != 0) {
            sde_json_free(parent);
            sde_json_free(v);
            return NULL;
        }
        v = parent;
    }
    return v;
}

static void test_json_depth(void)
{
    char      err[128];
    char     *doc;
    sde_json *v;
    sde_buf   out;

    /*
     * The reader checks the limit for every value, so the deepest document it
     * takes nests SDE_JSON_MAX_DEPTH - 1 containers, and the writer has to
     * draw the line in the same place.
     */
    doc = nested_doc(SDE_JSON_MAX_DEPTH - 1);
    ok(doc != NULL, "json: build a document at the depth limit");
    err[0] = '\0';
    v = (doc == NULL) ? NULL
                      : sde_json_parse(doc, strlen(doc), err, sizeof(err));
    ok(v != NULL, "json: a document at the depth limit is accepted");
    if (v == NULL) {
        printf("     error: %s\n", err);
    } else {
        sde_buf_init(&out);
        ok(sde_json_write(&out, v) == 0,
           "json: what the reader accepts the writer can write");
        sde_buf_free(&out);
        sde_json_free(v);
    }
    free(doc);

    doc = nested_doc(SDE_JSON_MAX_DEPTH);
    ok(doc != NULL, "json: build a document past the depth limit");
    err[0] = '\0';
    v = (doc == NULL) ? NULL
                      : sde_json_parse(doc, strlen(doc), err, sizeof(err));
    ok(v == NULL, "json: a document past the depth limit is refused");
    ok(strstr(err, "nesting too deep") != NULL,
       "json: and the refusal names the reason");
    if (v != NULL) {
        sde_json_free(v);
    }
    free(doc);

    /* The writer: the same boundary for a tree built by hand. */
    v = nested_tree(SDE_JSON_MAX_DEPTH - 1);
    ok(v != NULL, "json: build a tree at the depth limit");
    if (v != NULL) {
        sde_buf_init(&out);
        ok(sde_json_write(&out, v) == 0,
           "json: a tree at the depth limit is written");
        sde_buf_free(&out);
        sde_json_free(v);
    }

    v = nested_tree(SDE_JSON_MAX_DEPTH);
    ok(v != NULL, "json: build a tree past the depth limit");
    if (v != NULL) {
        sde_buf_init(&out);
        ok(sde_json_write(&out, v) != 0,
           "json: a tree past the depth limit is refused, not walked");
        sde_buf_free(&out);
        sde_json_free(v);
    }

    /* Also the canonical writer, which sorts objects as it recurses. */
    v = nested_tree(SDE_JSON_MAX_DEPTH);
    if (v != NULL) {
        sde_buf_init(&out);
        ok(sde_json_write_canonical(&out, v) != 0,
           "json: the canonical writer refuses a tree that deep too");
        sde_buf_free(&out);
        sde_json_free(v);
    }
}

/* ---------------------------------------------------------------------- */
/* json: input nobody wrote on purpose                                     */
/* ---------------------------------------------------------------------- */

static void test_json_fuzz(void)
{
    static const char alphabet[] =
        "{}[]\",:0123456789.eE+-truefalsn\\/ \t\n\r\x01\xff";
    static const size_t rounds = 4000u;
    unsigned long state = 20261016ul;
    char  text[96];
    int   accepted = 0;
    int   bad = 0;
    size_t round;

    for (round = 0; round < rounds; round++) {
        size_t      n = 0;
        size_t      len;
        size_t      i;
        char        err[96];
        sde_json   *v;

        state = state * 1103515245ul + 12345ul;
        len = (state >> 16) % (sizeof(text) - 1u);
        for (i = 0; i < len; i++) {
            state = state * 1103515245ul + 12345ul;
            text[n] = alphabet[(state >> 16) % (sizeof(alphabet) - 1u)];
            n++;
        }
        text[n] = '\0';

        v = sde_json_parse(text, n, err, sizeof(err));
        if (v == NULL) {
            continue;   /* refusing junk is the ordinary answer */
        }
        accepted++;

        {
            sde_buf   out;
            sde_json *again;

            sde_buf_init(&out);
            if (sde_json_write(&out, v) != 0) {
                bad++;
            } else {
                again = sde_json_parse(sde_buf_cstr(&out), out.len, err,
                                       sizeof(err));
                if (again == NULL) {
                    bad++;
                    printf("     did not read back: %s\n", sde_buf_cstr(&out));
                } else {
                    sde_json_free(again);
                }
            }
            sde_buf_free(&out);
        }
        sde_json_free(v);
    }

    printf("     fuzz: %d of %lu documents accepted\n",
           accepted, (unsigned long) rounds);
    ok(bad == 0, "fuzz: every accepted document writes and reads back");
    ok(accepted > 0, "fuzz: the corpus reached the parser at all");
}

int main(void)
{
    test_buf_limits();
    test_vec_limits();
    test_json_depth();
    test_json_fuzz();
    printf(failures ? "\nFAILED (%d)\n" : "\nall good\n", failures);
    return failures ? 1 : 0;
}
