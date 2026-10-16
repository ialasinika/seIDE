/*
 * serve.c - newline-delimited JSON over stdin/stdout.
 *
 * Reads with stdio a line at a time -- no hand-rolled byte loop -- and writes
 * with the port's raw writer (so no layer can rewrite our line endings).
 *
 * The output mutex is the one piece of synchronisation in the transport: the
 * main thread answers requests while the proc pump thread may publish
 * `proc.output` at any moment, and a half-written frame would desynchronise
 * the shell's parser permanently.  If stdout itself fails, that mutex is not
 * enough -- nobody is reading any more -- so the failure is remembered and the
 * read loop ends rather than answering into a dead pipe.
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

/* Frames arrive as newline-delimited text; read them in chunks, not bytes. */
#define SDE_SERVE_CHUNK 8192u

static sde_mutex *g_out_mutex = NULL;
static int        g_out_failed = 0;   /* stdout refused: nobody is listening */

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
        } else {
            /*
             * stdout is gone: the shell died, or its pipe filled and it
             * stopped reading.  Either way it cannot hear us, and every later
             * answer would be written into the same dead pipe.
             */
            g_out_failed = 1;
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
    char    chunk[SDE_SERVE_CHUNK];
    size_t  n;
    int     complete;
    int     oversized = 0;
    int     status = 0;

    g_out_mutex = sde_mutex_new();
    if (g_out_mutex == NULL) {
        const char *note = "seide: cannot create the output lock\n";

        /*
         * Without the mutex a `proc.output` notification can land inside a
         * response frame and desynchronise the shell's parser for good.  That
         * is worse than not serving, so report it and stop.
         */
        sde_port_stderr_write(note, strlen(note));
        sde_app_free(app);
        return 1;
    }
    sde_buf_init(&line);

    /*
     * One stdio call per line, not per byte.  fgets() pulls a block from the
     * OS into stdio's own buffer and returns as soon as this line ends -- or
     * as soon as `chunk` is full, which is how a frame longer than the chunk
     * gets assembled across passes.  (A raw NUL would make strlen() stop
     * early; a frame with one in it is not JSON, so it is refused either way.)
     */
    while (!g_out_failed && fgets(chunk, (int) sizeof(chunk), stdin) != NULL) {
        n = strlen(chunk);
        complete = (n > 0 && chunk[n - 1] == '\n');

        if (oversized) {
            if (complete) {
                oversized = 0;   /* the rest of that frame is now drained */
            }
            continue;
        }

        if (complete) {
            n--;   /* the newline separates frames; it is not part of one */
        }

        if (line.len + n > SDE_SERVE_MAX_LINE) {
            sde_buf_clear(&line);
            sde_app_emit_simple(app, "log", "message",
                                "frame too large; dropped");
            oversized = complete ? 0 : 1;
            continue;
        }

        if (n > 0 && sde_buf_add(&line, chunk, n) != 0) {
            /* Out of memory mid-frame: drop it rather than run on garbage. */
            sde_buf_clear(&line);
            oversized = complete ? 0 : 1;
            continue;
        }

        if (!complete) {
            continue;   /* the frame continues in the next chunk */
        }

        handle_frame(app, line.data, line.len);
        sde_buf_clear(&line);
    }

    /* A final frame without a trailing newline still counts. */
    if (!g_out_failed && !oversized && line.len > 0) {
        handle_frame(app, line.data, line.len);
    }
    if (g_out_failed) {
        status = 1;
    }

    sde_buf_free(&line);

    /*
     * stdin closed, or stdout is gone: the shell is done with us either way.
     * Freeing the app kills every live child, which is the behaviour a closing
     * window needs.
     */
    sde_app_free(app);

    if (g_out_mutex != NULL) {
        sde_mutex_free(g_out_mutex);
        g_out_mutex = NULL;
    }
    return status;
}
