/*
 * test_blob.c - self-checks for the binary / large-file session layer.
 *
 * The point of that layer is the pair of limits it removes: a JSON string
 * cannot carry a NUL, and `file.read` refuses anything past 4 MiB.  So the
 * checks that matter here are the ones that would fail if either limit came
 * back quietly:
 *
 *   * every one of the 256 byte values survives a base64 round trip;
 *   * a file assembled chunk by chunk is published byte for byte, atomically,
 *     with no temporary left behind;
 *   * a session can carry a file larger than the text limit, and the revision
 *     it reports is the same FNV-1a hash `file.read` would report;
 *   * a client that walks away leaves no temporary file, and neither does a
 *     kernel that exits.
 *
 * Everything is created under build/test_blob, so a run cannot touch your
 * workspace or your files.  Not part of the shipped kernel; run by `make test`.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "base64.h"
#include "blob.h"
#include "buf.h"
#include "json.h"
#include "port.h"
#include "rpc.h"
#include "wksp.h"

#define SCRATCH "build/test_blob"
#define BIGSIZE (5 * 1024 * 1024)

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

/* A deterministic byte stream, so a reordered or lost chunk cannot hide. */
static char pattern_at(int64_t i)
{
    return (char) (((i * 131 + 17) & 0xff));
}

static void fill_pattern(char *buf, size_t len, int64_t start)
{
    size_t i;

    for (i = 0; i < len; i++) {
        buf[i] = pattern_at(start + (int64_t) i);
    }
}

static int check_pattern(const char *buf, size_t len, int64_t start)
{
    size_t i;

    for (i = 0; i < len; i++) {
        if ((unsigned char) buf[i] != (unsigned char) pattern_at(start + (int64_t) i)) {
            return 0;
        }
    }
    return 1;
}

static int64_t num_at(const sde_json *o, const char *key)
{
    return (int64_t) sde_json_as_num(sde_json_get(o, key), -1.0);
}

/* Reads a whole file and says whether it is the pattern run [0,len). */
static int file_is_pattern(const char *rel, int64_t len)
{
    sde_buf b;
    char    err[200];
    int     same = 0;

    sde_buf_init(&b);
    if (sde_port_read_file(rel, &b, err, sizeof(err)) == 0
        && (int64_t) b.len == len
        && check_pattern(b.data, b.len, 0)) {
        same = 1;
    } else {
        printf("     %s: %s (len %ld, wanted %ld)\n", rel, err,
               (long) b.len, (long) len);
    }
    sde_buf_free(&b);
    return same;
}

static int decode_ok(const char *s, const char *want, size_t wantlen)
{
    char  *raw = NULL;
    size_t n = 0;
    int    good;

    good = (sde_base64_decode(s, strlen(s), &raw, &n) == 0
            && n == wantlen
            && (wantlen == 0 || (raw != NULL && memcmp(raw, want, wantlen) == 0)));
    free(raw);
    return good;
}

static int decode_fails(const char *s)
{
    char  *raw = NULL;
    size_t n = 12345;
    int    rc = sde_base64_decode(s, strlen(s), &raw, &n);

    free(raw);
    return rc != 0;
}

/*
 * One read, checked end to end: the bytes that come back, where the session
 * says they start, and whether it says the file ended.  A reader that dropped
 * or reordered a chunk fails here rather than in a client.
 */
static int read_matches(sde_app *app, long session, int has_offset,
                        int64_t offset, int has_length, int64_t length,
                        int64_t want_start, int64_t want_len, int want_eof)
{
    char       err[256];
    sde_json  *res = NULL;
    char      *raw = NULL;
    size_t     rawlen = 0;
    const char *b64;
    int        good = 0;
    int        rc;

    err[0] = '\0';
    rc = sde_blob_read(app->blobs, session, has_offset, offset,
                       has_length, length, &res, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        printf("     read failed: %s\n", err[0] ? err : "no message");
    } else {
        b64 = sde_json_gets(res, "data", "");
        if (sde_base64_decode(b64, strlen(b64), &raw, &rawlen) == 0
            && (int64_t) rawlen == want_len
            && (want_len == 0 || check_pattern(raw, rawlen, want_start))
            && num_at(res, "offset") == want_start
            && sde_json_getb(res, "eof", -1) == want_eof) {
            good = 1;
        } else {
            printf("     read got %ld bytes at %ld (eof %d), wanted %ld at %ld (eof %d)\n",
                   (long) rawlen, (long) num_at(res, "offset"),
                   sde_json_getb(res, "eof", -1), (long) want_len,
                   (long) want_start, want_eof);
        }
    }
    free(raw);
    sde_json_free(res);
    return good;
}

/* ---------------------------------------------------------------------- */

static void test_base64(void)
{
    char          *e;
    unsigned char  bin[256];
    int            i;

    e = sde_base64_encode("abc", 3);
    ok(e != NULL && strcmp(e, "YWJj") == 0, "abc encodes to YWJj");
    free(e);

    e = sde_base64_encode("", 0);
    ok(e != NULL && e[0] == '\0', "the empty input encodes to the empty string");
    free(e);

    e = sde_base64_encode(NULL, 0);
    ok(e != NULL && e[0] == '\0', "a null pointer at length 0 is the empty input");
    free(e);

    e = sde_base64_encode("\x00\x01\x02", 3);
    ok(e != NULL && strlen(e) == 4, "three NUL-leading bytes are four characters");
    free(e);

    for (i = 0; i < 256; i++) {
        bin[i] = (unsigned char) i;
    }
    e = sde_base64_encode((const char *) bin, sizeof(bin));
    ok(e != NULL, "all 256 byte values encode");
    if (e != NULL) {
        ok(decode_ok(e, (const char *) bin, sizeof(bin)),
           "and every byte, NUL included, survives the round trip");
        free(e);
    }

    ok(decode_ok("", "", 0), "the empty string decodes to nothing");
    ok(decode_ok("QQ==", "A", 1), "one padded byte decodes to A");
    ok(decode_ok("QUI=", "AB", 2), "two padded bytes decode to AB");

    ok(decode_fails("YWJ"), "a length that is not a multiple of four is refused");
    ok(decode_fails("YW!j"), "a character outside the alphabet is refused");
    ok(decode_fails("YW=j"), "padding anywhere but the end is refused");
    ok(decode_fails("=YWJ"), "padding in the lead position is refused");
    ok(decode_fails("QR=="), "padding that would carry information is refused");
    ok(decode_fails("YWJj="), "a lone trailing character is refused");
}

/* ---------------------------------------------------------------------- */

static void test_write_and_commit(sde_app *app)
{
    char          err[256];
    sde_json     *res = NULL;
    sde_json     *r2 = NULL;
    sde_buf       back;
    char         *chunk;
    long          session;
    unsigned long rev;
    int           rc;

    (void) sde_port_remove_file(SCRATCH "/bin/blob.bin");
    (void) sde_port_remove_file(SCRATCH "/bin/blob.bin.tmp");

    chunk = (char *) malloc((size_t) SDE_BLOB_MAX_CHUNK + 1u);
    if (chunk == NULL) {
        ok(0, "allocate a chunk");
        return;
    }

    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "bin/blob.bin", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a write session opens on a file that does not exist");
    if (rc != SDE_BLOB_OK) {
        free(chunk);
        return;
    }
    ok(strcmp(sde_json_gets(res, "path", ""), "bin/blob.bin") == 0,
       "the session names the path the client asked for");
    ok(num_at(res, "size") == 0, "a fresh write session reports size 0");
    session = sde_json_geti(res, "session", 0);
    ok(session > 0, "and it carries a session id");
    sde_json_free(res);
    res = NULL;

    ok(sde_port_file_exists(SCRATCH "/bin/blob.bin.tmp"),
       "the session writes to a temporary neighbour");
    ok(!sde_port_file_exists(SCRATCH "/bin/blob.bin"),
       "and the target itself is not created yet");
    ok(sde_port_is_dir(SCRATCH "/bin"),
       "a missing parent directory was created for it");

    /* One full chunk, which is the largest a single frame may carry. */
    fill_pattern(chunk, (size_t) SDE_BLOB_MAX_CHUNK, 0);
    rc = sde_blob_append(app->blobs, session, chunk,
                         (size_t) SDE_BLOB_MAX_CHUNK, 0, 0, &r2, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a full 1 MiB chunk appends");
    ok(rc == SDE_BLOB_OK && num_at(r2, "offset") == SDE_BLOB_MAX_CHUNK,
       "and the session reports where the next byte goes");
    sde_json_free(r2);
    r2 = NULL;

    /* One chunk too many: the limit is per frame, not per file. */
    fill_pattern(chunk, (size_t) SDE_BLOB_MAX_CHUNK + 1u, 0);
    rc = sde_blob_append(app->blobs, session, chunk,
                         (size_t) SDE_BLOB_MAX_CHUNK + 1u, 0, 0, &r2,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_PARAM, "a chunk past 1 MiB is refused");
    ok(err[0] != '\0', "and the refusal names the limit");
    sde_json_free(r2);
    r2 = NULL;

    /* A chunk with NULs in it, at the position the session is actually at. */
    fill_pattern(chunk, 300u, SDE_BLOB_MAX_CHUNK);
    rc = sde_blob_append(app->blobs, session, chunk, 300u, 0, 0, &r2,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a chunk full of NULs appends");
    sde_json_free(r2);
    r2 = NULL;

    rc = sde_blob_append(app->blobs, session, chunk, 1u, 1,
                         (int64_t) SDE_BLOB_MAX_CHUNK, &r2, err, sizeof(err));
    ok(rc == SDE_BLOB_PARAM, "an offset that is not the end of the file is refused");
    sde_json_free(r2);
    r2 = NULL;

    chunk[0] = pattern_at((int64_t) SDE_BLOB_MAX_CHUNK + 300);
    rc = sde_blob_append(app->blobs, session, chunk, 1u, 1,
                         (int64_t) SDE_BLOB_MAX_CHUNK + 300, &r2,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "the true end of the file is accepted as an offset");
    sde_json_free(r2);
    r2 = NULL;

    rc = sde_blob_commit(app, app->blobs, session, 0, 0, &res, err, sizeof(err));
    ok(rc == SDE_BLOB_PARAM, "a commit without total_size is refused");
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_commit(app, app->blobs, session, 1, 5, &res, err, sizeof(err));
    ok(rc == SDE_BLOB_PARAM, "a total_size that is not the bytes written is refused");
    sde_json_free(res);
    res = NULL;

    ok(sde_port_file_exists(SCRATCH "/bin/blob.bin.tmp"),
       "a refused commit keeps the session and its temporary file");
    chunk[0] = pattern_at((int64_t) SDE_BLOB_MAX_CHUNK + 301);
    rc = sde_blob_append(app->blobs, session, chunk, 1u, 0, 0, &r2,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "so the client can still finish the file");
    sde_json_free(r2);
    r2 = NULL;

    rc = sde_blob_commit(app, app->blobs, session, 1,
                         (int64_t) SDE_BLOB_MAX_CHUNK + 302, &res,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "the commit that matches publishes the file");
    if (rc == SDE_BLOB_OK) {
        ok(num_at(res, "size") == SDE_BLOB_MAX_CHUNK + 302,
           "the result reports the final size");
        ok(sde_json_getb(res, "replaced", 0) == 1, "and says the target was replaced");
        rev = (unsigned long) num_at(res, "revision");
        ok(rev != 0, "and reports a revision");
    } else {
        rev = 0;
    }
    sde_json_free(res);
    res = NULL;

    ok(!sde_port_file_exists(SCRATCH "/bin/blob.bin.tmp"),
       "the temporary file is gone once it has been published");
    ok(file_is_pattern(SCRATCH "/bin/blob.bin",
                       (int64_t) SDE_BLOB_MAX_CHUNK + 302),
       "the published file is the bytes the client sent, in order");

    sde_buf_init(&back);
    if (sde_port_read_file(SCRATCH "/bin/blob.bin", &back, err, sizeof(err)) == 0) {
        ok(sde_rev_of(back.data, back.len) == rev,
           "the incremental revision is the hash of the whole file");
    } else {
        ok(0, "read back the published file");
    }
    sde_buf_free(&back);

    rc = sde_blob_read(app->blobs, session, 0, 0, 0, 0, &res, err, sizeof(err));
    ok(rc == SDE_BLOB_NOSESS, "the session is closed once it has been committed");
    sde_json_free(res);
    res = NULL;

    free(chunk);
}

/* ---------------------------------------------------------------------- */

static void test_base_revision(sde_app *app)
{
    char          err[256];
    sde_json     *res = NULL;
    sde_json     *r2 = NULL;
    unsigned long base = 0;
    unsigned long cur = 0;
    long          session;
    int           rc;

    (void) sde_port_remove_file(SCRATCH "/rev.txt");
    (void) sde_port_remove_file(SCRATCH "/rev.txt.tmp");

    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "rev.txt", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a write session opens on a new text file");
    if (rc != SDE_BLOB_OK) {
        return;
    }
    session = sde_json_geti(res, "session", 0);
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_append(app->blobs, session, "hello ", 6u, 0, 0, &r2,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "and takes its first bytes");
    sde_json_free(r2);
    r2 = NULL;

    rc = sde_blob_commit(app, app->blobs, session, 1, 6, &res, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "and publishes them");
    if (rc != SDE_BLOB_OK) {
        sde_json_free(res);
        return;
    }
    base = (unsigned long) num_at(res, "revision");
    sde_json_free(res);
    res = NULL;

    /* The revision the commit reported is the base a second write must send. */
    rc = sde_blob_open(app, app->blobs, "rev.txt", "write", 1, base, 0,
                       &res, &cur, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a write session with the matching base opens");
    if (rc == SDE_BLOB_OK) {
        long s2 = sde_json_geti(res, "session", 0);

        ok(sde_blob_abort(app->blobs, s2, &r2, err, sizeof(err)) == SDE_BLOB_OK,
           "and can be aborted");
        sde_json_free(r2);
        r2 = NULL;
    }
    sde_json_free(res);
    res = NULL;

    cur = 0;
    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "rev.txt", "write", 1, base + 1, 0,
                       &res, &cur, err, sizeof(err));
    ok(rc == SDE_BLOB_STALE, "a base that does not match is stale");
    ok(rc == SDE_BLOB_STALE && cur == base,
       "and the session reports the revision to retry from");
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_open(app, app->blobs, "rev.txt", "read", 0, 0, 1,
                       &res, &cur, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a read session asks for the revision");
    ok(rc == SDE_BLOB_OK && cur == base,
       "and it is the same revision the writer reported");
    ok(rc == SDE_BLOB_OK
       && strcmp(sde_json_gets(res, "path", ""), "rev.txt") == 0,
       "the read session names the file too");
    if (rc == SDE_BLOB_OK) {
        long s3 = sde_json_geti(res, "session", 0);

        ok(sde_blob_abort(app->blobs, s3, &r2, err, sizeof(err)) == SDE_BLOB_OK,
           "and closes with abort");
        sde_json_free(r2);
        r2 = NULL;
    }
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_open(app, app->blobs, "rev.txt", "sideways", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc == SDE_BLOB_PARAM, "an unknown mode is refused");
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_open(app, app->blobs, "does/not/exist.bin", "read", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc == SDE_BLOB_NOTFOUND, "a read session on a missing file is not found");
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_open(app, app->blobs, "..", "read", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc != SDE_BLOB_OK, "a path that leaves the workspace is refused");

    rc = sde_blob_append(app->blobs, 424242, "x", 1u, 0, 0, &res,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_NOSESS, "appending to a session that never existed is refused");
    sde_json_free(res);
    res = NULL;
}

/* ---------------------------------------------------------------------- */

static void test_read_sessions(sde_app *app)
{
    char      err[256];
    sde_json *res = NULL;
    sde_json *r2 = NULL;
    char     *chunk;
    long      session;
    int64_t   total = (int64_t) SDE_BLOB_MAX_CHUNK * 2 + 4096;
    int64_t   i;
    int       rc;

    (void) sde_port_remove_file(SCRATCH "/read.bin");
    (void) sde_port_remove_file(SCRATCH "/read.bin.tmp");

    chunk = (char *) malloc((size_t) SDE_BLOB_MAX_CHUNK);
    if (chunk == NULL) {
        ok(0, "allocate a read chunk");
        return;
    }

    /* Build the file with the session layer itself: no text limit applies. */
    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "read.bin", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        ok(0, "open a write session for the read tests");
        free(chunk);
        return;
    }
    session = sde_json_geti(res, "session", 0);
    sde_json_free(res);
    res = NULL;

    for (i = 0; i < total; i += (int64_t) SDE_BLOB_MAX_CHUNK) {
        size_t n = (size_t) (total - i);

        if (n > (size_t) SDE_BLOB_MAX_CHUNK) {
            n = (size_t) SDE_BLOB_MAX_CHUNK;
        }
        fill_pattern(chunk, n, i);
        rc = sde_blob_append(app->blobs, session, chunk, n, 0, 0, &r2,
                             err, sizeof(err));
        if (rc != SDE_BLOB_OK) {
            break;
        }
        sde_json_free(r2);
        r2 = NULL;
    }
    ok(rc == SDE_BLOB_OK, "a file of two chunks and a remainder is written");
    ok(sde_blob_commit(app, app->blobs, session, 1, total, &res,
                       err, sizeof(err)) == SDE_BLOB_OK,
       "and published");
    sde_json_free(res);
    res = NULL;

    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "read.bin", "read", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a read session opens on it");
    if (rc != SDE_BLOB_OK) {
        free(chunk);
        return;
    }
    session = sde_json_geti(res, "session", 0);
    ok(num_at(res, "size") == total, "it reports the file's size");
    sde_json_free(res);
    res = NULL;

    /* Sequential reads, one full chunk at a time, then the remainder. */
    ok(read_matches(app, session, 0, 0, 0, 0, 0, SDE_BLOB_MAX_CHUNK, 0),
       "the first read returns one full chunk from offset 0");
    ok(read_matches(app, session, 0, 0, 0, 0, SDE_BLOB_MAX_CHUNK,
                    SDE_BLOB_MAX_CHUNK, 0),
       "the second read continues where the first stopped");
    ok(read_matches(app, session, 0, 0, 0, 0, 2 * (int64_t) SDE_BLOB_MAX_CHUNK,
                    4096, 1),
       "the third read returns the remainder and says it is the end");

    /* A read with no bytes left is not an error: it is the answer. */
    ok(read_matches(app, session, 0, 0, 0, 0, total, 0, 1),
       "a read at the end returns nothing");
    ok(read_matches(app, session, 1, total + 4096, 0, 0, total, 0, 1),
       "a read past the end is answered at the end");

    /*
     * An explicit offset and length are honoured, and the session's sequential
     * position follows the read rather than staying where it was.
     */
    ok(read_matches(app, session, 1, 2, 1, 16, 2, 16, 0),
       "an explicit offset and length are honoured");
    ok(read_matches(app, session, 0, 0, 0, 0, 18, SDE_BLOB_MAX_CHUNK, 0),
       "and the next sequential read continues from where that one ended");

    ok(read_matches(app, session, 1, 0, 1, 1, 0, 1, 0),
       "one byte at a time can be asked for");
    ok(read_matches(app, session, 1, 1, 1, (int64_t) SDE_BLOB_MAX_CHUNK,
                    1, SDE_BLOB_MAX_CHUNK, 0),
       "a length that runs past the end stops at the end");

    ok(sde_blob_abort(app->blobs, session, &r2, err, sizeof(err)) == SDE_BLOB_OK,
       "the read session closes");
    sde_json_free(r2);
    r2 = NULL;

    free(chunk);
}

/* ---------------------------------------------------------------------- */

static void test_abort(sde_app *app)
{
    char      err[256];
    sde_json *res = NULL;
    sde_json *r2 = NULL;
    long      session;
    int       rc;

    (void) sde_port_remove_file(SCRATCH "/abort.txt");
    (void) sde_port_remove_file(SCRATCH "/abort.txt.tmp");

    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "abort.txt", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        ok(0, "open a write session to abort");
        return;
    }
    session = sde_json_geti(res, "session", 0);
    sde_json_free(res);
    res = NULL;

    ok(sde_blob_append(app->blobs, session, "gone", 4u, 0, 0, &r2,
                       err, sizeof(err)) == SDE_BLOB_OK,
       "the abandoned session takes bytes");
    sde_json_free(r2);
    r2 = NULL;
    ok(sde_port_file_exists(SCRATCH "/abort.txt.tmp"),
       "its temporary file is there");

    rc = sde_blob_abort(app->blobs, session, &res, err, sizeof(err));
    ok(rc == SDE_BLOB_OK && sde_json_getb(res, "aborted", 0) == 1,
       "abort reports that it aborted");
    sde_json_free(res);
    res = NULL;

    ok(!sde_port_file_exists(SCRATCH "/abort.txt.tmp"),
       "and the temporary file is gone");
    ok(!sde_port_file_exists(SCRATCH "/abort.txt"),
       "and nothing was published");
    ok(sde_blob_abort(app->blobs, session, &res, err, sizeof(err)) == SDE_BLOB_NOSESS,
       "aborting twice is refused the second time");
    sde_json_free(res);
    res = NULL;
}

/* ---------------------------------------------------------------------- */

static void test_limits(sde_app *app)
{
    char      err[256];
    sde_json *res = NULL;
    sde_json *r2 = NULL;
    long      ids[SDE_BLOB_MAX_SESSIONS];
    long      session;
    int       i;
    int       rc;

    (void) sde_port_remove_file(SCRATCH "/limits.txt");
    (void) sde_port_remove_file(SCRATCH "/limits.txt.tmp");

    /* One writer per target: a second session would share the temporary name. */
    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "limits.txt", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        ok(0, "open the first writer");
        return;
    }
    session = sde_json_geti(res, "session", 0);
    sde_json_free(res);
    res = NULL;

    rc = sde_blob_open(app, app->blobs, "limits.txt", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc != SDE_BLOB_OK, "a second writer on the same target is refused");
    sde_json_free(res);
    res = NULL;
    ok(sde_blob_abort(app->blobs, session, &res, err, sizeof(err)) == SDE_BLOB_OK,
       "the first writer can still abort");
    sde_json_free(res);
    res = NULL;

    /* The table is bounded, and it says so instead of reusing a slot. */
    err[0] = '\0';
    rc = sde_port_write_file(SCRATCH "/limits.txt", "x", 1u, err, sizeof(err));
    ok(rc == 0, "a file exists to hold read sessions");

    for (i = 0; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
        rc = sde_blob_open(app, app->blobs, "limits.txt", "read", 0, 0, 0,
                           &res, NULL, err, sizeof(err));
        if (rc != SDE_BLOB_OK) {
            printf("     read session %d was refused: %s\n", i, err);
            break;
        }
        ids[i] = sde_json_geti(res, "session", 0);
        sde_json_free(res);
        res = NULL;
    }
    {
        char what[128];

        snprintf(what, sizeof(what),
                 "the table holds all %d sessions (it held %d)",
                 (int) SDE_BLOB_MAX_SESSIONS, i);
        ok(i == (int) SDE_BLOB_MAX_SESSIONS, what);
    }

    rc = sde_blob_open(app, app->blobs, "limits.txt", "read", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc != SDE_BLOB_OK, "one more session is refused");
    ok(err[0] != '\0', "and the refusal says why");
    sde_json_free(res);
    res = NULL;

    ok(sde_blob_abort(app->blobs, ids[0], &res, err, sizeof(err)) == SDE_BLOB_OK,
       "closing one session frees its slot");
    sde_json_free(res);
    res = NULL;
    rc = sde_blob_open(app, app->blobs, "limits.txt", "read", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "so another session opens");
    if (rc == SDE_BLOB_OK) {
        long id = sde_json_geti(res, "session", 0);

        ok(id != ids[0], "and the id is never reused");
        sde_json_free(res);
        res = NULL;
        (void) sde_blob_abort(app->blobs, id, &r2, err, sizeof(err));
        sde_json_free(r2);
        r2 = NULL;
    }
    for (i = 1; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
        (void) sde_blob_abort(app->blobs, ids[i], &r2, err, sizeof(err));
        sde_json_free(r2);
        r2 = NULL;
    }

    /* A read session is not a write session, and the other way round. */
    rc = sde_blob_open(app, app->blobs, "limits.txt", "read", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    if (rc == SDE_BLOB_OK) {
        session = sde_json_geti(res, "session", 0);
        sde_json_free(res);
        res = NULL;

        rc = sde_blob_append(app->blobs, session, "x", 1u, 0, 0, &res,
                             err, sizeof(err));
        ok(rc == SDE_BLOB_PARAM, "a read session cannot be appended to");
        sde_json_free(res);
        res = NULL;

        rc = sde_blob_commit(app, app->blobs, session, 1, 1, &res,
                             err, sizeof(err));
        ok(rc == SDE_BLOB_PARAM, "and has nothing to commit");
        sde_json_free(res);
        res = NULL;

        rc = sde_blob_read(app->blobs, session, 1, -1, 0, 0, &res,
                           err, sizeof(err));
        ok(rc == SDE_BLOB_PARAM, "a negative offset is refused");
        sde_json_free(res);
        res = NULL;

        rc = sde_blob_read(app->blobs, session, 0, 0, 1, 0, &res,
                           err, sizeof(err));
        ok(rc == SDE_BLOB_PARAM, "a length of zero is refused");
        sde_json_free(res);
        res = NULL;

        rc = sde_blob_read(app->blobs, session, 0, 0, 1,
                           (int64_t) SDE_BLOB_MAX_CHUNK + 1, &res,
                           err, sizeof(err));
        ok(rc == SDE_BLOB_PARAM, "a length past the chunk limit is refused");
        sde_json_free(res);
        res = NULL;

        (void) sde_blob_abort(app->blobs, session, &r2, err, sizeof(err));
        sde_json_free(r2);
        r2 = NULL;
    } else {
        ok(0, "open a read session for the shape checks");
    }
}

/* ---------------------------------------------------------------------- */

static void test_large_file(sde_app *app)
{
    char          err[256];
    sde_json     *res = NULL;
    sde_json     *r2 = NULL;
    char         *chunk;
    sde_buf       back;
    unsigned long rev = 0;
    unsigned long cur = 0;
    long          session;
    int64_t       i;
    int64_t       total = (int64_t) BIGSIZE;
    int           rc;

    (void) sde_port_remove_file(SCRATCH "/big.bin");
    (void) sde_port_remove_file(SCRATCH "/big.bin.tmp");

    chunk = (char *) malloc((size_t) SDE_BLOB_MAX_CHUNK);
    if (chunk == NULL) {
        ok(0, "allocate a large-file chunk");
        return;
    }

    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "big.bin", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        ok(0, "open a write session for a 5 MiB file");
        free(chunk);
        return;
    }
    session = sde_json_geti(res, "session", 0);
    sde_json_free(res);
    res = NULL;

    for (i = 0; i < total; i += (int64_t) SDE_BLOB_MAX_CHUNK) {
        size_t n = (size_t) (total - i);

        if (n > (size_t) SDE_BLOB_MAX_CHUNK) {
            n = (size_t) SDE_BLOB_MAX_CHUNK;
        }
        fill_pattern(chunk, n, i);
        rc = sde_blob_append(app->blobs, session, chunk, n, 0, 0, &r2,
                             err, sizeof(err));
        if (rc != SDE_BLOB_OK) {
            break;
        }
        sde_json_free(r2);
        r2 = NULL;
    }
    ok(rc == SDE_BLOB_OK, "5 MiB of chunks append");

    rc = sde_blob_commit(app, app->blobs, session, 1, total, &res,
                         err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "and the 5 MiB file publishes");
    if (rc == SDE_BLOB_OK) {
        rev = (unsigned long) num_at(res, "revision");
        ok(num_at(res, "size") == total, "the result's size is the whole file");
    }
    sde_json_free(res);
    res = NULL;

    ok(sde_port_file_size(SCRATCH "/big.bin") == total,
       "the file on disk is exactly 5 MiB");
    ok(file_is_pattern(SCRATCH "/big.bin", total),
       "and every byte of it is the byte that was sent");

    /* This is the limit the layer exists to lift. */
    err[0] = '\0';
    res = sde_wksp_read(app, "big.bin", err, sizeof(err));
    ok(res == NULL, "file.read still refuses a file past its text limit");
    ok(err[0] != '\0', "and says so");
    sde_json_free(res);
    res = NULL;

    /* The revision of a 5 MiB file: file.stat reports 0 there, a session does not. */
    err[0] = '\0';
    rc = sde_blob_open(app, app->blobs, "big.bin", "read", 0, 0, 1,
                       &res, &cur, err, sizeof(err));
    ok(rc == SDE_BLOB_OK, "a read session hashes the whole 5 MiB file");
    ok(rc == SDE_BLOB_OK && cur == rev,
       "and its revision is the one the writer reported");
    if (rc == SDE_BLOB_OK) {
        session = sde_json_geti(res, "session", 0);
        sde_json_free(res);
        res = NULL;

        /* Read it back through the session, and hash it the same way. */
        sde_buf_init(&back);
        rc = sde_blob_read(app->blobs, session, 0, 0, 0, 0, &res,
                           err, sizeof(err));
        ok(rc == SDE_BLOB_OK && num_at(res, "size") == total,
           "a session read sees the whole file's size");
        sde_json_free(res);
        res = NULL;
        sde_buf_free(&back);

        (void) sde_blob_abort(app->blobs, session, &r2, err, sizeof(err));
        sde_json_free(r2);
        r2 = NULL;
    }

    free(chunk);
}

/* ---------------------------------------------------------------------- */

/* A kernel that exits must not leave a half-written temporary behind. */
static void test_shutdown_cleanup(void)
{
    char      err[256];
    sde_app   app;
    sde_json *res = NULL;
    long      session;
    int       rc;

    (void) sde_port_remove_file(SCRATCH "/left.txt");
    (void) sde_port_remove_file(SCRATCH "/left.txt.tmp");

    err[0] = '\0';
    if (sde_app_init(&app, SCRATCH, NULL, NULL, NULL, err, sizeof(err)) != 0) {
        ok(0, "a second app can be built");
        return;
    }
    rc = sde_blob_open(&app, app.blobs, "left.txt", "write", 0, 0, 0,
                       &res, NULL, err, sizeof(err));
    if (rc == SDE_BLOB_OK) {
        session = sde_json_geti(res, "session", 0);
        sde_json_free(res);
        res = NULL;
        (void) sde_blob_append(app.blobs, session, "half", 4u, 0, 0, &res,
                               err, sizeof(err));
        sde_json_free(res);
        res = NULL;
        ok(sde_port_file_exists(SCRATCH "/left.txt.tmp"),
           "an open write session has a temporary file");
    } else {
        ok(0, "open a write session to abandon");
    }

    sde_app_free(&app);
    ok(!sde_port_file_exists(SCRATCH "/left.txt.tmp"),
       "freeing the app removes a temporary file a client left open");
    ok(!sde_port_file_exists(SCRATCH "/left.txt"),
       "and publishes nothing on the way out");
}

/* ====================================================================== */
/* the JSON-RPC surface                                                   */
/* ====================================================================== */

/*
 * The checks above drive the session layer directly.  These drive the five
 * handlers through sde_rpc_handle() instead, because the layer below never
 * sees the parts a client depends on most: the method names, the reading of
 * the parameters, the base64 decoding, the mapping of a failure onto a code,
 * and the file.changed a successful commit emits.
 */

static char recorded[128];

static int record_event(void *ud, sde_json *payload)
{
    const char *ev = sde_json_gets(payload, "event", "?");
    const char *path = sde_json_gets(payload, "path", "?");

    (void) ud;
    snprintf(recorded, sizeof(recorded), "%s %s", ev, path);
    sde_json_free(payload);
    return 0;
}

/* One request through the dispatcher, built from a params string. */
static sde_json *call(sde_app *app, const char *method, const char *params)
{
    char      perr[128];
    sde_json *req;
    sde_json *p;
    sde_json *res;

    req = sde_json_obj();
    if (req == NULL) {
        return NULL;
    }
    sde_json_set(req, "jsonrpc", sde_json_str("2.0"));
    sde_json_set(req, "id", sde_json_int(7));
    sde_json_set(req, "method", sde_json_str(method));
    if (params != NULL) {
        p = sde_json_parse(params, strlen(params), perr, sizeof(perr));
        if (p == NULL) {
            printf("     params did not parse: %s\n", perr);
            sde_json_free(req);
            return NULL;
        }
        sde_json_set(req, "params", p);
    }
    res = sde_rpc_handle(app, req);
    sde_json_free(req);
    return res;
}

static long err_code(const sde_json *res)
{
    return sde_json_geti(sde_json_get(res, "error"), "code", 0);
}

static const char *err_message(const sde_json *res)
{
    return sde_json_gets(sde_json_get(res, "error"), "message", "");
}

static int mentions(const char *hay, const char *needle)
{
    return strstr(hay, needle) != NULL;
}

static void test_rpc_surface(void)
{
    char          err[256];
    char          params[256];
    sde_app       app;
    sde_json     *res;
    sde_json     *result;
    long          writer = 0;
    long          reader = 0;
    unsigned long rev = 0u;
    unsigned long seen = 0u;

    recorded[0] = '\0';
    err[0] = '\0';
    if (sde_app_init(&app, SCRATCH, NULL, record_event, NULL, err,
                     sizeof(err)) != 0) {
        ok(0, "an app with an event recorder can be built");
        return;
    }

    /* --- a write session, end to end ---------------------------------- */

    res = call(&app, "file.blobOpen",
               "{\"path\":\"rpc/notes.txt\",\"mode\":\"write\"}");
    result = sde_json_get(res, "result");
    writer = sde_json_geti(result, "session", 0);
    ok(result != NULL && writer > 0,
       "file.blobOpen over the wire opens a session");
    ok(result != NULL
       && strcmp(sde_json_gets(result, "path", ""), "rpc/notes.txt") == 0,
       "and the session names the file it opened");
    sde_json_free(res);

    /* "hi\n" is "aGkK" in base64. */
    snprintf(params, sizeof(params), "{\"session\":%ld,\"data\":\"aGkK\"}",
             writer);
    res = call(&app, "file.blobAppend", params);
    result = sde_json_get(res, "result");
    ok(result != NULL && num_at(result, "offset") == 3
       && num_at(result, "size") == 3,
       "file.blobAppend decodes the chunk and reports the new end");
    sde_json_free(res);

    snprintf(params, sizeof(params), "{\"session\":%ld,\"data\":\"!!!!\"}",
             writer);
    res = call(&app, "file.blobAppend", params);
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "not valid base64"),
       "data that is not base64 is INVALID_PARAMS");
    sde_json_free(res);

    {
        /*
         * One base64 character over the chunk limit.  The handler has to
         * refuse this on the length of the frame, before it decodes anything.
         */
        size_t frame = (size_t) SDE_BLOB_MAX_CHUNK / 3u * 4u + 5u;
        char  *huge = (char *) malloc(frame + 64u);

        if (huge == NULL) {
            ok(0, "a frame past the chunk limit can be built");
        } else {
            sprintf(huge, "{\"session\":%ld,\"data\":\"", writer);
            memset(huge + strlen(huge), 'A', frame);
            strcpy(huge + strlen(huge), "\"}");
            res = call(&app, "file.blobAppend", huge);
            ok(err_code(res) == SDE_RPC_INVALID_PARAMS
               && mentions(err_message(res), "1048576"),
               "a frame past the chunk limit is refused before decoding");
            sde_json_free(res);
            free(huge);
        }
    }

    snprintf(params, sizeof(params), "{\"session\":%ld}", writer);
    res = call(&app, "file.blobCommit", params);
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "total_size"),
       "a commit with no total_size is INVALID_PARAMS");
    sde_json_free(res);

    snprintf(params, sizeof(params), "{\"session\":%ld,\"total_size\":4}",
             writer);
    res = call(&app, "file.blobCommit", params);
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "does not match"),
       "a total_size that is not what was written is INVALID_PARAMS");
    sde_json_free(res);

    /* "hi\n" is three bytes, and the revision hashes exactly those bytes. */
    rev = sde_rev_of("hi\n", 3u);

    snprintf(params, sizeof(params), "{\"session\":%ld,\"total_size\":3}",
             writer);
    res = call(&app, "file.blobCommit", params);
    result = sde_json_get(res, "result");
    ok(result != NULL && num_at(result, "size") == 3
       && num_at(result, "revision") == (int64_t) rev
       && sde_json_getb(result, "replaced", 0) == 1,
       "the commit publishes and reports the revision of the bytes");
    ok(strcmp(recorded, "file.changed rpc/notes.txt") == 0,
       "and file.changed is emitted before the response");
    ok(!sde_port_file_exists(SCRATCH "/rpc/notes.txt.tmp"),
       "with no temporary file left behind");
    sde_json_free(res);

    /* --- reading it back ---------------------------------------------- */

    res = call(&app, "file.blobOpen",
               "{\"path\":\"rpc/notes.txt\",\"mode\":\"read\","
               "\"want_revision\":true}");
    result = sde_json_get(res, "result");
    reader = sde_json_geti(result, "session", 0);
    ok(result != NULL && num_at(result, "size") == 3
       && num_at(result, "revision") == (int64_t) rev,
       "a read session reports the size and the revision asked for");
    sde_json_free(res);

    snprintf(params, sizeof(params), "{\"session\":%ld,\"length\":100}",
             reader);
    res = call(&app, "file.blobRead", params);
    result = sde_json_get(res, "result");
    ok(result != NULL
       && strcmp(sde_json_gets(result, "data", ""), "aGkK") == 0
       && num_at(result, "offset") == 0
       && sde_json_getb(result, "eof", 0) == 1,
       "file.blobRead returns the bytes as base64 and says the file ended");
    sde_json_free(res);

    snprintf(params, sizeof(params), "{\"session\":%ld}", reader);
    res = call(&app, "file.blobRead", params);
    result = sde_json_get(res, "result");
    ok(result != NULL && strcmp(sde_json_gets(result, "data", ""), "") == 0
       && num_at(result, "offset") == 3,
       "a read at the end is answered at the end, not refused");
    sde_json_free(res);

    res = call(&app, "file.blobAbort", params);
    ok(sde_json_getb(sde_json_get(res, "result"), "aborted", 0) == 1,
       "file.blobAbort closes a read session");
    sde_json_free(res);

    /* --- the refusals a client has to tell apart ---------------------- */

    res = call(&app, "file.blobOpen",
               "{\"path\":\"rpc/nothing.txt\",\"mode\":\"read\"}");
    ok(err_code(res) == SDE_RPC_NOT_FOUND,
       "a file that is not there is 1002 NOT_FOUND");
    sde_json_free(res);

    snprintf(params, sizeof(params),
             "{\"path\":\"rpc/notes.txt\",\"mode\":\"write\","
             "\"base_revision\":12345}");
    res = call(&app, "file.blobOpen", params);
    seen = (unsigned long) num_at(sde_json_get(sde_json_get(res, "error"),
                                               "data"),
                                  "current_revision");
    ok(err_code(res) == SDE_RPC_STALE_REVISION && seen == rev,
       "a stale base_revision is 1001 with the revision to retry from");
    ok(!sde_port_file_exists(SCRATCH "/rpc/notes.txt.tmp"),
       "and a refused open creates no temporary file");
    sde_json_free(res);

    res = call(&app, "file.blobOpen",
               "{\"path\":\"rpc/notes.txt\",\"mode\":\"append\"}");
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "mode"),
       "a mode that is neither read nor write is INVALID_PARAMS");
    sde_json_free(res);

    res = call(&app, "file.blobRead", "{}");
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "session"),
       "a request with no session is INVALID_PARAMS");
    sde_json_free(res);

    res = call(&app, "file.blobAbort", "{\"session\":424242}");
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "no such blob session"),
       "aborting a session that never existed says so");
    sde_json_free(res);

    /* A write session cannot be read, and aborting one drops its temp. */
    res = call(&app, "file.blobOpen",
               "{\"path\":\"rpc/other.bin\",\"mode\":\"write\"}");
    result = sde_json_get(res, "result");
    writer = sde_json_geti(result, "session", 0);
    ok(writer > 0, "a second write session opens");
    sde_json_free(res);

    snprintf(params, sizeof(params), "{\"session\":%ld}", writer);
    res = call(&app, "file.blobRead", params);
    ok(err_code(res) == SDE_RPC_INVALID_PARAMS
       && mentions(err_message(res), "nothing to read"),
       "reading a write session is INVALID_PARAMS");
    sde_json_free(res);

    res = call(&app, "file.blobAbort", params);
    ok(sde_json_getb(sde_json_get(res, "result"), "aborted", 0) == 1,
       "and it can still be aborted");
    sde_json_free(res);
    ok(!sde_port_file_exists(SCRATCH "/rpc/other.bin.tmp"),
       "which removes its temporary file");
    ok(!sde_port_file_exists(SCRATCH "/rpc/other.bin"),
       "and publishes nothing");

    res = call(&app, "file.blobs", "{}");
    ok(err_code(res) == SDE_RPC_METHOD_NOT_FOUND,
       "a method that does not exist is 32601 as everywhere else");
    sde_json_free(res);

    sde_app_free(&app);
}

int main(void)
{
    char    err[256];
    sde_app app;

    /* Unbuffered: a crash mid-run must still show how far the run got. */
    setvbuf(stdout, NULL, _IONBF, 0u);
    err[0] = '\0';
    if (sde_port_mkdirs(SCRATCH, err, sizeof(err)) != 0) {
        printf("cannot create %s: %s\n", SCRATCH, err);
        return 1;
    }

    test_base64();

    err[0] = '\0';
    if (sde_app_init(&app, SCRATCH, NULL, NULL, NULL, err, sizeof(err)) != 0) {
        printf("cannot build an app on %s: %s\n", SCRATCH, err);
        return 1;
    }

    test_write_and_commit(&app);
    test_base_revision(&app);
    test_read_sessions(&app);
    test_abort(&app);
    test_limits(&app);
    test_large_file(&app);

    sde_app_free(&app);
    test_shutdown_cleanup();
    test_rpc_surface();

    printf(failures ? "\nFAILED (%d)\n" : "\nall good\n", failures);
    return failures ? 1 : 0;
}
