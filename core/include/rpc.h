/*
 * rpc.h - the kernel's only public entrance.
 *
 * One request per line in, one response per line out; notifications may
 * appear between responses at any time.  Everything the kernel can do is a
 * method in this file's table, which is also the list a fork reads to decide
 * what to cut.
 */
#ifndef SEIDE_RPC_H
#define SEIDE_RPC_H

#include <stddef.h>
#include "json.h"

#ifndef SEIDE_APP_TYPEDEF
#define SEIDE_APP_TYPEDEF
typedef struct sde_app sde_app;
#endif

/* JSON-RPC 2.0 standard codes. */
#define SDE_RPC_PARSE_ERROR      (-32700)
#define SDE_RPC_INVALID_REQUEST  (-32600)
#define SDE_RPC_METHOD_NOT_FOUND (-32601)
#define SDE_RPC_INVALID_PARAMS   (-32602)
#define SDE_RPC_INTERNAL         (-32603)

/* Application codes.  These are part of the frozen protocol. */
#define SDE_RPC_STALE_REVISION  1001
#define SDE_RPC_NOT_FOUND       1002
#define SDE_RPC_IO              1003
/*
 * 1004 INVALID_BOARD is reserved and the kernel does not emit it: since
 * `seide/2` a view document's shape is the client's business, so the client
 * that validates its own document -- the reference shell does -- is the one
 * that answers with it.  See `docs/PROTOCOL.md`.
 */
/* Nothing was asked for the process, or it could not be started. */
#define SDE_RPC_PROC            1005

/*
 * Builds an error response by hand.  Used by the reader loop for frames that
 * could not be parsed at all, where there is no request to answer.
 */
sde_json *sde_rpc_error(const sde_json *id, int code, const char *name,
                        const char *message);

/*
 * Handles one parsed frame.
 *
 *   - a request (has an "id") returns the response object, owned by caller
 *   - a notification (no "id") returns NULL and nothing is sent back
 *   - a non-object frame returns an error response with a null id
 *
 * `req` is borrowed and is never modified.
 */
sde_json *sde_rpc_handle(sde_app *app, const sde_json *req);

#endif /* SEIDE_RPC_H */
