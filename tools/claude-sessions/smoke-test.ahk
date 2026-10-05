; Drives the real panel through processing, waiting (the alert path), approval,
; an interrupt, pause, auto-unpause, the closed state, the chat-link safeguards,
; unread reports and git counts. What is drawn is checked in the touch page's state
; JSON (TouchState); only the flashing still reads the old panel. It uses scratch files in %TEMP%,
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
SETTINGS_INI := dir "\settings.ini"   ; from here on, nothing touches the real settings
try FileDelete(SETTINGS_INI)
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
ms.paused := false, ms.chromeTitle := "", ms.chatLink := "https://claude.ai/chat/smoke-start", ms.chatLinkFor := "smoke-proj"
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
; A fixed layout, so the monitor numbers below do not depend on this PC's screens.
fakeMonitors := [{l: 0, t: 0, r: 1920, b: 1080}, {l: 1920, t: 0, r: 3840, b: 1080}, {l: -1024, t: 470, r: 0, b: 1070}]
listMonitors := () => fakeMonitors
UpdateAppMonitors()

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
; The touch page's state, read back the way the page gets it: as JSON.
PageState() => JSON.parse(ToJson(TouchState()))
TileOf(id) {
    for t in PageState()["tiles"]
        if t["id"] = id
            return t
    return Map()
}
TileField(id, field) => TileOf(id).Get(field, "(no tile)")

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
Expect("denial recorded", ms.interruptAt != "", true)
Expect("denial tile not red", TileField("cli:main", "color") != "red", true)

; --- pause ------------------------------------------------------------------
PauseClick("main")
Expect("pause button pauses", ms.paused, true)
Expect("paused tile in paused group", TileField("cli:main", "group"), 2)
Expect("paused tile has its own darker colour", TileField("cli:main", "color"), "paused")
Expect("paused tile wording", SubStr(TileField("cli:main", "action"), 1, 7), "Paused ")
Refresh()
Expect("paused left out of taskbar", InStr(A_IconTip, "main: paused") > 0, true)
Step("processing", "2026-09-30T10:03:00.000Z", false)
Expect("auto-unpause", ms.paused, false)
Expect("unpaused tile back in active group", TileField("cli:main", "group"), 0)

; --- touch page: long-press pauses and unpauses, tap clicks, orphans do nothing ----
TouchDo("hold", "cli:main")
Expect("long-press pauses", ms.paused, true)
Expect("paused age counts from the pause", TileField("cli:main", "action"), "Paused 0m")
TouchDo("hold", "cli:main")
Expect("long-press again unpauses", ms.paused, false)
arranged := []
TouchDo("tap", "cli:main")
Expect("tap arranges like a click", JoinCodes(arranged), "main|")
TouchDo("tap", "orphan:gone-x1y"), TouchDo("tap", "cli:no-such-code")
Expect("orphan and unknown taps do nothing", JoinCodes(arranged), "main|")
ms.changed := -1
TouchDo("git", "")
Expect("Refresh git recounts", ms.changed >= 0, true)

; --- closed -----------------------------------------------------------------
fakeWindows.RemoveAt(1)   ; main's VS Code window closes
Refresh(), Refresh()
Expect("not closed after 2 polls", ms.closed, false)
Refresh()
Expect("closed after 3 polls", ms.closed, true)
Expect("closed tile wording", TileField("cli:main", "action"), "Closed, tap to reopen")
Expect("closed tile in active group", TileField("cli:main", "group") " " TileField("cli:main", "color"), "0 grey")
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
Expect("saved to settings", IniRead(SETTINGS_INI, "chatlink", "main", ""), "https://claude.ai/chat/abc-1")
Expect("saved with its project code", IniRead(SETTINGS_INI, "chatlinkcode", "main", ""), "smoke-proj")
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
; Monitors renumbered (touch screen first after a replug): still VS Code left, Chrome right.
fakeMonitors := [{l: -1024, t: 470, r: 0, b: 1070}, {l: 1920, t: 0, r: 3840, b: 1080}, {l: 0, t: 0, r: 1920, b: 1080}]
placed := []
Arrange(ms)
Expect("renumbered: VS Code left, Chrome right", JoinCodes(placed), "99@3|501@2|")
fakeMonitors := [{l: -1024, t: 470, r: 0, b: 1070}, {l: 0, t: 0, r: 1920, b: 1080}]
placed := []
Arrange(ms)
Expect("one main monitor: both on it", JoinCodes(placed), "99@2|501@2|")
fakeMonitors := [{l: 0, t: 0, r: 1920, b: 1080}, {l: 1920, t: 0, r: 3840, b: 1080}, {l: -1024, t: 470, r: 0, b: 1070}]
UpdateAppMonitors()
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

; --- unread report (the touch page has no badge; the state still tracks it) -------
FileOpen(reportPath, "w", "UTF-8").Write("report")
FileSetTime(DateAdd(ms.lastClick, 60, "Seconds"), reportPath, "M")
Refresh()
Expect("new report is unread", ms.unread, true)
ButtonClick("main")
FileSetTime(DateAdd(ms.lastClick, -60, "Seconds"), reportPath, "M")
Refresh()
Expect("click marks it read", ms.unread, false)

; --- top bar and git counts ------------------------------------------------------
Expect("db status sent", SubStr(PageState()["db"], 1, 4), "db: ")
Expect("no window: docked mode reported", PageState()["mode"] " " PageState()["noTouch"], "touch 0")
Expect("no touch window: the old panel owns the taskbar button", TaskbarGui() = panel, true)
TouchDo("move", ""), TouchDo("menu", "cli:main")
Expect("move and menu are safe with no window", TOUCH_MODE, IniRead(SETTINGS_INI, "panel", "touchmode", "touch"))
Expect("main status sent", SubStr(PageState()["main"], 1, 6), "main: ")
Expect("git counted", IsInteger(sessions[order[order.Length]].changed), true)
ms.changed := 3, ms.ahead := 2
Expect("git counts on the tile", TileField("cli:main", "git"), "±3 ↑2")
ms.changed := 0, ms.ahead := 0
Expect("no git counts when clean", TileField("cli:main", "git"), "")

; --- main's button names the bound project, not the status file's -------------
try FileDelete(BINDING_FILE)
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"2026-09-30T10:05:00.000Z","project":"switchboard_icon-k7w","red":false}')
Refresh()
Expect("free main ignores stale project", TileField("cli:main", "name"), "main")
Expect("free main status", PageState()["main"], "main: free")
Expect("free main reads free", TileField("cli:main", "action"), "Free")
Expect("free main grey", TileField("cli:main", "color"), "grey")
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
Expect("bound main shows project", TileField("cli:main", "name"), "main · rem")
Expect("bound main not free", ms.free, false)
Expect("bound main chat follows binding", FindChromeWindow(ms), 602)

; --- yellow flashes five times, then stays solid ---------------------------------
ms.chatLink := "https://claude.ai/chat/abc-1", ms.chatLinkFor := "rem-j7p"   ; unbinding above dropped the link
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
Step("processing", IsoAgo(30), false, T9)
Expect("green CLI working", ms.color " / " ms.label, "green / CLI working")
Expect("tile shows the step", TileField("cli:main", "step"), "s9")
Expect("tile shows the timer", TileField("cli:main", "action") ~= "^Working 0:3\d$", 1)
Step("waiting", IsoAgo(20), false, T9)
Expect("no report for the run: Check CLI", ms.color " / " ms.label, "red / Check CLI")
Expect("Check CLI alerts", ms.unseen, true)
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(10) '"}')
Refresh()
Expect("report not read: Send cli", ms.color " / " ms.label, "orange / Send cli")
WriteChats("https://claude.ai/chat/abc-1|finished|5|" T10 "|1|1|abc")
Refresh()
Expect("newer tag: Paste prompt", ms.color " / " ms.label, "purple / Paste prompt")
Expect("handover tile shows the new step only", TileField("cli:main", "step"), "→s10")
Expect("purple tile", TileField("cli:main", "color") " / " TileField("cli:main", "action"), "purple / Paste prompt")
arranged := []
ButtonClick("main")
Expect("purple click arranges, nothing more", JoinCodes(arranged), "main|")
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
Expect("no newer tag: Your turn", ms.color " / " ms.label, "yellow / Your turn")
Expect("paired chat: both icons", TileField("cli:main", "icon"), "both")

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
Expect("no chat: terminal icon only", TileField("cli:main", "icon"), "cli")

; --- unpaired chats get their own rows --------------------------------------------
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc", "https://claude.ai/chat/loose|responding|2||1|900|Loose chat - Claude")
Refresh()
Expect("one row, paired chat left out", rowTabs.Length = 1 ? rowTabs[1] : rowTabs.Length, 900)
loose := TileOf("chat:900")
Expect("chat tile", loose.Get("kind", "") " " loose.Get("group", "") " " loose.Get("name", "") " / " loose.Get("action", ""), "chat 1 Loose chat / Writing")
Expect("chat tile after CLI tiles", PageState()["tiles"][1]["kind"], "cli")
Expect("chat tile: bubble icon", loose.Get("icon", ""), "chat")
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc", "https://claude.ai/chat/loose|finished|1||30|900|Loose chat - Claude")
Refresh()
Expect("finished, not viewed: yellow", rowState[900].color, "yellow")
Expect("chat tile reply ready", TileField("chat:900", "color") " / " TileField("chat:900", "action"), "yellow / Reply ready")
Expect("row alerts", rowState[900].unseen, true)
focusCalls := [], composerCalls := [], pointed := []
focusReply := Map("ok", true, "windowTitle", "Loose chat - Claude")
chromeWindows := [{hwnd: 801, title: "Loose chat - Claude - Google Chrome"}]
ChatRowClick(1)
Expect("row click: pointer to its Chrome window", JoinCodes(pointed), "801|")
Expect("row click focuses its tab", focusCalls.Length = 1 ? focusCalls[1] : focusCalls.Length, 900)
Expect("row click: cursor to the message box", composerCalls.Length = 1 ? composerCalls[1] : composerCalls.Length, true)
Expect("row click marks seen", rowState[900].unseen, false)
rowState[900].unseen := true, focusCalls := [], composerCalls := [], pointed := []
TouchDo("tap", "chat:900")
Expect("chat tap: pointer to its Chrome window", JoinCodes(pointed), "801|")
Expect("chat tap focuses its tab", focusCalls.Length = 1 ? focusCalls[1] : focusCalls.Length, 900)
Expect("chat tap: cursor to the message box", composerCalls.Length = 1 ? composerCalls[1] : composerCalls.Length, true)
Expect("chat tap marks seen", rowState[900].unseen, false)
pausedBefore := ms.paused
TouchDo("hold", "chat:900")
Expect("chat long-press ignored", ms.paused, pausedBefore)
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
Expect("chat tile gone with its chat", TileOf("chat:900").Count, 0)

; --- no saved link: learn one from any tab whose title has the code ---------------
ms.chatLink := ""
FileOpen(BRIDGE_DIR "\tabs.json", "w", "UTF-8-RAW").Write('{"at":"' IsoAgo(0) '","tabs":[{"tabId":3,"url":"https://claude.ai/chat/learned?x","title":"rem-j7p plan - Claude","active":false}]}')
Refresh()
Expect("link learned from a background tab", ms.chatLink, "https://claude.ai/chat/learned")
Expect("learned link saved", IniRead(SETTINGS_INI, "chatlink", "main", ""), "https://claude.ai/chat/learned")

; --- main rebound: the old project's link is dropped and the new chat learned ------
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"next-q2z"}')
FileOpen(BRIDGE_DIR "\tabs.json", "w", "UTF-8-RAW").Write('{"at":"' IsoAgo(0) '","tabs":[{"tabId":3,"url":"https://claude.ai/chat/learned","title":"rem-j7p plan - Claude"},{"tabId":4,"url":"https://claude.ai/chat/next","title":"Not done next-q2z - Claude"}]}')
Refresh()
Expect("rebind relearns the link", ms.chatLink, "https://claude.ai/chat/next")
Expect("rebind saves the new code", IniRead(SETTINGS_INI, "chatlinkcode", "main", ""), "next-q2z")
FileDelete(BRIDGE_DIR "\tabs.json")
try FileDelete(BINDING_FILE)
Refresh()
Expect("unbind drops the link", ms.chatLink " / " IniRead(SETTINGS_INI, "chatlink", "main", ""), " / ")
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"rem-j7p"}')

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

; --- a worktree folder left behind by gitpush gets no row ----------------------
realRepo := REPO, REPO := dir "\repo"
try DirDelete(REPO, true)
DirCreate(REPO "\.claude\worktrees\live-a1b"), DirCreate(REPO "\.claude\worktrees\gone-c2d")
FileOpen(REPO "\.claude\worktrees\live-a1b\.git", "w", "UTF-8-RAW").Write("gitdir: x")
smokeCodes := ""
for smokePair in Checkouts()    ; not `pair`: Sync() uses a local pair
    smokeCodes .= smokePair[1] "|"
Expect("leftover folder has no row", smokeCodes, "main|live-a1b|")
REPO := realRepo

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
