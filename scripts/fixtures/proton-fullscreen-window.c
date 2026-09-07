/* C11 Win32 fullscreen fixture, only for an isolated display and Wine prefix.
 * DXVK_FIXTURE requests a fullscreen swapchain using the existing monitor mode.
 * The GDI variant responds to WM_SIZE; the GPU variant keeps its render extent.
 */
#include <windows.h>
#include <windowsx.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef DXVK_FIXTURE
#define COBJMACROS
#define INITGUID
#include <d3d11_1.h>
static IDXGISwapChain *swapchain;
static ID3D11Device *device;
static ID3D11DeviceContext *context;
static ID3D11DeviceContext1 *context1;
static ID3D11RenderTargetView *target;
static UINT render_width, render_height;

static int gpu_start(HWND window, UINT width, UINT height) {
    DXGI_SWAP_CHAIN_DESC desc = {0};
    desc.BufferDesc.Width = width;
    desc.BufferDesc.Height = height;
    desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.BufferDesc.RefreshRate.Numerator = 60;
    desc.BufferDesc.RefreshRate.Denominator = 1;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.OutputWindow = window;
    desc.Windowed = FALSE;
    desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    desc.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    HRESULT hr = D3D11CreateDeviceAndSwapChain(NULL, D3D_DRIVER_TYPE_HARDWARE,
        NULL, 0, NULL, 0, D3D11_SDK_VERSION, &desc, &swapchain, &device, NULL, &context);
    if (FAILED(hr)) { printf("GPU_ERROR create=%lx\n", (unsigned long)hr); return 0; }
    hr = ID3D11DeviceContext_QueryInterface(context, &IID_ID3D11DeviceContext1, (void **)&context1);
    if (FAILED(hr)) { printf("GPU_ERROR context1=%lx\n", (unsigned long)hr); return 0; }
    ID3D11Texture2D *buffer = NULL;
    hr = IDXGISwapChain_GetBuffer(swapchain, 0, &IID_ID3D11Texture2D, (void **)&buffer);
    if (FAILED(hr)) { printf("GPU_ERROR buffer=%lx\n", (unsigned long)hr); return 0; }
    hr = ID3D11Device_CreateRenderTargetView(device, (ID3D11Resource *)buffer, NULL, &target);
    ID3D11Texture2D_Release(buffer);
    if (FAILED(hr)) { printf("GPU_ERROR target=%lx\n", (unsigned long)hr); return 0; }
    render_width = width; render_height = height;
    puts("DXVK_FIXTURE_READY");
    return 1;
}

static void gpu_paint(void) {
    if (!target) return;
    const FLOAT background[] = {.18f, .18f, .18f, 1};
    const FLOAT colors[4][4] = {{1,0,0,1}, {0,1,0,1}, {0,0,1,1}, {1,1,0,1}};
    const LONG w = (LONG)render_width, h = (LONG)render_height, side = 100;
    const D3D11_RECT corners[] = {{0,0,side,side}, {w-side,0,w,side}, {0,h-side,side,h}, {w-side,h-side,w,h}};
    ID3D11DeviceContext_ClearRenderTargetView(context, target, background);
    for (int i = 0; i < 4; i++) ID3D11DeviceContext1_ClearView(context1, (ID3D11View *)target, colors[i], &corners[i], 1);
    HRESULT hr = IDXGISwapChain_Present(swapchain, 0, 0);
    if (FAILED(hr)) printf("GPU_ERROR present=%lx\n", (unsigned long)hr);
}

static void gpu_resize_windowed(HWND window) {
    BOOL fullscreen = TRUE;
    if (!swapchain || FAILED(IDXGISwapChain_GetFullscreenState(swapchain, &fullscreen, NULL)) || fullscreen) return;
    RECT rect;
    GetClientRect(window, &rect);
    if (rect.right <= 0 || rect.bottom <= 0 || ((UINT)rect.right == render_width && (UINT)rect.bottom == render_height)) return;
    ID3D11DeviceContext_ClearState(context);
    ID3D11RenderTargetView_Release(target);
    target = NULL;
    HRESULT hr = IDXGISwapChain_ResizeBuffers(swapchain, 0, rect.right, rect.bottom, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH);
    if (FAILED(hr)) { printf("GPU_ERROR resize=%lx\n", (unsigned long)hr); return; }
    ID3D11Texture2D *buffer = NULL;
    hr = IDXGISwapChain_GetBuffer(swapchain, 0, &IID_ID3D11Texture2D, (void **)&buffer);
    if (FAILED(hr)) { printf("GPU_ERROR resized-buffer=%lx\n", (unsigned long)hr); return; }
    hr = ID3D11Device_CreateRenderTargetView(device, (ID3D11Resource *)buffer, NULL, &target);
    ID3D11Texture2D_Release(buffer);
    if (FAILED(hr)) { printf("GPU_ERROR resized-target=%lx\n", (unsigned long)hr); return; }
    render_width = rect.right; render_height = rect.bottom;
}
#endif

static void geometry(HWND window, const char *reason) {
    RECT client, outer;
    MONITORINFO monitor = { .cbSize = sizeof(MONITORINFO) };
    GetClientRect(window, &client);
    GetWindowRect(window, &outer);
    GetMonitorInfoA(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
    printf("RECT {\"reason\":\"%s\",\"clientWidth\":%ld,\"clientHeight\":%ld,"
           "\"left\":%ld,\"top\":%ld,\"width\":%ld,\"height\":%ld,"
           "\"monitorWidth\":%ld,\"monitorHeight\":%ld}\n", reason,
           client.right, client.bottom, outer.left, outer.top,
           outer.right - outer.left, outer.bottom - outer.top,
           monitor.rcMonitor.right - monitor.rcMonitor.left,
           monitor.rcMonitor.bottom - monitor.rcMonitor.top);
}

static LRESULT CALLBACK events(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_SIZE:
        geometry(window, "WM_SIZE");
        InvalidateRect(window, NULL, FALSE);
        return 0;
    case WM_TIMER:
#ifdef DXVK_FIXTURE
        if (wparam == 2) { gpu_resize_windowed(window); gpu_paint(); return 0; }
        if (swapchain) {
            BOOL fullscreen = FALSE;
            IDXGISwapChain_GetFullscreenState(swapchain, &fullscreen, NULL);
            printf("SWAP {\"width\":%u,\"height\":%u,\"fullscreen\":%s}\n", render_width, render_height, fullscreen ? "true" : "false");
        }
#endif
        geometry(window, "timer");
        InvalidateRect(window, NULL, FALSE);
        return 0;
    case WM_LBUTTONDOWN:
        printf("MOUSE {\"x\":%d,\"y\":%d}\n", GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam));
        return 0;
    case WM_KEYDOWN:
        if (wparam == VK_F11) {
#ifdef DXVK_FIXTURE
            HRESULT hr = IDXGISwapChain_SetFullscreenState(swapchain, FALSE, NULL);
            if (FAILED(hr)) printf("GPU_ERROR exit-fullscreen=%lx\n", (unsigned long)hr);
#endif
            SetWindowPos(window, NULL, 0, 0, 1000, 640, SWP_NOZORDER | SWP_NOACTIVATE);
            puts("FULLSCREEN_EXIT_REQUESTED");
            return 0;
        }
        break;
    case WM_PAINT: {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
#ifdef DXVK_FIXTURE
        (void)dc;
        EndPaint(window, &paint);
        gpu_paint();
        return 0;
#else
        RECT rect;
        GetClientRect(window, &rect);
        HBRUSH background = CreateSolidBrush(RGB(45, 45, 45));
        FillRect(dc, &rect, background);
        DeleteObject(background);
        HPEN pen = CreatePen(PS_SOLID, 2, RGB(120, 120, 120));
        HGDIOBJ old = SelectObject(dc, pen);
        for (int x = 0; x < rect.right; x += 100) { MoveToEx(dc, x, 0, NULL); LineTo(dc, x, rect.bottom); }
        for (int y = 0; y < rect.bottom; y += 100) { MoveToEx(dc, 0, y, NULL); LineTo(dc, rect.right, y); }
        SelectObject(dc, old);
        DeleteObject(pen);
        const int side = 100;
        RECT corners[] = {{0, 0, side, side}, {rect.right-side, 0, rect.right, side},
                          {0, rect.bottom-side, side, rect.bottom},
                          {rect.right-side, rect.bottom-side, rect.right, rect.bottom}};
        COLORREF colors[] = {RGB(255, 0, 0), RGB(0, 255, 0), RGB(0, 0, 255), RGB(255, 255, 0)};
        for (int i = 0; i < 4; i++) {
            HBRUSH brush = CreateSolidBrush(colors[i]);
            FillRect(dc, &corners[i], brush);
            DeleteObject(brush);
        }
        EndPaint(window, &paint);
        return 0;
#endif
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcA(window, message, wparam, lparam);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    SetProcessDPIAware();
    MONITORINFO monitor = { .cbSize = sizeof(MONITORINFO) };
    if (!GetMonitorInfoA(MonitorFromPoint((POINT){0, 0}, MONITOR_DEFAULTTOPRIMARY), &monitor)) return 2;
    HINSTANCE instance = GetModuleHandleA(NULL);
    WNDCLASSA klass = { .lpfnWndProc = events, .hInstance = instance, .lpszClassName = "LwfaFullscreenFixture" };
    if (!RegisterClassA(&klass)) return 3;
    RECT rect = monitor.rcMonitor;
    HWND window = CreateWindowExA(0, klass.lpszClassName, "lwfa-proton-fullscreen-fixture",
                                 WS_POPUP | WS_VISIBLE, rect.left, rect.top,
                                 rect.right - rect.left, rect.bottom - rect.top,
                                 NULL, NULL, instance, NULL);
    if (!window) return 4;
#ifdef DXVK_FIXTURE
    UINT render_w = rect.right - rect.left, render_h = rect.bottom - rect.top;
    const char *configured_w = getenv("LWFA_FIXTURE_RENDER_WIDTH");
    const char *configured_h = getenv("LWFA_FIXTURE_RENDER_HEIGHT");
    if (configured_w && configured_h) { render_w = (UINT)atoi(configured_w); render_h = (UINT)atoi(configured_h); }
    if (!gpu_start(window, render_w, render_h)) return 5;
    SetTimer(window, 2, 16, NULL);
#endif
    geometry(window, "created");
    SetTimer(window, 1, 250, NULL);
    puts("FULLSCREEN_FIXTURE_READY");
    MSG message;
    while (GetMessageA(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageA(&message);
    }
    return 0;
}
