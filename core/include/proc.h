/*
 * proc.h - the kernel's child-process channel.
 *
 * A process is identified by a `run_id`; what it prints arrives as
 * `proc.output` notifications, what is written to it goes out through
 * sde_procset_send(), and its end arrives as `proc.exit`.  The kernel owns
 * child processes so that a client does not have to: no other part of the
 * IDE knows about handles, threads or blocking reads.
 *
 * The kernel does not know *why* a process was started.  It used to: a run
 * carried a `card_id`, because the only caller was a `runner` card.  That is
 * the client's bookkeeping, not the kernel's, and it is gone -- the shell
 * remembers which card a run_id belongs to.
 *
 * Deleting this module costs the IDE exactly one thing: nothing outside the
 * kernel can start a process, so runner cards and every subsystem that needs
 * one (a language server, a formatter, a debugger, a terminal) stop working.
 */
#ifndef SEIDE_PROC_H
#define SEIDE_PROC_H

#include <stddef.h>
#include "json.h"

#ifndef SEIDE_APP_TYPEDEF
#define SEIDE_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

#ifndef SEIDE_PROCSET_TYPEDEF
#define SEIDE_PROCSET_TYPEDEF
typedef struct sde_procset sde_procset;
#endif

sde_procset *sde_procset_new(void);
void         sde_procset_free(sde_procset *s);

/*
 * The set needs an app so that the pump thread can publish notifications.
 * Without a bind, runs still work and output is silently dropped.
 */
void sde_procset_bind(sde_procset *s, sde_app *app);

/*
 * Starts `cmd` through the shell, in `cwd` (absolute; NULL means inherit).
 * Returns the new run id (> 0) or -1 with `err` filled in.
 */
long sde_procset_start(sde_procset *s, const char *cmd, const char *cwd,
                       char *err, size_t errcap);

/* Kills the run.  Returns 0 if it was known, whether or not it was alive. */
int  sde_procset_stop(sde_procset *s, long run_id);

/*
 * Queues `len` bytes for the run's stdin.  The bytes go out on the port
 * layer's writer thread, so this never blocks on a child that stopped
 * reading; a queue that is already full is an error rather than a wait.
 *
 * Returns 0, or -1 with `err` filled in (no such run, input closed, queue
 * full).  Writing to a run that has exited is an error too.
 */
int  sde_procset_send(sde_procset *s, long run_id, const char *data, size_t len,
                      char *err, size_t errcap);

/*
 * Closes the run's stdin after everything queued before this call has been
 * written, so a child that reads until EOF can finish on its own.
 * Returns 0 if the run was known, -1 otherwise.
 */
int  sde_procset_close_input(sde_procset *s, long run_id);

/* Owned JSON: {"runs":[{run_id,cmd,running,code,started}]} */
sde_json *sde_procset_list(const sde_procset *s);

/*
 * One polling pass over every live run.  The pump thread calls this; tests
 * call it directly instead of waiting for the thread to wake up.
 * Returns the number of runs that produced output or ended.
 */
int  sde_procset_pump(sde_procset *s);

/* Number of runs that still have a live child. */
int  sde_procset_live_count(const sde_procset *s);

#endif /* SEIDE_PROC_H */
