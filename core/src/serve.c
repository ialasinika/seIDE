/*
 * serve.c - newline-delimited JSON over stdin/stdout.
 *
 * Reads with stdio (buffered, so a byte-at-a-time loop is cheap) and writes
 * with the port's raw writer (so no layer can rewrite our line endings).
 *
 * The output mutex is the one piece of synchronisation in the transport: the
 * main thread answers requests while the proc pump thread may publish
 * `proc.output` at any moment, and a half-written frame would desynchronise
 * the shell's parser permanently.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "buf.h"
#include "json.h"
#include "port.h"
#include "rpc.h"
#include "serve.h"

/*
 * A single frame cap.  Frames are whole files, so this is generous; its only
 * job is to stop a runaway writer from eating all memory.  An oversized frame
 * is reported and dropped rather than killing the session.
 */
#define SDE_SERVE_MAX_LINE (64u * 1024u * 1024u)

static sde_mutex *g_out_mutex = NULL;

static void out_lock(void)
{
    if (g_out_mutex != NULL) {
        sde_mutex_lock(g_out_mutex);
    }
}

static void out_unlock(void)
{
    if (g_out_mutex != NULL) {
        sde_mutex_unlock(g_out_mutex);
    }
}

int sde_serve_emit(void *ud, sde_json *payload)
{
    sde_buf   b;
    int       ok = -1;

    (void) ud;
    if (payload == NULL) {
        return -1;
    }

    sde_buf_init(&b);
    if (sde_json_write(&b, payload) == 0 && sde_buf_addc(&b, '\n') == 0) {
        out_lock();
        if (sde_port_stdout_write(b.data, b.len) == 0) {
            ok = 0;
        }
        out_unlock();
    }
    sde_buf_free(&b);
    sde_json_free(payload);
    return ok;
}

static void answer(sde_app *app, sde_json *response)
{
    if (response != NULL) {
        (void) sde_serve_emit(app->emit_ud, response);
    }
}

static int is_space(char c)
{
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static void handle_frame(sde_app *app, char *text, size_t len)
{
    char      err[160];
    sde_json *req;
    sde_json *resp;

    while (len > 0 && is_space(text[len - 1])) {
        len--;
    }
    while (len > 0 && is_space(text[0])) {
        text++;
        len--;
    }
    if (len == 0) {
        return;   /* blank keep-alive line */
    }

    req = sde_json_parse(text, len, err, sizeof(err));
    if (req == NULL) {
        answer(app, sde_rpc_error(NULL, SDE_RPC_PARSE_ERROR, "PARSE_ERROR",
                                  err));
        return;
    }

    resp = sde_rpc_handle(app, req);
    sde_json_free(req);
    answer(app, resp);
}

int sde_serve(sde_app *app)
{
    sde_buf line;
    int     c;
    int     oversized = 0;
    int     status = 0;

    g_out_mutex = sde_mutex_new();
    sde_buf_init(&line);

    for (;;) {
        c = fgetc(stdin);

        if (c == EOF) {
            /* A final frame without a trailing newline still counts. */
            if (!oversized && line.len > 0) {
                handle_frame(app, line.data, line.len);
            }
            break;
        }

        if (c == '\n') {
            if (oversized) {
                oversized = 0;
            } else {
                handle_frame(app, line.data, line.len);
            }
            sde_buf_clear(&line);
            continue;
        }

        if (oversized) {
            continue;   /* draining the rest of an unacceptable frame */
        }

        if (line.len >= SDE_SERVE_MAX_LINE) {
            oversized = 1;
            sde_buf_clear(&line);
            sde_app_emit_simple(app, "log", "message",
                                "frame too large; dropped");
            continue;
        }

        if (sde_buf_addc(&line, (char) c) != 0) {
            /* Out of memory mid-frame: drop it rather than run on garbage. */
            oversized = 1;
            sde_buf_clear(&line);
            continue;
        }
    }

    sde_buf_free(&line);

    /*
     * stdin closed: the shell is gone (or asked us to stop).  Freeing the app
     * kills every live child, which is the behaviour a closing window needs.
     */
    sde_app_free(app);

    if (g_out_mutex != NULL) {
        sde_mutex_free(g_out_mutex);
        g_out_mutex = NULL;
    }
    return status;
}
