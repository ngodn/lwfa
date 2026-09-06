/* Passive Windows XInput observer, built as C11 for x86_64 Windows.
 * It never sets vibration, grabs devices, or injects input. */
#include <windows.h>
#include <xinput.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef DWORD (WINAPI *get_state_fn)(DWORD, XINPUT_STATE *);

static unsigned long long now_us(void) {
    FILETIME ft;
    ULARGE_INTEGER value;
    GetSystemTimePreciseAsFileTime(&ft);
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    return (value.QuadPart - 116444736000000000ULL) / 10;
}

int main(int argc, char **argv) {
    unsigned seconds = argc > 1 ? (unsigned)atoi(argv[1]) : 15;
    unsigned interval = argc > 2 ? (unsigned)atoi(argv[2]) : 1;
    if (!seconds || seconds > 600 || !interval || interval > 1000) return 2;
    HMODULE dll = LoadLibraryA("xinput1_4.dll");
    if (!dll) dll = LoadLibraryA("xinput1_3.dll");
    get_state_fn get_state = dll ? (get_state_fn)GetProcAddress(dll, "XInputGetState") : NULL;
    if (!get_state) { fprintf(stderr, "XInput unavailable\n"); return 3; }
    XINPUT_STATE previous[4] = {0};
    DWORD last_status[4] = {~0u, ~0u, ~0u, ~0u};
    LARGE_INTEGER frequency, start, tick, last;
    QueryPerformanceFrequency(&frequency);
    QueryPerformanceCounter(&start);
    last = start;
    unsigned long long polls = 0, max_gap_us = 0;
    timeBeginPeriod(1);
    ULONGLONG last_scan[4] = {0};
    for (;;) {
        QueryPerformanceCounter(&tick);
        unsigned long long gap = (tick.QuadPart - last.QuadPart) * 1000000ULL / frequency.QuadPart;
        if (gap > max_gap_us) max_gap_us = gap;
        last = tick;
        if ((tick.QuadPart - start.QuadPart) >= (LONGLONG)seconds * frequency.QuadPart) break;
        for (DWORD slot = 0; slot < 4; slot++) {
            /* Missing slots force Wine to rescan devices. Keep checking for
             * hotplug without making every connected-state poll pay for it. */
            ULONGLONG scan = GetTickCount64();
            if (last_status[slot] == ERROR_DEVICE_NOT_CONNECTED && scan - last_scan[slot] < 250) continue;
            last_scan[slot] = scan;
            XINPUT_STATE state = {0};
            DWORD status = get_state(slot, &state);
            if (status != last_status[slot] || (status == ERROR_SUCCESS &&
                memcmp(&state.Gamepad, &previous[slot].Gamepad, sizeof(state.Gamepad)))) {
                printf("{\"type\":\"state\",\"time_us\":%llu,\"slot\":%lu,\"status\":%lu,\"packet\":%lu,\"buttons\":%u,\"lx\":%d,\"ly\":%d,\"rx\":%d,\"ry\":%d,\"lt\":%u,\"rt\":%u}\n",
                    now_us(), slot, status, state.dwPacketNumber, state.Gamepad.wButtons,
                    state.Gamepad.sThumbLX, state.Gamepad.sThumbLY,
                    state.Gamepad.sThumbRX, state.Gamepad.sThumbRY,
                    state.Gamepad.bLeftTrigger, state.Gamepad.bRightTrigger);
                fflush(stdout);
            }
            previous[slot] = state;
            last_status[slot] = status;
        }
        if (!polls) {
            QueryPerformanceCounter(&start);
            last = start;
            max_gap_us = 0;
            printf("{\"type\":\"ready\",\"time_us\":%llu,\"interval_ms\":%u}\n", now_us(), interval);
            fflush(stdout);
        }
        polls++;
        Sleep(interval);
    }
    printf("{\"type\":\"done\",\"time_us\":%llu,\"polls\":%llu,\"max_gap_us\":%llu}\n", now_us(), polls, max_gap_us);
    timeEndPeriod(1);
    FreeLibrary(dll);
    return 0;
}
