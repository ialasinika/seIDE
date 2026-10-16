/*
 * proc_win32.c - child processes with streamed output (port.h).
 *
 * Each child gets three pipes:
 *
 *   stdin   <- a writer thread (a private pipe, never the kernel's own)
 *   stdout  -> a reader thread
 *   stderr  -> a reader thread
 *
 * Reader threads append tagged chunks to a small mutex-guarded queue.  The
 * kernel polls that queue from its single main loop, so no part of the IDE
 * outside this file has to know about threads, handles or blocking reads.
 * The writer thread owns the one blocking call in the other direction and
 * takes bytes from a bounded queue, so a call to sde_proc_write() can never
 * block the kernel's RPC loop on a child that has stopped reading.
 */
#include "seide_cfg.h"

#if defined(SDE_PLATFORM_WIN32)

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port.h"

#define PROC_READ_BUF 4096
#define PROC_WRITE_BUF 4096
/* A child that stops reading its input must not grow the kernel's memory. */
#define PROC_WRITE_MAX (1024u * 1024u)
#define PROC_WRITE_IDLE_MS 5

typedef struct pchunk {
    struct pchunk *next;
    int            stream;   /* 'o' or 'e' from the child, 'i' towards it */
    char          *data;
    size_t         len;
    size_t         off;
} pchunk;

struct sde_proc;

typedef struct sde_reader {
    struct sde_proc *proc;
    HANDLE           h;
    int              stream;
} sde_reader;

struct sde_proc {
    HANDLE      process;
    HANDLE      in_read;
    HANDLE      in_write;
    HANDLE      out_read;
    HANDLE      err_read;
    sde_thread *t_in;
    sde_thread *t_out;
    sde_thread *t_err;
    sde_reader  readers[2];
    sde_mutex  *lock;
    pchunk     *head;
    pchunk     *tail;
    pchunk     *whead;
    pchunk     *wtail;
    size_t      wqueued;
    int         input_closing;
    int         input_closed;
    int         exited;
    int         exit_code;
    volatile LONG writer_stop;
    volatile LONG readers_done;
};

static void set_err(char *err, size_t cap, const char *msg, const char *detail)
{
    if (err == NULL || cap == 0) {
        return;
    }
    if (detail != NULL) {
        snprintf(err, cap, "%s: %s", msg, detail);
    } else {
        snprintf(err, cap, "%s", msg);
    }
    err[cap - 1] = '\0';
}

static void queue_push(struct sde_proc *p, int stream, char *data, size_t len)
{
    pchunk *c = (pchunk *) malloc(sizeof(pchunk));

    if (c == NULL) {
        free(data);
        return;
    }
    c->next = NULL;
    c->stream = stream;
    c->data = data;
    c->len = len;
    c->off = 0;

    sde_mutex_lock(p->lock);
    if (p->tail == NULL) {
        p->head = c;
        p->tail = c;
    } else {
        p->tail->next = c;
        p->tail = c;
    }
    sde_mutex_unlock(p->lock);
}

static void reader_main(void *ud)
{
    sde_reader     *r = (sde_reader *) ud;
    struct sde_proc *p = r->proc;

    for (;;) {
        char  *buf;
        DWORD  got = 0;

        buf = (char *) malloc(PROC_READ_BUF);
        if (buf == NULL) {
            break;
        }
        if (!ReadFile(r->h, buf, (DWORD) PROC_READ_BUF, &got, NULL)
            || got == 0) {
            free(buf);
            break;
        }
        queue_push(p, r->stream, buf, (size_t) got);
    }
    (void) InterlockedIncrement(&p->readers_done);
}

/*
 * `inherit_read` says which end the child keeps: the reading end for the two
 * output pipes, the writing end for stdin.  The end this process keeps must
 * not be inherited, or the child would hold a copy of it and never see EOF.
 */
static int make_pipe(HANDLE *rd, HANDLE *wr, int inherit_read)
{
    SECURITY_ATTRIBUTES sa;

    sa.nLength = (DWORD) sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    if (!CreatePipe(rd, wr, &sa, 0)) {
        return -1;
    }
    if (!SetHandleInformation(inherit_read ? *wr : *rd, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(*rd);
        CloseHandle(*wr);
        return -1;
    }
    return 0;
}

/* Called with `lock` held: forgets queued input the child will never read. */
static void drop_wqueue_locked(struct sde_proc *p)
{
    pchunk *c;

    while (p->whead != NULL) {
        c = p->whead;
        p->whead = c->next;
        free(c->data);
        free(c);
    }
    p->wtail = NULL;
    p->wqueued = 0;
}

/*
 * Moves queued bytes into the child's stdin, one bounded block at a time so
 * the lock is never held across a blocking write.  Ends when the queue is
 * empty and stdin has been asked to close, or when the pipe breaks.
 */
static void writer_main(void *ud)
{
    struct sde_proc *p = (struct sde_proc *) ud;
    char             buf[PROC_WRITE_BUF];

    for (;;) {
        pchunk *c;
        size_t  want = 0;
        int     do_close = 0;
        HANDLE  h;

        sde_mutex_lock(p->lock);
        if (p->writer_stop) {
            sde_mutex_unlock(p->lock);
            break;
        }
        c = p->whead;
        if (c != NULL) {
            want = c->len - c->off;
            if (want > sizeof(buf)) {
                want = sizeof(buf);
            }
            memcpy(buf, c->data + c->off, want);
            c->off += want;
            p->wqueued -= want;
            if (c->off >= c->len) {
                p->whead = c->next;
                if (p->whead == NULL) {
                    p->wtail = NULL;
                }
                free(c->data);
                free(c);
            }
        } else if (p->input_closing && !p->input_closed) {
            do_close = 1;
        }
        h = p->in_write;
        sde_mutex_unlock(p->lock);

        if (want > 0) {
            DWORD wrote = 0;

            if (h == NULL
                || !WriteFile(h, buf, (DWORD) want, &wrote, NULL)
                || wrote == 0) {
                sde_mutex_lock(p->lock);
                drop_wqueue_locked(p);
                p->input_closed = 1;
                sde_mutex_unlock(p->lock);
                break;
            }
            continue; /* drain while there is anything to drain */
        }
        if (do_close) {
            if (h != NULL) {
                CloseHandle(h);
            }
            sde_mutex_lock(p->lock);
            p->in_write = NULL;
            p->input_closed = 1;
            p->input_closing = 0;
            sde_mutex_unlock(p->lock);
            break;
        }
        sde_port_sleep_ms(PROC_WRITE_IDLE_MS);
    }
}

int sde_proc_write(sde_proc *p, const char *data, size_t len,
                   char *err, size_t errcap)
{
    pchunk *c;
    char   *copy;

    if (p == NULL) {
        set_err(err, errcap, "no such process", NULL);
        return -1;
    }
    if (len == 0) {
        return 0;
    }
    if (data == NULL) {
        set_err(err, errcap, "nothing to write", NULL);
        return -1;
    }

    sde_mutex_lock(p->lock);
    if (p->input_closed || p->input_closing) {
        sde_mutex_unlock(p->lock);
        set_err(err, errcap, "the process input has been closed", NULL);
        return -1;
    }
    if (p->wqueued + len > PROC_WRITE_MAX) {
        sde_mutex_unlock(p->lock);
        set_err(err, errcap, "the process is not reading its input", NULL);
        return -1;
    }
    copy = (char *) malloc(len);
    c = (pchunk *) malloc(sizeof(pchunk));
    if (copy == NULL || c == NULL) {
        free(copy);
        free(c);
        sde_mutex_unlock(p->lock);
        set_err(err, errcap, "out of memory", NULL);
        return -1;
    }
    memcpy(copy, data, len);
    c->next = NULL;
    c->stream = 'i';
    c->data = copy;
    c->len = len;
    c->off = 0;
    if (p->wtail == NULL) {
        p->whead = c;
        p->wtail = c;
    } else {
        p->wtail->next = c;
        p->wtail = c;
    }
    p->wqueued += len;
    sde_mutex_unlock(p->lock);
    return 0;
}

int sde_proc_close_input(sde_proc *p)
{
    if (p == NULL) {
        return -1;
    }
    sde_mutex_lock(p->lock);
    if (!p->input_closed) {
        p->input_closing = 1;
    }
    sde_mutex_unlock(p->lock);
    return 0;
}

sde_proc *sde_proc_start(const char *cmd, const char *cwd,
                         char *err, size_t errcap)
{
    struct sde_proc *p;
    STARTUPINFOA     si;
    PROCESS_INFORMATION pi;
    HANDLE           in_read = NULL;
    HANDLE           in_write = NULL;
    HANDLE           out_write = NULL;
    HANDLE           err_write = NULL;
    char            *mutable_cmd;
    size_t           n;

    if (cmd == NULL || cmd[0] == '\0') {
        set_err(err, errcap, "empty command line", NULL);
        return NULL;
    }

    p = (struct sde_proc *) malloc(sizeof(struct sde_proc));
    if (p == NULL) {
        set_err(err, errcap, "out of memory", NULL);
        return NULL;
    }
    memset(p, 0, sizeof(*p));
    p->process = NULL;
    p->lock = sde_mutex_new();
    if (p->lock == NULL) {
        free(p);
        set_err(err, errcap, "out of memory", NULL);
        return NULL;
    }

    if (make_pipe(&in_read, &in_write, 1) != 0
        || make_pipe(&p->out_read, &out_write, 0) != 0
        || make_pipe(&p->err_read, &err_write, 0) != 0) {
        set_err(err, errcap, "cannot create pipes for", cmd);
        if (in_read != NULL) {
            CloseHandle(in_read);
        }
        if (in_write != NULL) {
            CloseHandle(in_write);
        }
        sde_proc_free(p);
        return NULL;
    }
    p->in_read = in_read;
    p->in_write = in_write;

    memset(&si, 0, sizeof(si));
    si.cb = (DWORD) sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = in_read;
    si.hStdOutput = out_write;
    si.hStdError = err_write;

    n = strlen(cmd);
    mutable_cmd = (char *) malloc(n + 1);
    if (mutable_cmd == NULL) {
        set_err(err, errcap, "out of memory", NULL);
        CloseHandle(out_write);
        CloseHandle(err_write);
        sde_proc_free(p);
        return NULL;
    }
    memcpy(mutable_cmd, cmd, n + 1);

    memset(&pi, 0, sizeof(pi));
    if (!CreateProcessA(NULL, mutable_cmd, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL,
                        (cwd != NULL && cwd[0] != '\0') ? cwd : NULL,
                        &si, &pi)) {
        DWORD e = GetLastError();
        char  num[32];

        snprintf(num, sizeof(num), "%lu", (unsigned long) e);
        set_err(err, errcap, "cannot start process (win32 error)", num);
        free(mutable_cmd);
        CloseHandle(out_write);
        CloseHandle(err_write);
        sde_proc_free(p);
        return NULL;
    }
    free(mutable_cmd);

    /*
     * Our copies of the child's ends must go, or the readers never see EOF
     * and a child reading its stdin never sees the end of its input.
     */
    CloseHandle(out_write);
    CloseHandle(err_write);
    CloseHandle(in_read);
    p->in_read = NULL;
    CloseHandle(pi.hThread);

    p->process = pi.hProcess;
    p->readers[0].proc = p;
    p->readers[0].h = p->out_read;
    p->readers[0].stream = 'o';
    p->readers[1].proc = p;
    p->readers[1].h = p->err_read;
    p->readers[1].stream = 'e';

    p->t_out = sde_thread_start(reader_main, &p->readers[0]);
    p->t_err = sde_thread_start(reader_main, &p->readers[1]);
    p->t_in = sde_thread_start(writer_main, p);
    if (p->t_out == NULL || p->t_err == NULL || p->t_in == NULL) {
        set_err(err, errcap, "cannot start process threads", NULL);
        sde_proc_free(p);
        return NULL;
    }
    return p;
}

static void reap(struct sde_proc *p)
{
    DWORD code = 0;

    if (p->exited || p->process == NULL) {
        return;
    }
    if (WaitForSingleObject(p->process, 0) != WAIT_OBJECT_0) {
        return;
    }
    if (GetExitCodeProcess(p->process, &code)) {
        p->exit_code = (int) code;
    }
    p->exited = 1;
}

int sde_proc_running(sde_proc *p)
{
    if (p == NULL) {
        return 0;
    }
    reap(p);
    return p->exited ? 0 : 1;
}

int sde_proc_exit_code(sde_proc *p)
{
    if (p == NULL) {
        return -1;
    }
    reap(p);
    return p->exit_code;
}

void sde_proc_kill(sde_proc *p)
{
    if (p == NULL || p->process == NULL) {
        return;
    }
    reap(p);
    if (!p->exited) {
        (void) TerminateProcess(p->process, 1);
    }
}

long sde_proc_read(sde_proc *p, int *stream, sde_buf *out, size_t max)
{
    pchunk *c;
    size_t  want;
    long    got;

    if (p == NULL) {
        return -1;
    }

    sde_mutex_lock(p->lock);
    c = p->head;
    if (c == NULL) {
        sde_mutex_unlock(p->lock);
        reap(p);
        if (p->exited && p->readers_done >= 2) {
            return -1;
        }
        return 0;
    }

    want = c->len - c->off;
    if (want > max) {
        want = max;
    }
    if (stream != NULL) {
        *stream = c->stream;
    }
    if (sde_buf_add(out, c->data + c->off, want) != 0) {
        sde_mutex_unlock(p->lock);
        return 0;
    }
    c->off += want;
    got = (long) want;

    if (c->off >= c->len) {
        p->head = c->next;
        if (p->head == NULL) {
            p->tail = NULL;
        }
        free(c->data);
        free(c);
    }
    sde_mutex_unlock(p->lock);
    return got;
}

void sde_proc_free(sde_proc *p)
{
    pchunk *c;

    if (p == NULL) {
        return;
    }

    sde_proc_kill(p);
    p->writer_stop = 1;
    if (p->t_in != NULL) {
        sde_thread_join(p->t_in);
        p->t_in = NULL;
    }
    if (p->t_out != NULL) {
        sde_thread_join(p->t_out);
        p->t_out = NULL;
    }
    if (p->t_err != NULL) {
        sde_thread_join(p->t_err);
        p->t_err = NULL;
    }
    if (p->process != NULL) {
        CloseHandle(p->process);
        p->process = NULL;
    }
    if (p->in_read != NULL) {
        CloseHandle(p->in_read);
        p->in_read = NULL;
    }
    if (p->in_write != NULL) {
        CloseHandle(p->in_write);
        p->in_write = NULL;
    }
    if (p->out_read != NULL) {
        CloseHandle(p->out_read);
        p->out_read = NULL;
    }
    if (p->err_read != NULL) {
        CloseHandle(p->err_read);
        p->err_read = NULL;
    }

    while (p->head != NULL) {
        c = p->head;
        p->head = c->next;
        free(c->data);
        free(c);
    }
    while (p->whead != NULL) {
        c = p->whead;
        p->whead = c->next;
        free(c->data);
        free(c);
    }
    sde_mutex_free(p->lock);
    free(p);
}

#endif /* SDE_PLATFORM_WIN32 */
