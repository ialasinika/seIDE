/*
 * port.h - everything the kernel needs from the operating system.
 *
 * The rest of seIDE is written against this header and nothing else, so
 * porting to a new platform (or replacing Win32 with something else) means
 * writing two new .c files, not touching the IDE.
 *
 * Two rules keep the seam clean:
 *
 *   1. Paths handed across this API always use '/' as the separator.  The
 *      Win32 implementation accepts both on input and normalises internally.
 *   2. Nothing here throws, allocates globally, or prints.  Failures come
 *      back as a negative return plus an optional `err` buffer.
 *
 * Function-pointer callbacks and opaque structs are used deliberately: a
 * fork may swap the implementation without recompiling its callers.
 */
#ifndef SEIDE_PORT_H
#define SEIDE_PORT_H

#include <stddef.h>
#include "buf.h"
#include "vec.h"

/* ====================================================================== */
/* startup / shutdown                                                     */
/* ====================================================================== */

/*
 * One-time platform setup: binary mode on the protocol streams, and making
 * our own standard handles non-inheritable so that a child process cannot
 * keep the shell's pipes open after we are gone.  Safe to call twice.
 */
void sde_port_startup(void);

/* ====================================================================== */
/* time                                                                   */
/* ====================================================================== */

unsigned long sde_port_now_ms(void);
void          sde_port_sleep_ms(unsigned long ms);
long          sde_port_pid(void);

/* ====================================================================== */
/* standard streams                                                       */
/* ====================================================================== */

/*
 * stdout carries the protocol and nothing else; every diagnostic goes to
 * stderr.  Both write the whole buffer or report failure.
 */
int sde_port_stdout_write(const char *data, size_t len);
int sde_port_stderr_write(const char *data, size_t len);

/* ====================================================================== */
/* files                                                                  */
/* ====================================================================== */

/* 0 on success, -1 on failure.  `out` is *appended* to. */
int  sde_port_read_file(const char *path, sde_buf *out, char *err, size_t errcap);
int  sde_port_write_file(const char *path, const char *data, size_t len,
                         char *err, size_t errcap);

int  sde_port_file_exists(const char *path);
int  sde_port_is_dir(const char *path);
long sde_port_file_size(const char *path);   /* -1 if it cannot be read */
long sde_port_file_mtime(const char *path);  /* -1 if it cannot be read */

int  sde_port_mkdirs(const char *path, char *err, size_t errcap);
int  sde_port_remove_file(const char *path);

/*
 * Atomically replaces `to` with `from`.  `from` is consumed whether or not
 * the replacement succeeds.  Used to publish a new document without
 * ever leaving a truncated one behind.
 */
int  sde_port_replace_file(const char *from, const char *to);

/* C89 has no strdup(); every module that needs one uses this. */
char *sde_port_strdup(const char *s);

/* ====================================================================== */
/* directories                                                            */
/* ====================================================================== */

typedef struct sde_dirent {
    char *name;    /* malloc'd; never "." or ".." */
    int   is_dir;
    long  size;
} sde_dirent;

/*
 * Appends sde_dirent* (malloc'd) to `out`.  Entries are unsorted; callers
 * that care sort by name.  Free with sde_port_dirent_free() per entry and
 * then sde_vec_free().
 */
int  sde_port_list_dir(const char *path, sde_vec *out, char *err, size_t errcap);
void sde_port_dirent_free(sde_dirent *d);

/* ====================================================================== */
/* paths                                                                  */
/* ====================================================================== */

int   sde_port_path_is_abs(const char *p);
char *sde_port_path_norm(const char *p);                    /* malloc'd */
char *sde_port_path_join(const char *a, const char *b);     /* malloc'd */
char *sde_port_path_abs(const char *p);                     /* malloc'd */
int   sde_port_path_within(const char *root, const char *p);

/* Exposed because the path logic is worth unit-testing on its own. */
char *sde_port_path_norm_into(const char *p, sde_buf *out);

/* ====================================================================== */
/* threads and locks                                                      */
/* ====================================================================== */

typedef struct sde_mutex  sde_mutex;
typedef struct sde_thread sde_thread;
typedef void (*sde_thread_fn)(void *ud);

sde_mutex  *sde_mutex_new(void);
void        sde_mutex_free(sde_mutex *m);
void        sde_mutex_lock(sde_mutex *m);
void        sde_mutex_unlock(sde_mutex *m);

sde_thread *sde_thread_start(sde_thread_fn fn, void *ud);
void        sde_thread_join(sde_thread *t);   /* waits, then frees */
void        sde_thread_free(sde_thread *t);

/* ====================================================================== */
/* child processes                                                        */
/* ====================================================================== */

typedef struct sde_proc sde_proc;

sde_proc *sde_proc_start(const char *cmd, const char *cwd,
                         char *err, size_t errcap);
void      sde_proc_free(sde_proc *p);
void      sde_proc_kill(sde_proc *p);

/*
 * Non-blocking.  Appends up to `max` pending bytes to `out` and reports
 * which stream they came from in *stream ('o' or 'e').
 *
 *   > 0  bytes appended
 *     0  nothing pending, child still alive
 *    -1  child has exited and every byte it wrote has been consumed
 */
long sde_proc_read(sde_proc *p, int *stream, sde_buf *out, size_t max);

/*
 * Non-blocking.  Queues `len` bytes for the child's stdin.  A writer thread
 * inside this module owns the blocking WriteFile(), so a child that stops
 * reading its input can never stall the caller; the queue is bounded and a
 * write that would overflow it fails instead of growing without limit.
 *
 * Returns 0, or -1 with `err` filled in (queue full, input already closed,
 * out of memory).
 */
int sde_proc_write(sde_proc *p, const char *data, size_t len,
                   char *err, size_t errcap);

/*
 * Closes the child's stdin after everything queued before this call has been
 * written.  A child that reads until EOF finishes on its own after this;
 * sde_proc_free() closes the pipe as well if this is never called.
 */
int sde_proc_close_input(sde_proc *p);

int  sde_proc_running(sde_proc *p);
int  sde_proc_exit_code(sde_proc *p);   /* valid once sde_proc_read() is -1 */

#endif /* SEIDE_PORT_H */
