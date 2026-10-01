; Drives the real panel through processing, waiting (the alert path), approval,
; an interrupt, the pause button, auto-unpause, the closed state, the chat-link
; safeguards, the unread badge and the strips. It uses scratch files in %TEMP%,
; a scratch settings.ini, fake window lists and a fake address reader; nothing
; real is moved. The panel shows and flashes for a moment.
; Run: AutoHotkey64.exe /ErrorStdOut smoke-test.ahk   (exit code 0 = passed)
; A runtime error fails it, and so does any #Warn warning when the panel is
; loaded on its own (checked at the end with /validate).
#Requires AutoHotkey v2.0
OnError(Trap)
#Include claude-sessions.ahk
#Warn All, StdOut

SetTimer(Refresh, 0), SetTimer(Blink, 0)
fails := 0
dir := A_Temp "\claude-sessions-smoke"
DirCreate(dir)
SETTINGS := dir "\settings.ini"   ; from here on, nothing touches the real settings
try FileDelete(SETTINGS)
statusPath := dir "\session-status.json", transcript := dir "\transcript.jsonl", reportPath := dir "\last-report.md"
FileOpen(transcript, "w", "UTF-8-RAW").Write("")
try FileDelete(reportPath)
ms := sessions["main"]    ; not `s`: the panel's functions use a local s
ms.statusFile := statusPath, ms.reportFile := reportPath
ms.paused := false, ms.chromeTitle := "", ms.chatLink := ""
fakeWindows := []
for smokeCode in order    ; not `code`: the panel's functions use a local code
    fakeWindows.Push({hwnd: A_Index, title: "x.md - " sessions[smokeCode].folder " - Visual Studio Code"})
listCodeWindows := () => fakeWindows
chromeWindows := []
listChromeWindows := () => chromeWindows
placed := []
placeWindow := (h, mon) => placed.Push(h "@" mon)
readerCalls := [], readerResult := ""
chromeAddressReader := FakeReader
arranged := []
arrangeAction := (t) => arranged.Push(t.code)

FakeReader(hwnd) {
    readerCalls.Push(hwnd)
    if readerResult = "THROW"
        throw Error("UIA failed")
    return readerResult
}
Step(state, since, red) {
    FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"' state '","since":"' since '","project":"main","red":'
        . (red ? "true" : "false") ',"transcript_path":"' StrReplace(transcript, "\", "\\")
        . '","session_id":"64faa3c6-f1f8-43af-840c-2a21141f081e"}')
    Refresh()
}
Expect(name, got, want) {
    global fails
    if (got !== want)
        fails++, FileAppend("FAIL " name ": got [" got "] want [" want "]`n", "*")
}

; --- states -----------------------------------------------------------------
Step("processing", "2026-09-30T10:00:00.000Z", false)
Expect("processing", ms.kind, "processing")
Step("waiting", "2026-09-30T10:01:00.000Z", false)
Expect("finished turn waits", ms.kind, "waiting")
Expect("finished turn alerts", ms.unseen, true)
ButtonClick("main")
Expect("click marks seen", ms.unseen, false)
Expect("click arranges", arranged.Length ? arranged[1] : "", "main")
Step("approval", "2026-09-30T10:02:00.000Z", true)
Expect("approval is red", ms.kind, "red")
FileOpen(transcript, "a", "UTF-8-RAW").Write('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"timestamp":"2026-09-30T10:02:30.000Z"}`n')
Refresh()
Expect("denial shows waiting", ms.kind, "waiting")
Expect("denial label", InStr(controls["main"].Text, "interrupted") > 0, true)

; --- pause ------------------------------------------------------------------
PauseClick("main")
Expect("pause button pauses", ms.paused, true)
Expect("pause button says resume", pauseButtons["main"].Text, "Resume")
Refresh()
Expect("paused left out of taskbar", InStr(A_IconTip, "main: paused") > 0, true)
Step("processing", "2026-09-30T10:03:00.000Z", false)
Expect("auto-unpause", ms.paused, false)
Expect("pause button says pause", pauseButtons["main"].Text, "Pause")

; --- closed -----------------------------------------------------------------
fakeWindows.RemoveAt(1)   ; main's VS Code window closes
Refresh(), Refresh()
Expect("not closed after 2 polls", ms.closed, false)
Refresh()
Expect("closed after 3 polls", ms.closed, true)
Expect("closed label, no timer", RegExMatch(controls["main"].Text, "closed · processing (\d+ \w+ )?\d\d:\d\d$") > 0, true)
Expect("closed left out of taskbar", InStr(A_IconTip, "main: closed") > 0, true)
Step("waiting", "2026-09-30T10:04:00.000Z", false)
Expect("closed does not alert", ms.unseen, false)
fakeWindows.InsertAt(1, {hwnd: 99, title: "alfred-v5 - Visual Studio Code"})
Refresh()
Expect("open again at once", ms.closed, false)

; --- automatic chat link: safeguards ------------------------------------------
ms.project := "main"
chromeWindows := [{hwnd: 501, title: "Inbox - Gmail - Google Chrome"}, {hwnd: 502, title: "main build - Claude - Google Chrome"}]
readerResult := "claude.ai/chat/abc-1"
Arrange(ms)
Expect("reads the matched window only", readerCalls.Length = 1 ? readerCalls[1] : readerCalls.Length, 502)
Expect("saves a chat address", ms.chatLink, "https://claude.ai/chat/abc-1")
Expect("saved to settings", IniRead(SETTINGS, "chatlink", "main", ""), "https://claude.ai/chat/abc-1")
readerResult := "claude.ai/new"
Arrange(ms)
Expect("non-chat address saves nothing", ms.chatLink, "https://claude.ai/chat/abc-1")
readerResult := "THROW", placed := []
Arrange(ms)
Expect("failed read saves nothing", ms.chatLink, "https://claude.ai/chat/abc-1")
Expect("failed read still arranges", JoinCodes(placed), "99@1|502@2|")
ms.chromeTitle := "Inbox", readerCalls := [], readerResult := "claude.ai/chat/zzz", placed := []
Arrange(ms)
Expect("typed title never reads", readerCalls.Length, 0)
Expect("typed title never saves", ms.chatLink, "https://claude.ai/chat/abc-1")
Expect("typed title still arranges", JoinCodes(placed), "99@1|501@2|")
ms.chromeTitle := ""

; --- unread badge -------------------------------------------------------------
FileOpen(reportPath, "w", "UTF-8").Write("report")
FileSetTime(DateAdd(ms.lastClick, 60, "Seconds"), reportPath, "M")
Refresh()
Expect("new report shows badge", InStr(controls["main"].Text, "• new") > 0, true)
ButtonClick("main")
FileSetTime(DateAdd(ms.lastClick, -60, "Seconds"), reportPath, "M")
Refresh()
Expect("click clears badge", InStr(controls["main"].Text, "• new"), 0)

; --- strips -------------------------------------------------------------------
Expect("db strip shown", SubStr(dbStripCtl.Text, 1, 4), "db: ")
Expect("main strip shown", SubStr(mainStripCtl.Text, 1, 6), "main: ")
Expect("git counted", IsInteger(sessions[order[order.Length]].changed), true)

; --- main's button names the bound project, not the status file's -------------
BINDING_FILE := dir "\alfred-project-code.json"
try FileDelete(BINDING_FILE)
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"2026-09-30T10:05:00.000Z","project":"switchboard_icon-k7w","red":false}')
Refresh()
Expect("free main ignores stale project", RegExReplace(StrSplit(controls["main"].Text, "`n")[1], " {3}.*"), "main")
Expect("free main strip", mainStripCtl.Text, "main: free")
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"rem-j7p"}')
Refresh()
Expect("bound main shows project", RegExReplace(StrSplit(controls["main"].Text, "`n")[1], " {3}.*"), "main · rem-j7p")

; --- the panel loads with no warnings -------------------------------------------
wrapper := dir "\validate.ahk", warnOut := dir "\validate.txt"
FileOpen(wrapper, "w", "UTF-8").Write("#Include " A_ScriptDir "\`n#Include claude-sessions.ahk`n#Warn All, StdOut`n")
RunWait(A_ComSpec ' /c ""' A_AhkPath '" /ErrorStdOut /validate "' wrapper '" > "' warnOut '" 2>&1"', , "Hide")
Expect("panel loads with no warnings", Trim(FileRead(warnOut), " `r`n"), "")

FileAppend(fails ? fails " failed`n" : "smoke passed`n", "*")
ExitApp(fails ? 1 : 0)

Trap(e, *) {
    FileAppend("ERROR " e.Message " | " e.What " | line " e.Line "`n", "*")
    ExitApp(3)
}
