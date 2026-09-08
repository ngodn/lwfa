/* C11 test fixture. Changes modes only in the caller's disposable Wine prefix.
 * https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-changedisplaysettingsexa */
#include <windows.h>
#include <stdio.h>
#include <string.h>
typedef HRESULT (WINAPI *dpi_fn)(HMONITOR, int, UINT *, UINT *);
static void sample(unsigned serial, LONG changed, dpi_fn dpi) {
    POINT origin = {0, 0};
    HMONITOR monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFOEXA info = {0}; info.cbSize = sizeof(info);
    if (!GetMonitorInfoA(monitor, (MONITORINFO *)&info)) ExitProcess(3);
    printf("{\"serial\":%u,\"pid\":%lu,\"changeResult\":%ld,\"monitor\":[%ld,%ld],\"modes\":[", serial, GetCurrentProcessId(), changed, info.rcMonitor.right-info.rcMonitor.left, info.rcMonitor.bottom-info.rcMonitor.top);
    DWORD modes[] = {ENUM_CURRENT_SETTINGS, ENUM_REGISTRY_SETTINGS, (DWORD)-3};
    for (unsigned i=0;i<3;i++) {
        DEVMODEA mode={0};mode.dmSize=sizeof(mode);
        BOOL ok=EnumDisplaySettingsExA(info.szDevice,modes[i],&mode,0);
        printf("%s{\"ok\":%s,\"size\":[%lu,%lu],\"hz\":%lu}",i?",":"",ok?"true":"false",mode.dmPelsWidth,mode.dmPelsHeight,mode.dmDisplayFrequency);
    }
    printf("],\"dpi\":[");
    for(int type=0;type<3;type++) {
        UINT x=0,y=0;HRESULT hr=dpi(monitor,type,&x,&y);
        printf("%s{\"result\":%ld,\"x\":%u,\"y\":%u}",type?",":"",(long)hr,x,y);
    }
    RECT clip = {0};
    BOOL clipped = GetClipCursor(&clip);
    printf("],\"clip\":{\"ok\":%s,\"rect\":[%ld,%ld,%ld,%ld]}}\n",
           clipped ? "true" : "false", clip.left, clip.top, clip.right, clip.bottom);
}
int main(void) {
    setvbuf(stdout,NULL,_IONBF,0);SetProcessDPIAware();
    HMODULE shcore=LoadLibraryA("shcore.dll");
    dpi_fn dpi=shcore?(dpi_fn)GetProcAddress(shcore,"GetDpiForMonitor"):NULL;
    if(!dpi)return 2;
    puts("READY");
    char line[128];
    while(fgets(line,sizeof(line),stdin)) {
        char command[16];unsigned serial=0,width=0,height=0;
        if(sscanf(line,"%15s %u %u %u",command,&serial,&width,&height)<1)continue;
        LONG changed=DISP_CHANGE_SUCCESSFUL;
        if(strcmp(command,"quit")==0)break;
        if(strcmp(command,"mode")==0) {
            DEVMODEA mode={0};mode.dmSize=sizeof(mode);
            if(!EnumDisplaySettingsA(NULL,ENUM_CURRENT_SETTINGS,&mode))return 4;
            mode.dmPelsWidth=width;mode.dmPelsHeight=height;
            mode.dmFields=DM_PELSWIDTH|DM_PELSHEIGHT|DM_BITSPERPEL;
            changed=ChangeDisplaySettingsExA(NULL,&mode,NULL,CDS_FULLSCREEN,NULL);
        } else if(strcmp(command,"reset")==0)changed=ChangeDisplaySettingsExA(NULL,NULL,NULL,0,NULL);
        else if(strcmp(command,"clip")==0) {
            RECT clip = {100, 80, 900, 600};
            changed = ClipCursor(&clip) ? 0 : 1;
        } else if(strcmp(command,"unclip")==0)changed=ClipCursor(NULL) ? 0 : 1;
        MSG message;while(PeekMessageA(&message,NULL,0,0,PM_REMOVE)){TranslateMessage(&message);DispatchMessageA(&message);}
        sample(serial,changed,dpi);
    }
    ClipCursor(NULL);
    FreeLibrary(shcore);return 0;
}
