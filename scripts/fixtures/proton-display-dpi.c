/* Read-only C11 display probe. Does not create windows or change display modes. */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
typedef HRESULT (WINAPI *dpi_fn)(HMONITOR, int, UINT *, UINT *);

static BOOL CALLBACK inspect(HMONITOR monitor, HDC dc, LPRECT rect, LPARAM context) {
    (void)dc;
    (void)rect;
    MONITORINFOEXA info = {0};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoA(monitor, (MONITORINFO *)&info)) return FALSE;
    printf("monitor=%s rectangle=%ld,%ld,%ld,%ld\n", info.szDevice,
           info.rcMonitor.left, info.rcMonitor.top,
           info.rcMonitor.right, info.rcMonitor.bottom);
    // Wine's physical mode is intentionally queried alongside its cached modes.
    DWORD modes[] = {ENUM_CURRENT_SETTINGS, ENUM_REGISTRY_SETTINGS, (DWORD)-3};
    const char *names[] = {"current", "registry", "wine-physical"};
    for (unsigned i = 0; i < 3; i++) {
        DEVMODEA mode = {0};
        mode.dmSize = sizeof(mode);
        if (EnumDisplaySettingsExA(info.szDevice, modes[i], &mode, 0)) {
            printf("%s=%lux%lu dpi=%u\n", names[i], mode.dmPelsWidth,
                   mode.dmPelsHeight, mode.dmLogPixels);
        }
    }
    for (int type = 0; type < 3; type++) {
        UINT x = 0, y = 0;
        printf("query-dpi type=%d\n", type);
        fflush(stdout);
        HRESULT hr = ((dpi_fn)context)(monitor, type, &x, &y);
        printf("dpi type=%d result=%lx x=%u y=%u\n", type, (unsigned long)hr, x, y);
        if (FAILED(hr)) return FALSE;
    }
    fflush(stdout);
    return TRUE;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    HMODULE shcore = LoadLibraryA("shcore.dll");
    dpi_fn get = shcore ? (dpi_fn)GetProcAddress(shcore, "GetDpiForMonitor") : NULL;
    if (!get) return 2;
    SetProcessDPIAware();
    unsigned loops = argc > 1 ? (unsigned)atoi(argv[1]) : 1;
    for (unsigned i = 0; i < loops; i++) {
        if (!EnumDisplayMonitors(NULL, NULL, inspect, (LPARAM)get)) return 3;
        if (i + 1 < loops) Sleep(500);
    }
    puts("DPI_PROBE_OK");
    FreeLibrary(shcore);
    return 0;
}
