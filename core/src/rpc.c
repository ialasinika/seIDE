/*
 * rpc.c - method dispatch.
 *
 * Every method is a small function that either fills in `c->owned` with the
 * result or calls fail().  Keeping them uniform is what makes the module
 * table in `module.h` honest: a fork deletes a handler, deletes its line in
 * `sde_methods[]`, and the protocol shrinks cleanly.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "base64.h"
#include "blob.h"
#include "json.h"
#include "port.h"
#include "proc.h"
#include "rpc.h"
#include "view.h"
#include "wksp.h"

typedef struct sde_call {
    sde_app        *app;
    const sde_json *params;  /* may be NULL */
    int             code;    /* 0 while the call is still succeeding */
    const char     *ename;
    char            message[256];
    sde_json       *data;    /* owned; optional error detail */
    sde_json       *owned;   /* owned; the result */
} sde_call;

typedef void (*sde_handler)(sde_call *c);

typedef struct sde_method {
    const char *name;
    sde_handler fn;
} sde_method;

/* ---------------------------------------------------------------------- */
/* result and error plumbing                                              */
/* ---------------------------------------------------------------------- */

static void fail(sde_call *c, int code, const char *name, const char *message)
{
    c->code = code;
    c->ename = name;
    snprintf(c->message, sizeof(c->message), "%s",
             message == NULL ? "failed" : message);
}

static void need_string(sde_call *c, const char *key, const char **out)
{
    const char *v;

    if (c->code != 0) {
        return;
    }
    v = sde_json_gets(c->params, key, NULL);
    if (v == NULL || v[0] == '\0') {
        char msg[128];
        snprintf(msg, sizeof(msg), "missing non-empty string `%s`", key);
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS", msg);
        return;
    }
    *out = v;
}

/* ---------------------------------------------------------------------- */
/* handlers: the kernel itself                                            */
/* ---------------------------------------------------------------------- */

static void h_hello(sde_call *c)
{
    sde_json *r = sde_json_obj();

    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    /*
     * `protocol` is the integer a client can compare; `protocol_name` is the
     * same version spelled out for a human reading a log line.
     */
    sde_json_set(r, "protocol", sde_json_int(SDE_PROTOCOL_VERSION));
    sde_json_set(r, "protocol_name", sde_json_str(SDE_PROTOCOL));
    sde_json_set(r, "kernel_version", sde_json_str(SDE_VERSION));
    sde_json_set(r, "root", sde_json_str(c->app->root));
    sde_json_set(r, "pid", sde_json_int(sde_port_pid()));
    c->owned = r;
}

static void h_workspace_info(sde_call *c)
{
    char        err[256];
    char        base[256];
    const char *slash;
    const char *const *ignored;
    size_t      ignored_count;
    size_t      i;
    sde_json   *info;
    sde_json   *names;

    err[0] = '\0';
    info = sde_wksp_info(c->app, err, sizeof(err));
    if (info == NULL) {
        fail(c, SDE_RPC_IO, "IO", err[0] ? err : "cannot inspect workspace");
        return;
    }

    slash = strrchr(c->app->root, '/');
    snprintf(base, sizeof(base), "%s",
             slash == NULL ? c->app->root : slash + 1);
    sde_json_set(info, "name", sde_json_str(base));
    /*
     * Where the client's document lives, and what revision it is at.  It is a
     * report, not a configuration: the kernel holds whatever path the client
     * last named, and nothing until then.
     */
    sde_json_set(info, "view_path", sde_json_str(sde_view_path(c->app->view)));
    sde_json_set(info, "view_revision",
                 sde_json_rev(sde_view_revision(c->app->view)));

    /* What `workspace.list` will never hand over, so a client can say why a
       directory it expects is missing instead of guessing. */
    ignored = sde_wksp_ignored_dirs(&ignored_count);
    names = sde_json_arr();
    for (i = 0; i < ignored_count; i++) {
        sde_json_push(names, sde_json_str(ignored[i]));
    }
    sde_json_set(info, "ignored", names);
    c->owned = info;
}

/*
 * Reads an optional numeric parameter.  Returns 1 when the caller supplied a
 * number, 0 when the member is absent (or explicitly null), and -1 when it is
 * present with some other type.
 *
 * A wrong-typed member is a caller bug, not a reason to fall back to the
 * default.  For `base_revision` the fallback silently throws away an
 * optimistic-locking check, turning a detected conflict into a lost update;
 * for `limit` it silently ignores the caller's bound.  Both must be reported.
 */
static int opt_number(const sde_json *params, const char *key, double *out)
{
    const sde_json *v = sde_json_get(params, key);

    if (v == NULL || v->type == SDE_JSON_NULL) {
        return 0;
    }
    if (v->type != SDE_JSON_NUM) {
        return -1;
    }
    *out = sde_json_as_num(v, 0.0);
    return 1;
}

static void h_workspace_list(sde_call *c)
{
    char        err[256];
    char        pattern[600];
    const char *path = sde_json_gets(c->params, "path", NULL);
    const char *glob = sde_json_gets(c->params, "glob", NULL);
    double      limit_num = 0.0;
    long        limit = 0;
    sde_json   *res;

    switch (opt_number(c->params, "limit", &limit_num)) {
    case -1:
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`limit` must be a number");
        return;
    case 1:
        limit = (long) limit_num;
        break;
    default:
        break;
    }

    err[0] = '\0';
    if (path != NULL && path[0] != '\0') {
        const char *g = (glob == NULL || glob[0] == '\0') ? "**/*" : glob;
        snprintf(pattern, sizeof(pattern), "%s/%s", path, g);
    } else {
        snprintf(pattern, sizeof(pattern), "%s",
                 (glob == NULL || glob[0] == '\0') ? "**/*" : glob);
    }

    res = sde_wksp_list(c->app, pattern, limit, err, sizeof(err));
    if (res == NULL) {
        fail(c, SDE_RPC_IO, "IO", err[0] ? err : "cannot list workspace");
        return;
    }
    c->owned = res;
}

/* Decides whether a failed path lookup was "absent" or "unreadable". */
static void fail_path(sde_call *c, const char *rel, const char *err)
{
    char *abs = NULL;

    if (sde_wksp_resolve(c->app, rel, &abs, NULL, 0) == 0) {
        int exists = sde_port_file_exists(abs);
        free(abs);
        if (!exists) {
            fail(c, SDE_RPC_NOT_FOUND, "NOT_FOUND", "no such file");
            return;
        }
    }
    fail(c, SDE_RPC_IO, "IO", err == NULL || err[0] == '\0'
         ? "cannot read file" : err);
}

static void h_file_read(sde_call *c)
{
    char         err[256];
    const char  *path = NULL;
    sde_json    *res;

    need_string(c, "path", &path);
    if (c->code != 0) {
        return;
    }
    err[0] = '\0';
    res = sde_wksp_read(c->app, path, err, sizeof(err));
    if (res == NULL) {
        fail_path(c, path, err);
        return;
    }
    c->owned = res;
}

static void h_file_write(sde_call *c)
{
    char                err[256];
    const char         *path = NULL;
    const sde_json     *textv;
    const char         *text;
    size_t              len;
    int                 has_base;
    double              base_num = 0.0;
    unsigned long       base = 0;
    unsigned long       cur = 0;
    sde_json           *res = NULL;
    int                 rc;
    sde_json           *note;

    need_string(c, "path", &path);
    if (c->code != 0) {
        return;
    }

    textv = sde_json_get(c->params, "text");
    if (textv == NULL) {
        /*
         * "I forgot the member" and "write an empty file" must not be the same
         * request: treating an absent `text` as "" silently truncated the file.
         */
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`text` is required; send \"\" to write an empty file");
        return;
    }
    if (textv->type != SDE_JSON_STR) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`text` must be a string");
        return;
    }
    text = sde_json_as_str(textv);
    if (text == NULL) {
        text = "";
    }
    len = strlen(text);

    switch (opt_number(c->params, "base_revision", &base_num)) {
    case -1:
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`base_revision` must be a number when it is present");
        return;
    case 1:
        has_base = 1;
        base = (unsigned long) base_num;
        break;
    default:
        has_base = 0;
        break;
    }

    err[0] = '\0';
    rc = sde_wksp_write(c->app, path, text, len, has_base, base,
                        &res, &cur, err, sizeof(err));
    if (rc == SDE_WKSP_STALE) {
        sde_json *d = sde_json_obj();
        if (d != NULL) {
            sde_json_set(d, "current_revision", sde_json_rev(cur));
        }
        fail(c, SDE_RPC_STALE_REVISION, "STALE_REVISION",
             "file changed on disk since it was read");
        c->data = d;
        return;
    }
    if (rc != SDE_WKSP_OK || res == NULL) {
        sde_json_free(res);
        fail(c, SDE_RPC_IO, "IO", err[0] ? err : "cannot write file");
        return;
    }

    /* Other viewers of the same workspace need to know. */
    note = sde_json_obj();
    if (note != NULL) {
        sde_json_set(note, "event", sde_json_str("file.changed"));
        sde_json_set(note, "path", sde_json_str(path));
        sde_json_set(note, "revision",
                     sde_json_rev((unsigned long) sde_json_as_num(
                         sde_json_get(res, "revision"), 0.0)));
        (void) sde_app_notify(c->app, note);
    }

    c->owned = res;
}

/*
 * The cheap half of `file.read`: what a watcher needs to ask "did this change?"
 * without paying for the text.  A missing file is not an error here -- it is
 * the answer -- so only a path that cannot be resolved at all fails.
 */
static void h_file_stat(sde_call *c)
{
    char        err[256];
    const char *path = NULL;
    sde_json   *res;

    need_string(c, "path", &path);
    if (c->code != 0) {
        return;
    }
    err[0] = '\0';
    res = sde_wksp_stat(c->app, path, err, sizeof(err));
    if (res == NULL) {
        fail_path(c, path, err);
        return;
    }
    c->owned = res;
}

/* ---------------------------------------------------------------------- */
/* handlers: the view document                                            */
/* ---------------------------------------------------------------------- */

#if SDE_WITH_VIEW

static void h_view_load(sde_call *c)
{
    char        err[256];
    const char *path = NULL;
    sde_json   *r;
    sde_json   *doc;
    sde_json   *copy;

    need_string(c, "path", &path);
    if (c->code != 0) {
        return;
    }
    err[0] = '\0';
    if (sde_view_load(c->app->view, c->app, path, err, sizeof(err)) != 0) {
        fail(c, SDE_RPC_IO, "IO", err[0] ? err : "cannot load the view document");
        return;
    }
    r = sde_json_obj();
    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    /*
     * A first run has no document, and that is what the answer says: an
     * explicit null, so a client can tell "nothing there yet" from a reply
     * that forgot the member.
     */
    doc = sde_view_document(c->app->view);
    if (doc == NULL) {
        sde_json_set(r, "document", sde_json_null());
    } else {
        copy = sde_json_clone(doc);
        if (copy == NULL) {
            sde_json_free(r);
            fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
            return;
        }
        sde_json_set(r, "document", copy);
    }
    sde_json_set(r, "path", sde_json_str(sde_view_path(c->app->view)));
    sde_json_set(r, "revision",
                 sde_json_rev(sde_view_revision(c->app->view)));
    c->owned = r;
}

static void h_view_save(sde_call *c)
{
    char            err[256];
    const char     *path = NULL;
    const sde_json *doc;
    sde_json       *copy;
    int             has_base;
    double          base_num = 0.0;
    unsigned long   base = 0;
    unsigned long   prev;
    sde_json       *r;
    sde_json       *note;

    need_string(c, "path", &path);
    if (c->code != 0) {
        return;
    }
    /*
     * The document is opaque, but it has to be *there*: "no document" and "a
     * document" must stay distinguishable, so an absent member or an explicit
     * null is a caller bug.  Any other JSON value is accepted -- object, array,
     * string, number, boolean -- and round-trips exactly.
     */
    doc = sde_json_get(c->params, "document");
    if (doc == NULL || doc->type == SDE_JSON_NULL) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`document` must be a JSON value, and not null");
        return;
    }
    copy = sde_json_clone(doc);
    if (copy == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }

    prev = sde_view_revision(c->app->view);
    switch (opt_number(c->params, "base_revision", &base_num)) {
    case -1:
        sde_json_free(copy);
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`base_revision` must be a number when it is present");
        return;
    case 1:
        has_base = 1;
        base = (unsigned long) base_num;
        break;
    default:
        has_base = 0;
        break;
    }
    if (has_base && base != prev) {
        sde_json *d = sde_json_obj();
        if (d != NULL) {
            sde_json_set(d, "current_revision", sde_json_rev(prev));
        }
        sde_json_free(copy);
        fail(c, SDE_RPC_STALE_REVISION, "STALE_REVISION",
             "the view document changed since it was loaded");
        c->data = d;
        return;
    }

    err[0] = '\0';
    if (sde_view_store(c->app->view, c->app, path, copy, err, sizeof(err)) != 0) {
        /* store() only takes ownership on success, so `copy` is still ours. */
        sde_json_free(copy);
        fail(c, SDE_RPC_IO, "IO", err[0] ? err : "cannot save the view document");
        return;
    }

    note = sde_json_obj();
    if (note != NULL) {
        sde_json_set(note, "event", sde_json_str("view.changed"));
        sde_json_set(note, "path", sde_json_str(sde_view_path(c->app->view)));
        sde_json_set(note, "revision",
                     sde_json_rev(sde_view_revision(c->app->view)));
        (void) sde_app_notify(c->app, note);
    }

    r = sde_json_obj();
    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    sde_json_set(r, "path", sde_json_str(sde_view_path(c->app->view)));
    sde_json_set(r, "revision",
                 sde_json_rev(sde_view_revision(c->app->view)));
    sde_json_set(r, "saved", sde_json_bool(1));
    c->owned = r;
}

#endif /* SDE_WITH_VIEW */

/* ---------------------------------------------------------------------- */
/* handlers: child processes                                              */
/* ---------------------------------------------------------------------- */

#if SDE_WITH_PROC

static void h_proc_start(sde_call *c)
{
    char        err[256];
    const char *cmd = NULL;
    const char *cwd = sde_json_gets(c->params, "cwd", NULL);
    char       *abs_cwd = NULL;
    long        run_id;
    sde_json   *r;

    need_string(c, "cmd", &cmd);
    if (c->code != 0) {
        return;
    }

    if (cwd != NULL && cwd[0] != '\0') {
        err[0] = '\0';
        if (sde_wksp_resolve(c->app, cwd, &abs_cwd, err, sizeof(err)) != 0) {
            fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
                 err[0] ? err : "`cwd` is outside the workspace");
            return;
        }
    } else {
        abs_cwd = sde_port_strdup(c->app->root);
    }

    err[0] = '\0';
    run_id = sde_procset_start(c->app->procs, cmd, abs_cwd, err, sizeof(err));
    free(abs_cwd);
    if (run_id < 0) {
        fail(c, SDE_RPC_PROC, "PROC", err[0] ? err : "cannot start process");
        return;
    }

    r = sde_json_obj();
    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    sde_json_set(r, "run_id", sde_json_int(run_id));
    c->owned = r;
}

/*
 * The three calls that name one run share this check.  Returns 0 and fills
 * `*run_id` in, or answers the call with an error and returns -1.
 */
static int want_run(sde_call *c, long *run_id)
{
    const sde_json *idv = sde_json_get(c->params, "run_id");

    if (idv == NULL || idv->type != SDE_JSON_NUM) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`run_id` must be a number");
        return -1;
    }
    *run_id = sde_json_as_int(idv, -1);
    return 0;
}

/*
 * Writes to a child's stdin.  The bytes are queued by the port layer and go
 * out on a writer thread of its own, so this answers immediately even when
 * the child has stopped reading; a queue that is already full is an error,
 * which is what keeps a chatty client from growing the kernel's memory.
 */
static void h_proc_send(sde_call *c)
{
    const char *data = NULL;
    long        run_id = 0;
    char        err[256];
    sde_json   *r;

    if (want_run(c, &run_id) != 0) {
        return;
    }
    need_string(c, "data", &data);
    if (c->code != 0) {
        return;
    }

    err[0] = '\0';
    if (sde_procset_send(c->app->procs, run_id, data, strlen(data),
                         err, sizeof(err)) != 0) {
        fail(c, SDE_RPC_PROC, "PROC",
             err[0] ? err : "cannot write to that process");
        return;
    }

    r = sde_json_obj();
    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    sde_json_set(r, "written", sde_json_int((long) strlen(data)));
    c->owned = r;
}

/*
 * Closes a child's stdin after everything already queued has gone out.  A
 * client that speaks a framed protocol uses this to say "no more requests";
 * the process then finishes on its own and `proc.exit` retires it.
 */
static void h_proc_close(sde_call *c)
{
    long      run_id = 0;
    sde_json *r;

    if (want_run(c, &run_id) != 0) {
        return;
    }
    if (sde_procset_close_input(c->app->procs, run_id) != 0) {
        fail(c, SDE_RPC_NOT_FOUND, "NOT_FOUND", "no such run");
        return;
    }
    r = sde_json_obj();
    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    sde_json_set(r, "closed", sde_json_bool(1));
    c->owned = r;
}

static void h_proc_stop(sde_call *c)
{
    long      run_id = 0;
    sde_json *r;

    if (want_run(c, &run_id) != 0) {
        return;
    }
    if (sde_procset_stop(c->app->procs, run_id) != 0) {
        fail(c, SDE_RPC_NOT_FOUND, "NOT_FOUND", "no such run");
        return;
    }
    r = sde_json_obj();
    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    sde_json_set(r, "stopped", sde_json_bool(1));
    c->owned = r;
}

static void h_proc_list(sde_call *c)
{
    sde_json *r = sde_procset_list(c->app->procs);

    if (r == NULL) {
        fail(c, SDE_RPC_INTERNAL, "INTERNAL", "out of memory");
        return;
    }
    c->owned = r;
}

#endif /* SDE_WITH_PROC */

/* ---------------------------------------------------------------------- */
/* handlers: binary and large files                                        */
/* ---------------------------------------------------------------------- */

/*
 * Maps a blob session status onto a JSON-RPC error.  The mapping is most of
 * the contract: a stale base is 1001 and carries the revision to retry from, a
 * missing file is 1002, real I/O trouble is 1003, and anything the caller got
 * wrong about the request is their own -32602.
 */
static void fail_blob(sde_call *c, int rc, unsigned long cur, const char *err)
{
    sde_json   *d;
    const char *msg = (err != NULL && err[0] != '\0') ? err
                                                     : "blob request failed";

    if (rc == SDE_BLOB_STALE) {
        d = sde_json_obj();
        if (d != NULL) {
            sde_json_set(d, "current_revision", sde_json_rev(cur));
        }
        fail(c, SDE_RPC_STALE_REVISION, "STALE_REVISION",
             "file changed on disk since it was read");
        c->data = d;
        return;
    }
    if (rc == SDE_BLOB_NOTFOUND) {
        fail(c, SDE_RPC_NOT_FOUND, "NOT_FOUND", "no such file");
        return;
    }
    if (rc == SDE_BLOB_NOSESS) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "no such blob session");
        return;
    }
    if (rc == SDE_BLOB_PARAM) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS", msg);
        return;
    }
    fail(c, SDE_RPC_IO, "IO", msg);
}

/* `session` is required, and it must be a number. */
static int need_session(sde_call *c, long *out)
{
    const sde_json *v = sde_json_get(c->params, "session");

    if (v == NULL || v->type != SDE_JSON_NUM) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`session` is required and must be a number");
        return -1;
    }
    *out = sde_json_as_int(v, 0);
    return 0;
}

/*
 * An optional integer member.  Integers are exact here -- the parser keeps the
 * digits it saw -- so an offset past 2^53 survives the trip, which matters for
 * a file large enough to be worth a session in the first place.
 */
static int opt_i64(sde_call *c, const char *key, int *has, int64_t *out)
{
    const sde_json *v = sde_json_get(c->params, key);
    char            msg[128];

    *has = 0;
    *out = 0;
    if (v == NULL) {
        return 0;
    }
    if (v->type != SDE_JSON_NUM) {
        snprintf(msg, sizeof(msg), "`%s` must be a number", key);
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS", msg);
        return -1;
    }
    if (v->inum) {
        *out = (int64_t) v->ival;
    } else {
        *out = (int64_t) v->nval;
    }
    *has = 1;
    return 0;
}

static void h_file_blob_open(sde_call *c)
{
    char          err[256];
    const char   *path = NULL;
    const char   *mode = NULL;
    int           has_base = 0;
    int64_t       base_i = 0;
    int           want_rev = 0;
    unsigned long cur = 0;
    sde_json     *res = NULL;
    int           rc;

    need_string(c, "path", &path);
    need_string(c, "mode", &mode);
    if (c->code != 0) {
        return;
    }
    if (opt_i64(c, "base_revision", &has_base, &base_i) != 0) {
        return;
    }
    want_rev = sde_json_getb(c->params, "want_revision", 0);

    err[0] = '\0';
    rc = sde_blob_open(c->app, c->app->blobs, path, mode, has_base,
                       (unsigned long) base_i, want_rev, &res, &cur,
                       err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        sde_json_free(res);
        fail_blob(c, rc, cur, err);
        return;
    }
    c->owned = res;
}

static void h_file_blob_read(sde_call *c)
{
    char      err[256];
    long      session = 0;
    int       has_offset = 0;
    int       has_length = 0;
    int64_t   offset = 0;
    int64_t   length = 0;
    sde_json *res = NULL;
    int       rc;

    if (need_session(c, &session) != 0) {
        return;
    }
    if (opt_i64(c, "offset", &has_offset, &offset) != 0) {
        return;
    }
    if (opt_i64(c, "length", &has_length, &length) != 0) {
        return;
    }

    err[0] = '\0';
    rc = sde_blob_read(c->app->blobs, session, has_offset, offset,
                       has_length, length, &res, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        sde_json_free(res);
        fail_blob(c, rc, 0, err);
        return;
    }
    c->owned = res;
}

static void h_file_blob_append(sde_call *c)
{
    char            err[256];
    long            session = 0;
    const sde_json *v;
    const char     *b64;
    size_t          b64len;
    char           *raw = NULL;
    size_t          rawlen = 0;
    int             has_offset = 0;
    int64_t         offset = 0;
    sde_json       *res = NULL;
    int             rc;

    if (need_session(c, &session) != 0) {
        return;
    }

    /*
     * A chunk travels base64 because a JSON string cannot hold a NUL.  The
     * encoded size is checked before the decode: a frame over the limit is
     * refused without allocating four thirds of it first.
     */
    v = sde_json_get(c->params, "data");
    if (v == NULL || v->type != SDE_JSON_STR) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`data` must be a base64 string");
        return;
    }
    b64 = sde_json_as_str(v);
    if (b64 == NULL) {
        b64 = "";
    }
    b64len = strlen(b64);
    if (b64len > (size_t) SDE_BLOB_MAX_CHUNK / 3u * 4u + 4u) {
        char msg[128];
        snprintf(msg, sizeof(msg),
                 "`data` decodes to more than %d bytes", SDE_BLOB_MAX_CHUNK);
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS", msg);
        return;
    }
    if (sde_base64_decode(b64, b64len, &raw, &rawlen) != 0) {
        fail(c, SDE_RPC_INVALID_PARAMS, "INVALID_PARAMS",
             "`data` is not valid base64");
        return;
    }
    if (opt_i64(c, "offset", &has_offset, &offset) != 0) {
        free(raw);
        return;
    }

    err[0] = '\0';
    rc = sde_blob_append(c->app->blobs, session,
                         raw == NULL ? "" : raw, rawlen,
                         has_offset, offset, &res, err, sizeof(err));
    free(raw);
    if (rc != SDE_BLOB_OK) {
        sde_json_free(res);
        fail_blob(c, rc, 0, err);
        return;
    }
    c->owned = res;
}

static void h_file_blob_commit(sde_call *c)
{
    char      err[256];
    long      session = 0;
    int       has_total = 0;
    int64_t   total = 0;
    sde_json *res = NULL;
    sde_json *note;
    int       rc;

    if (need_session(c, &session) != 0) {
        return;
    }
    if (opt_i64(c, "total_size", &has_total, &total) != 0) {
        return;
    }

    err[0] = '\0';
    rc = sde_blob_commit(c->app, c->app->blobs, session, has_total, total,
                         &res, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        sde_json_free(res);
        fail_blob(c, rc, 0, err);
        return;
    }

    /* Other viewers of the same workspace need to know. */
    note = sde_json_obj();
    if (note != NULL) {
        const sde_json *p = sde_json_get(res, "path");
        const sde_json *r = sde_json_get(res, "revision");

        sde_json_set(note, "event", sde_json_str("file.changed"));
        if (p != NULL) {
            sde_json_set(note, "path", sde_json_clone(p));
        }
        if (r != NULL) {
            sde_json_set(note, "revision", sde_json_clone(r));
        }
        (void) sde_app_notify(c->app, note);
    }

    c->owned = res;
}

static void h_file_blob_abort(sde_call *c)
{
    char      err[256];
    long      session = 0;
    sde_json *res = NULL;
    int       rc;

    if (need_session(c, &session) != 0) {
        return;
    }

    err[0] = '\0';
    rc = sde_blob_abort(c->app->blobs, session, &res, err, sizeof(err));
    if (rc != SDE_BLOB_OK) {
        sde_json_free(res);
        fail_blob(c, rc, 0, err);
        return;
    }
    c->owned = res;
}

/* ---------------------------------------------------------------------- */
/* the table                                                              */
/* ---------------------------------------------------------------------- */

static const sde_method sde_methods[] = {
    { "hello",          h_hello },
    { "workspace.info", h_workspace_info },
    { "workspace.list", h_workspace_list },
    { "file.read",      h_file_read },
    { "file.write",     h_file_write },
    { "file.stat",      h_file_stat },
    { "file.blobOpen",  h_file_blob_open },
    { "file.blobRead",  h_file_blob_read },
    { "file.blobAppend", h_file_blob_append },
    { "file.blobCommit", h_file_blob_commit },
    { "file.blobAbort", h_file_blob_abort },
#if SDE_WITH_VIEW
    { "view.load",      h_view_load },
    { "view.save",      h_view_save },
#endif
#if SDE_WITH_PROC
    { "proc.start",     h_proc_start },
    { "proc.send",      h_proc_send },
    { "proc.close",     h_proc_close },
    { "proc.stop",      h_proc_stop },
    { "proc.list",      h_proc_list },
#endif
    { NULL, NULL }
};

/* ---------------------------------------------------------------------- */
/* the frame                                                              */
/* ---------------------------------------------------------------------- */

sde_json *sde_rpc_error(const sde_json *id, int code, const char *name,
                        const char *message)
{
    sde_json *resp = sde_json_obj();
    sde_json *e;

    if (resp == NULL) {
        return NULL;
    }
    sde_json_set(resp, "jsonrpc", sde_json_str("2.0"));
    sde_json_set(resp, "id", id == NULL ? sde_json_null()
                                        : sde_json_clone(id));
    e = sde_json_obj();
    if (e == NULL) {
        sde_json_free(resp);
        return NULL;
    }
    sde_json_set(e, "code", sde_json_int((long) code));
    sde_json_set(e, "name", sde_json_str(name == NULL ? "ERROR" : name));
    sde_json_set(e, "message",
                 sde_json_str(message == NULL ? "" : message));
    sde_json_set(resp, "error", e);
    return resp;
}

sde_json *sde_rpc_handle(sde_app *app, const sde_json *req)
{
    sde_call        c;
    sde_json       *resp;
    const sde_json *id;
    const sde_json *params;
    const char     *method;
    size_t          i;
    int             found = 0;

    if (req == NULL || req->type != SDE_JSON_OBJ) {
        return sde_rpc_error(NULL, SDE_RPC_INVALID_REQUEST, "INVALID_REQUEST",
                             "request must be a JSON object");
    }

    id = sde_json_get(req, "id");
    method = sde_json_as_str(sde_json_get(req, "method"));
    params = sde_json_get(req, "params");

    if (method == NULL) {
        /* A malformed notification is simply dropped; a request is answered. */
        if (id == NULL) {
            return NULL;
        }
        return sde_rpc_error(id, SDE_RPC_INVALID_REQUEST, "INVALID_REQUEST",
                             "missing string `method`");
    }

    memset(&c, 0, sizeof(c));
    c.app = app;
    c.params = params;

    for (i = 0; sde_methods[i].name != NULL; i++) {
        if (strcmp(sde_methods[i].name, method) == 0) {
            found = 1;
            sde_methods[i].fn(&c);
            break;
        }
    }
    if (!found) {
        char msg[192];
        snprintf(msg, sizeof(msg), "no such method `%s`", method);
        fail(&c, SDE_RPC_METHOD_NOT_FOUND, "METHOD_NOT_FOUND", msg);
    }

    /* A notification gets no answer, even when it failed. */
    if (id == NULL) {
        sde_json_free(c.owned);
        sde_json_free(c.data);
        return NULL;
    }

    resp = sde_json_obj();
    if (resp == NULL) {
        sde_json_free(c.owned);
        sde_json_free(c.data);
        return NULL;
    }
    sde_json_set(resp, "jsonrpc", sde_json_str("2.0"));
    sde_json_set(resp, "id", sde_json_clone(id));

    if (c.code != 0) {
        sde_json *e = sde_json_obj();
        if (e != NULL) {
            sde_json_set(e, "code", sde_json_int((long) c.code));
            sde_json_set(e, "name",
                         sde_json_str(c.ename == NULL ? "ERROR" : c.ename));
            sde_json_set(e, "message", sde_json_str(c.message));
            if (c.data != NULL) {
                sde_json_set(e, "data", c.data);
                c.data = NULL;
            }
            sde_json_set(resp, "error", e);
        }
    } else {
        sde_json_set(resp, "result",
                     c.owned == NULL ? sde_json_obj() : c.owned);
        c.owned = NULL;
    }

    sde_json_free(c.owned);
    sde_json_free(c.data);
    return resp;
}
