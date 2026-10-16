/*
 * test_port.c - self-checks for the port layer.
 *
 * The port is the one module that had no test of its own.  Two of its promises
 * are load-bearing for the whole kernel and are what this file checks:
 *
 *   * a write is published atomically -- the bytes go to a neighbour and are
 *     moved into place -- so a reader never sees a half-written file; and
 *   * containment is physical as well as lexical: a junction or symlink inside
 *     the workspace that points outside it must not make an outside path look
 *     like in-workspace work.
 *
 * Everything is created under build/test_port, so a run cannot touch your
 * workspace or your files.  Not part of the shipped kernel; run by `make test`.
 */
#include "seide_cfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "buf.h"
#include "port.h"
#include "vec.h"

static int failures = 0;

static void ok(int cond, const char *what)
{
    if (!cond) {
        failures++;
        printf("FAIL %s\n", what);
    } else {
        printf("ok   %s\n", what);
    }
}

#define SCRATCH "build/test_port"

/* '/' -> '\' for the one command that needs a Win32 path spelled its way. */
static void win_path(const char *in, char *out, size_t cap)
{
    size_t i;

    for (i = 0; in[i] != '\0' && i + 1u < cap; i++) {
        out[i] = (in[i] == '/') ? '\\' : in[i];
    }
    out[i] = '\0';
}

static int same_file(const char *path, const char *want, size_t len)
{
    sde_buf b;
    char    err[200];
    int     same = 0;

    sde_buf_init(&b);
    if (sde_port_read_file(path, &b, err, sizeof(err)) == 0
        && b.len == len
        && memcmp(b.data, want, len) == 0) {
        same = 1;
    } else {
        printf("     read %s: %s (len %lu, wanted %lu)\n",
               path, err, (unsigned long) b.len, (unsigned long) len);
    }
    sde_buf_free(&b);
    return same;
}

/* ---------------------------------------------------------------------- */

static void test_directories_and_files(void)
{
    char     err[200];
    char    *abs;
    int64_t  size;

    ok(sde_port_mkdirs(SCRATCH "/deep/a/b", err, sizeof(err)) == 0,
       "mkdirs creates a chain");
    ok(sde_port_is_dir(SCRATCH "/deep/a/b") == 1, "mkdirs made the directory");
    ok(sde_port_mkdirs(SCRATCH "/deep/a/b", err, sizeof(err)) == 0,
       "mkdirs is happy with a directory that already exists");

    ok(sde_port_write_file(SCRATCH "/one.txt", "hello\n", 6u,
                           err, sizeof(err)) == 0,
       "write_file");
    ok(sde_port_file_exists(SCRATCH "/one.txt") == 1, "the file is there");
    ok(same_file(SCRATCH "/one.txt", "hello\n", 6u), "read_file round-trips");

    size = sde_port_file_size(SCRATCH "/one.txt");
    ok(size == 6, "file_size is the byte count");
    ok(sde_port_file_mtime(SCRATCH "/one.txt") > 0, "file_mtime is set");

    /*
     * The atomic publish leaves no neighbour behind, on the success path or
     * the failure path.
     */
    ok(sde_port_file_exists(SCRATCH "/one.txt.tmp") == 0,
       "an atomic write leaves no temporary file");

    /* Overwriting in place. */
    ok(sde_port_write_file(SCRATCH "/one.txt", "hello there\n", 12u,
                           err, sizeof(err)) == 0,
       "overwrite");
    ok(same_file(SCRATCH "/one.txt", "hello there\n", 12u), "overwrite landed");
    ok(sde_port_file_size(SCRATCH "/one.txt") == 12, "the size followed");

    /* A write into directories that do not exist yet. */
    ok(sde_port_write_file(SCRATCH "/made/up/deep.txt", "x", 1u,
                           err, sizeof(err)) == 0,
       "write_file creates missing parents");
    ok(sde_port_file_exists(SCRATCH "/made/up/deep.txt") == 1,
       "the nested file is there");

    /* Things that are not there. */
    ok(sde_port_file_size(SCRATCH "/nope.txt") == -1,
       "file_size reports -1 for a missing file");
    ok(sde_port_file_exists(SCRATCH "/nope.txt") == 0, "exists is 0");
    {
        sde_buf b;
        sde_buf_init(&b);
        ok(sde_port_read_file(SCRATCH "/nope.txt", &b, err, sizeof(err)) != 0,
           "read_file fails on a missing file");
        ok(b.len == 0, "and appends nothing to the buffer");
        sde_buf_free(&b);
    }

    abs = sde_port_path_abs(SCRATCH "/one.txt");
    ok(abs != NULL && sde_port_path_is_abs(abs) == 1, "path_abs is absolute");
    ok(abs != NULL && strchr(abs, '\\') == NULL,
       "path_abs hands back '/' separators");
    free(abs);

    ok(sde_port_remove_file(SCRATCH "/one.txt") == 0, "remove_file");
    ok(sde_port_file_exists(SCRATCH "/one.txt") == 0, "the file is gone");
}

static void test_atomic_replace(void)
{
    char err[200];

    ok(sde_port_write_file(SCRATCH "/from.txt", "new", 3u,
                           err, sizeof(err)) == 0,
       "replace: write the source");
    ok(sde_port_write_file(SCRATCH "/to.txt", "old", 3u,
                           err, sizeof(err)) == 0,
       "replace: write the destination");

    ok(sde_port_replace_file(SCRATCH "/from.txt", SCRATCH "/to.txt") == 0,
       "replace_file succeeds");
    ok(sde_port_file_exists(SCRATCH "/from.txt") == 0,
       "the source is gone once it has been moved");
    ok(same_file(SCRATCH "/to.txt", "new", 3u),
       "the destination holds the new bytes");

    /*
     * The failure path matters more than the success path: a caller that
     * still owns the only complete copy needs to hear that it still does.
     * A missing source must not delete the destination.
     */
    ok(sde_port_replace_file(SCRATCH "/nothere.txt", SCRATCH "/to.txt") != 0,
       "replace_file fails for a missing source");
    ok(same_file(SCRATCH "/to.txt", "new", 3u),
       "a failed replace left the destination alone");
}

static void test_containment(void)
{
    char  err[200];
    char *root;
    char *p;
    int   made;

    ok(sde_port_mkdirs(SCRATCH "/ws/inside", err, sizeof(err)) == 0,
       "containment: make the workspace");
    ok(sde_port_mkdirs(SCRATCH "/outside", err, sizeof(err)) == 0,
       "containment: make the outside directory");

    root = sde_port_path_abs(SCRATCH "/ws");
    ok(root != NULL, "containment: the root is absolute");
    if (root == NULL) {
        return;
    }

    p = sde_port_path_abs(SCRATCH "/ws/inside/a.txt");
    ok(p != NULL && sde_port_path_within(root, p) == 1,
       "containment: a file inside the workspace is inside");
    free(p);

    p = sde_port_path_abs(SCRATCH "/ws");
    ok(p != NULL && sde_port_path_within(root, p) == 1,
       "containment: the root is within itself");
    free(p);

    p = sde_port_path_abs(SCRATCH "/ws/../outside/a.txt");
    ok(p != NULL && sde_port_path_within(root, p) == 0,
       "containment: .. out of the workspace is outside");
    free(p);

    p = sde_port_path_abs(SCRATCH "/outside/a.txt");
    ok(p != NULL && sde_port_path_within(root, p) == 0,
       "containment: a sibling directory is outside");
    free(p);

    /*
     * The interesting case: a junction INSIDE the workspace that points out
     * of it.  Every lexical check passes here, and only the resolved path
     * shows where the bytes would really come from.
     */
    {
        char  cmd[600];
        char  target[400];
        char  link[400];
        char *outside = sde_port_path_abs(SCRATCH "/outside");

        win_path(SCRATCH "/outside", target, sizeof(target));
        win_path(SCRATCH "/ws/link", link, sizeof(link));
        snprintf(cmd, sizeof(cmd), "cmd /c mklink /J \"%s\" \"%s\" >nul 2>nul",
                 link, target);
        made = (system(cmd) == 0);
        if (!made) {
            printf("     note: no junction could be created, so only the\n"
                   "           lexical half of containment was checked here\n");
        } else {
            p = sde_port_path_abs(SCRATCH "/ws/link/secret.txt");
            ok(p != NULL && sde_port_path_within(root, p) == 0,
               "containment: a junction inside the root does not escape it");
            free(p);
            p = sde_port_path_abs(SCRATCH "/ws/link");
            ok(p != NULL && sde_port_path_within(root, p) == 0,
               "containment: the junction itself is outside too");
            free(p);
            snprintf(cmd, sizeof(cmd), "cmd /c rmdir \"%s\" >nul 2>nul", link);
            (void) system(cmd);
        }
        free(outside);
    }

    free(root);
}

static void test_list_dir(void)
{
    char         err[200];
    sde_vec      out;
    sde_dirent  *found;
    size_t       i;
    int          saw_six = 0;
    int64_t      reported = -1;

    ok(sde_port_write_file(SCRATCH "/listed/one.txt", "abcdef", 6u,
                           err, sizeof(err)) == 0,
       "list_dir: write a file to list");

    sde_vec_init(&out);
    ok(sde_port_list_dir(SCRATCH "/listed", &out, err, sizeof(err)) == 0,
       "list_dir");
    found = NULL;
    for (i = 0; i < out.count; i++) {
        sde_dirent *d = (sde_dirent *) sde_vec_at(&out, i);

        if (strcmp(d->name, "one.txt") == 0) {
            found = d;
            reported = d->size;
            saw_six = 1;
        }
    }
    ok(found != NULL, "list_dir named the file");
    ok(found != NULL && found->is_dir == 0, "and marked it a file");
    ok(reported == 6, "the entry carries the size, in 64 bits");
    for (i = 0; i < out.count; i++) {
        sde_port_dirent_free((sde_dirent *) sde_vec_at(&out, i));
    }
    sde_vec_free(&out);
    (void) saw_six;
}

static void test_large_file(void)
{
    static char pattern[1024];
    sde_buf     big;
    sde_buf     back;
    char        err[200];
    size_t      i;
    int         round;

    for (i = 0; i < sizeof(pattern); i++) {
        pattern[i] = (char) (i * 7u % 251u);
    }

    /*
     * Enough to cross every internal chunk boundary more than once, so the
     * write path is exercised where it loops and the read path where it
     * appends.
     */
    sde_buf_init(&big);
    for (round = 0; round < 200; round++) {
        if (sde_buf_add(&big, pattern, sizeof(pattern)) != 0) {
            break;
        }
    }
    ok(big.len == 200u * sizeof(pattern), "built a 200 KiB buffer");

    ok(sde_port_write_file(SCRATCH "/big.bin", big.data, big.len,
                           err, sizeof(err)) == 0,
       "write_file handles a large buffer");
    ok(sde_port_file_size(SCRATCH "/big.bin") == (int64_t) big.len,
       "the size of the large file is exact");

    sde_buf_init(&back);
    ok(sde_port_read_file(SCRATCH "/big.bin", &back, err, sizeof(err)) == 0,
       "read_file handles a large buffer");
    ok(back.len == big.len && memcmp(back.data, big.data, big.len) == 0,
       "200 KiB round-trips byte for byte");
    sde_buf_free(&back);
    sde_buf_free(&big);
}

static void test_mutex(void)
{
    sde_mutex *m = sde_mutex_new();

    ok(m != NULL, "a mutex can be created");
    if (m != NULL) {
        sde_mutex_lock(m);
        sde_mutex_unlock(m);
        sde_mutex_lock(m);
        sde_mutex_unlock(m);
        ok(1, "and taken and released twice");
        sde_mutex_free(m);
    }
}

int main(void)
{
    test_directories_and_files();
    test_atomic_replace();
    test_containment();
    test_list_dir();
    test_large_file();
    test_mutex();
    printf(failures ? "\nFAILED (%d)\n" : "\nall good\n", failures);
    return failures ? 1 : 0;
}
