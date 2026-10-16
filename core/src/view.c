/*
 * view.c - see view.h: a JSON document the client owns, kept alive by the
 * kernel.
 *
 * The work here is small on purpose.  Loading is "resolve, read, skip a BOM,
 * parse"; storing is "print, hand it to the port".  Everything that
 * used to live in this file's predecessor -- the board schema, id allocation,
 * geometry and link validation, the `.seide/board.json` path -- moved to the
 * client that actually decides what the document means
 * (`shell/web/board.mjs`).
 */
#include "seide_cfg.h"   /* first: it fixes snprintf and _WIN32_WINNT */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port.h"
#include "view.h"
#include "wksp.h"
#include "buf.h"

struct sde_view {
    char     *path;   /* workspace-relative, or NULL before any load/store */
    sde_json *doc;    /* the document; NULL means "there is none yet" */
};

static void set_err(char *err, size_t errcap, const char *msg)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s", msg);
    }
}

/*
 * The one place that changes what the kernel remembers.  `path` is copied
 * first so the switch itself cannot fail half-way: either the view is the new
 * document or it is untouched.
 */
static int install(sde_view *v, const char *rel, sde_json *doc)
{
    char *copy = sde_port_strdup(rel);

    if (copy == NULL) {
        return -1;
    }
    sde_json_free(v->doc);
    free(v->path);
    v->doc = doc;
    v->path = copy;
    return 0;
}

sde_view *sde_view_new(void)
{
    sde_view *v = (sde_view *) malloc(sizeof(*v));

    if (v == NULL) {
        return NULL;
    }
    v->path = NULL;
    v->doc = NULL;
    return v;
}

void sde_view_free(sde_view *v)
{
    if (v == NULL) {
        return;
    }
    free(v->path);
    sde_json_free(v->doc);
    free(v);
}

sde_json *sde_view_document(const sde_view *v)
{
    return v->doc;
}

const char *sde_view_path(const sde_view *v)
{
    return v->path == NULL ? "" : v->path;
}

unsigned long sde_view_revision(const sde_view *v)
{
    sde_buf       out;
    unsigned long rev;

    if (v->doc == NULL) {
        /* Nothing to compare.  A document that exists hashes to a real number,
           so 0 means "no revision", never "empty". */
        return 0;
    }
    sde_buf_init(&out);
    if (sde_json_write_canonical(&out, v->doc) != 0) {
        sde_buf_free(&out);
        return 0;
    }
    rev = sde_rev_of(sde_buf_cstr(&out), out.len);
    sde_buf_free(&out);
    return rev;
}

int sde_view_load(sde_view *v, const sde_app *app, const char *rel,
                  char *err, size_t errcap)
{
    char       *abs = NULL;
    sde_buf     raw;
    const char *text;
    size_t      len;
    char        perr[256];
    sde_json   *doc = NULL;

    if (sde_wksp_resolve(app, rel, &abs, err, errcap) != 0) {
        return -1;
    }
    if (sde_port_is_dir(abs)) {
        set_err(err, errcap, "the view document is a directory, not a file");
        free(abs);
        return -1;
    }
    if (!sde_port_file_exists(abs)) {
        /* A first run: no document is the answer, not an error. */
        free(abs);
        if (install(v, rel, NULL) != 0) {
            set_err(err, errcap, "out of memory");
            return -1;
        }
        return 0;
    }
    if (sde_port_file_size(abs) > (int64_t) SDE_VIEW_MAX_READ) {
        set_err(err, errcap, "the view document is larger than the kernel will read");
        free(abs);
        return -1;
    }
    sde_buf_init(&raw);
    if (sde_port_read_file(abs, &raw, err, errcap) != 0) {
        sde_buf_free(&raw);
        free(abs);
        return -1;
    }
    free(abs);

    text = sde_buf_cstr(&raw);
    len = raw.len;
    /*
     * A UTF-8 BOM is not JSON, but Windows editors add one readily.  Skipping
     * it is the difference between "your document is unreadable" and reading
     * it.
     */
    if (len >= 3u && (unsigned char) text[0] == 0xEFu
        && (unsigned char) text[1] == 0xBBu && (unsigned char) text[2] == 0xBFu) {
        text += 3;
        len -= 3u;
    }
    perr[0] = '\0';
    doc = sde_json_parse(text, len, perr, sizeof(perr));
    sde_buf_free(&raw);
    if (doc == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "the view document is not JSON: %s",
                     perr[0] == '\0' ? "cannot parse it" : perr);
        }
        return -1;
    }
    if (install(v, rel, doc) != 0) {
        sde_json_free(doc);
        set_err(err, errcap, "out of memory");
        return -1;
    }
    return 0;
}

int sde_view_store(sde_view *v, const sde_app *app, const char *rel,
                   sde_json *doc, char *err, size_t errcap)
{
    char   *abs = NULL;
    char   *path_copy;
    sde_buf out;
    int     rc = -1;

    if (doc == NULL) {
        set_err(err, errcap, "there is no document to save");
        return -1;
    }
    path_copy = sde_port_strdup(rel);
    if (path_copy == NULL) {
        set_err(err, errcap, "out of memory");
        return -1;
    }
    if (sde_wksp_resolve(app, rel, &abs, err, errcap) != 0) {
        free(path_copy);
        return -1;
    }
    sde_buf_init(&out);
    if (sde_json_write_pretty(&out, doc, 2) != 0 || sde_buf_addc(&out, '\n') != 0) {
        set_err(err, errcap, "out of memory");
        goto done;
    }
    /*
     * The port publishes atomically -- it writes a neighbour and replaces this
     * path -- so a reader (or a crash) sees either the whole old document or
     * the whole new one, never half of one.  file.write gets the same guarantee
     * from the same function; there is no second write path left to get it
     * wrong in.
     */
    if (sde_port_write_file(abs, sde_buf_cstr(&out), out.len, err, errcap) != 0) {
        set_err(err, errcap, "cannot write the view document");
        goto done;
    }
    rc = 0;

done:
    sde_buf_free(&out);
    free(abs);
    if (rc != 0) {
        free(path_copy);
        return -1;
    }
    /* The file is written, so the kernel now holds this document.  No failure
       is possible past this point: only pointers change. */
    sde_json_free(v->doc);
    free(v->path);
    v->doc = doc;
    v->path = path_copy;
    return 0;
}
