#define _POSIX_C_SOURCE 200809L
/* Protontricks checks the Wine loader/server ELF architecture before running
 * them. Keep these entrypoints native, then delegate routing to Python. */
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    char path[PATH_MAX], router[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (length < 0 || length >= (ssize_t)sizeof(path) - 1) {
        fprintf(stderr, "lwfa Wine: cannot locate the tool launcher\n");
        return 1;
    }
    path[length] = '\0';
    char *name = strrchr(path, '/');
    if (!name) return 1;
    ++name;
    const char *entry;
    if (!strcmp(name, "proton")) entry = "proton";
    else if (!strcmp(name, "wine")) entry = "files/bin/wine";
    else if (!strcmp(name, "wine64")) entry = "files/bin/wine64";
    else if (!strcmp(name, "wineserver")) entry = "files/bin/wineserver";
    else if (!strcmp(name, "msidb")) entry = "files/bin/msidb";
    else {
        fprintf(stderr, "lwfa Wine: unknown entrypoint %s\n", name);
        return 1;
    }
    name[-1] = '\0';
    if (strcmp(entry, "proton")) {
        for (int i = 0; i < 2; ++i) {
            char *slash = strrchr(path, '/');
            if (!slash) return 1;
            *slash = '\0';
        }
    }
    if (snprintf(router, sizeof(router), "%s/router.py", path) >= (int)sizeof(router)) return 1;
    char **args = calloc((size_t)argc + 4, sizeof(*args));
    if (!args) return 1;
    args[0] = "python3";
    args[1] = router;
    args[2] = "run";
    args[3] = (char *)entry;
    for (int i = 1; i < argc; ++i) args[i + 3] = argv[i];
    execvp(args[0], args);
    fprintf(stderr, "lwfa Wine: cannot execute Python 3: %s\n", strerror(errno));
    free(args);
    return 1;
}
