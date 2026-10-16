/*
 * serve.h - the stdio transport.
 *
 * The kernel's whole public surface is one loop over lines of JSON on
 * stdin/stdout.  Keeping the transport this small is what makes the kernel
 * testable by hand (type a request, read a reply) and portable to a fork's
 * own transport: replace `sde_serve` with a socket loop and nothing above it
 * changes.
 *
 * Contract: stdout carries protocol frames and nothing else.  Every
 * diagnostic goes to stderr.
 */
#ifndef SEIDE_SERVE_H
#define SEIDE_SERVE_H

#include "app.h"

/*
 * Reads frames until stdin ends, answering requests and forwarding
 * notifications.  Returns the process exit code (0 on a clean EOF).
 */
int sde_serve(sde_app *app);

/*
 * The emit sink wired into sde_app_init in `rpc` mode: serialises `payload`
 * as one line and writes it to stdout, taking ownership.  Safe to call from
 * any thread, which is how `proc` publishes output while the main loop is
 * blocked on input.
 */
int sde_serve_emit(void *ud, sde_json *payload);

#endif /* SEIDE_SERVE_H */
