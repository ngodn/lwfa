/* C11 fixture, only used on the isolated test display. */
#include <X11/Xlib.h>
#include <stdio.h>
int main(void) {
    Display *d = XOpenDisplay(NULL);
    if (!d) return 2;
    Window w = XCreateSimpleWindow(d, DefaultRootWindow(d), 0, 0, 600, 400, 0, 0, 0x4488aa);
    XStoreName(d, w, "lwfa-dpi-window-fixture");
    XSelectInput(d, w, ExposureMask | StructureNotifyMask);
    XMapWindow(d, w);
    XFlush(d);
    for (;;) {
        XEvent event;
        XNextEvent(d, &event);
    }
}
