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
BINDING_FILE := dir "\alfred-project-code.json"   ; nor the real binding
BRIDGE_DIR := dir "\bridge"                        ; nor the real bridge folder
DirCreate(BRIDGE_DIR)
try FileDelete(BRIDGE_DIR "\tabs.json")
focusCalls := [], focusReply := "", composerCalls := [], activated := [], actionCalls := []
focusRequester := (id, composer := false, action := "focus") => (focusCalls.Push(id), composerCalls.Push(composer), actionCalls.Push(action), focusReply)
activateWindow := (h) => activated.Push(h)
pointed := [], POINTER_FOLLOWS := true
pointerMover := (h) => pointed.Push(h)
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"smoke-proj"}')
statusPath := dir "\session-status.json", transcript := dir "\transcript.jsonl", reportPath := dir "\last-report.md"
FileOpen(transcript, "w", "UTF-8-RAW").Write("")
try FileDelete(reportPath)
ms := sessions["main"]    ; not `s`: the panel's functions use a local s
ms.statusFile := statusPath, ms.reportFile := reportPath
ms.reportMetaFile := dir "\last-report.json"
try FileDelete(ms.reportMetaFile)
try FileDelete(BRIDGE_DIR "\chats.json")
; Paired with a finished chat, so a CLI that stops waiting shows yellow (bridge spec, section 5).
ms.paused := false, ms.chromeTitle := "", ms.chatLink := "https://claude.ai/chat/smoke-start"
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
Step(state, since, red, runTag := "") {
    FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"' state '","since":"' since '","project":"main","red":'
        . (red ? "true" : "false") ',"transcript_path":"' StrReplace(transcript, "\", "\\")
        . '","session_id":"64faa3c6-f1f8-43af-840c-2a21141f081e","run_tag":"' runTag '"}')
    Refresh()
}
IsoAgo(seconds) => FormatTime(DateAdd(A_NowUTC, -seconds, "Seconds"), "yyyy-MM-dd'T'HH:mm:ss") ".000Z"
; chats.json, fresh, from "url|state|sinceAgo|issuedTag|viewedAgo|tabId|title" lines ("" viewedAgo = never).
WriteChats(lines*) {
    body := ""
    for line in lines {
        f := StrSplit(line, "|")
        body .= (body = "" ? "" : ",") '{"tabId":' f[6] ',"url":"' f[1] '","title":"' f[7] '","state":"' f[2]
            . '","since":"' IsoAgo(f[3]) '","issuedTag":"' f[4] '","viewedAt":"' (f[5] = "" ? "" : IsoAgo(f[5])) '"}'
    }
    FileOpen(BRIDGE_DIR "\chats.json", "w", "UTF-8-RAW").Write('{"at":"' IsoAgo(0) '","chats":[' body ']}')
}
WriteChats("https://claude.ai/chat/smoke-start|finished|9999||1|1|start")
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
chromeWindows := [{hwnd: 501, title: "Inbox - Gmail - Google Chrome"}, {hwnd: 502, title: "smoke-proj build - Claude - Google Chrome"}]
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

; --- bridge: pair by exact address, fall back when stale or unmatched ----------
WriteTabs(ageSeconds, url) {
    at := FormatTime(DateAdd(A_NowUTC, -ageSeconds, "Seconds"), "yyyy-MM-dd'T'HH:mm:ss") ".000Z"
    FileOpen(BRIDGE_DIR "\tabs.json", "w", "UTF-8-RAW").Write('{"at":"' at '","tabs":[{"tabId":5,"url":"https://claude.ai/chat/other"},{"tabId":77,"url":"' url '"}]}')
}
chromeWindows := [{hwnd: 502, title: "smoke-proj build - Claude - Google Chrome"}, {hwnd: 701, title: "abc chat - Claude - Google Chrome"}]
focusReply := Map("ok", true, "windowTitle", "abc chat - Claude")
WriteTabs(5, "https://claude.ai/chat/abc-1")
placed := [], readerCalls := []
Arrange(ms)
Expect("bridge focuses the linked tab", focusCalls.Length = 1 ? focusCalls[1] : focusCalls.Length, 77)
Expect("bridge places the window by title", JoinCodes(placed), "99@1|701@2|")
Expect("bridge skips the address reader", readerCalls.Length, 0)
WriteTabs(60, "https://claude.ai/chat/abc-1")
focusCalls := [], placed := []
Arrange(ms)
Expect("stale tabs: no focus", focusCalls.Length, 0)
Expect("stale tabs: title fallback", JoinCodes(placed), "99@1|502@2|")
WriteTabs(5, "https://claude.ai/chat/not-this-one")
placed := []
Arrange(ms)
Expect("no tab matches: no focus", focusCalls.Length, 0)
Expect("no tab matches: title fallback", JoinCodes(placed), "99@1|502@2|")
WriteTabs(5, "https://claude.ai/chat/abc-1")
focusReply := Map("ok", false, "error", "no tab with id 77"), placed := []
Arrange(ms)
Expect("failed focus: title fallback", JoinCodes(placed), "99@1|502@2|")
focusReply := "", placed := []
WriteTabs(6, "https://claude.ai/chat/abc-1")
Arrange(ms)
Expect("no reply: title fallback", JoinCodes(placed), "99@1|502@2|")
FileDelete(BRIDGE_DIR "\tabs.json")

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
try FileDelete(BINDING_FILE)
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"2026-09-30T10:05:00.000Z","project":"switchboard_icon-k7w","red":false}')
Refresh()
Expect("free main ignores stale project", RegExReplace(StrSplit(controls["main"].Text, "`n")[1], " {3}.*"), "main")
Expect("free main strip", mainStripCtl.Text, "main: free")
Expect("free main reads free", StrSplit(controls["main"].Text, "`n")[2], "free")
Expect("free main grey", SubStr(ms.painted, 1, 6), FREE_COLOR)
Expect("free main out of taskbar", InStr(A_IconTip, "main: free") > 0, true)
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"processing","since":"2026-09-30T10:06:00.000Z","project":"x","red":false}')
Refresh()
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"2026-09-30T10:07:00.000Z","project":"x","red":false}')
Refresh()
Expect("free main does not alert", ms.unseen, false)
chromeWindows := [{hwnd: 601, title: "switchboard_icon-k7w - Claude - Google Chrome"}, {hwnd: 602, title: "rem-j7p plan - Claude - Google Chrome"}]
Expect("free main chat ignores stale project", FindChromeWindow(ms), 0)
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"rem-j7p"}')
Refresh()
Expect("bound main shows project", RegExReplace(StrSplit(controls["main"].Text, "`n")[1], " {3}.*"), "main · rem-j7p")
Expect("bound main not free", ms.free, false)
Expect("bound main chat follows binding", FindChromeWindow(ms), 602)

; --- yellow flashes five times, then stays solid ---------------------------------
ms.chatLink := "https://claude.ai/chat/abc-1"   ; the bridge fallbacks above saved the reader's zzz
WriteChats("https://claude.ai/chat/abc-1|finished|9999||1|1|abc")
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"processing","since":"2026-09-30T10:08:00.000Z","project":"rem-j7p","red":false}')
Refresh()
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"2026-09-30T10:09:00.000Z","project":"rem-j7p","red":false}')
Refresh()
Expect("bound main alerts", ms.unseen, true)
lit := 0
blinkOn := false
Loop 30 {
    Blink()
    if SubStr(ms.painted, 1, 6) = BLINK_COLOR
        lit++
}
Expect("yellow lit five times", lit, 5)
Expect("then solid yellow", SubStr(ms.painted, 1, 6), COLORS["yellow"])
Expect("still unseen until clicked", ms.unseen, true)

; --- state model: one project through every colour ------------------------------
T9 := "rem-j7p-s9-aaaa", T10 := "rem-j7p-s10-bbbb"
Line2() => StrSplit(controls["main"].Text, "`n")[2]
Step("processing", IsoAgo(30), false, T9)
Expect("green CLI working", ms.color " / " ms.label, "green / CLI working")
Expect("label shows the step", SubStr(Line2(), 1, 17), "s9 · CLI working ")
Step("waiting", IsoAgo(20), false, T9)
Expect("no report for the run: Check CLI", ms.color " / " ms.label, "red / Check CLI")
Expect("Check CLI alerts", ms.unseen, true)
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(10) '"}')
Refresh()
Expect("report not read: Send cli", ms.color " / " ms.label, "orange / Send cli")
WriteChats("https://claude.ai/chat/abc-1|finished|5|" T10 "|1|1|abc")
Refresh()
Expect("newer tag: Paste prompt", ms.color " / " ms.label, "purple / Paste prompt")
Expect("label shows both steps", SubStr(Line2(), 1, 25), "s9 -> s10 · Paste prompt ")
arranged := []
ButtonClick("main")
Expect("purple click arranges, nothing more", JoinCodes(arranged), "main|")
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
Expect("no newer tag: Your turn", ms.color " / " ms.label, "yellow / Your turn")

; --- where the keyboard lands after a click ----------------------------------------
WriteTabs(1, "https://claude.ai/chat/abc-1")
chromeWindows := [{hwnd: 701, title: "abc chat - Claude - Google Chrome"}]
focusReply := Map("ok", true, "windowTitle", "abc chat - Claude")
composerCalls := [], activated := [], placed := [], actionCalls := [], pointed := []
Arrange(ms)
Expect("yellow: pointer to Chrome", JoinCodes(pointed), "701|")
Expect("yellow: cursor to the chat's message box", composerCalls.Length = 1 ? composerCalls[1] : composerCalls.Length, true)
Expect("yellow: Chrome placed last, VS Code not re-activated", JoinCodes(placed) "/" activated.Length, "99@1|701@2|/0")
Expect("yellow never types", JoinCodes(actionCalls), "focus|")

; --- Send cli: orange only, and the extension decides on the live page --------------
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(0) '"}')
Refresh()
Expect("orange again", ms.color, "orange")
actionCalls := [], composerCalls := []
Arrange(ms)
Expect("orange sends a sendcli command", JoinCodes(actionCalls), "sendcli|")
WriteChats("https://claude.ai/chat/abc-1|finished|0|" "rem-j7p-s10-bbbb" "|1|1|abc")
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(30) '"}')
Refresh()
Expect("purple again", ms.color, "purple")
actionCalls := []
Arrange(ms)
Expect("purple never types", JoinCodes(actionCalls), "focus|")
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
; The real command file for Send cli: no composer flag, nothing else.
try FileDelete(BRIDGE_DIR "\command.json")
SendFocus(42, true, "sendcli")
Expect("sendcli command file", FileRead(BRIDGE_DIR "\command.json", "UTF-8") ~= '^\{"id":"panel-[0-9-]+","action":"sendcli","tabId":42\}$', 1)
FileDelete(BRIDGE_DIR "\command.json")
actionCalls := [], composerCalls := [], activated := [], placed := []
Step("processing", IsoAgo(2), false, T9)
composerCalls := [], activated := [], pointed := []
Arrange(ms)
Expect("CLI working: no message-box focus", composerCalls.Length = 1 ? composerCalls[1] : composerCalls.Length, false)
Expect("CLI working: VS Code activated last", JoinCodes(activated), "99|")
Expect("CLI working: pointer to VS Code", JoinCodes(pointed), "99|")
POINTER_FOLLOWS := false, pointed := []
Arrange(ms)
Expect("pointer setting off: no move", pointed.Length, 0)
POINTER_FOLLOWS := true
Step("waiting", IsoAgo(1), false, "rem-j7p-s9b-cccc")
Expect("now red", ms.color, "red")
composerCalls := [], activated := [], pointed := []
Arrange(ms)
Expect("red: VS Code activated last", JoinCodes(activated), "99|")
Expect("red: pointer to VS Code", JoinCodes(pointed), "99|")
FileDelete(BRIDGE_DIR "\tabs.json")
Step("waiting", IsoAgo(1), false, T9)
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
Expect("back to yellow", ms.color, "yellow")
WriteChats("https://claude.ai/chat/abc-1|responding|3||1|1|abc")
Refresh()
Expect("Claude writing is green", ms.color " / " ms.label, "green / Claude writing")
FileDelete(BRIDGE_DIR "\chats.json")
Refresh()
Expect("no chat file: grey", ms.color " / " ms.label, "grey / chat unknown")

; --- unpaired chats get their own rows --------------------------------------------
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc", "https://claude.ai/chat/loose|responding|2||1|900|Loose chat - Claude")
Refresh()
Expect("one row, paired chat left out", rowTabs.Length = 1 ? rowTabs[1] : rowTabs.Length, 900)
Expect("row visible", chatRows[1].Visible, true)
Expect("row text", chatRows[1].Text, "Loose chat`nClaude writing")
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc", "https://claude.ai/chat/loose|finished|1||30|900|Loose chat - Claude")
Refresh()
Expect("finished, not viewed: yellow", rowState[900].color, "yellow")
Expect("row alerts", rowState[900].unseen, true)
focusCalls := [], composerCalls := [], pointed := []
focusReply := Map("ok", true, "windowTitle", "Loose chat - Claude")
chromeWindows := [{hwnd: 801, title: "Loose chat - Claude - Google Chrome"}]
ChatRowClick(1)
Expect("row click: pointer to its Chrome window", JoinCodes(pointed), "801|")
Expect("row click focuses its tab", focusCalls.Length = 1 ? focusCalls[1] : focusCalls.Length, 900)
Expect("row click: cursor to the message box", composerCalls.Length = 1 ? composerCalls[1] : composerCalls.Length, true)
Expect("row click marks seen", rowState[900].unseen, false)
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
Expect("row gone with its chat", chatRows[1].Visible, false)

; --- no saved link: learn one from any tab whose title has the code ---------------
ms.chatLink := ""
FileOpen(BRIDGE_DIR "\tabs.json", "w", "UTF-8-RAW").Write('{"at":"' IsoAgo(0) '","tabs":[{"tabId":3,"url":"https://claude.ai/chat/learned?x","title":"rem-j7p plan - Claude","active":false}]}')
Refresh()
Expect("link learned from a background tab", ms.chatLink, "https://claude.ai/chat/learned")
Expect("learned link saved", IniRead(SETTINGS, "chatlink", "main", ""), "https://claude.ai/chat/learned")
FileDelete(BRIDGE_DIR "\tabs.json")

; --- git counts re-run when a watched file changes -----------------------------
watched := dir "\logs-HEAD"
FileOpen(watched, "w", "UTF-8-RAW").Write("a")
ms.gitWatch := [watched]
Refresh()
ms.changed := -1          ; a count git never gives
Refresh()
Expect("unchanged watch, no recount", ms.changed, -1)
FileSetTime(DateAdd(A_Now, 120, "Seconds"), watched, "M")
Refresh()
Expect("watched file change recounts", ms.changed >= 0, true)

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
