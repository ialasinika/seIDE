#include "seide_cfg.h"

#include "blob.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "base64.h"
#include "buf.h"
#include "port.h"
#include "wksp.h"

/* ====================================================================== */
/* the table                                                              */
/* ====================================================================== */

typedef struct sde_blob {
    long          id;
    int           used;
    int           is_write;
    char         *abs;      /* the target, absolute and '/'-separated */
    char         *rel;      /* as the client named it, for results */
    char         *tmp;      /* write sessions only: abs plus ".tmp" */
    int64_t       pos;      /* read: where the next read starts; write: end */
    int64_t       size;     /* read: the file's size; write: bytes written */
    unsigned long rev;      /* write: the hash of what has been written */
    unsigned long stamp;    /* sde_port_now_ms() of the last use */
} sde_blob;

struct sde_blobset {
    sde_blob sess[SDE_BLOB_MAX_SESSIONS];
    long     next_id;
};

/* ====================================================================== */
/* helpers                                                                */
/* ====================================================================== */

static void set_err(char *err, size_t errcap, const char *msg)
{
    if (err != NULL && errcap > 0u) {
        snprintf(err, errcap, "%s", msg);
        err[errcap - 1u] = '\0';
    }
}

static void set_err_path(char *err, size_t errcap, const char *msg,
                         const char *path)
{
    if (err != NULL && errcap > 0u) {
        snprintf(err, errcap, "%s: %s", msg, path);
        err[errcap - 1u] = '\0';
    }
}

static sde_blob *blob_find(sde_blobset *bs, long id)
{
    int i;

    for (i = 0; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
        if (bs->sess[i].used && bs->sess[i].id == id) {
            return &bs->sess[i];
        }
    }
    return (sde_blob *) 0;
}

/*
 * Frees a session.  `discard` removes the temporary file of a write session:
 * set it everywhere except after a commit, where the temporary file *is* the
 * target now.
 */
static void blob_close(sde_blob *b, int discard)
{
    if (b->is_write && discard && b->tmp != NULL) {
        (void) sde_port_remove_file(b->tmp);
    }
    free(b->abs);
    free(b->rel);
    free(b->tmp);
    memset(b, 0, sizeof(*b));
}

/* Closes what a client walked away from, so a forgotten session cannot hold a
 * slot -- or a temporary file -- forever. */
static void blob_reap(sde_blobset *bs)
{
    unsigned long now = sde_port_now_ms();
    int           i;

    for (i = 0; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
        sde_blob *b = &bs->sess[i];
        if (b->used && (unsigned long) (now - b->stamp) > SDE_BLOB_IDLE_MS) {
            blob_close(b, 1);
        }
    }
}

/* The hash of a file, read a chunk at a time: any size, binary or not. */
static int abs_rev(const char *abs, unsigned long *out,
                   char *err, size_t errcap)
{
    unsigned long h = SDE_REV_SEED;
    int64_t       size;
    int64_t       off = 0;

    *out = 0;
    if (!sde_port_file_exists(abs)) {
        return 0;
    }
    size = sde_port_file_size(abs);
    if (size < 0) {
        set_err_path(err, errcap, "cannot read", abs);
        return -1;
    }
    while (off < size) {
        sde_buf buf;
        int64_t got;
        int64_t seen = -1;

        sde_buf_init(&buf);
        got = sde_port_read_at(abs, off, 65536u, &buf, &seen, err, errcap);
        if (got < 0) {
            sde_buf_free(&buf);
            return -1;
        }
        if (got == 0) {
            sde_buf_free(&buf);
            break;
        }
        h = sde_rev_update(h, buf.data, (size_t) got);
        off += got;
        sde_buf_free(&buf);
        if (seen >= 0) {
            size = seen;    /* the file moved: follow it */
        }
    }
    *out = sde_rev_final(h);
    return 0;
}

static char *abs_parent(const char *abs)
{
    const char *slash = strrchr(abs, '/');
    char       *dir;
    size_t      n;

    if (slash == NULL || slash == abs) {
        return (char *) 0;
    }
    n = (size_t) (slash - abs);
    dir = (char *) malloc(n + 1u);
    if (dir == NULL) {
        return (char *) 0;
    }
    memcpy(dir, abs, n);
    dir[n] = '\0';
    return dir;
}

static sde_json *session_object(const sde_blob *b)
{
    sde_json *o = sde_json_obj();

    if (o == NULL) {
        return (sde_json *) 0;
    }
    sde_json_set(o, "session", sde_json_int(b->id));
    sde_json_set(o, "path", sde_json_str(b->rel));
    sde_json_set(o, "size", sde_json_num((double) b->size));
    return o;
}

static void deliver(sde_json *o, sde_json **out)
{
    if (out != NULL) {
        *out = o;
    } else {
        sde_json_free(o);
    }
}

/* ====================================================================== */
/* lifetime                                                               */
/* ====================================================================== */

sde_blobset *sde_blobset_new(void)
{
    sde_blobset *bs = (sde_blobset *) malloc(sizeof(sde_blobset));

    if (bs == NULL) {
        return (sde_blobset *) 0;
    }
    memset(bs, 0, sizeof(*bs));
    return bs;
}

void sde_blobset_free(sde_blobset *bs)
{
    int i;

    if (bs == NULL) {
        return;
    }
    for (i = 0; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
        if (bs->sess[i].used) {
            /* A kernel that is going away leaves nothing behind. */
            blob_close(&bs->sess[i], 1);
        }
    }
    free(bs);
}

/* ====================================================================== */
/* open                                                                   */
/* ====================================================================== */

int sde_blob_open(const sde_app *app, sde_blobset *bs, const char *rel,
                  const char *mode, int has_base, unsigned long base,
                  int want_rev, sde_json **out, unsigned long *cur_rev,
                  char *err, size_t errcap)
{
    sde_blob     *b = (sde_blob *) 0;
    char         *abs = (char *) 0;
    unsigned long cur = 0;
    int           is_write;
    int           i;

    if (out != NULL) {
        *out = (sde_json *) 0;
    }
    if (cur_rev != NULL) {
        *cur_rev = 0;
    }
    if (bs == NULL) {
        set_err(err, errcap, "no blob table");
        return SDE_BLOB_FAIL;
    }
    if (mode != NULL && strcmp(mode, "read") == 0) {
        is_write = 0;
    } else if (mode != NULL && strcmp(mode, "write") == 0) {
        is_write = 1;
    } else {
        set_err(err, errcap, "mode must be \"read\" or \"write\"");
        return SDE_BLOB_PARAM;
    }

    blob_reap(bs);

    if (sde_wksp_resolve(app, rel, &abs, err, errcap) != 0) {
        return SDE_BLOB_FAIL;
    }
    if (sde_port_is_dir(abs)) {
        set_err_path(err, errcap, "is a directory", rel);
        free(abs);
        return SDE_BLOB_FAIL;
    }
    if (!is_write && !sde_port_file_exists(abs)) {
        set_err_path(err, errcap, "no such file", rel);
        free(abs);
        return SDE_BLOB_NOTFOUND;
    }

    /*
     * The revision is worked out before a slot is taken, so a stale base fails
     * without leaving a session or a temporary file behind.
     */
    if (has_base || want_rev) {
        if (abs_rev(abs, &cur, err, errcap) != 0) {
            free(abs);
            return SDE_BLOB_FAIL;
        }
        if (cur_rev != NULL) {
            *cur_rev = cur;
        }
        if (has_base && is_write && base != cur) {
            free(abs);
            return SDE_BLOB_STALE;
        }
    }

    for (i = 0; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
        if (!bs->sess[i].used) {
            b = &bs->sess[i];
            break;
        }
    }
    if (b == NULL) {
        set_err(err, errcap, "too many open blob sessions");
        free(abs);
        return SDE_BLOB_FAIL;
    }

    if (is_write) {
        /*
         * Two sessions writing one target would share one temporary name, and
         * the second commit would publish whatever the first left there.
         */
        for (i = 0; i < (int) SDE_BLOB_MAX_SESSIONS; i++) {
            if (bs->sess[i].used && bs->sess[i].is_write
                && strcmp(bs->sess[i].abs, abs) == 0) {
                set_err_path(err, errcap, "another blob session is writing",
                             rel);
                free(abs);
                return SDE_BLOB_FAIL;
            }
        }
    }

    memset(b, 0, sizeof(*b));
    b->id = ++bs->next_id;
    b->used = 1;
    b->is_write = is_write;
    b->rel = sde_port_strdup(rel);
    if (b->rel == NULL) {
        free(abs);
        blob_close(b, 0);
        set_err(err, errcap, "out of memory");
        return SDE_BLOB_FAIL;
    }
    b->abs = abs;
    b->stamp = sde_port_now_ms();
    b->rev = SDE_REV_SEED;

    if (is_write) {
        char  *dir = abs_parent(abs);
        size_t cap;

        if (dir != NULL) {
            /* file.write creates a missing parent directory; so does this. */
            (void) sde_port_mkdirs(dir, (char *) 0, 0u);
            free(dir);
        }
        cap = strlen(abs) + 5u;
        b->tmp = (char *) malloc(cap);
        if (b->tmp == NULL) {
            blob_close(b, 0);
            set_err(err, errcap, "out of memory");
            return SDE_BLOB_FAIL;
        }
        snprintf(b->tmp, cap, "%s.tmp", abs);
        /* A kernel that died mid-session leaves one of these behind. */
        (void) sde_port_remove_file(b->tmp);
        if (sde_port_append_file(b->tmp, "", 0u, err, errcap) != 0) {
            blob_close(b, 1);
            return SDE_BLOB_FAIL;
        }
        b->pos = 0;
        b->size = 0;
    } else {
        int64_t size = sde_port_file_size(abs);

        if (size < 0) {
            blob_close(b, 0);
            set_err_path(err, errcap, "cannot read", rel);
            return SDE_BLOB_FAIL;
        }
        b->pos = 0;
        b->size = size;
    }

    {
        sde_json *o = session_object(b);

        if (o == NULL) {
            blob_close(b, 1);
            set_err(err, errcap, "out of memory");
            return SDE_BLOB_FAIL;
        }
        if (has_base || want_rev) {
            sde_json_set(o, "revision", sde_json_rev(cur));
        }
        deliver(o, out);
    }
    return SDE_BLOB_OK;
}

/* ====================================================================== */
/* read                                                                   */
/* ====================================================================== */

int sde_blob_read(sde_blobset *bs, long session, int has_offset, int64_t offset,
                  int has_length, int64_t length, sde_json **out,
                  char *err, size_t errcap)
{
    sde_blob *b;
    sde_buf   raw;
    sde_json *o;
    char     *b64;
    int64_t   want;
    int64_t   start;
    int64_t   got = 0;
    int64_t   seen = -1;

    if (out != NULL) {
        *out = (sde_json *) 0;
    }
    if (bs == NULL) {
        set_err(err, errcap, "no blob table");
        return SDE_BLOB_FAIL;
    }
    b = blob_find(bs, session);
    if (b == NULL) {
        set_err(err, errcap, "no such blob session");
        return SDE_BLOB_NOSESS;
    }
    if (b->is_write) {
        set_err(err, errcap, "a write session has nothing to read");
        return SDE_BLOB_PARAM;
    }
    if (has_length) {
        if (length < 1 || length > (int64_t) SDE_BLOB_MAX_CHUNK) {
            set_err(err, errcap, "length must be 1 to 1048576 bytes");
            return SDE_BLOB_PARAM;
        }
        want = length;
    } else {
        want = (int64_t) SDE_BLOB_MAX_CHUNK;
    }
    start = has_offset ? offset : b->pos;
    if (start < 0) {
        set_err(err, errcap, "offset must not be negative");
        return SDE_BLOB_PARAM;
    }
    /*
     * Asking past the end is answered at the end: the offset in the result is
     * where the bytes that came back start, and there are none.  Without this
     * the session would sit past the end and every later read would be empty.
     */
    if (start > b->size) {
        start = b->size;
    }

    sde_buf_init(&raw);
    if (start < b->size) {
        got = sde_port_read_at(b->abs, start, (size_t) want, &raw, &seen,
                               err, errcap);
        if (got < 0) {
            sde_buf_free(&raw);
            return SDE_BLOB_FAIL;
        }
    }
    if (seen >= 0) {
        b->size = seen;
    }
    b->pos = start + got;
    b->stamp = sde_port_now_ms();

    b64 = sde_base64_encode(raw.data, (size_t) got);
    if (b64 == NULL) {
        sde_buf_free(&raw);
        set_err(err, errcap, "out of memory");
        return SDE_BLOB_FAIL;
    }
    o = sde_json_obj();
    if (o == NULL) {
        free(b64);
        sde_buf_free(&raw);
        set_err(err, errcap, "out of memory");
        return SDE_BLOB_FAIL;
    }
    sde_json_set(o, "session", sde_json_int(b->id));
    sde_json_set(o, "offset", sde_json_num((double) start));
    sde_json_set(o, "size", sde_json_num((double) b->size));
    sde_json_set(o, "eof", sde_json_bool(b->pos >= b->size));
    sde_json_set(o, "data", sde_json_str(b64));
    free(b64);
    sde_buf_free(&raw);
    deliver(o, out);
    return SDE_BLOB_OK;
}

/* ====================================================================== */
/* append                                                                 */
/* ====================================================================== */

int sde_blob_append(sde_blobset *bs, long session, const char *data, size_t len,
                    int has_offset, int64_t offset, sde_json **out,
                    char *err, size_t errcap)
{
    sde_blob *b;
    sde_json *o;

    if (out != NULL) {
        *out = (sde_json *) 0;
    }
    if (bs == NULL) {
        set_err(err, errcap, "no blob table");
        return SDE_BLOB_FAIL;
    }
    b = blob_find(bs, session);
    if (b == NULL) {
        set_err(err, errcap, "no such blob session");
        return SDE_BLOB_NOSESS;
    }
    if (!b->is_write) {
        set_err(err, errcap, "a read session cannot be appended to");
        return SDE_BLOB_PARAM;
    }
    if (len > (size_t) SDE_BLOB_MAX_CHUNK) {
        set_err(err, errcap, "a chunk must not exceed 1048576 bytes");
        return SDE_BLOB_PARAM;
    }
    if (has_offset && offset != b->pos) {
        set_err(err, errcap,
                "offset does not match the end of what has been written");
        return SDE_BLOB_PARAM;
    }

    if (b->pos == 0) {
        /* The first chunk creates -- and truncates -- the temporary file. */
        if (sde_port_write_file(b->tmp, data, len, err, errcap) != 0) {
            return SDE_BLOB_FAIL;
        }
    } else if (len > 0u) {
        if (sde_port_append_file(b->tmp, data, len, err, errcap) != 0) {
            return SDE_BLOB_FAIL;
        }
    }

    b->rev = sde_rev_update(b->rev, data, len);
    b->pos += (int64_t) len;
    b->size = b->pos;
    b->stamp = sde_port_now_ms();

    o = sde_json_obj();
    if (o == NULL) {
        set_err(err, errcap, "out of memory");
        return SDE_BLOB_FAIL;
    }
    sde_json_set(o, "session", sde_json_int(b->id));
    sde_json_set(o, "offset", sde_json_num((double) b->pos));
    sde_json_set(o, "size", sde_json_num((double) b->size));
    deliver(o, out);
    return SDE_BLOB_OK;
}

/* ====================================================================== */
/* commit and abort                                                       */
/* ====================================================================== */

int sde_blob_commit(const sde_app *app, sde_blobset *bs, long session,
                    int has_total, int64_t total, sde_json **out,
                    char *err, size_t errcap)
{
    sde_blob     *b;
    sde_json     *o;
    unsigned long rev;
    int64_t       size;

    (void) app;
    if (out != NULL) {
        *out = (sde_json *) 0;
    }
    if (bs == NULL) {
        set_err(err, errcap, "no blob table");
        return SDE_BLOB_FAIL;
    }
    b = blob_find(bs, session);
    if (b == NULL) {
        set_err(err, errcap, "no such blob session");
        return SDE_BLOB_NOSESS;
    }
    if (!b->is_write) {
        set_err(err, errcap,
                "a read session has nothing to publish; use file.blobAbort");
        return SDE_BLOB_PARAM;
    }
    if (!has_total) {
        set_err(err, errcap, "file.blobCommit needs total_size");
        return SDE_BLOB_PARAM;
    }
    if (total != b->pos) {
        /* Nothing is thrown away: the client may still finish the file. */
        set_err(err, errcap, "total_size does not match the bytes written");
        return SDE_BLOB_PARAM;
    }
    if (sde_port_replace_file(b->tmp, b->abs) != 0) {
        set_err_path(err, errcap, "cannot replace", b->rel);
        return SDE_BLOB_FAIL;
    }

    rev = sde_rev_final(b->rev);
    size = b->pos;
    o = sde_json_obj();
    if (o == NULL) {
        blob_close(b, 0);
        set_err(err, errcap, "out of memory");
        return SDE_BLOB_FAIL;
    }
    sde_json_set(o, "path", sde_json_str(b->rel));
    sde_json_set(o, "size", sde_json_num((double) size));
    sde_json_set(o, "revision", sde_json_rev(rev));
    sde_json_set(o, "replaced", sde_json_bool(1));
    blob_close(b, 0);   /* the temporary file is the target now */
    deliver(o, out);
    return SDE_BLOB_OK;
}

int sde_blob_abort(sde_blobset *bs, long session, sde_json **out,
                   char *err, size_t errcap)
{
    sde_blob *b;
    sde_json *o;

    if (out != NULL) {
        *out = (sde_json *) 0;
    }
    if (bs == NULL) {
        set_err(err, errcap, "no blob table");
        return SDE_BLOB_FAIL;
    }
    b = blob_find(bs, session);
    if (b == NULL) {
        set_err(err, errcap, "no such blob session");
        return SDE_BLOB_NOSESS;
    }
    o = sde_json_obj();
    if (o != NULL) {
        sde_json_set(o, "aborted", sde_json_bool(1));
    }
    blob_close(b, 1);
    if (o == NULL) {
        set_err(err, errcap, "out of memory");
        return SDE_BLOB_FAIL;
    }
    deliver(o, out);
    return SDE_BLOB_OK;
}
