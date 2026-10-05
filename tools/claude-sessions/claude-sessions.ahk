#Requires AutoHotkey v2.0
#SingleInstance Force      ; double-clicking the file again replaces the running copy
#Warn                      ; names are case-insensitive: a local `alert` once hid Alert()
Persistent
#Include lib\JSON.ahk
#Include lib\status.ahk
#Include lib\chrome-address.ahk
#Include lib\bridge.ahk
#Include lib\webview2\WebView2\WebView2.ahk

; Switchboard: one button per Claude Code session on alfred-v5 (main plus each
; worktree), coloured from that checkout's .clip\session-status.json, which the
; repo's hooks write. The panel never writes to the repo. Spec:
; docs\technical-spec-switchboard.md, section 2.

; ---------------------------------------------------------------------------
; Settings (kept outside the repo)
; ---------------------------------------------------------------------------

SETTINGS_DIR := EnvGet("APPDATA") "\claude-sessions"
SETTINGS_INI := SETTINGS_DIR "\settings.ini"   ; not `SETTINGS`: WebView2.ahk has a local `settings`
if !DirExist(SETTINGS_DIR)
    DirCreate(SETTINGS_DIR)
REPO := IniRead(SETTINGS_INI, "panel", "repo", "C:\Users\Alex\projects\alfred-v5")
CLAIMS_FILE := REPO "\.git\alfred-claims.json"
BINDING_FILE := REPO "\.git\alfred-project-code.json"
; Where the Chrome bridge host writes tabs.json (docs\technical-spec-switchboard_bridge.md).
BRIDGE_DIR := IniRead(SETTINGS_INI, "panel", "bridge", EnvGet("LOCALAPPDATA") "\claude-sessions\bridge")
POINTER_FOLLOWS := IniRead(SETTINGS_INI, "panel", "pointer", "1") != "0"   ; mouse to the window that gets the keyboard
mouseLockOn := IniRead(SETTINGS_INI, "panel", "mouselock", "1") != "0"     ; keep the pointer off the touch screen
LOCK_ITEM := "Mouse lock (hold Ctrl to cross)"
TOUCH_UI := IniRead(SETTINGS_INI, "panel", "touchui", "1") != "0"           ; the touch page (default); touchui=0 brings back the old panel
TOUCH_MODE := IniRead(SETTINGS_INI, "panel", "touchmode", "touch")          ; "touch" (docked) or "main", remembered
TOUCH_DATA_DIR := SETTINGS_DIR "\webview2"                              ; WebView2's profile, never in the repo
SplitPath(A_LineFile, , &PANEL_DIR)   ; this file's folder, even when a test script includes it

PAUSED_COLOR := "C8C8C8"
CLOSED_COLOR := "E4E4E4"
FREE_COLOR := "D4D4D4"     ; main with no project bound
BLINK_COLOR := "FFFFFF"
; Colour says which window to go to; the label says what to do there (bridge spec, section 5).
COLORS := Map("green", "70C070", "yellow", "E8C840", "red", "E06060", "orange", "F0A040", "purple", "B48CE6"
    , "grey", "D8D8D8", "none", "F4F4F4", "paused", PAUSED_COLOR, "closed", CLOSED_COLOR, "free", FREE_COLOR)
DIM_COLORS := "grey|none|paused|closed|free"   ; drawn with grey text
CHAT_ROWS_MAX := 8, CHAT_ROW_H := 36
TAIL_BYTES := 16384        ; how much of a transcript's end is searched for an interrupt
BUTTON_W := 280, BUTTON_H := 44, PAUSE_W := 64, GAP := 6, STRIP_H := 20
; Monitor numbers for VS Code and Chrome, chosen by position (AppMonitors): set by
; UpdateAppMonitors whenever the layout changes. lib\bridge.ahk reads CHROME_MONITOR too.
VS_MONITOR := 1, CHROME_MONITOR := 2
CLOSED_AFTER := 3          ; polls with no VS Code window before a session counts as closed

; ---------------------------------------------------------------------------
; State
; ---------------------------------------------------------------------------

sessions := Map()          ; project code -> session object, for checkouts that exist now
order := []                ; codes in display order: main first, then worktrees by name
controls := Map()          ; code -> its button, kept (hidden) if the worktree goes away
pauseButtons := Map()      ; code -> the small pause/resume button beside it
blinkOn := false
lastTaskbar := -1
needsResize := true
claimsRaw := "", claimsState := Map("claims", [], "reservations", [])
mainProject := ""          ; main's bound project code, from BINDING_FILE; "" when free
chatRows := []             ; Text controls for unpaired claude.ai chats, reused in order
rowTabs := []              ; tabId shown in each visible chat row
rowState := Map()          ; tabId -> {color, unseen, flashes, painted} for unpaired chats
shownRows := -1            ; chat rows laid out last time
tipFor := Map()            ; session button hwnd -> project code, for the step tooltip
; Swappable so smoke-test.ahk can run without real windows.
listCodeWindows := ListWindows.Bind("ahk_exe Code.exe")
listChromeWindows := ListWindows.Bind("ahk_exe chrome.exe")
chromeAddressReader := ReadChromeAddress
placeWindow := PutOnMonitor
focusRequester := SendFocus
activateWindow := (hwnd) => (WinExist("ahk_id " hwnd) && WinActivate(hwnd))
pointerMover := MovePointerTo
arrangeAction := Arrange
listMonitors := PhysicalMonitors
appMonitorsFor := ""       ; the layout VS_MONITOR and CHROME_MONITOR were chosen for
lockPid := 0               ; the running lib\mouse-lock.ahk, or 0
touchGui := "", touchCtrl := "", touchCore := "", touchMsgToken := 0, touchLast := ""
touchSent := ""            ; the last state JSON posted to the page
touchPlace := ""           ; TouchPlacement() the window is at now
touchMonitors := ""        ; the monitor layout it was placed for, to notice a plug or unplug
touchOrder := Map()        ; tile id -> position last shown, so ties keep their place

; ---------------------------------------------------------------------------
; Panel, taskbar and tray
; ---------------------------------------------------------------------------

; Set before the Gui exists: new windows take the tray icon. Missing file keeps the green H.
if FileExist(A_ScriptDir "\alfred.ico")
    try TraySetIcon(A_ScriptDir "\alfred.ico")

panel := Gui("-MaximizeBox", "Switchboard")
panel.SetFont("s10")
; The X minimizes to the taskbar instead of closing. To quit: tray icon > Exit.
panel.OnEvent("Close", (gui) => (gui.Minimize(), true))

STRIP_W := BUTTON_W + 4 + PAUSE_W
; `…Ctl`: DbStrip() and MainStrip() are helpers, and names are case-insensitive.
dbStripCtl := panel.AddText("w" STRIP_W " h" STRIP_H " 0x200", "db: …")
dbStripLook := ""
mainStripCtl := panel.AddText("w" (STRIP_W - 80) " h" STRIP_H " 0x200", "main: …")
gitButton := panel.AddButton("w76 h" STRIP_H, "Refresh git")
gitButton.OnEvent("Click", (*) => RefreshGit())
orphanStripCtl := panel.AddText("w" STRIP_W " h" (STRIP_H * 2), "")

A_TrayMenu.Insert("1&", "Show panel", (*) => ShowSwitchboard())
A_TrayMenu.Default := "Show panel"
A_TrayMenu.ClickCount := 1
A_TrayMenu.Insert("2&", LOCK_ITEM, (*) => SetMouseLock(!mouseLockOn))
A_TrayMenu.Insert("3&")
; Only when the panel is the script being run, so smoke-test.ahk never fences the real pointer.
if A_LineFile = A_ScriptFullPath {
    OnExit((*) => StopLock())
    SetMouseLock(mouseLockOn)
}

; The taskbar "progress bar" tints the panel's taskbar button: 4 red, 8 yellow, 2 green.
taskbar := ComObject("{56FDF344-FD6D-11d0-958A-006097C9A090}", "{ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf}")
ComCall(3, taskbar)        ; HrInit

OnMessage(0x200, ShowStepTip)   ; WM_MOUSEMOVE
; A new taskbar button (Explorer restarted, or the window was recreated) has no colour: re-apply it.
OnMessage(DllCall("RegisterWindowMessage", "str", "TaskbarButtonCreated", "uint"), TaskbarButtonCreated)

Refresh()
; One taskbar button: the touch window's, or the old panel's with touchui=0. Test
; scripts that include this file always get the old panel.
if A_LineFile = A_ScriptFullPath && TOUCH_UI
    OpenTouchWindow()
else
    panel.Show("AutoSize")
lastTaskbar := -1
Refresh()                  ; again, now the taskbar button exists
SetTimer(Refresh, 1000)
SetTimer(Blink, 500)

; ---------------------------------------------------------------------------
; Sessions
; ---------------------------------------------------------------------------

Checkouts() {
    list := [["main", REPO]]
    names := ""
    Loop Files REPO "\.claude\worktrees\*", "D"
        if IsWorktreeDir(A_LoopFileFullPath)
            names .= A_LoopFileName "`n"
    for name in StrSplit(Sort(Trim(names, "`n")), "`n")
        if name != ""
            list.Push([name, REPO "\.claude\worktrees\" name])
    return list
}

; Add buttons for new worktrees, hide those whose folder has gone, and lay out
; the buttons, the chat rows and the strips again when either list changes.
Sync() {
    global order, shownRows
    fresh := [], seen := Map()
    for pair in Checkouts() {
        code := pair[1], seen[code] := true, fresh.Push(code)
        if !sessions.Has(code)
            sessions[code] := NewSession(code, pair[2])
    }
    for code in sessions.Clone()
        if !seen.Has(code) {
            controls[code].Visible := false
            pauseButtons[code].Visible := false
            sessions.Delete(code)
        }
    if JoinCodes(fresh) != JoinCodes(order)
        order := fresh, shownRows := -1
}

Layout(rows) {
    global shownRows, needsResize
    x := panel.MarginX, y := panel.MarginY
    for code in order {
        controls[code].Move(x, y, BUTTON_W, BUTTON_H)
        pauseButtons[code].Move(x + BUTTON_W + 4, y, PAUSE_W, BUTTON_H)
        controls[code].Visible := true
        pauseButtons[code].Visible := true
        y += BUTTON_H + GAP
    }
    for i, row in chatRows {
        row.Visible := i <= rows
        if i <= rows
            row.Move(x, y, STRIP_W, CHAT_ROW_H), y += CHAT_ROW_H + GAP
    }
    dbStripCtl.Move(x, y), y += STRIP_H + 2
    mainStripCtl.Move(x, y), gitButton.Move(x + STRIP_W - 76, y), y += STRIP_H + 2
    orphanStripCtl.Move(x, y)
    shownRows := rows, needsResize := true
}

JoinCodes(list) {
    s := ""
    for c in list
        s .= c "|"
    return s
}

NewSession(code, root) {
    if !controls.Has(code) {
        ctrl := panel.AddText("Hidden Center Border w" BUTTON_W " h" BUTTON_H, code)
        ctrl.OnEvent("Click", ButtonClick.Bind(code))
        ctrl.OnEvent("ContextMenu", ButtonMenu.Bind(code))
        controls[code] := ctrl
        tipFor[ctrl.Hwnd] := code
        btn := panel.AddButton("Hidden w" PAUSE_W " h" BUTTON_H, "Pause")
        btn.OnEvent("Click", PauseClick.Bind(code))
        pauseButtons[code] := btn
    }
    SplitPath(root, &folder)
    lastClick := IniRead(SETTINGS_INI, "lastclick", code, "")
    if lastClick = "" {
        ; First sight: reports written before the panel knew this session count as read.
        lastClick := A_Now
        IniWrite(lastClick, SETTINGS_INI, "lastclick", code)
    }
    return {
        code: code, root: root, folder: folder,
        statusFile: root "\.clip\session-status.json",
        reportFile: root "\.clip\last-report.md",
        reportMetaFile: root "\.clip\last-report.json",
        raw: "", hasStatus: false,
        state: "", since: "", red: false, project: "", transcript: "", sessionId: "", runTag: "",
        metaRaw: "", reportTag: "", reportAt: "",
        tKey: "", interruptAt: "",
        kind: "", color: "", label: "", step: "",
        unseen: false, flashes: 0, free: false, painted: "", hasChat: false, pausedAt: "",
        misses: CLOSED_AFTER - 1, closed: false,   ; the first poll decides at once
        lastClick: lastClick, unread: false,
        gitDirty: true, changed: "", ahead: "",     ; git runs on the first poll
        gitWatch: GitWatchFiles(code), gitKey: "",
        paused: IniRead(SETTINGS_INI, "paused", code, 0) = 1,
        vscodeTitle: IniRead(SETTINGS_INI, "vscode", code, ""),
        chromeTitle: IniRead(SETTINGS_INI, "chrome", code, ""),
        chatLink: IniRead(SETTINGS_INI, "chatlink", code, ""),
        chatLinkFor: IniRead(SETTINGS_INI, "chatlinkcode", code, ""),
    }
}

; Re-read the status file. Returns true when its content changed. The file is
; read every poll rather than by modified time, which only has 1 s resolution.
ReadStatus(s) {
    try text := FileRead(s.statusFile, "UTF-8")
    catch {
        if !FileExist(s.statusFile)
            s.hasStatus := false, s.raw := ""
        return false       ; missing, or mid-rename: try again next second
    }
    if text == s.raw
        return false
    try data := JSON.parse(text)
    catch
        return false       ; half-written: try again next second
    s.raw := text, s.hasStatus := true
    s.state := data.Get("state", ""), s.since := data.Get("since", "")
    s.red := !!data.Get("red", 0), s.project := data.Get("project", "")
    s.transcript := data.Get("transcript_path", ""), s.sessionId := data.Get("session_id", "")
    s.runTag := data.Get("run_tag", "")
    return true
}

; .clip\last-report.json, written by clip.mjs: the last report's run tag and push time.
ReadReportMeta(s) {
    try text := FileRead(s.reportMetaFile, "UTF-8")
    catch {
        if !FileExist(s.reportMetaFile)
            s.metaRaw := "", s.reportTag := "", s.reportAt := ""
        return
    }
    if text == s.metaRaw
        return
    try data := JSON.parse(text)
    catch
        return
    s.metaRaw := text, s.reportTag := data.Get("run_tag", ""), s.reportAt := data.Get("pushed_at", "")
}

; Approval or processing with an interrupt line after `since` shows as waiting.
; Only the transcript's tail is read, and only when its size has changed.
CheckInterrupt(s) {
    if !s.hasStatus || !(s.state = "approval" || s.state = "processing") || s.transcript = "" {
        s.interruptAt := "", s.tKey := ""
        return
    }
    try size := FileGetSize(s.transcript)
    catch
        return
    key := size "|" s.since
    if key = s.tKey
        return
    s.tKey := key
    try {
        f := FileOpen(s.transcript, "r", "UTF-8")
        f.Pos := Max(0, f.Length - TAIL_BYTES)
        tail := f.Read()
        f.Close()
    } catch
        return
    s.interruptAt := FindInterrupt(tail, s.since)
}

; ---------------------------------------------------------------------------
; Strips: claims, main's project, git counts, orphans
; ---------------------------------------------------------------------------

; Parsed only when the text changes; a failed parse is retried once, then the
; last good state is kept.
ReadClaims() {
    global claimsRaw, claimsState
    Loop 2 {
        try text := FileRead(CLAIMS_FILE, "UTF-8")
        catch
            return
        if text == claimsRaw
            return
        try {
            parsed := JSON.parse(text)
            claimsState := Map("claims", parsed.Get("claims", []), "reservations", parsed.Get("reservations", []))
            claimsRaw := text
            return
        }
        Sleep(50)
    }
}

MainCode() {
    try return JSON.parse(FileRead(BINDING_FILE, "UTF-8")).Get("code", "")
    return ""
}

; Hidden git, output through a file in %TEMP%. --no-optional-locks keeps
; `status` from refreshing the index, so the panel writes nothing in the repo.
GitCounts(s) {
    out := A_Temp "\claude-sessions-git.txt"
    s.gitDirty := false
    try {
        RunWait(A_ComSpec ' /c git --no-optional-locks -C "' s.root '" status --porcelain > "' out '" 2>nul', , "Hide")
        s.changed := CountLines(FileRead(out))
        if s.code = "main" {
            RunWait(A_ComSpec ' /c git --no-optional-locks -C "' s.root '" rev-list --count origin/main..main > "' out '" 2>nul', , "Hide")
            s.ahead := Integer(Trim(FileRead(out), " `r`n") || 0)
        }
    }
}

; Files whose change means the counts are stale even though no status file
; changed: a commit, merge or reset moves logs\HEAD, a push or fetch moves
; origin/main's log, and gitpush Finish on main clears the binding.
GitWatchFiles(code) => code = "main"
    ? [BINDING_FILE, REPO "\.git\logs\HEAD", REPO "\.git\logs\refs\remotes\origin\main"]
    : [REPO "\.git\worktrees\" code "\logs\HEAD"]

RefreshGit() {
    for code in order
        sessions[code].gitDirty := true
    Refresh()
}

NewestStamp(files) {
    newest := ""
    for f in files
        try {
            t := FileGetTime(f, "M")
            if newest = "" || t > newest   ; a number > "" is a type error in v2
                newest := t
        }
    return newest
}

PaintStrips() {
    global dbStripLook
    db := DbStrip(claimsState["claims"], A_NowUTC)
    if dbStripCtl.Text != db.text
        dbStripCtl.Text := db.text
    look := db.red ? "cC00000" : "c000000"
    if look != dbStripLook
        dbStripCtl.Opt(look), dbStripLook := look, dbStripCtl.Redraw()
    mainText := MainStrip(mainProject)
    if mainStripCtl.Text != mainText
        mainStripCtl.Text := mainText

    worktrees := [], activity := Map()
    for code in order
        if code != "main" {
            worktrees.Push(code)
            activity[code] := NewestStamp([sessions[code].statusFile, sessions[code].reportFile
                , REPO "\.git\worktrees\" code "\index"])
        }
    list := Orphans(claimsState["claims"], claimsState["reservations"], worktrees, activity, A_Now)
    text := ""
    for o in list
        text .= (text = "" ? "orphans: " : ", ") o
    if orphanStripCtl.Text != text
        orphanStripCtl.Text := text
}

; ---------------------------------------------------------------------------
; Windows
; ---------------------------------------------------------------------------

ListWindows(criteria) {
    found := []
    for hwnd in WinGetList(criteria)
        try found.Push({hwnd: hwnd, title: WinGetTitle(hwnd)})
    return found
}

FindCodeWindow(s, windows := "") {
    if !IsObject(windows)
        windows := listCodeWindows()
    return FirstMatch(windows, CodeTitleMatches.Bind(s.folder, s.vscodeTitle))
}

FindChromeWindow(s) => FirstMatch(listChromeWindows(), ChromeTitleMatches.Bind(ChatCode(s.code, mainProject), s.chromeTitle))

; VS Code maximized on monitor 1, the claude.ai chat on monitor 2. The chat's tab
; is found by its saved address through the bridge when tabs.json is fresh;
; otherwise by window title, and with no match a saved chat link opens in a new window.
; The keyboard goes to the window that needs Alex: VS Code for red and a working
; CLI, otherwise the chat, with the cursor in its message box.
Arrange(s) {
    UpdateAppMonitors()
    toCode := FocusTarget(s.color, s.label) = "code"
    codeHwnd := FindCodeWindow(s)
    if codeHwnd
        placeWindow(codeHwnd, VS_MONITOR)
    ; Only orange types, and the extension decides from the live page (Send cli).
    chromeHwnd := ArrangeChrome(s, !toCode, s.color = "orange" ? "sendcli" : "focus")
    if toCode && codeHwnd
        activateWindow(codeHwnd)
    PointTo(toCode ? codeHwnd : chromeHwnd)
}

; Returns the Chrome window it placed, or 0.
ArrangeChrome(s, composer, action := "focus") {
    if hwnd := BridgeArrange(s, composer, action)
        return hwnd
    if hwnd := FindChromeWindow(s) {
        SaveLinkFrom(s, hwnd)
        placeWindow(hwnd, CHROME_MONITOR)
        return hwnd
    }
    if s.chatLink = ""
        return 0
    before := Map()
    for w in listChromeWindows()
        before[w.hwnd] := true
    Run('chrome.exe --new-window "' s.chatLink '"')
    deadline := A_TickCount + 10000
    while A_TickCount < deadline {
        Sleep(250)
        for w in listChromeWindows()
            if !before.Has(w.hwnd) && w.title != "" {
                placeWindow(w.hwnd, CHROME_MONITOR)
                return w.hwnd
            }
    }
    return 0
}

; The mouse pointer follows the keyboard, so scrolling works where Alex types.
; [panel] pointer=0 in settings.ini turns it off.
PointTo(hwnd) {
    if hwnd && POINTER_FOLLOWS
        pointerMover(hwnd)
}

; Centre of the window, in physical screen pixels on any monitor: both calls run
; per-monitor DPI aware, so a scaled monitor does not skew the position.
MovePointerTo(hwnd) {
    old := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    try {
        WinGetPos(&x, &y, &w, &h, "ahk_id " hwnd)
        c := WindowCentre(x, y, w, h)
        DllCall("SetCursorPos", "int", c.x, "int", c.y)
    }
    DllCall("SetThreadDpiAwarenessContext", "ptr", old, "ptr")
}

; Save the matched window's chat address as this session's link. Only for an
; automatic title match, only a https://claude.ai/chat/ address, and any
; failure saves nothing and lets the click carry on.
SaveLinkFrom(s, hwnd) {
    if s.chromeTitle != ""
        return
    try {
        link := AutoSaveLink(s.chromeTitle, chromeAddressReader(hwnd))
        if link != "" && link != s.chatLink
            SaveChatLink(s, link, ChatCode(s.code, mainProject))
    }
}

; Save a chat link with the project code it belongs to; "" removes both.
SaveChatLink(s, link, project) {
    s.chatLink := link, s.chatLinkFor := link = "" ? "" : project
    if link = "" {
        IniDelete(SETTINGS_INI, "chatlink", s.code)
        IniDelete(SETTINGS_INI, "chatlinkcode", s.code)
    } else {
        IniWrite(link, SETTINGS_INI, "chatlink", s.code)
        IniWrite(project, SETTINGS_INI, "chatlinkcode", s.code)
    }
}

; Monitors in physical pixels, so the touch screen reads as 1024x600 on any scaling.
PhysicalMonitors() {
    old := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    list := MonitorRects()
    DllCall("SetThreadDpiAwarenessContext", "ptr", old, "ptr")
    return list
}

; VS Code on the leftmost monitor that is not the touch screen, Chrome on the rightmost:
; re-chosen when monitors are plugged in or out, which can renumber them.
UpdateAppMonitors() {
    global VS_MONITOR, CHROME_MONITOR, appMonitorsFor
    mons := listMonitors()
    shape := ToJson(mons)     ; not `layout`: Layout() is the old panel's
    if shape == appMonitorsFor
        return
    apps := AppMonitors(mons)
    VS_MONITOR := apps.code, CHROME_MONITOR := apps.chrome, appMonitorsFor := shape
}

PutOnMonitor(hwnd, monitor) {
    monitor := Min(monitor, MonitorGetCount())
    try {
        WinRestore(hwnd)
        MonitorGetWorkArea(monitor, &left, &top, &right, &bottom)
        WinMove(left, top, right - left, bottom - top, hwnd)
        WinMaximize(hwnd)
        WinActivate(hwnd)
    }
}

; Open VS Code on the checkout, wait for its window, then ask the Claude Code
; extension to resume the last conversation. The URI goes to the focused window.
Reopen(s) {
    Run(A_ComSpec ' /c code "' s.root '"', , "Hide")
    deadline := A_TickCount + 30000
    while A_TickCount < deadline {
        Sleep(500)
        if hwnd := FindCodeWindow(s) {
            WinActivate(hwnd)
            if (uri := ResumeUri(s.sessionId)) != "" {
                Sleep(3000)    ; let the extension start before it gets the URI
                WinActivate(hwnd)
                Run(uri)
            }
            return
        }
    }
    MsgBox("No VS Code window for " s.folder " appeared within 30 seconds.", "Switchboard", "Icon!")
}

; ---------------------------------------------------------------------------
; Refresh and painting
; ---------------------------------------------------------------------------

Refresh() {
    global lastTaskbar, needsResize, mainProject
    UpdateAppMonitors()
    Sync()
    ReadClaims()
    mainProject := MainCode()
    offset := DateDiff(A_Now, A_NowUTC, "Minutes") * 60
    codeWindows := listCodeWindows()
    ReadTabs(), ReadChats()
    chatsOk := ChatsFresh()    ; not `chatsFresh` or `colors`: names are case-insensitive
    liveColors := [], tip := "", anyAlert := false, paired := Map()

    for code in order {
        s := sessions[code]
        oldSince := s.since
        if ReadStatus(s)
            s.gitDirty := true
        ReadReportMeta(s)
        gitKey := StampKey(s.gitWatch)
        if gitKey != s.gitKey
            s.gitKey := gitKey, s.gitDirty := true
        if s.gitDirty
            GitCounts(s)
        CheckInterrupt(s)
        s.unread := IsUnread(NewestStamp([s.reportFile]), s.lastClick)
        s.misses := FindCodeWindow(s, codeWindows) ? 0 : s.misses + 1
        s.closed := s.misses >= CLOSED_AFTER
        s.free := IsFree(code, mainProject)
        project := ChatCode(code, mainProject)
        if StaleChatLink(s.chatLink, s.chatLinkFor, project)
            SaveChatLink(s, "", project)
        LearnChatLink(s, project)
        if s.chatLink != ""
            paired[NormaliseUrl(s.chatLink)] := true
        chat := chatsOk ? FindTabByLink(chatsList, s.chatLink) : ""
        s.hasChat := chat != ""
        kind := KindOf(s.hasStatus, s.state, s.red, s.interruptAt != "")
        ; A paused session that starts processing again is unpaused at once.
        if s.paused && kind = "processing" && (s.kind != "processing" || s.since != oldSince) && s.kind != ""
            SetPaused(s, false)
        s.kind := kind
        issued := chat ? chat.Get("issuedTag", "") : ""
        v := ViewOf({free: s.free, closed: s.closed, paused: s.paused, kind: kind, runTag: s.runTag
            , reportTag: s.reportTag, reportAt: s.reportAt, chatState: chat ? chat.Get("state", "") : ""
            , chatSince: chat ? chat.Get("since", "") : "", issuedTag: issued, project: project})
        if v.color != s.color {
            s.unseen := false
            if ShouldAlert(s.color, v.color)
                s.unseen := true, s.flashes := 0, anyAlert := true
        }
        s.color := v.color, s.label := v.label, s.step := StepText(s.runTag, issued, project)
        Paint(s, offset)
        if !s.paused && !s.closed && !s.free
            liveColors.Push(s.color)
        tip .= code ": " (s.free ? "free" : s.closed ? "closed" : s.paused ? "paused" : s.label) "`n"
    }
    anyAlert := RefreshChatRows(chatsOk ? chatsList : [], paired, liveColors) || anyAlert
    PaintStrips()

    A_IconTip := SubStr(Trim(tip, "`n"), 1, 127)

    flag := TaskbarFlag(liveColors)
    if flag != lastTaskbar {
        if flag
            ComCall(9, taskbar, "ptr", TaskbarGui().Hwnd, "int64", 100, "int64", 100)  ; fill the bar
        ComCall(10, taskbar, "ptr", TaskbarGui().Hwnd, "int", flag)                    ; set its colour
        lastTaskbar := flag
    }

    if needsResize && WinExist("ahk_id " panel.Hwnd) && WinGetMinMax(panel.Hwnd) != -1 {
        panel.Show("AutoSize NoActivate")
        needsResize := false
    }
    if anyAlert
        Alert()
    TouchSend()
}

Label(s, offset) {
    name := ButtonName(s.code, mainProject)
    if s.unread
        name .= "   • new"
    if s.changed != "" && s.changed > 0
        name .= "   ±" s.changed
    if s.ahead != "" && s.ahead > 0
        name .= "   ↑" s.ahead
    if s.free
        return name "`nfree"
    if s.kind = "none"
        return name "`nno status"
    processing := s.kind = "processing" && !s.closed
    time := s.interruptAt != "" ? "interrupted " FormatEntered(s.interruptAt, offset)
        : processing ? FormatElapsed(DateDiff(A_NowUTC, IsoToStamp(s.since), "Seconds"))
        : FormatEntered(s.since, offset)
    if s.closed || s.paused
        return name "`n" (s.closed ? "closed · " : "") (s.paused ? "paused · " : "")
            . (s.interruptAt != "" ? "" : s.state " ") time
    ; "s9 -> s10 · Paste prompt · 10:45": the run-tag step, what to do, and when.
    return name "`n" (s.step != "" ? s.step " · " : "") s.label " · " time
}

Paint(s, offset := "") {
    if offset = ""
        offset := DateDiff(A_Now, A_NowUTC, "Minutes") * 60
    ctrl := controls[s.code]
    color := s.unseen && blinkOn && StillFlashing(s.flashes) ? BLINK_COLOR : COLORS.Get(s.color, COLORS["none"])
    look := color (InStr("|" DIM_COLORS "|", "|" s.color "|") ? " c707070" : " c000000")
    if look != s.painted {
        ctrl.Opt("Background" look)
        s.painted := look
        ctrl.Redraw()
    }
    text := Label(s, offset)
    if ctrl.Text != text
        ctrl.Text := text
    btnText := s.paused ? "Resume" : "Pause"
    if pauseButtons[s.code].Text != btnText
        pauseButtons[s.code].Text := btnText
}

Blink() {
    global blinkOn := !blinkOn
    for code in order {
        s := sessions[code]
        if !s.unseen
            continue
        ; A flash is counted as it goes dark, so a colour lights exactly five times.
        if !blinkOn && StillFlashing(s.flashes)
            s.flashes++
        Paint(s)
    }
    for i, tabId in rowTabs {
        r := rowState[tabId]
        if !r.unseen
            continue
        if !blinkOn && StillFlashing(r.flashes)
            r.flashes++
        PaintRow(i, r)
    }
}

; ---------------------------------------------------------------------------
; Unpaired claude.ai chats
; ---------------------------------------------------------------------------

; One row per chat no session is paired with. Returns true when one turns to an
; attention colour. Adds the rows' colours to `colors` for the taskbar.
RefreshChatRows(chats, paired, liveColors) {
    global rowTabs
    shown := [], rowAlert := false, live := Map()
    for c in chats {
        if !IsObject(c) || paired.Has(NormaliseUrl(c.Get("url", ""))) || shown.Length >= CHAT_ROWS_MAX
            continue
        tabId := c.Get("tabId", "")
        v := ChatRowView(c.Get("state", ""), c.Get("since", ""), c.Get("viewedAt", ""))
        if !rowState.Has(tabId)
            rowState[tabId] := {color: "", unseen: false, flashes: 0, painted: "", text: "", row: 0, title: "", label: ""}
        r := rowState[tabId]
        if v.color != r.color {
            r.unseen := false
            if ShouldAlert(r.color, v.color)
                r.unseen := true, r.flashes := 0, rowAlert := true
            r.color := v.color
        }
        r.title := ChatRowTitle(c.Get("title", "")), r.label := v.label
        r.text := r.title "`n" v.label
        live[tabId] := true
        shown.Push(tabId)
        if r.color != "grey"
            liveColors.Push(r.color)
    }
    for tabId in rowState.Clone()
        if !live.Has(tabId)
            rowState.Delete(tabId)
    while chatRows.Length < shown.Length {
        row := panel.AddText("Hidden Center Border w" STRIP_W " h" CHAT_ROW_H, "")
        row.OnEvent("Click", ChatRowClick.Bind(chatRows.Length + 1))
        chatRows.Push(row)
    }
    rowTabs := shown
    if shown.Length != shownRows
        Layout(shown.Length)
    for i, tabId in shown {
        r := rowState[tabId]
        if r.row != i                     ; this chat moved to another row
            r.row := i, r.painted := ""
        PaintRow(i, r)
    }
    return rowAlert
}

ChatRowTitle(title) {
    title := RegExReplace(title, "\s+-\s+Claude$")
    return StrLen(title) > 44 ? SubStr(title, 1, 43) "…" : title
}

PaintRow(i, r) {
    row := chatRows[i]
    color := r.unseen && blinkOn && StillFlashing(r.flashes) ? BLINK_COLOR : COLORS.Get(r.color, COLORS["grey"])
    look := color (r.color = "grey" ? " c707070" : " c000000")
    if look != r.painted
        row.Opt("Background" look), r.painted := look, row.Redraw()
    if row.Text != r.text
        row.Text := r.text
}

ChatRowClick(i, *) {
    if i > rowTabs.Length
        return
    r := rowState[rowTabs[i]]
    r.unseen := false
    PaintRow(i, r)
    PointTo(FocusAndPlace(rowTabs[i], true))
}

; With no saved link and no typed Chrome title, save the address of a claude.ai
; chat tab, in any window, whose title carries the project code.
LearnChatLink(s, project) {
    if s.chatLink != "" || s.chromeTitle != "" || s.free || !TabsFresh()
        return
    link := FindChatLinkByCode(tabsList, project)
    if link != ""
        SaveChatLink(s, link, project)
}

; Hovering a session button shows "Step N of M: <name>" from its progress file.
ShowStepTip(wParam, lParam, msg, hwnd) {
    static last := 0
    if hwnd = last
        return
    last := hwnd
    if !tipFor.Has(hwnd) || !sessions.Has(tipFor[hwnd]) {
        ToolTip()
        return
    }
    s := sessions[tipFor[hwnd]]
    text := ""
    try text := ProgressSummary(FileRead(s.root "\docs\progress-" ProjectName(ChatCode(s.code, mainProject)) ".md", "UTF-8"))
    ToolTip(text = "" ? "" : text)
}

; The window that owns Switchboard's one taskbar button: the touch window when it
; exists, otherwise the old panel.
TaskbarGui() => touchGui != "" ? touchGui : panel

; Not SetTimer(Refresh, -10): that would turn the 1 s timer into a one-shot.
TaskbarButtonCreated(*) {
    global lastTaskbar := -1    ; the next Refresh sets the colour again
}

; Tray > Show panel: bring whichever window is in use to the front.
ShowSwitchboard() {
    g := TaskbarGui()
    g.Show(g = panel ? "" : "NoActivate")
    try WinActivate(g.Hwnd)
}

; A session finished or needs you: bring the window forward without taking
; focus, and flash its taskbar button until it comes to the front.
Alert() {
    g := TaskbarGui()
    DllCall("ShowWindow", "ptr", g.Hwnd, "int", 4)   ; SW_SHOWNOACTIVATE
    g.Opt("+AlwaysOnTop")
    g.Opt("-AlwaysOnTop")
    fi := Buffer(A_PtrSize = 8 ? 32 : 20, 0)
    NumPut("uint", fi.Size, fi, 0)
    NumPut("ptr", g.Hwnd, fi, A_PtrSize)
    NumPut("uint", 0x2 | 0xC, "uint", 0, "uint", 0, fi, A_PtrSize * 2)
    DllCall("FlashWindowEx", "ptr", fi)
}

; ---------------------------------------------------------------------------
; Clicks
; ---------------------------------------------------------------------------

ButtonClick(code, *) {
    if !sessions.Has(code)
        return
    s := sessions[code]
    s.lastClick := A_Now, s.unread := false
    IniWrite(s.lastClick, SETTINGS_INI, "lastclick", code)
    if s.closed {
        Paint(s)
        if MsgBox("No VS Code window is open for " s.folder ".`n`nReopen it and resume its last conversation?"
            , "Switchboard", "YesNo Icon?") = "Yes"
            Reopen(s)
        return
    }
    s.unseen := false
    Paint(s)
    arrangeAction(s)
}

PauseClick(code, *) {
    if sessions.Has(code)
        SetPaused(sessions[code], !sessions[code].paused)
}

ButtonMenu(code, *) {
    if !sessions.Has(code)
        return
    s := sessions[code]
    m := Menu()
    m.Add(s.paused ? "Resume" : "Pause", (*) => SetPaused(s, !s.paused))
    if s.closed
        m.Add("Reopen VS Code", (*) => Reopen(s))
    m.Add()
    m.Add("VS Code title text…", (*) => EditTitle(s, "vscode", "VS Code", "vscodeTitle"))
    m.Add("Chrome title text…", (*) => EditTitle(s, "chrome", "Chrome", "chromeTitle"))
    m.Add("Save chat link…", (*) => EditChatLink(s))
    m.Add()
    m.Add(LOCK_ITEM, (*) => SetMouseLock(!mouseLockOn))
    if mouseLockOn
        m.Check(LOCK_ITEM)
    m.Show()
}

; ---------------------------------------------------------------------------
; Mouse lock: lib\mouse-lock.ahk runs as its own process (spec, "Mouse lock")
; ---------------------------------------------------------------------------

SetMouseLock(on) {
    global mouseLockOn := on
    IniWrite(on ? 1 : 0, SETTINGS_INI, "panel", "mouselock")
    on ? StartLock() : StopLock()
    on ? A_TrayMenu.Check(LOCK_ITEM) : A_TrayMenu.Uncheck(LOCK_ITEM)
}

; Passes this process's ID, so the lock exits if the panel dies without closing it.
StartLock() {
    global lockPid
    if lockPid && ProcessExist(lockPid)
        return
    try Run('"' A_AhkPath '" "' A_ScriptDir '\lib\mouse-lock.ahk" ' ProcessExist(), , , &pid)
    catch
        pid := 0
    lockPid := pid
}

; WM_CLOSE lets the lock run its OnExit and release the clip; killing it is the fallback.
StopLock() {
    global lockPid
    if !lockPid
        return
    DetectHiddenWindows(true)
    try WinClose("ahk_pid " lockPid " ahk_class AutoHotkey")
    if ProcessWaitClose(lockPid, 2)
        ProcessClose(lockPid)
    lockPid := 0
}

; ---------------------------------------------------------------------------
; Touch window ([panel] touchui=1): a borderless WebView2 window showing
; ui\switchboard.html, docked on the touch screen or centred on the main screen
; ([panel] touchmode=touch|main, remembered). The old panel is untouched.
; ---------------------------------------------------------------------------

OpenTouchWindow() {
    global touchGui
    ; Created per-monitor DPI aware, so its size and position are physical pixels.
    old := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    ; -Caption: no title bar or border. WS_EX_APPWINDOW (0x40000) keeps a taskbar button.
    touchGui := Gui("-Caption -DPIScale +E0x40000", "Switchboard touch")
    touchGui.BackColor := "1C222C"
    DllCall("SetThreadDpiAwarenessContext", "ptr", old, "ptr")
    PlaceTouchWindow()
    WebView2.CreateControllerAsync(touchGui.Hwnd, 0, TOUCH_DATA_DIR, "", PANEL_DIR "\lib\webview2\WebView2\64bit\WebView2Loader.dll")
        .then(TouchReady, TouchFailed)
}

; Docked or centred on the main screen, per the remembered mode and what is plugged in.
PlaceTouchWindow() {
    global touchPlace, touchMonitors
    old := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    try {
        mons := MonitorRects(), primary := MonitorGetPrimary()
        touchMonitors := ToJson(mons)
        touchPlace := TouchPlacement(mons, TOUCH_MODE, primary, MonitorScale(mons[primary]))
        pos := "NoActivate x" touchPlace.x " y" touchPlace.y " w" touchPlace.w " h" touchPlace.h
        ; Twice: crossing to a monitor with another DPI can resize it on the first move.
        touchGui.Show(pos), touchGui.Show(pos)
    }
    DllCall("SetThreadDpiAwarenessContext", "ptr", old, "ptr")
    if touchCtrl != "" {
        try touchCtrl.Fill(), touchCtrl.ZoomFactor := touchPlace.zoom
    }
    TouchSend()
}

; DPI scale of the monitor with this rect: 1 at 96 dpi. Call per-monitor aware.
MonitorScale(m) {
    hmon := DllCall("MonitorFromPoint", "int64", ((m.t + 1) << 32) | ((m.l + 1) & 0xFFFFFFFF), "uint", 2, "ptr")
    dpi := 96, dpiY := 96
    try DllCall("shcore\GetDpiForMonitor", "ptr", hmon, "int", 0, "uint*", &dpi, "uint*", &dpiY)
    return dpi / 96
}

; The top bar: to the main screen and back. Undocking puts the pointer in its middle.
TouchMove() {
    global TOUCH_MODE
    if touchGui = ""
        return
    present := TouchMonitor(MonitorRects()) != 0
    next := NextTouchMode(touchPlace = "" ? TOUCH_MODE : touchPlace.mode, present)
    TOUCH_MODE := next
    IniWrite(next, SETTINGS_INI, "panel", "touchmode")
    PlaceTouchWindow()
    if touchPlace.mode = "main" {
        WinActivate(touchGui.Hwnd)
        pointerMover(touchGui.Hwnd)
    }
}

TouchReady(ctrl) {
    global touchCtrl := ctrl, touchCore := ctrl.CoreWebView2, touchMsgToken
    s := touchCore.Settings
    for name in ["AreDefaultContextMenusEnabled", "IsZoomControlEnabled", "IsStatusBarEnabled", "IsPinchZoomEnabled", "IsSwipeNavigationEnabled"]
        try s.%name% := false
    touchMsgToken := touchCore.add_WebMessageReceived(TouchMessage)
    ; ui\ served as https://switchboard.ui/, so the page and its font load with no internet.
    touchCore.SetVirtualHostNameToFolderMapping("switchboard.ui", PANEL_DIR "\ui", 1)
    touchCore.Navigate("https://switchboard.ui/switchboard.html")
    try ctrl.ZoomFactor := touchPlace.zoom
}

; Falls back to the old panel, so there is always one Switchboard window and taskbar button.
TouchFailed(err) {
    global touchGui, lastTaskbar
    try touchGui.Destroy()
    touchGui := "", lastTaskbar := -1
    panel.Show("AutoSize")
    MsgBox("The touch window's WebView2 did not start, so Switchboard is using the old panel.`n`n"
        . (err is Error ? err.Message : String(err)), "Switchboard", "Icon! T60")
}

; Page -> AutoHotkey: {"type": "ready"|"tap"|"hold"|"git"|"move"|"menu", "id": tile id}.
TouchMessage(core, args) {
    global touchLast, touchSent
    try msg := JSON.parse(args.TryGetWebMessageAsString())
    catch
        return
    touchLast := msg.Get("type", "")
    if touchLast = "ready"
        touchSent := "", TouchSend()
    else    ; on its own thread: Arrange can wait seconds or show a dialog, never inside WebView2's callback
        SetTimer(TouchDo.Bind(touchLast, msg.Get("id", "")), -1)
}

; Exactly what the old panel's controls do: the button, its chat row, Pause/Resume, Refresh git.
TouchDo(type, id) {
    c := TouchCommand(type, id)
    switch c.do {
        case "click":
            if sessions.Has(c.key)
                ButtonClick(c.key)
        case "chat":
            for i, tabId in rowTabs
                if tabId = c.key {
                    ChatRowClick(i)
                    break
                }
        case "pause": PauseClick(c.key)
        case "git":
            RefreshGit()
            try touchCore.PostWebMessageAsJson('{"type":"gitDone"}')   ; the button goes back to its icon
        case "move": TouchMove()
        case "menu":       ; right-click: main screen mode only, the old button's menu
            if touchPlace != "" && touchPlace.mode = "main" && sessions.Has(c.key)
                ButtonMenu(c.key)
    }
    TouchSend()
}

; AutoHotkey -> page: the whole state, posted only when it differs from the last one.
; Also re-places the window when a monitor is plugged in or out.
TouchSend() {
    global touchSent
    if touchGui != "" && touchMonitors != "" {
        old := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
        changed := ToJson(MonitorRects()) != touchMonitors
        DllCall("SetThreadDpiAwarenessContext", "ptr", old, "ptr")
        if changed
            return PlaceTouchWindow()     ; which sends
    }
    if touchCore = ""
        return
    text := ToJson(TouchState())
    if text == touchSent
        return
    try touchCore.PostWebMessageAsJson(text), touchSent := text
}

; Everything the page draws, already sorted. The page keeps no state but its scroll.
TouchState() {
    global touchOrder
    tiles := [], now := A_Now, nowUtc := A_NowUTC
    worktrees := []
    for code in order {
        s := sessions[code]
        stamp := s.since != "" ? IsoToStamp(s.since) : nowUtc
        action := CliAction({color: s.color, label: s.label, kind: s.kind, free: s.free, closed: s.closed
            , paused: s.paused, elapsed: DateDiff(nowUtc, stamp, "Seconds")
            , age: DateDiff(nowUtc, s.paused && s.pausedAt != "" ? s.pausedAt : stamp, "Minutes")})
        git := (s.changed != "" && s.changed > 0 ? "±" s.changed : "")
        git .= (s.ahead != "" && s.ahead > 0 ? (git = "" ? "" : " ") "↑" s.ahead : "")
        idle := 0
        if code != "main" {
            worktrees.Push(code)
            idle := IdleDays(NewestStamp([s.statusFile, s.reportFile, REPO "\.git\worktrees\" code "\index"]), now)
        }
        ; Paused is grey at once; s.color only catches up on the next Refresh.
        if idle                ; on the action line, so the bottom line keeps the git counts
            action .= " · idle " idle "d"
        tiles.Push({id: "cli:" code, kind: "cli", icon: TileIcon("cli", s.hasChat), group: s.paused ? 2 : 0, color: s.paused ? "paused" : TileColor(s.color)
            , name: TileName(code, mainProject), action: action, step: TileStep(s.step), git: git, note: ""})
    }
    for tabId in rowTabs {
        r := rowState[tabId]
        tiles.Push({id: "chat:" tabId, kind: "chat", icon: TileIcon("chat", false), group: 1, color: TileColor(r.color), name: r.title
            , action: ChatAction(r.label), step: "", git: "", note: ""})
    }
    for o in OrphanOwners(claimsState["claims"], claimsState["reservations"], worktrees)
        tiles.Push({id: "orphan:" o.owner, kind: "orphan", icon: TileIcon("orphan", false), group: 3, color: "grey", name: o.owner
            , action: "No worktree", step: "", git: "", note: o.n " held"})
    tiles := TileSort(tiles, touchOrder)
    touchOrder := Map()
    for i, t in tiles
        touchOrder[t.id] := i
    db := DbStrip(claimsState["claims"], nowUtc)
    return {type: "state", main: MainStrip(mainProject), db: db.text, dbRed: db.red ? 1 : 0, tiles: tiles
        , mode: touchPlace = "" ? "touch" : touchPlace.mode, noTouch: touchPlace = "" ? 0 : touchPlace.noTouch}
}

; Blank clears the override, and matching falls back to the folder or project code.
EditTitle(s, section, app, prop) {
    r := InputBox("Text that appears in this session's " app " window title.`nLeave blank to match by "
        . (section = "vscode" ? "folder name (" s.folder ")." : "project code (" ChatCode(s.code, mainProject) ")."),
        s.code " - " app, "w460 h150", s.%prop%)
    if r.Result != "OK"
        return
    s.%prop% := Trim(r.Value)
    if s.%prop% = ""
        IniDelete(SETTINGS_INI, section, s.code)
    else
        IniWrite(s.%prop%, SETTINGS_INI, section, s.code)
}

EditChatLink(s) {
    r := InputBox("claude.ai chat link, opened when no Chrome window matches.`nLeave blank to remove it.",
        s.code " - chat link", "w520 h150", s.chatLink)
    if r.Result != "OK"
        return
    link := Trim(r.Value)
    if link != "" && !IsChatLink(link) {
        MsgBox("That is not a https://claude.ai/ link, so it was not saved.", "Switchboard", "Icon!")
        return
    }
    SaveChatLink(s, link, ChatCode(s.code, mainProject))
}

SetPaused(s, paused) {
    s.paused := paused
    s.pausedAt := paused ? A_NowUTC : ""   ; "Paused 0m" counts from here; after a restart, from the state time
    if paused
        s.unseen := false
    IniWrite(paused ? 1 : 0, SETTINGS_INI, "paused", s.code)
    Paint(s)
}
