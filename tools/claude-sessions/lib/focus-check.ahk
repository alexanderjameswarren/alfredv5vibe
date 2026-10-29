#Requires AutoHotkey v2.0
; What has the keyboard focus, read through Windows UI Automation, so a Send link
; pastes only into Claude Code's message input (switchboard2-h8r 1.3). The
; panel includes it; FocusVerdict in status.ahk decides from what it returns.
;
; Run it on its own once to set up: it waits while you click into Claude Code's
; message box, shows what UI Automation sees there, and on Yes adds that name to
; settings.ini [send] input. Nothing is pasted unless the focus matches a saved name.

; The focused element as {name, helpText, className, automationId}, or "" when it
; cannot be read. Chromium reports an input's placeholder as its help text.
FocusedElement() {
    static uia := ""
    el := 0
    try {
        if uia = ""
            uia := ComObject("{e22ad333-b25f-460c-83d0-0581107395c9}", "{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")
        ComCall(8, uia, "ptr*", &el)                  ; IUIAutomation::GetFocusedElement
        if !el
            return ""
        out := {name: UiaText(el, 23), helpText: UiaText(el, 31), className: UiaText(el, 30), automationId: UiaText(el, 29)}
        ObjRelease(el)
        return out
    } catch {
        if el
            ObjRelease(el)
        return ""
    }
}

; One BSTR property of an IUIAutomationElement, by vtable index
; (23 CurrentName, 29 CurrentAutomationId, 30 CurrentClassName, 31 CurrentHelpText).
UiaText(el, index) {
    bstr := 0
    ComCall(index, el, "ptr*", &bstr)
    text := bstr ? StrGet(bstr, "UTF-16") : ""
    if bstr
        DllCall("OleAut32\SysFreeString", "ptr", bstr)
    return text
}

if A_LineFile = A_ScriptFullPath
    FocusCheckSetup()

FocusCheckSetup() {
    title := "Switchboard focus check"
    MsgBox("After OK you have 5 seconds: click into Claude Code's message box in VS Code and wait.", title)
    Sleep(5000)
    el := FocusedElement()
    if !IsObject(el) {
        MsgBox("UI Automation could not read the focused element.", title, "Icon!")
        ExitApp(1)
    }
    seen := "name: " el.name "`nplaceholder / help: " el.helpText "`nclass: " el.className "`nautomation id: " el.automationId
    pick := el.name != "" ? el.name : el.helpText
    if pick = "" || el.className ~= "i)monaco|inputarea|xterm" {
        MsgBox("This does not look like Claude's message box, so nothing was saved.`n`n" seen, title, "Icon!")
        ExitApp(1)
    }
    ini := (EnvGet("SWITCHBOARD_SETTINGS_DIR") || EnvGet("APPDATA") "\claude-sessions") "\settings.ini"
    if MsgBox(seen "`n`nSave `"" pick "`" as Claude's message input?", title, "YesNo Icon?") = "Yes" {
        cur := IniRead(ini, "send", "input", "")
        IniWrite(Trim(cur "|" pick, "|"), ini, "send", "input")
    }
    ExitApp(0)
}
