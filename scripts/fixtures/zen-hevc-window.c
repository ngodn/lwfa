#define _DEFAULT_SOURCE
#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    Display *display = XOpenDisplay(NULL);
    if (!display) return 1;
    Window window = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1000, 640, 0, 0, 0);
    GC gc = XCreateGC(display, window, 0, NULL);
    XStoreName(display, window, "lwfa-zen-hevc-probe");
    XSelectInput(display, window, StructureNotifyMask | ExposureMask);
    Atom close = XInternAtom(display, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(display, window, &close, 1);
    XMapWindow(display, window);
    unsigned width = 1000, height = 640, tick = 0;
    for (;;) {
        while (XPending(display)) {
            XEvent event;
            XNextEvent(display, &event);
            if (event.type == ClientMessage && (Atom)event.xclient.data.l[0] == close) goto done;
            if (event.type == ConfigureNotify) {
                width = event.xconfigure.width;
                height = event.xconfigure.height;
            }
        }
        const unsigned gray[] = {40, 100, 160, 220};
        for (unsigned quadrant = 0; quadrant < 4; ++quadrant) {
            unsigned x = (quadrant & 1) ? width / 2 : 0;
            unsigned y = (quadrant & 2) ? height / 2 : 0;
            XSetForeground(display, gc, gray[quadrant] * 0x010101);
            XFillRectangle(display, window, gc, x, y, (quadrant & 1) ? width - x : width / 2,
                           (quadrant & 2) ? height - y : height / 2);
        }
        XSetForeground(display, gc, (tick++ & 1) ? 0xffffff : 0x808080);
        XFillRectangle(display, window, gc, width / 2 - 8, height / 2 - 8, 16, 16);
        XFlush(display);
        usleep(100000);
    }
done:
    XFreeGC(display, gc);
    XDestroyWindow(display, window);
    XCloseDisplay(display);
    return 0;
}
