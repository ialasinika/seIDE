/*
 * blob.h - binary files, and files too big to be one JSON string.
 *
 * `file.read` and `file.write` move a whole document through one JSON string,
 * which caps them at 4 MiB and at text: the wire is terminated by a NUL (the
 * reader is line-based) and `file.write` cannot count bytes it never received.
 * This module is the other path: a client opens a session on a file, moves it
 * in fixed-size chunks, and the kernel never holds the whole thing at once.
 *
 *   read   file.blobOpen {mode:"read"}  -> file.blobRead * n   -> blobAbort
 *   write  file.blobOpen {mode:"write"} -> file.blobAppend * n
 *                                       -> file.blobCommit {total_size}
 *
 * A write session writes a neighbour (`<path>.tmp`) and the commit publishes it
 * with the same atomic replace `file.write` uses, so a reader of the target
 * sees the old file or the new one and never a half-written one.  A session
 * that is aborted, or one that is idle past SDE_BLOB_IDLE_MS, takes its
 * temporary file with it; so does a kernel that exits with sessions open.
 *
 * Sessions are not thread-safe and do not need to be: only the RPC loop
 * touches them.
 */
#ifndef SEIDE_BLOB_H
#define SEIDE_BLOB_H

#include <stddef.h>
#include <stdint.h>

#include "json.h"

#ifndef SEIDE_APP_TYPEDEF
#define SEIDE_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

/* One frame carries at most this many decoded bytes.  A chunk is refused, not
 * truncated: the client learns the limit instead of silently losing bytes. */
#define SDE_BLOB_MAX_CHUNK (1024u * 1024u)

/* Open sessions per kernel.  Small on purpose: a session holds a file open and
 * a write session owns a temporary file. */
#define SDE_BLOB_MAX_SESSIONS 8

/* A session untouched for this long is closed by the next open.  There is no
 * timer in the kernel, so this is checked when the table is looked at. */
#define SDE_BLOB_IDLE_MS (15u * 60u * 1000u)

/* Status codes.  `err` carries the message; SDE_BLOB_STALE also fills cur_rev. */
#define SDE_BLOB_OK        0
#define SDE_BLOB_FAIL     -1   /* an I/O or memory failure: 1003 IO */
#define SDE_BLOB_STALE    -2   /* base_revision did not match: 1001 */
#define SDE_BLOB_NOSESS   -3   /* no such session: -32602 */
#define SDE_BLOB_PARAM    -4   /* the request is wrong: -32602 */
#define SDE_BLOB_NOTFOUND -5   /* a read session on a missing file: 1002 */

#ifndef SEIDE_BLOBSET_TYPEDEF
#define SEIDE_BLOBSET_TYPEDEF
typedef struct sde_blobset sde_blobset;
#endif

sde_blobset *sde_blobset_new(void);
void         sde_blobset_free(sde_blobset *bs);

/*
 * Opens a session on `rel`.
 *
 *   mode "read"  result {"session","path","size","revision"?}
 *                size is the file's size and a missing file is SDE_BLOB_NOTFOUND.
 *   mode "write" result {"session","path","size","revision"?}
 *                size is 0 -- nothing has been written yet -- and a file that is
 *                not there is not an error: the session creates it on commit.
 *
 * `has_base` compares `base` against the file's revision and fails with
 * SDE_BLOB_STALE (and *cur_rev) when they differ, exactly as file.write does.
 * `want_rev` asks for the file's revision in the result; it is what a client
 * uses to learn the base of a file too large for file.stat, which reports 0
 * there.  Both hash the file as it streams, so the size of the file does not
 * matter.  `revision` is 0 only when the file is not there.
 */
int sde_blob_open(const sde_app *app, sde_blobset *bs, const char *rel,
                  const char *mode, int has_base, unsigned long base,
                  int want_rev, sde_json **out, unsigned long *cur_rev,
                  char *err, size_t errcap);

/*
 * Reads the next chunk -- or, with `has_offset`, the chunk at that offset --
 * of a read session.  `length` defaults to SDE_BLOB_MAX_CHUNK and is refused
 * outside 1..SDE_BLOB_MAX_CHUNK.
 *
 * Result {"session","offset","size","eof","data"}: `data` is base64, `offset`
 * is where this chunk started, `size` is the file's size as last seen and `eof`
 * says whether the session has reached the end.
 */
int sde_blob_read(sde_blobset *bs, long session, int has_offset, int64_t offset,
                  int has_length, int64_t length, sde_json **out,
                  char *err, size_t errcap);

/*
 * Appends `len` raw bytes (already decoded) to a write session.  With
 * `has_offset`, `offset` must be where the session's data currently ends: a
 * client that has lost its place is told so instead of splicing bytes into the
 * wrong spot.  Result {"session","offset","size"} -- offset is where the next
 * append goes.
 */
int sde_blob_append(sde_blobset *bs, long session, const char *data, size_t len,
                    int has_offset, int64_t offset, sde_json **out,
                    char *err, size_t errcap);

/*
 * Publishes a write session: `total_size` must equal the bytes written, and is
 * the client's own statement that it sent everything.  The temporary file is
 * moved onto the target in one step.  Result
 * {"path","size","revision","replaced"} -- revision is the same hash
 * file.read would report for those bytes, so it can be the next base_revision.
 *
 * On a refusal the session stays open: the bytes are still in the temporary
 * file, and the client may append more or abort.
 */
int sde_blob_commit(const sde_app *app, sde_blobset *bs, long session,
                    int has_total, int64_t total, sde_json **out,
                    char *err, size_t errcap);

/* Closes a session, discarding a write session's temporary file. */
int sde_blob_abort(sde_blobset *bs, long session, sde_json **out,
                   char *err, size_t errcap);

#endif /* SEIDE_BLOB_H */
