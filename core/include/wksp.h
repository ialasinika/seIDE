/*
 * wksp.h - the workspace: files under `root`, and nothing outside it.
 *
 * Every path the kernel touches goes through sde_wksp_resolve(), which is the
 * single place that decides what "inside the workspace" means.  A fork that
 * wants a sandbox with different rules changes one function.
 *
 * The kernel reports facts about files (text, size, end-of-line style, a
 * content revision).  It deliberately does not guess a file's language: that
 * is the language layer's job, and it lives outside `core/`.
 */
#ifndef SEIDE_WKSP_H
#define SEIDE_WKSP_H

#include <stddef.h>
#include "json.h"

#ifndef SEIDE_APP_TYPEDEF
#define SEIDE_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

/* A file bigger than this is refused rather than pasted into a JSON string. */
#define SDE_WKSP_MAX_READ (4u * 1024u * 1024u)

/* A generous ceiling so a pathological tree cannot stall the kernel. */
#define SDE_WKSP_MAX_LIST 20000L
#define SDE_WKSP_MAX_DEPTH 24

/* Status codes shared by the mutating calls. */
#define SDE_WKSP_OK      0
#define SDE_WKSP_FAIL   -1
#define SDE_WKSP_STALE  -2

/*
 * The optimistic-concurrency token for a file's contents.  Callers treat it
 * as opaque: compare it, never interpret it.  FNV-1a, 32 bits; the RPC layer
 * carries it as a JSON number.
 */
unsigned long sde_rev_of(const char *data, size_t len);

/*
 * The same hash, fed a piece at a time, so a file can be streamed instead of
 * held whole in memory.  Start from SDE_REV_SEED, call this once per chunk, and
 * finish with sde_rev_final(); that is exactly what sde_rev_of() does:
 *
 *     sde_rev_final(sde_rev_update(SDE_REV_SEED, data, len))
 *
 * The two halves are exposed because the blob interface hashes a file as it
 * copies it, bytes that may never all be in one buffer at once.
 */
#define SDE_REV_SEED 2166136261UL

unsigned long sde_rev_update(unsigned long h, const char *data, size_t len);

/* Maps the one value that means "nothing to compare" onto a usable one. */
unsigned long sde_rev_final(unsigned long h);

/*
 * Resolves a workspace-relative path.  Rejects absolute paths, `..` escapes
 * and anything that normalises outside `root`.  `*out_abs` is malloc'd.
 */
int sde_wksp_resolve(const sde_app *app, const char *rel, char **out_abs,
                     char *err, size_t errcap);

/* {"root","name","file_count"} -- the shell adds anything it alone knows. */
sde_json *sde_wksp_info(const sde_app *app, char *err, size_t errcap);

/*
 * The directory names `sde_wksp_list()` skips while it walks, in the order the
 * table declares them.  `*count` receives how many.  Callers report these; they
 * must not filter by them, because the listing never contains them.
 */
const char *const *sde_wksp_ignored_dirs(size_t *count);

/*
 * Walks the tree and returns
 * {"files":[{"path","dir","size","mtime"}, ...],"truncated":bool}.
 * `glob` may be NULL (means "**|*"), and matches workspace-relative paths.
 */
sde_json *sde_wksp_list(const sde_app *app, const char *glob, long limit,
                        char *err, size_t errcap);

/* {"path","text","revision","eol","size"} */
sde_json *sde_wksp_read(const sde_app *app, const char *rel,
                        char *err, size_t errcap);

/*
 * {"path","exists","dir","size","mtime","revision"} -- facts about a file
 * without its text, for a client that wants to notice a change made behind its
 * back.  `revision` is the hash `sde_wksp_read()` would report, and 0 when
 * there is nothing to hash (absent, a directory, larger than the read cap, or
 * not text): a caller must read 0 as "cannot compare", not as "empty", because
 * a file that exists and is empty hashes to a real revision.
 */
sde_json *sde_wksp_stat(const sde_app *app, const char *rel,
                        char *err, size_t errcap);

/*
 * Writes `len` bytes of `text`.  When `has_base` is set, the write fails with
 * SDE_WKSP_STALE unless the file's current revision equals `base`; `*cur_rev`
 * then reports what the file actually holds.
 */
int sde_wksp_write(const sde_app *app, const char *rel, const char *text,
                   size_t len, int has_base, unsigned long base,
                   sde_json **out, unsigned long *cur_rev,
                   char *err, size_t errcap);

#endif /* SEIDE_WKSP_H */
