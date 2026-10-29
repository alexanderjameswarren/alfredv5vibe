; The Switchboard bridge, panel side: reads tabs.json and asks the extension to
; focus a tab through command.json / result.json. Spec:
; docs\history\technical-spec-switchboard_bridge.md, sections 2 and 5.

tabsRaw := "", tabsList := [], tabsAt := ""
chatsRaw := "", chatsList := [], chatsAt := ""

; Re-read one bridge file, parsing only when its text changed. A missing file
; empties the list; a half-written one keeps the last good list until the next read.
ReadBridgeFile(name, key, &raw, &list, &at) {
    bridgePath := BRIDGE_DIR "\" name
    try text := FileRead(bridgePath, "UTF-8")
    catch {
        if !FileExist(bridgePath)
            raw := "", list := [], at := ""
        return
    }
    if text == raw
        return
    try data := JSON.parse(text)
    catch
        return
    raw := text, at := data.Get("at", ""), list := data.Get(key, [])
}

ReadTabs() {
    global tabsRaw, tabsList, tabsAt
    ReadBridgeFile("tabs.json", "tabs", &tabsRaw, &tabsList, &tabsAt)
}

ReadChats() {
    global chatsRaw, chatsList, chatsAt
    ReadBridgeFile("chats.json", "chats", &chatsRaw, &chatsList, &chatsAt)
}

TabsFresh() => IsFresh(tabsAt, A_NowUTC)
ChatsFresh() => IsFresh(chatsAt, A_NowUTC)

; Write a command (temp file, then rename) and wait up to 3 s for its reply.
; Returns the reply Map, or "" on a timeout or any failure. `composer` asks the
; extension to put the cursor in the chat's message box; nothing is typed.
; `action` "sendcli" lets the extension type and send "cli" (orange only).
SendFocus(tabId, composer := false, action := "focus") {
    static n := 0
    id := "panel-" A_TickCount "-" (++n)
    cmd := BRIDGE_DIR "\command.json", tmp := cmd ".tmp-panel"
    action := action = "sendcli" ? "sendcli" : "focus"
    try {
        FileOpen(tmp, "w", "UTF-8-RAW").Write('{"id":"' id '","action":"' action '","tabId":' tabId
            . (composer && action = "focus" ? ',"composer":true' : '') '}')
        FileMove(tmp, cmd, 1)
    } catch
        return ""
    deadline := A_TickCount + 3000
    while A_TickCount < deadline {
        Sleep(50)
        try {
            reply := JSON.parse(FileRead(BRIDGE_DIR "\result.json", "UTF-8"))
            if reply.Get("id", "") == id
                return reply
        }
    }
    return ""
}

; Focus the session's chat tab through the extension and put its window on
; monitor 2. True when that worked; false sends the caller to the old matching.
BridgeArrange(s, composer := false, action := "focus") {
    if s.chatLink = ""
        return false
    ReadTabs()
    if !TabsFresh()
        return false
    tab := FindTabByLink(tabsList, s.chatLink)
    return tab ? FocusAndPlace(tab.Get("tabId", ""), composer, action) : 0
}

; Ask the extension to focus a tab, then put its window on monitor 2. Returns
; that window's handle, or 0.
FocusAndPlace(tabId, composer := false, action := "focus") {
    reply := focusRequester(tabId, composer, action)
    if !IsObject(reply) || !reply.Get("ok", false)
        return 0
    ; Chrome retitles the window a moment after the tab changes.
    deadline := A_TickCount + 1000
    loop {
        if hwnd := FirstMatch(listChromeWindows(), WindowTitleStarts.Bind(reply.Get("windowTitle", "")))
            break
        if A_TickCount > deadline
            return 0
        Sleep(100)
    }
    placeWindow(hwnd, CHROME_MONITOR)
    return hwnd
}

; ---------------------------------------------------------------------------
; Send link (switchboard2-h8r 1.3, spec 7.1): deliver prompt-<project>.json
; ---------------------------------------------------------------------------
;
; Three layers, each a refusal: the one window titled with the checkout's folder
; (never the active window); Claude Code's input as UI Automation reports the
; focus (lib\focus-check.ahk), after at most one press of its focus key; and the
; prompt hook's record of the tag within [send] deliverySeconds.

promptResultRaw := "", promptResultId := "", promptResultSeen := false

; A refusal by the host or extension, from prompt-result.json, shown on the
; project's tile. The file already there at startup is old news.
ReadPromptResult() {
    global promptResultRaw, promptResultId, promptResultSeen
    text := ""
    try text := FileRead(BRIDGE_DIR "\prompt-result.json", "UTF-8")
    first := !promptResultSeen, promptResultSeen := true
    if text == promptResultRaw || text = ""
        return
    promptResultRaw := text
    try data := JSON.parse(text)
    catch
        return
    id := data.Get("id", "")
    if first || id == promptResultId
        return promptResultId := id
    promptResultId := id
    if data.Get("ok", false)
        return
    code := SessionForProject(order, mainProject, data.Get("project", ""))
    if code != ""
        sessions[code].sendNote := "Not sent: " (data.Get("error", "") || "refused")
}

; Take every waiting prompt file: deliver it or refuse it, and delete it either way,
; so a refused prompt never goes later by surprise.
TakePrompts() {
    Loop Files BRIDGE_DIR "\prompt-*.json" {
        if A_LoopFileName = "prompt-result.json"
            continue
        promptPath := A_LoopFileFullPath
        try data := JSON.parse(FileRead(promptPath, "UTF-8"))
        catch
            continue       ; mid-write: next poll
        try FileDelete(promptPath)
        DeliverPrompt(data.Get("project", ""), data.Get("tag", ""), data.Get("text", ""))
    }
}

DeliverPrompt(project, tag, text) {
    code := SessionForProject(order, mainProject, project)
    reason := SendRefusal(code, code != "" ? sessions[code].kind : "", project)
    if reason = "" {
        s := sessions[code]
        pick := PickSendWindow(listCodeWindows(), s.folder)
        reason := pick.error != "" ? pick.error : PasteIntoClaude(pick.hwnd, text)
    }
    if reason != "" {
        UnmarkSent(project, tag)
        if code != ""
            sessions[code].sendNote := "Not sent: " reason
        return false
    }
    s.sendNote := "", s.sendTag := tag, s.sendAt := A_TickCount
    return true
}

; Activate the window, make sure Claude's input has the focus, then paste and
; submit. Returns "" when pasted, or why nothing was.
PasteIntoClaude(hwnd, text) {
    names := InputNames(IniRead(SETTINGS_INI, "send", "input", ""))
    activateWindow(hwnd)
    Sleep(150)
    if !windowIsActive(hwnd)
        return "its VS Code window would not come to the front"
    if FocusVerdict(focusReader(), names) != "" {
        ; One press of Claude Code's focus key, which toggles: only when focus is elsewhere.
        keySender(IniRead(SETTINGS_INI, "send", "focusKey", "^{Esc}"))
        Sleep(300)
        if !windowIsActive(hwnd)
            return "the focus key took focus out of VS Code"
        if (verdict := FocusVerdict(focusReader(), names)) != ""
            return verdict
    }
    if !windowIsActive(hwnd)
        return "its VS Code window lost the front"
    return pasteSender(text) ? "" : "the clipboard could not be set"
}

; Clipboard in, Ctrl+V, Enter, clipboard back.
PastePrompt(text) {
    saved := ClipboardAll()
    A_Clipboard := ""
    A_Clipboard := text
    if !ClipWait(1) {
        A_Clipboard := saved
        return false
    }
    Send("^v")
    Sleep(300)
    Send("{Enter}")
    Sleep(200)
    A_Clipboard := saved
    return true
}

; A refused prompt's tag leaves sent.json, so its link can be clicked again.
UnmarkSent(project, tag) {
    sentPath := BRIDGE_DIR "\sent.json"
    try sent := JSON.parse(FileRead(sentPath, "UTF-8"))
    catch
        return
    if !(sent is Map) || sent.Get(project, "") != tag
        return
    sent.Delete(project)
    try {
        FileOpen(sentPath ".tmp-panel", "w", "UTF-8-RAW").Write(ToJson(sent))
        FileMove(sentPath ".tmp-panel", sentPath, 1)
    }
}

; Pasted and waiting: delivered once the prompt hook records the tag, else Not delivered.
CheckDelivery(s) {
    if s.sendTag = ""
        return
    state := DeliveryState(s.sendTag, s.runTag, s.sendAt, A_TickCount, 1000 * IniRead(SETTINGS_INI, "send", "deliverySeconds", 8))
    if state = "delivered"
        s.sendTag := ""
    else if state = "missing"
        s.sendTag := "", s.sendNote := "Not delivered"
}
