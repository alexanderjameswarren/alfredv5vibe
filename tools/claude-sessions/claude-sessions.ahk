#Requires AutoHotkey v2.0
#SingleInstance Force      ; double-clicking the file again replaces the running copy
#Warn                      ; names are case-insensitive: a local `alert` once hid Alert()
Persistent
#Include lib\JSON.ahk
#Include lib\status.ahk
#Include lib\chrome-address.ahk

; Switchboard: one button per Claude Code session on alfred-v5 (main plus each
; worktree), coloured from that checkout's .clip\session-status.json, which the
; repo's hooks write. The panel never writes to the repo. Spec:
; docs\technical-spec-switchboard.md, section 2.

; ---------------------------------------------------------------------------
; Settings (kept outside the repo)
; ---------------------------------------------------------------------------

SETTINGS_DIR := EnvGet("APPDATA") "\claude-sessions"
SETTINGS := SETTINGS_DIR "\settings.ini"
if !DirExist(SETTINGS_DIR)
    DirCreate(SETTINGS_DIR)
REPO := IniRead(SETTINGS, "panel", "repo", "C:\Users\Alex\projects\alfred-v5")
CLAIMS_FILE := REPO "\.git\alfred-claims.json"
BINDING_FILE := REPO "\.git\alfred-project-code.json"

COLORS := Map("processing", "70C070", "waiting", "E8C840", "red", "E06060", "none", "F4F4F4")
PAUSED_COLOR := "C8C8C8"
CLOSED_COLOR := "E4E4E4"
FREE_COLOR := "D4D4D4"     ; main with no project bound
BLINK_COLOR := "FFFFFF"
TAIL_BYTES := 16384        ; how much of a transcript's end is searched for an interrupt
BUTTON_W := 280, BUTTON_H := 44, PAUSE_W := 64, GAP := 6, STRIP_H := 20
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
; Swappable so smoke-test.ahk can run without real windows.
listCodeWindows := ListWindows.Bind("ahk_exe Code.exe")
listChromeWindows := ListWindows.Bind("ahk_exe chrome.exe")
chromeAddressReader := ReadChromeAddress
placeWindow := PutOnMonitor
arrangeAction := Arrange

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

A_TrayMenu.Insert("1&", "Show panel", (*) => panel.Show())
A_TrayMenu.Default := "Show panel"
A_TrayMenu.ClickCount := 1

; The taskbar "progress bar" tints the panel's taskbar button: 4 red, 8 yellow, 2 green.
taskbar := ComObject("{56FDF344-FD6D-11d0-958A-006097C9A090}", "{ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf}")
ComCall(3, taskbar)        ; HrInit

Refresh()
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
        names .= A_LoopFileName "`n"
    for name in StrSplit(Sort(Trim(names, "`n")), "`n")
        if name != ""
            list.Push([name, REPO "\.claude\worktrees\" name])
    return list
}

; Add buttons for new worktrees, hide those whose folder has gone, and put the
; strips under the last button.
Sync() {
    global order, needsResize
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
    if JoinCodes(fresh) != JoinCodes(order) {
        order := fresh
        x := panel.MarginX, y := panel.MarginY
        for code in order {
            controls[code].Move(x, y, BUTTON_W, BUTTON_H)
            pauseButtons[code].Move(x + BUTTON_W + 4, y, PAUSE_W, BUTTON_H)
            controls[code].Visible := true
            pauseButtons[code].Visible := true
            y += BUTTON_H + GAP
        }
        dbStripCtl.Move(x, y), y += STRIP_H + 2
        mainStripCtl.Move(x, y), gitButton.Move(x + STRIP_W - 76, y), y += STRIP_H + 2
        orphanStripCtl.Move(x, y)
        needsResize := true
    }
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
        btn := panel.AddButton("Hidden w" PAUSE_W " h" BUTTON_H, "Pause")
        btn.OnEvent("Click", PauseClick.Bind(code))
        pauseButtons[code] := btn
    }
    SplitPath(root, &folder)
    lastClick := IniRead(SETTINGS, "lastclick", code, "")
    if lastClick = "" {
        ; First sight: reports written before the panel knew this session count as read.
        lastClick := A_Now
        IniWrite(lastClick, SETTINGS, "lastclick", code)
    }
    return {
        code: code, root: root, folder: folder,
        statusFile: root "\.clip\session-status.json",
        reportFile: root "\.clip\last-report.md",
        raw: "", hasStatus: false,
        state: "", since: "", red: false, project: "", transcript: "", sessionId: "",
        tKey: "", interruptAt: "",
        kind: "", unseen: false, flashes: 0, free: false, painted: "",
        misses: CLOSED_AFTER - 1, closed: false,   ; the first poll decides at once
        lastClick: lastClick, unread: false,
        gitDirty: true, changed: "", ahead: "",     ; git runs on the first poll
        gitWatch: GitWatchFiles(code), gitKey: "",
        paused: IniRead(SETTINGS, "paused", code, 0) = 1,
        vscodeTitle: IniRead(SETTINGS, "vscode", code, ""),
        chromeTitle: IniRead(SETTINGS, "chrome", code, ""),
        chatLink: IniRead(SETTINGS, "chatlink", code, ""),
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
    return true
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

; VS Code maximized on monitor 1, the claude.ai chat on monitor 2. With no
; matching Chrome window, a saved chat link opens in a new one.
Arrange(s) {
    if hwnd := FindCodeWindow(s)
        placeWindow(hwnd, VS_MONITOR)
    if hwnd := FindChromeWindow(s) {
        SaveLinkFrom(s, hwnd)
        placeWindow(hwnd, CHROME_MONITOR)
        return
    }
    if s.chatLink = ""
        return
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
                return
            }
    }
}

; Save the matched window's chat address as this session's link. Only for an
; automatic title match, only a https://claude.ai/chat/ address, and any
; failure saves nothing and lets the click carry on.
SaveLinkFrom(s, hwnd) {
    if s.chromeTitle != ""
        return
    try {
        link := AutoSaveLink(s.chromeTitle, chromeAddressReader(hwnd))
        if link != "" && link != s.chatLink {
            s.chatLink := link
            IniWrite(link, SETTINGS, "chatlink", s.code)
        }
    }
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
    Sync()
    ReadClaims()
    mainProject := MainCode()
    offset := DateDiff(A_Now, A_NowUTC, "Minutes") * 60
    codeWindows := listCodeWindows()
    kinds := [], tip := "", anyAlert := false

    for code in order {
        s := sessions[code]
        oldSince := s.since
        if ReadStatus(s)
            s.gitDirty := true
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
        if s.free
            s.unseen := false
        kind := KindOf(s.hasStatus, s.state, s.red, s.interruptAt != "")
        if kind != s.kind {
            if kind = "processing"
                s.unseen := false
            if !s.paused && !s.closed && !s.free && ShouldAlert(s.kind, kind)
                s.unseen := true, s.flashes := 0, anyAlert := true
        }
        ; A paused session that starts processing again is unpaused at once.
        if s.paused && kind = "processing" && (s.kind != "processing" || s.since != oldSince) && s.kind != ""
            SetPaused(s, false)
        s.kind := kind
        Paint(s, offset)
        if !s.paused && !s.closed && !s.free
            kinds.Push(kind)
        tip .= code ": " (s.free ? "free" : s.closed ? "closed" : s.paused ? "paused" : kind) "`n"
    }
    PaintStrips()

    A_IconTip := SubStr(Trim(tip, "`n"), 1, 127)

    flag := TaskbarFlag(kinds)
    if flag != lastTaskbar {
        if flag
            ComCall(9, taskbar, "ptr", panel.Hwnd, "int64", 100, "int64", 100)  ; fill the bar
        ComCall(10, taskbar, "ptr", panel.Hwnd, "int", flag)                    ; set its colour
        lastTaskbar := flag
    }

    if needsResize && WinExist("ahk_id " panel.Hwnd) && WinGetMinMax(panel.Hwnd) != -1 {
        panel.Show("AutoSize NoActivate")
        needsResize := false
    }
    if anyAlert
        Alert()
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
        line := "no status"
    else if s.interruptAt != ""
        line := "interrupted " FormatEntered(s.interruptAt, offset)
    else if s.kind = "processing" && !s.closed
        line := "processing " FormatElapsed(DateDiff(A_NowUTC, IsoToStamp(s.since), "Seconds"))
    else
        line := s.state " " FormatEntered(s.since, offset)
    return name "`n" (s.closed ? "closed · " : "") (s.paused ? "paused · " : "") line
}

Paint(s, offset := "") {
    if offset = ""
        offset := DateDiff(A_Now, A_NowUTC, "Minutes") * 60
    ctrl := controls[s.code]
    color := s.free ? FREE_COLOR
        : s.unseen && blinkOn && !s.paused && !s.closed && StillFlashing(s.kind, s.flashes) ? BLINK_COLOR
        : s.closed ? CLOSED_COLOR
        : s.paused ? PAUSED_COLOR
        : COLORS.Get(s.kind, COLORS["none"])
    look := color (s.paused || s.closed || s.free || s.kind = "none" ? " c707070" : " c000000")
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
        ; A flash is counted as it goes dark, so yellow lights exactly five times.
        if !blinkOn && StillFlashing(s.kind, s.flashes)
            s.flashes++
        Paint(s)
    }
}

; A session finished or needs you: bring the panel forward without taking
; focus, and flash its taskbar button until the panel comes to the front.
Alert() {
    DllCall("ShowWindow", "ptr", panel.Hwnd, "int", 4)   ; SW_SHOWNOACTIVATE
    panel.Opt("+AlwaysOnTop")
    panel.Opt("-AlwaysOnTop")
    fi := Buffer(A_PtrSize = 8 ? 32 : 20, 0)
    NumPut("uint", fi.Size, fi, 0)
    NumPut("ptr", panel.Hwnd, fi, A_PtrSize)
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
    IniWrite(s.lastClick, SETTINGS, "lastclick", code)
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
    m.Show()
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
        IniDelete(SETTINGS, section, s.code)
    else
        IniWrite(s.%prop%, SETTINGS, section, s.code)
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
    s.chatLink := link
    if link = ""
        IniDelete(SETTINGS, "chatlink", s.code)
    else
        IniWrite(link, SETTINGS, "chatlink", s.code)
}

SetPaused(s, paused) {
    s.paused := paused
    if paused
        s.unseen := false
    IniWrite(paused ? 1 : 0, SETTINGS, "paused", s.code)
    Paint(s)
}
