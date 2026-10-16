/*
 * app.h - the shared state every kernel module is handed.
 *
 * There is exactly one of these per kernel process.  Modules receive it as
 * an opaque pointer plus the accessors they need, which is what lets a fork
 * delete a module (and its fields) without rewriting the others.
 *
 * The `emit` callback is how any module pushes an unsolicited notification
 * to the shell.  In `serve.c` it writes one JSON line to stdout; in tests it
 * can be a recorder.  Nothing else in the kernel writes to stdout.
 *
 * The kernel deliberately knows nothing about programming languages.  There
 * is no tokenizer, no keyword table and no shipped grammar here: language
 * support is a separate, optional layer outside `core/` (see `langs/`), so a
 * fork can delete it, replace it, or never build it at all.
 */
#ifndef SEIDE_APP_H
#define SEIDE_APP_H

#include <stddef.h>
#include "json.h"

/*
 * The typedef is guarded because C89 has no notion of a repeated typedef, and
 * a module header that wants the forward declaration must not fight app.h
 * over who declares it first.
 */
#ifndef SEIDE_APP_TYPEDEF
#define SEIDE_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

#ifndef SEIDE_VIEW_TYPEDEF
#define SEIDE_VIEW_TYPEDEF
typedef struct sde_view sde_view;
#endif

#ifndef SEIDE_PROCSET_TYPEDEF
#define SEIDE_PROCSET_TYPEDEF
typedef struct sde_procset sde_procset;
#endif

/* Takes ownership of `payload`.  Returns 0 on success. */
typedef int (*sde_emit_fn)(void *ud, sde_json *payload);

struct sde_app {
    char        *root;      /* absolute, '/'-separated workspace root */
    sde_view    *view;      /* the client's view document: opaque JSON */
    sde_procset *procs;     /* running child processes */
    sde_emit_fn  emit;
    void        *emit_ud;
    int          verbose;
};

/*
 * `root` is made absolute and normalised.  `exe_dir` is accepted for
 * forward compatibility and may be NULL.
 */
int  sde_app_init(sde_app *app, const char *root, const char *exe_dir,
                  sde_emit_fn emit, void *ud, char *err, size_t errcap);
void sde_app_free(sde_app *app);

/* Sends one notification; the payload must contain an "event" member. */
int  sde_app_notify(sde_app *app, sde_json *payload);

/* Convenience: build {"event":name,key1:val1} and send it. */
void sde_app_emit_simple(sde_app *app, const char *event, const char *key1,
                         const char *val1);

#endif /* SEIDE_APP_H */
