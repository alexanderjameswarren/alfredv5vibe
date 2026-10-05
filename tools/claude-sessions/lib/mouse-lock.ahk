#Requires AutoHotkey v2.0
#SingleInstance Force
#Warn
#NoTrayIcon
Persistent
#Include status.ahk

; Mouse lock: keeps the pointer off the 1024x600 touch screen with ClipCursor;
; finger taps still work. Started and closed by claude-sessions.ahk, which passes
; its process ID; with that process gone, this exits too. Holding Ctrl lifts the
; fence. Spec: docs\history\technical-spec-switchboard_touch-t4n.md, "Mouse lock".

; Physical pixels, so a scaled monitor does not skew the box.
DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")

panelPid := A_Args.Length ? Integer(A_Args[1]) : 0   ; not `owner`: Orphans() has a local of that name
clipped := false
OnExit((*) => Release())
SetTimer(Fence, 1000)
Fence()

~*Ctrl:: Release()
~*Ctrl up:: Fence()

; Re-applied every second: Windows drops the clip on some events (UAC, the lock screen).
Fence() {
    global clipped
    if panelPid && !ProcessExist(panelPid)
        ExitApp()
    if GetKeyState("Ctrl", "P")
        return
    box := FenceBox(MonitorRects())
    if box = "" {
        Release()
        return
    }
    rc := Buffer(16)
    NumPut("int", box.l, "int", box.t, "int", box.r, "int", box.b, rc)
    DllCall("ClipCursor", "ptr", rc)
    clipped := true
}

; Only lifts a clip this script set, so it never undoes someone else's.
Release() {
    global clipped
    if clipped
        DllCall("ClipCursor", "ptr", 0), clipped := false
}
