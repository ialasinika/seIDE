#include "seide_cfg.h"

#include "vec.h"

#include <stdlib.h>

#define SDE_VEC_MIN_CAP 8u

void sde_vec_init(sde_vec *v)
{
    v->items = (void **) 0;
    v->count = 0u;
    v->cap = 0u;
}

void sde_vec_free(sde_vec *v)
{
    if (v->items != (void **) 0) {
        free(v->items);
    }
    sde_vec_init(v);
}

void sde_vec_clear(sde_vec *v)
{
    v->count = 0u;
}

int sde_vec_push(sde_vec *v, void *item)
{
    void **grown;
    size_t cap;

    if (v->count == v->cap) {
        /* Both the doubling and the bytes it asks for have to be in range. */
        if (v->cap > ((size_t) -1) / 2u / sizeof(void *)) {
            return -1;
        }
        cap = (v->cap == 0u) ? SDE_VEC_MIN_CAP : v->cap * 2u;
        if (cap > ((size_t) -1) / sizeof(void *)) {
            return -1;
        }
        grown = (void **) realloc(v->items, cap * sizeof(void *));
        if (grown == (void **) 0) {
            return -1;
        }
        v->items = grown;
        v->cap = cap;
    }
    v->items[v->count] = item;
    v->count += 1u;
    return 0;
}

void *sde_vec_at(const sde_vec *v, size_t i)
{
    if (i >= v->count) {
        return (void *) 0;
    }
    return v->items[i];
}
