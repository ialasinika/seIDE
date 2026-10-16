/*
 * main.c - the command line.
 *
 * The kernel ships as one executable with a handful of subcommands.  `rpc` is
 * the one the shell drives; the rest exist so that the kernel is usable and
 * debuggable without any user interface at all, which is the whole reason the
 * transport is plain stdio.
 *
 * `seide modules` prints the trim manifest below.  That table, plus the SRC
 * list in the Makefile and the method table in rpc.c, is the complete list of
 * places a fork touches to remove a subsystem.
 *
 * The version string is not here: it comes from seide_cfg.h, which this file
 * includes first, and `tools/version.py` keeps that one copy in step with
 * VERSION and the shell.  A second define of SDE_VERSION in a .c file is a
 * check failure, not a convenience.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "buf.h"
#include "json.h"
#include "module.h"
#include "port.h"
#include "rpc.h"
#include "serve.h"
#include "view.h"

/* ---------------------------------------------------------------------- */
/* trim manifest                                                          */
/* ---------------------------------------------------------------------- */

static const sde_module sde_module_table[] = {
    { "buf",
      "growable byte buffer, the kernel's only string type",
      "nothing builds: every other module formats through it",
      0 },
    { "vec",
      "growable pointer array, used for lists without a fixed bound",
      "nothing builds",
      0 },
    { "json",
      "JSON parse/serialise; the protocol's value type",
      "nothing builds",
      0 },
    { "port",
      "the platform boundary: files, paths, threads, processes",
      "nothing builds; this is the layer a fork replaces to leave Win32",
      0 },
    { "wksp",
      "workspace reads/writes, path containment, content revisions",
      "files can no longer be opened or saved; only the canvas remains",
      1 },
    { "view",
      "the client's view document: opaque JSON, atomic persistence, revisions",
      "no document survives a restart; the client is left with what it holds",
      1 },
    { "proc",
      "child processes with a duplex channel, streamed to the client",
      "nothing can start a process; runners and process subsystems stop",
      1 },
    { "serve",
      "newline-delimited JSON-RPC over stdin/stdout",
      "the kernel has no way in; useful only as a linkable library",
      1 },
    { "rpc",
      "the method table that turns frames into actions",
      "nothing is callable; keep it and the kernel has no verbs",
      0 },
    { "app",
      "constructs and owns the shared state modules are handed",
      "nothing builds",
      0 },
    { NULL, NULL, NULL, 0 }
};

const sde_module *sde_modules(size_t *count)
{
    if (count != NULL) {
        *count = (sizeof(sde_module_table) / sizeof(sde_module_table[0])) - 1u;
    }
    return sde_module_table;
}

/* ---------------------------------------------------------------------- */
/* argument helpers                                                       */
/* ---------------------------------------------------------------------- */

static const char *opt_value(int argc, char **argv, const char *name)
{
    int i;

    for (i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], name) == 0) {
            return argv[i + 1];
        }
    }
    return NULL;
}

static int has_flag(int argc, char **argv, const char *name)
{
    int i;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], name) == 0) {
            return 1;
        }
    }
    return 0;
}

static const char *opt_root(int argc, char **argv)
{
    const char *root = opt_value(argc, argv, "--root");

    return root == NULL ? "." : root;
}

static void usage(FILE *out)
{
    /*
     * Split across several calls on purpose: C89 only requires a compiler to
     * accept 509 characters in one string literal, and this text is longer.
     */
    fprintf(out, "seIDE kernel " SDE_VERSION " (protocol " SDE_PROTOCOL ")\n");
    fprintf(out, "\n");
    fprintf(out, "usage: seide <command> [options]\n");
    fprintf(out, "\n");
    fprintf(out, "  rpc [--root DIR] [--verbose]\n");
    fprintf(out, "        Speak newline-delimited JSON-RPC on stdin/stdout\n");
    fprintf(out, "        until EOF.  This is the mode the shell drives.\n");
    fprintf(out, "\n");
    fprintf(out, "  view show --path REL [--root DIR]\n");
    fprintf(out, "        Print the JSON document a client keeps at REL.\n");
    fprintf(out, "        The kernel holds no document of its own: the path is\n");
    fprintf(out, "        the client's choice, and this command is a way to look\n");
    fprintf(out, "        at one without a window.\n");
    fprintf(out, "\n");
    fprintf(out, "  modules\n");
    fprintf(out, "        List the kernel's source modules and what deleting\n");
    fprintf(out, "        each one costs.  The fork's trimming checklist.\n");
    fprintf(out, "\n");
    fprintf(out, "  version\n");
    fprintf(out, "        Print the kernel version.\n");
    fprintf(out, "\n");
    fprintf(out, "  help\n");
    fprintf(out, "        This text.\n");
    fprintf(out, "\n");
    fprintf(out, "Language support is deliberately not a kernel concern:\n");
    fprintf(out, "`.lang` descriptors and the tokenizers live in langs/ and\n");
    fprintf(out, "are served by the shell.  The kernel knows nothing about\n");
    fprintf(out, "programming languages.\n");
}

/* ---------------------------------------------------------------------- */
/* commands                                                               */
/* ---------------------------------------------------------------------- */

static int emit_discard(void *ud, sde_json *payload)
{
    (void) ud;
    sde_json_free(payload);
    return 0;
}

static int cmd_rpc(int argc, char **argv)
{
    sde_app app;
    char    err[256];
    int     code;

    err[0] = '\0';
    if (sde_app_init(&app, opt_root(argc, argv), NULL, sde_serve_emit, NULL,
                     err, sizeof(err)) != 0) {
        fprintf(stderr, "seide: %s\n", err[0] != '\0' ? err : "cannot start");
        return 1;
    }
    app.verbose = has_flag(argc, argv, "--verbose");

    /* sde_serve owns the app from here and releases it on EOF. */
    code = sde_serve(&app);
    return code;
}

static int cmd_view_show(int argc, char **argv)
{
    sde_app     app;
    sde_buf     b;
    char        err[256];
    const char *path = opt_value(argc, argv, "--path");
    sde_json   *doc;

    if (path == NULL || path[0] == '\0') {
        fprintf(stderr, "seide: view show needs --path REL\n");
        return 2;
    }
    err[0] = '\0';
    if (sde_app_init(&app, opt_root(argc, argv), NULL, emit_discard, NULL,
                     err, sizeof(err)) != 0) {
        fprintf(stderr, "seide: %s\n", err[0] != '\0' ? err : "cannot start");
        return 1;
    }
    if (sde_view_load(app.view, &app, path, err, sizeof(err)) != 0) {
        fprintf(stderr, "seide: %s\n",
                err[0] != '\0' ? err : "cannot read the view document");
        sde_app_free(&app);
        return 1;
    }

    doc = sde_view_document(app.view);
    sde_buf_init(&b);
    if (doc == NULL) {
        /* No file yet.  Say so in JSON rather than printing nothing. */
        (void) sde_buf_adds(&b, "null");
    } else if (sde_json_write_pretty(&b, doc, 2) != 0) {
        sde_buf_free(&b);
        sde_app_free(&app);
        fprintf(stderr, "seide: cannot serialise the view document\n");
        return 1;
    }
    (void) sde_buf_addc(&b, '\n');
    (void) sde_port_stdout_write(sde_buf_cstr(&b), b.len);
    sde_buf_free(&b);

    fprintf(stderr, "view file: %s\n", sde_view_path(app.view));
    sde_app_free(&app);
    return 0;
}

static int cmd_modules(void)
{
    const sde_module *table;
    size_t            count;
    size_t            i;
    int               required = 0;

    table = sde_modules(&count);
    printf("seIDE kernel %s -- %lu source modules\n",
           SDE_VERSION, (unsigned long) count);
    printf("To drop one: delete its line in the Makefile SRC list, its file\n"
           "under core/, and any method in rpc.c that calls it.\n\n");

    for (i = 0; i < count; i++) {
        printf("%-8s %s\n", table[i].name,
               table[i].optional ? "[optional]" : "[required]");
        printf("         %s\n", table[i].role);
        printf("         cut it and: %s\n\n", table[i].loses);
        if (!table[i].optional) {
            required++;
        }
    }

    printf("%lu of these cannot be cut without breaking the build; the rest\n"
           "are whole subsystems.\n",
           (unsigned long) required);
    return 0;
}

int main(int argc, char **argv)
{
    const char *cmd;

    sde_port_startup();

    if (argc < 2) {
        usage(stderr);
        return 2;
    }

    cmd = argv[1];

    if (strcmp(cmd, "rpc") == 0) {
        return cmd_rpc(argc, argv);
    }
    if (strcmp(cmd, "modules") == 0) {
        return cmd_modules();
    }
    if (strcmp(cmd, "version") == 0) {
        printf("seide %s protocol %s\n", SDE_VERSION, SDE_PROTOCOL);
        return 0;
    }
    if (strcmp(cmd, "view") == 0) {
        if (argc > 2 && strcmp(argv[2], "show") == 0) {
            return cmd_view_show(argc, argv);
        }
        fprintf(stderr, "seide: view needs a subcommand (show)\n");
        return 2;
    }
    if (strcmp(cmd, "help") == 0 || strcmp(cmd, "--help") == 0
        || strcmp(cmd, "-h") == 0) {
        usage(stdout);
        return 0;
    }

    fprintf(stderr, "seide: unknown command: %s\n", cmd);
    usage(stderr);
    return 2;
}
