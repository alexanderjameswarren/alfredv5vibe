; The Switchboard bridge, panel side: reads tabs.json and asks the extension to
; focus a tab through command.json / result.json. Spec:
; docs\technical-spec-switchboard_bridge.md, sections 2 and 5.

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
