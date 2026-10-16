/*
 * proc.c - child process bookkeeping, the duplex channel and the pump.
 *
 * One pump thread serves every run.  It polls each live process with the
 * non-blocking sde_proc_read() offered by the port layer and turns what it
 * finds into notifications.  Polling (15 ms) rather than blocking readers
 * keeps the kernel single-writer: nothing but this thread and the RPC loop
 * writes to stdout, and both go through the same emit callback, which the
 * shell layer serialises behind one mutex.  Input travels the other way on
 * the port layer's writer thread, so a call that sends bytes to a child that
 * has stopped reading cannot stall the RPC loop.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "proc.h"
#include "json.h"
#include "port.h"

#define SDE_PROC_MAX_RUNS    64
#define SDE_PROC_IDLE_MS     15
#define SDE_PROC_READ_MAX    8192

typedef struct sde_run {
    long          id;
    char         *cmd;
    char         *cwd;
    sde_proc     *proc;
    int           running;
    int           code;
    unsigned long started;
} sde_run;

struct sde_procset {
    sde_run    *runs;
    size_t      count;
    size_t      cap;
    long        next_id;
    sde_mutex  *lock;
    sde_thread *pump;
    volatile int pump_stop;
    int          pump_started;
    sde_app    *app;
};

/* ---------------------------------------------------------------------- */
/* helpers                                                                */
/* ---------------------------------------------------------------------- */

static void set_err(char *err, size_t errcap, const char *msg)
{
    if (err != NULL && errcap > 0) {
        snprintf(err, errcap, "%s", msg);
    }
}

static sde_json *notification(const char *event, long run_id)
{
    sde_json *n = sde_json_obj();

    if (n == NULL) {
        return NULL;
    }
    sde_json_set(n, "event", sde_json_str(event));
    sde_json_set(n, "run_id", sde_json_int(run_id));
    return n;
}

/*
 * Drops the oldest finished runs so a long session cannot grow without
 * bound.  Called with `lock` held and at least one free slot available.
 */
static void prune_locked(sde_procset *s)
{
    size_t i;

    while (s->count >= SDE_PROC_MAX_RUNS) {
        size_t victim = s->count; /* none found yet */

        for (i = 0; i < s->count; i++) {
            if (!s->runs[i].running) {
                victim = i;
                break;
            }
        }
        if (victim == s->count) {
            break; /* every run is still alive; let the table grow instead */
        }
        sde_proc_free(s->runs[victim].proc);
        free(s->runs[victim].cmd);
        free(s->runs[victim].cwd);
        memmove(&s->runs[victim], &s->runs[victim + 1],
                (s->count - victim - 1) * sizeof(sde_run));
        s->count--;
    }
}

/* ---------------------------------------------------------------------- */
/* lifecycle                                                              */
/* ---------------------------------------------------------------------- */

sde_procset *sde_procset_new(void)
{
    sde_procset *s = (sde_procset *) malloc(sizeof(sde_procset));

    if (s == NULL) {
        return NULL;
    }
    s->runs = NULL;
    s->count = 0;
    s->cap = 0;
    s->next_id = 1;
    s->pump = NULL;
    s->pump_stop = 0;
    s->pump_started = 0;
    s->app = NULL;
    s->lock = sde_mutex_new();
    if (s->lock == NULL) {
        free(s);
        return NULL;
    }
    return s;
}

void sde_procset_bind(sde_procset *s, sde_app *app)
{
    if (s != NULL) {
        s->app = app;
    }
}

static void pump_main(void *ud)
{
    sde_procset *s = (sde_procset *) ud;

    while (!s->pump_stop) {
        if (sde_procset_pump(s) == 0) {
            sde_port_sleep_ms(SDE_PROC_IDLE_MS);
        }
    }
}

static void ensure_pump(sde_procset *s)
{
    if (s->pump_started) {
        return;
    }
    s->pump_started = 1;
    s->pump_stop = 0;
    s->pump = sde_thread_start(pump_main, s);
}

void sde_procset_free(sde_procset *s)
{
    size_t i;

    if (s == NULL) {
        return;
    }
    s->pump_stop = 1;
    if (s->pump != NULL) {
        sde_thread_join(s->pump);
        s->pump = NULL;
    }

    for (i = 0; i < s->count; i++) {
        if (s->runs[i].running) {
            sde_proc_kill(s->runs[i].proc);
        }
        sde_proc_free(s->runs[i].proc);
        free(s->runs[i].cmd);
        free(s->runs[i].cwd);
    }
    free(s->runs);
    sde_mutex_free(s->lock);
    free(s);
}

/* ---------------------------------------------------------------------- */
/* starting and stopping                                                  */
/* ---------------------------------------------------------------------- */

long sde_procset_start(sde_procset *s, const char *cmd, const char *cwd,
                       char *err, size_t errcap)
{
    sde_proc *proc;
    long      id;

    if (s == NULL || cmd == NULL || cmd[0] == '\0') {
        set_err(err, errcap, "proc.start needs a non-empty `cmd`");
        return -1;
    }

    proc = sde_proc_start(cmd, cwd, err, errcap);
    if (proc == NULL) {
        if (err != NULL && errcap > 0 && err[0] == '\0') {
            set_err(err, errcap, "cannot start process");
        }
        return -1;
    }

    sde_mutex_lock(s->lock);
    prune_locked(s); /* keeps the table bounded; never drops a live run */
    if (s->count == s->cap) {
        size_t   want = (s->cap == 0) ? 8 : s->cap * 2;
        sde_run *grown;

        grown = (sde_run *) realloc(s->runs, want * sizeof(sde_run));
        if (grown == NULL) {
            sde_mutex_unlock(s->lock);
            sde_proc_free(proc);
            set_err(err, errcap, "out of memory");
            return -1;
        }
        s->runs = grown;
        s->cap = want;
    }

    id = s->next_id++;
    s->runs[s->count].id = id;
    s->runs[s->count].cmd = sde_port_strdup(cmd);
    s->runs[s->count].cwd = sde_port_strdup(cwd == NULL ? "" : cwd);
    s->runs[s->count].proc = proc;
    s->runs[s->count].running = 1;
    s->runs[s->count].code = -1;
    s->runs[s->count].started = sde_port_now_ms();
    s->count++;
    sde_mutex_unlock(s->lock);

    ensure_pump(s);
    return id;
}

int sde_procset_stop(sde_procset *s, long run_id)
{
    size_t i;
    int    found = 0;
    int    stopped = 0;

    if (s == NULL) {
        return -1;
    }
    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        if (s->runs[i].id == run_id) {
            found = 1;
            if (s->runs[i].running) {
                sde_proc_kill(s->runs[i].proc);
                s->runs[i].running = 0;
                s->runs[i].code = -1;
                stopped = 1;
            }
            break;
        }
    }
    sde_mutex_unlock(s->lock);

    if (stopped) {
        /*
         * `proc.exit` is the only event that retires a run, and the pump skips
         * runs that are no longer running, so a stopped run would otherwise
         * stay on screen forever.  The code matches what `proc.list` reports
         * for the same run (-1, "stopped rather than exited").  Whatever the
         * child had left in its pipe is discarded: the user asked for it to
         * die, not to finish.
         */
        sde_json *notif = notification("proc.exit", run_id);

        if (notif != NULL) {
            sde_json_set(notif, "code", sde_json_int(-1));
            (void) sde_app_notify(s->app, notif);
        }
    }
    return found ? 0 : -1;
}

/*
 * Looks a run up and hands it the port layer's process.  Called with no lock
 * held; the caller owns whatever it does with the process next.  A run that
 * has already exited has no input left to write to, which is an error.
 */
static sde_proc *lookup_live(sde_procset *s, long run_id)
{
    size_t     i;
    sde_proc  *proc = NULL;

    if (s == NULL) {
        return NULL;
    }
    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        if (s->runs[i].id == run_id && s->runs[i].running) {
            proc = s->runs[i].proc;
            break;
        }
    }
    sde_mutex_unlock(s->lock);
    return proc;
}

int sde_procset_send(sde_procset *s, long run_id, const char *data, size_t len,
                     char *err, size_t errcap)
{
    sde_proc *proc = lookup_live(s, run_id);

    if (proc == NULL) {
        set_err(err, errcap, "no such running process");
        return -1;
    }
    /*
     * The port layer queues the bytes and returns; it never calls WriteFile
     * from this thread.  Holding no lock here matters: a child that stopped
     * reading must not be able to block the RPC loop, and it cannot.
     */
    return sde_proc_write(proc, data, len, err, errcap);
}

int sde_procset_close_input(sde_procset *s, long run_id)
{
    sde_proc *proc = lookup_live(s, run_id);

    if (proc == NULL) {
        return -1;
    }
    return sde_proc_close_input(proc);
}

int sde_procset_live_count(const sde_procset *s)
{
    size_t i;
    int    n = 0;

    if (s == NULL) {
        return 0;
    }
    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        if (s->runs[i].running) {
            n++;
        }
    }
    sde_mutex_unlock(s->lock);
    return n;
}

sde_json *sde_procset_list(const sde_procset *s)
{
    sde_json *out = sde_json_obj();
    sde_json *arr = sde_json_arr();
    size_t    i;

    if (out == NULL || arr == NULL) {
        sde_json_free(out);
        sde_json_free(arr);
        return NULL;
    }

    sde_mutex_lock(s->lock);
    for (i = 0; i < s->count; i++) {
        sde_json *r = sde_json_obj();

        if (r == NULL) {
            continue;
        }
        sde_json_set(r, "run_id", sde_json_int(s->runs[i].id));
        sde_json_set(r, "cmd", sde_json_str(s->runs[i].cmd));
        sde_json_set(r, "running", sde_json_bool(s->runs[i].running));
        sde_json_set(r, "code", sde_json_int(s->runs[i].code));
        sde_json_set(r, "started", sde_json_int((long) s->runs[i].started));
        sde_json_push(arr, r);
    }
    sde_mutex_unlock(s->lock);

    sde_json_set(out, "runs", arr);
    return out;
}

/* ---------------------------------------------------------------------- */
/* the pump                                                               */
/* ---------------------------------------------------------------------- */

/*
 * A child process may print anything at all -- a NUL byte, a stray 0x80 from a
 * binary blob, half a UTF-8 sequence cut in two by the read -- but a JSON
 * string must be valid UTF-8 and cannot contain U+0000.  Rather than drop
 * everything from the first byte JSON cannot carry (which silently truncated
 * the output and still reported the read as successful), every byte that cannot
 * be carried becomes U+FFFD.  The shell used to do this rewrite itself; doing
 * it here means both endpoints agree on what a run produced.
 */
static void append_safe(sde_buf *out, const char *data, size_t len)
{
    const unsigned char *p = (const unsigned char *) data;
    size_t               i = 0;

    if (data == NULL) {
        return;
    }
    while (i < len) {
        unsigned char c = p[i];
        size_t        need;
        unsigned long cp;
        size_t        k;
        int           ok;

        if (c < 0x80u) {
            if (c != 0u) {
                (void) sde_buf_addc(out, (char) c);
            } else {
                (void) sde_buf_adds(out, "\xEF\xBF\xBD");
            }
            i++;
            continue;
        }

        if ((c & 0xE0u) == 0xC0u) {
            need = 2;
            cp = (unsigned long) (c & 0x1Fu);
        } else if ((c & 0xF0u) == 0xE0u) {
            need = 3;
            cp = (unsigned long) (c & 0x0Fu);
        } else if ((c & 0xF8u) == 0xF0u) {
            need = 4;
            cp = (unsigned long) (c & 0x07u);
        } else {
            (void) sde_buf_adds(out, "\xEF\xBF\xBD");
            i++;
            continue;
        }

        ok = (i + need <= len);
        for (k = 1; ok && k < need; k++) {
            if ((p[i + k] & 0xC0u) != 0x80u) {
                ok = 0;
                break;
            }
            cp = (cp << 6) | (unsigned long) (p[i + k] & 0x3Fu);
        }

        /* Reject overlong forms, surrogates and out-of-range code points. */
        if (ok) {
            if (cp > 0x10FFFFul) {
                ok = 0;
            } else if (cp >= 0xD800ul && cp <= 0xDFFFul) {
                ok = 0;
            } else if ((need == 2 && cp < 0x80ul)
                       || (need == 3 && cp < 0x800ul)
                       || (need == 4 && cp < 0x10000ul)) {
                ok = 0;
            }
        }

        if (ok) {
            (void) sde_buf_add(out, (const char *) (p + i), need);
            i += need;
        } else {
            (void) sde_buf_adds(out, "\xEF\xBF\xBD");
            i++;
        }
    }
}

static int pump_one(sde_procset *s, size_t i)
{
    sde_buf   out;
    int       stream = 0;
    long      n;
    int       exited = 0;
    int       code = -1;
    long      run_id;
    sde_json *notif;

    sde_mutex_lock(s->lock);
    if (i >= s->count || s->runs[i].proc == NULL || !s->runs[i].running) {
        sde_mutex_unlock(s->lock);
        return 0;
    }
    run_id = s->runs[i].id;
    sde_buf_init(&out);
    n = sde_proc_read(s->runs[i].proc, &stream, &out, SDE_PROC_READ_MAX);
    if (n < 0) {
        exited = 1;
        code = sde_proc_exit_code(s->runs[i].proc);
        s->runs[i].running = 0;
        s->runs[i].code = code;
    }
    sde_mutex_unlock(s->lock);

    if (n > 0) {
        notif = notification("proc.output", run_id);
        if (notif != NULL) {
            sde_buf safe;

            sde_json_set(notif, "stream",
                         sde_json_str(stream == 'e' ? "stderr" : "stdout"));
            sde_buf_init(&safe);
            append_safe(&safe, out.data, out.len);
            sde_json_set(notif, "data",
                         sde_json_str_n(safe.data == NULL ? "" : safe.data,
                                        safe.len));
            sde_buf_free(&safe);
            (void) sde_app_notify(s->app, notif);
        }
    }
    sde_buf_free(&out);
    if (exited) {
        notif = notification("proc.exit", run_id);
        if (notif != NULL) {
            sde_json_set(notif, "code", sde_json_int((long) code));
            (void) sde_app_notify(s->app, notif);
        }
    }

    return (n > 0 || exited) ? 1 : 0;
}

int sde_procset_pump(sde_procset *s)
{
    size_t i;
    int    busy = 0;

    if (s == NULL) {
        return 0;
    }
    for (i = 0; i < s->count; i++) {
        /*
         * One read per run per pass keeps output from a chatty process from
         * starving the others, and keeps each notification small enough that
         * the shell never has to buffer a burst.
         */
        busy += pump_one(s, i);
    }
    return busy;
}
