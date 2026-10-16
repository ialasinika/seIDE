/*
 * app.c - construction of the shared kernel state.
 *
 * The kernel starts with an empty view: it reads no document until a client
 * asks for one (`view.load`) and it has no opinion about what a document
 * contains.  A client's file is therefore never a reason for the kernel to
 * refuse to start, which is what a board that did not parse used to be.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "blob.h"
#include "proc.h"
#include "port.h"
#include "view.h"

int sde_app_init(sde_app *app, const char *root, const char *exe_dir,
                 sde_emit_fn emit, void *ud, char *err, size_t errcap)
{
    char *abs_root;

    (void) exe_dir; /* reserved: forks may use it to locate their own assets */

    if (app == NULL) {
        return -1;
    }
    memset(app, 0, sizeof(*app));
    app->emit = emit;
    app->emit_ud = ud;

    abs_root = sde_port_path_abs(root == NULL ? "." : root);
    if (abs_root == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "cannot resolve workspace root");
        }
        return -1;
    }
    if (!sde_port_is_dir(abs_root)) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "not a directory: %s", abs_root);
        }
        free(abs_root);
        return -1;
    }
    app->root = abs_root;

    app->view = sde_view_new();
    if (app->view == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }

    app->procs = sde_procset_new();
    if (app->procs == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }
    /* Lets the proc pump thread publish notifications through app->emit. */
    sde_procset_bind(app->procs, app);

    app->blobs = sde_blobset_new();
    if (app->blobs == NULL) {
        if (err != NULL && errcap > 0) {
            snprintf(err, errcap, "out of memory");
        }
        sde_app_free(app);
        return -1;
    }

    return 0;
}

void sde_app_free(sde_app *app)
{
    if (app == NULL) {
        return;
    }
    free(app->root);
    app->root = NULL;
    sde_view_free(app->view);
    app->view = NULL;
    sde_procset_free(app->procs);
    app->procs = NULL;
    /* Closes whatever a client left open, temporary files included. */
    sde_blobset_free(app->blobs);
    app->blobs = NULL;
}

int sde_app_notify(sde_app *app, sde_json *payload)
{
    if (app == NULL || app->emit == NULL) {
        sde_json_free(payload);
        return -1;
    }
    return app->emit(app->emit_ud, payload);
}

void sde_app_emit_simple(sde_app *app, const char *event, const char *key1,
                         const char *val1)
{
    sde_json *n = sde_json_obj();

    if (n == NULL) {
        return;
    }
    sde_json_set(n, "event", sde_json_str(event));
    if (key1 != NULL) {
        sde_json_set(n, key1, sde_json_str(val1 == NULL ? "" : val1));
    }
    (void) sde_app_notify(app, n);
}
