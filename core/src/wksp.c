/*
 * wksp.c - workspace paths, listings, reads, a stat, and revision-checked
 * writes.
 *
 * Two properties matter more than speed here:
 *
 *   1. Nothing outside `root` is ever touched, however creative the path in a
 *      request is.  sde_wksp_resolve() is the only door.
 *   2. A write that raced with someone else's write is refused rather than
 *      silently winning.  A document and the editor both rely on this.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "port.h"
#include "wksp.h"

/* Directories that are never interesting to a person browsing a workspace. */
static const char *const IGNORED_DIRS[] = {
    ".git", ".seide", ".hg", ".svn", "node_modules", "__pycache__",
    ".vscode", ".idea", ".cache", "dist", "build", "target", "obj"
};

static void set_err(char *err, size_t errcap, const char *message)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s", message);
    }
}

static void set_err_path(char *err, size_t errcap, const char *message, const char *path)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s: %s", message, path);
    }
}

/*
 * A size as JSON.  A file can be larger than a `long` here (MinGW's long is
 * 32 bits), and a double holds every integer below 2^53 exactly, so a size is
 * emitted as a number rather than as a truncated long.  For every size a
 * `long` can hold the bytes on the wire are unchanged.
 */
static sde_json *json_size(int64_t v)
{
    return sde_json_num((double) v);
}

/* ====================================================================== */
/* revisions                                                              */
/* ====================================================================== */

unsigned long sde_rev_update(unsigned long h, const char *data, size_t len)
{
    size_t i;

    for (i = 0; i < len; i++) {
        h ^= (unsigned long) (unsigned char) data[i];
        h = (h * 16777619UL) & 0xFFFFFFFFUL;
    }
    return h;
}

unsigned long sde_rev_final(unsigned long h)
{
    /*
     * 0 means "there is no revision to compare" -- an absent, unreadable or
     * non-text file.  The hash itself can land on 0 (~2^-32 per content), and
     * a file whose bytes hash to 0 would then be indistinguishable from a
     * missing one, so that one value is reported as 1.
     */
    return (h == 0UL) ? 1UL : h;
}

unsigned long sde_rev_of(const char *data, size_t len)
{
    return sde_rev_final(sde_rev_update(SDE_REV_SEED, data, len));
}

/*
 * The revision of the file at `path`.
 *
 *    0  *out holds the revision; 0 means the file does not exist, which is
 *       itself a fact a client compares against
 *   -1  the file is there but has no revision to give: it could not be read
 *
 * Keeping the two apart is the point.  When both reported 0, a write carrying
 * base 0 -- "I believe there is no file" -- matched an unreadable one and
 * overwrote it without ever comparing anything.
 */
static int rev_of_file(const char *path, unsigned long *out,
                       char *err, size_t errcap)
{
    sde_buf buf;

    *out = 0;
    if (!sde_port_file_exists(path)) {
        return 0;
    }
    sde_buf_init(&buf);
    if (sde_port_read_file(path, &buf, err, errcap) != 0) {
        set_err_path(err, errcap, "cannot read the file on disk", path);
        sde_buf_free(&buf);
        return -1;
    }
    *out = sde_rev_of(buf.data, buf.len);
    sde_buf_free(&buf);
    return 0;
}

/* ====================================================================== */
/* paths                                                                  */
/* ====================================================================== */

int sde_wksp_resolve(const sde_app *app, const char *rel, char **out_abs,
                     char *err, size_t errcap)
{
    char *joined;
    char *norm;

    if (out_abs != NULL) {
        *out_abs = NULL;
    }
    if (app == NULL || app->root == NULL) {
        set_err(err, errcap, "no workspace root");
        return -1;
    }
    if (rel == NULL || rel[0] == '\0') {
        set_err(err, errcap, "empty path");
        return -1;
    }
    /*
     * Absolute paths are accepted as long as they land inside the workspace.
     * Refusing them outright would only push the join-and-check dance onto
     * every client (and the shell already knows absolute paths, because that
     * is what the kernel reports back).
     */
    if (sde_port_path_is_abs(rel)) {
        joined = sde_port_strdup(rel);
    } else {
        joined = sde_port_path_join(app->root, rel);
    }
    if (joined == NULL) {
        set_err(err, errcap, "out of memory");
        return -1;
    }
    norm = sde_port_path_norm(joined);
    free(joined);
    if (norm == NULL) {
        set_err(err, errcap, "out of memory");
        return -1;
    }
    if (!sde_port_path_within(app->root, norm)) {
        set_err_path(err, errcap, "path escapes the workspace", rel);
        free(norm);
        return -1;
    }
    if (out_abs != NULL) {
        *out_abs = norm;
    } else {
        free(norm);
    }
    return 0;
}

/* ====================================================================== */
/* glob matching                                                          */
/* ====================================================================== */

/*
 * Windows paths are case-insensitive, so literal comparison folds case.  A
 * glob that behaved differently from the file system underneath it would be a
 * bug generator, not a feature.
 */
static int ch_fold(int c)
{
    if (c >= 'A' && c <= 'Z') {
        return c - 'A' + 'a';
    }
    return c;
}

/*
 * `*` matches within one path segment, `?` matches one non-separator
 * character, and `**` matches across separators - including none at all, so a
 * pattern that wants a file anywhere in the tree also finds one at the top
 * level.  (Do not spell that separator out next to the stars here: the two
 * characters together would close this comment, as once happened.)
 *
 * The pattern language is the kernel's whole opinion about file names: it
 * carries no table of extensions, and no example here names a programming
 * language, because the kernel does not know one.
 */
static int glob_match(const char *p, const char *s)
{
    while (*p != '\0') {
        if (p[0] == '*') {
            if (p[1] == '*') {
                const char *rest = p + 2;
                const char *scan;

                if (*rest == '/') {
                    rest++;
                }
                if (glob_match(rest, s)) {
                    return 1;
                }
                for (scan = s; *scan != '\0'; scan++) {
                    if (*scan == '/' && glob_match(rest, scan + 1)) {
                        return 1;
                    }
                }
                return 0;
            }
            {
                const char *rest = p + 1;
                const char *scan = s;

                for (;;) {
                    if (glob_match(rest, scan)) {
                        return 1;
                    }
                    if (*scan == '\0' || *scan == '/') {
                        return 0;
                    }
                    scan++;
                }
            }
        }
        if (p[0] == '?') {
            if (*s == '\0' || *s == '/') {
                return 0;
            }
            p++;
            s++;
            continue;
        }
        if (*s == '\0' || ch_fold((unsigned char) *p) != ch_fold((unsigned char) *s)) {
            return 0;
        }
        p++;
        s++;
    }
    return *s == '\0';
}

static int is_ignored_dir(const char *name)
{
    size_t i;

    for (i = 0; i < sizeof(IGNORED_DIRS) / sizeof(IGNORED_DIRS[0]); i++) {
        if (strcmp(name, IGNORED_DIRS[i]) == 0) {
            return 1;
        }
    }
    return 0;
}

/*
 * The same table, for callers that have to *tell* someone what the listing left
 * out.  A client cannot work the names out from a listing -- absent rows look
 * like an empty directory -- so `workspace.info` reports them and a panel can
 * say "the kernel does not list build" without keeping its own copy of a rule
 * that lives here.
 */
const char *const *sde_wksp_ignored_dirs(size_t *count)
{
    if (count != NULL) {
        *count = sizeof(IGNORED_DIRS) / sizeof(IGNORED_DIRS[0]);
    }
    return IGNORED_DIRS;
}

/* ====================================================================== */
/* listing                                                                */
/* ====================================================================== */

typedef struct walk_state {
    const char *glob;
    long        limit;
    long        count;      /* entries accepted so far (dirs + files) */
    long        file_count; /* files only, for workspace.info */
    int         truncated;
    sde_json   *files;
    char       *err;
    size_t      errcap;
} walk_state;

static char *rel_join(const char *dir, const char *name)
{
    size_t dl;
    size_t nl;
    char  *out;

    if (dir[0] == '\0') {
        nl = strlen(name);
        out = (char *) malloc(nl + 1);
        if (out != NULL) {
            memcpy(out, name, nl + 1);
        }
        return out;
    }
    dl = strlen(dir);
    nl = strlen(name);
    out = (char *) malloc(dl + 1 + nl + 1);
    if (out == NULL) {
        return NULL;
    }
    memcpy(out, dir, dl);
    out[dl] = '/';
    memcpy(out + dl + 1, name, nl + 1);
    return out;
}

static void walk(walk_state *w, const char *abs_dir, const char *rel_dir, int depth)
{
    sde_vec entries;
    size_t  i;

    if (w->truncated || depth > SDE_WKSP_MAX_DEPTH) {
        return;
    }
    sde_vec_init(&entries);

    if (sde_port_list_dir(abs_dir, &entries, w->err, w->errcap) != 0) {
        sde_vec_free(&entries);
        return; /* unreadable directory: skip it, do not fail the listing */
    }

    for (i = 0; i < entries.count; i++) {
        sde_dirent *d = (sde_dirent *) sde_vec_at(&entries, i);
        char       *rel;

        if (d == NULL) {
            continue;
        }
        if (d->is_dir && is_ignored_dir(d->name)) {
            continue;
        }
        rel = rel_join(rel_dir, d->name);
        if (rel == NULL) {
            set_err(w->err, w->errcap, "out of memory");
            break;
        }

        /*
         * Only matching entries are listed -- both files and directories, so
         * that a pattern like "core/src/star.c" with a real star yields
         * exactly the sources, while the default pattern yields everything.
         * Recursion below is unconditional: a directory that does not match
         * the pattern may still contain descendants that do.
         */
        if (glob_match(w->glob, rel)) {
            if (w->count >= w->limit) {
                w->truncated = 1;
                free(rel);
                break;
            }
            {
                sde_json *item = sde_json_obj();

                if (item == NULL) {
                    set_err(w->err, w->errcap, "out of memory");
                    free(rel);
                    break;
                }
                sde_json_set(item, "path", sde_json_str(rel));
                sde_json_set(item, "dir", sde_json_bool(d->is_dir ? 1 : 0));
                sde_json_set(item, "size", json_size(d->is_dir ? 0 : d->size));
                if (sde_json_push(w->files, item) != 0) {
                    sde_json_free(item);
                    set_err(w->err, w->errcap, "out of memory");
                    free(rel);
                    break;
                }
                w->count++;
                if (!d->is_dir) {
                    w->file_count++;
                }
            }
        }

        if (d->is_dir) {
            char *child_abs = sde_port_path_join(abs_dir, d->name);

            if (child_abs != NULL) {
                walk(w, child_abs, rel, depth + 1);
                free(child_abs);
            }
        }
        free(rel);
    }

    for (i = 0; i < entries.count; i++) {
        sde_dirent *d = (sde_dirent *) sde_vec_at(&entries, i);
        if (d != NULL) {
            sde_port_dirent_free(d);
        }
    }
    sde_vec_free(&entries);
}

sde_json *sde_wksp_list(const sde_app *app, const char *glob, long limit,
                        char *err, size_t errcap)
{
    walk_state w;
    sde_json  *out;

    if (limit <= 0 || limit > SDE_WKSP_MAX_LIST) {
        limit = SDE_WKSP_MAX_LIST;
    }

    memset(&w, 0, sizeof(w));
    w.glob = (glob == NULL || glob[0] == '\0') ? "**/*" : glob;
    w.limit = limit;
    w.err = err;
    w.errcap = errcap;
    w.files = sde_json_arr();
    if (w.files == NULL) {
        set_err(err, errcap, "out of memory");
        return NULL;
    }

    walk(&w, app->root, "", 0);

    out = sde_json_obj();
    if (out == NULL) {
        sde_json_free(w.files);
        set_err(err, errcap, "out of memory");
        return NULL;
    }
    sde_json_set(out, "files", w.files);
    sde_json_set(out, "truncated", sde_json_bool(w.truncated));
    sde_json_set(out, "count", sde_json_int((long) sde_json_count(w.files)));
    return out;
}

sde_json *sde_wksp_info(const sde_app *app, char *err, size_t errcap)
{
    sde_json *listing;
    sde_json *out;
    long      file_count = 0;
    const char *slash;

    listing = sde_wksp_list(app, "**/*", SDE_WKSP_MAX_LIST, err, errcap);
    if (listing == NULL) {
        return NULL;
    }
    {
        sde_json *files = sde_json_get(listing, "files");
        size_t    i;
        size_t    n = sde_json_count(files);

        for (i = 0; i < n; i++) {
            sde_json *item = sde_json_at(files, i);
            if (!sde_json_getb(item, "dir", 0)) {
                file_count++;
            }
        }
    }
    sde_json_free(listing);

    out = sde_json_obj();
    if (out == NULL) {
        set_err(err, errcap, "out of memory");
        return NULL;
    }
    sde_json_set(out, "root", sde_json_str(app->root));
    slash = strrchr(app->root, '/');
    sde_json_set(out, "name", sde_json_str(slash == NULL ? app->root : slash + 1));
    sde_json_set(out, "file_count", sde_json_int(file_count));
    return out;
}

/* ====================================================================== */
/* reading and writing                                                    */
/* ====================================================================== */

static const char *detect_eol(const char *text, size_t len)
{
    size_t i;

    for (i = 0; i < len; i++) {
        if (text[i] == '\n') {
            return (i > 0 && text[i - 1] == '\r') ? "crlf" : "lf";
        }
    }
    return "lf";
}

sde_json *sde_wksp_read(const sde_app *app, const char *rel, char *err, size_t errcap)
{
    char     *abs = NULL;
    sde_buf   buf;
    sde_json *out;
    unsigned long rev;
    const char *text;
    size_t    len;

    if (sde_wksp_resolve(app, rel, &abs, err, errcap) != 0) {
        return NULL;
    }
    if (sde_port_is_dir(abs)) {
        set_err_path(err, errcap, "is a directory", rel);
        free(abs);
        return NULL;
    }
    if (!sde_port_file_exists(abs)) {
        set_err_path(err, errcap, "no such file", rel);
        free(abs);
        return NULL;
    }
    if (sde_port_file_size(abs) > (int64_t) SDE_WKSP_MAX_READ) {
        set_err_path(err, errcap, "file is too large to open", rel);
        free(abs);
        return NULL;
    }

    sde_buf_init(&buf);
    if (sde_port_read_file(abs, &buf, err, errcap) != 0) {
        sde_buf_free(&buf);
        free(abs);
        return NULL;
    }
    text = buf.data;
    len = buf.len;
    if (text == NULL) {
        text = "";
    }

    /* A NUL byte means this is not text, and shipping it as a JSON string
     * would produce a document no client can round-trip. */
    if (len > 0 && memchr(text, '\0', len) != NULL) {
        set_err_path(err, errcap, "file is binary", rel);
        sde_buf_free(&buf);
        free(abs);
        return NULL;
    }

    rev = sde_rev_of(text, len);
    out = sde_json_obj();
    if (out == NULL) {
        set_err(err, errcap, "out of memory");
        sde_buf_free(&buf);
        free(abs);
        return NULL;
    }
    sde_json_set(out, "path", sde_json_str(rel));
    sde_json_set(out, "text", sde_json_str(text));
    sde_json_set(out, "revision", sde_json_rev(rev));
    sde_json_set(out, "eol", sde_json_str(detect_eol(text, len)));
    sde_json_set(out, "size", sde_json_int((long) len));
    sde_json_set(out, "mtime", sde_json_int(sde_port_file_mtime(abs)));

    sde_buf_free(&buf);
    free(abs);
    return out;
}

sde_json *sde_wksp_stat(const sde_app *app, const char *rel, char *err, size_t errcap)
{
    char         *abs = NULL;
    sde_json     *out;
    int           is_dir;
    int           exists;
    int64_t       size = 0;
    unsigned long rev = 0;

    if (sde_wksp_resolve(app, rel, &abs, err, errcap) != 0) {
        return NULL;
    }
    is_dir = sde_port_is_dir(abs);
    exists = is_dir || sde_port_file_exists(abs);
    if (exists && !is_dir) {
        size = sde_port_file_size(abs);
        if (size < 0) {
            size = 0;
        }
        /*
         * The revision has to be the number `file.read` hands out for the same
         * bytes, or a client comparing a held revision with this one could
         * miss a change.  So the same two refusals apply: a file past the read
         * cap, and a file with a NUL byte in it, have no revision to report.
         */
        if (size <= (int64_t) SDE_WKSP_MAX_READ) {
            if (size == 0) {
                rev = sde_rev_of("", 0);
            } else {
                sde_buf buf;

                sde_buf_init(&buf);
                if (sde_port_read_file(abs, &buf, NULL, 0) == 0
                    && buf.data != NULL
                    && memchr(buf.data, '\0', buf.len) == NULL) {
                    rev = sde_rev_of(buf.data, buf.len);
                }
                sde_buf_free(&buf);
            }
        }
    }

    out = sde_json_obj();
    if (out == NULL) {
        set_err(err, errcap, "out of memory");
        free(abs);
        return NULL;
    }
    sde_json_set(out, "path", sde_json_str(rel));
    sde_json_set(out, "exists", sde_json_bool(exists));
    sde_json_set(out, "dir", sde_json_bool(is_dir));
    sde_json_set(out, "size", json_size(size));
    sde_json_set(out, "mtime",
                 sde_json_int(exists ? sde_port_file_mtime(abs) : -1));
    sde_json_set(out, "revision", sde_json_rev(rev));

    free(abs);
    return out;
}
/* Creates every missing parent directory of an absolute path. */
static int ensure_parent(const char *abs, char *err, size_t errcap)
{
    size_t i;
    size_t len = strlen(abs);
    char  *dir;
    int    rc = 0;

    dir = (char *) malloc(len + 1);
    if (dir == NULL) {
        set_err(err, errcap, "out of memory");
        return -1;
    }
    memcpy(dir, abs, len + 1);

    for (i = len; i > 0; i--) {
        if (dir[i] == '/') {
            dir[i] = '\0';
            break;
        }
    }
    if (i > 0 && !sde_port_is_dir(dir)) {
        rc = sde_port_mkdirs(dir, err, errcap);
    }
    free(dir);
    return rc;
}

int sde_wksp_write(const sde_app *app, const char *rel, const char *text,
                   size_t len, int has_base, unsigned long base,
                   sde_json **out, unsigned long *cur_rev,
                   char *err, size_t errcap)
{
    char         *abs = NULL;
    unsigned long cur;
    sde_json     *result;

    if (out != NULL) {
        *out = NULL;
    }
    if (cur_rev != NULL) {
        *cur_rev = 0;
    }
    if (sde_wksp_resolve(app, rel, &abs, err, errcap) != 0) {
        return SDE_WKSP_FAIL;
    }
    if (sde_port_is_dir(abs)) {
        set_err_path(err, errcap, "is a directory", rel);
        free(abs);
        return SDE_WKSP_FAIL;
    }
    if (sde_port_file_size(abs) > (int64_t) SDE_WKSP_MAX_READ) {
        set_err_path(err, errcap, "file is too large to overwrite", rel);
        free(abs);
        return SDE_WKSP_FAIL;
    }

    if (rev_of_file(abs, &cur, err, errcap) != 0) {
        /*
         * The file is there but has no revision to compare, so no base can be
         * proved to match it.  Refusing is the honest answer: overwriting here
         * would be the lost update optimistic locking exists to prevent.
         */
        free(abs);
        return SDE_WKSP_FAIL;
    }
    if (cur_rev != NULL) {
        *cur_rev = cur;
    }
    if (has_base && base != cur) {
        /* Someone else got there first.  Refusing is the whole point. */
        set_err_path(err, errcap, "file changed on disk", rel);
        free(abs);
        return SDE_WKSP_STALE;
    }
    if (ensure_parent(abs, err, errcap) != 0) {
        free(abs);
        return SDE_WKSP_FAIL;
    }
    if (sde_port_write_file(abs, text, len, err, errcap) != 0) {
        free(abs);
        return SDE_WKSP_FAIL;
    }

    result = sde_json_obj();
    if (result == NULL) {
        set_err(err, errcap, "out of memory");
        free(abs);
        return SDE_WKSP_FAIL;
    }
    sde_json_set(result, "path", sde_json_str(rel));
    sde_json_set(result, "revision", sde_json_rev(sde_rev_of(text, len)));
    sde_json_set(result, "eol", sde_json_str(detect_eol(text, len)));
    sde_json_set(result, "size", sde_json_int((long) len));
    if (out != NULL) {
        *out = result;
    } else {
        sde_json_free(result);
    }
    free(abs);
    return SDE_WKSP_OK;
}
