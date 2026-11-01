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
; Before the include: the panel's startup reads and writes settings.ini.
dir := A_Temp "\claude-sessions-smoke"
DirCreate(dir)
try FileDelete(dir "\settings.ini")
EnvSet("SWITCHBOARD_SETTINGS_DIR", dir)
realIni := EnvGet("APPDATA") "\claude-sessions\settings.ini"
realIniTime := FileExist(realIni) ? FileGetTime(realIni, "M") : ""
#Include claude-sessions.ahk
#Warn All, StdOut

SetTimer(Refresh, 0), SetTimer(Blink, 0)
; A real click on the panel's chat row focused a tab mid-run (switchboard_guard s6b).
; The tests call the handlers directly, so the window takes no input. A test script
; never opens the touch window (claude-sessions.ahk, before the first SetTimer).
panel.Opt("+Disabled")
fails := 0
Expect("scratch settings from the start", SETTINGS_INI, dir "\settings.ini")
Expect("panel takes no real input", (WinGetStyle(panel.Hwnd) & 0x08000000) != 0, true)   ; WS_DISABLED
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
ms.scopeFile := dir "\scope.json"
try FileDelete(ms.scopeFile)
try FileDelete(BRIDGE_DIR "\chats.json")
; Paired with a finished chat, so a CLI that stops waiting shows a colour (bridge spec, section 5).
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
; "tag|ok|error" from the panel's report to the host, taken as the host would; "" for none.
DeliveryFile(project) {
    target := BRIDGE_DIR "\delivery-" project ".json"
    if !FileExist(target)
        return ""
    d := JSON.parse(FileRead(target, "UTF-8"))
    FileDelete(target)
    return d.Get("tag", "") "|" (d.Get("ok", false) ? 1 : 0) "|" d.Get("error", "")
}

; --- states -----------------------------------------------------------------
Step("processing", "2026-09-30T10:00:00.000Z", false)
Expect("processing", ms.kind, "processing")
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"","pushed_at":"' IsoAgo(0) '"}')
Step("waiting", "2026-09-30T10:01:00.000Z", false)
Expect("finished turn waits", ms.kind, "waiting")
Expect("finished turn with a report alerts", ms.unseen, true)
FileDelete(ms.reportMetaFile)
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
Expect("paused tile keeps its place", TileField("cli:main", "group"), 0)
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
Expect("bridge focuses the linked tab", JoinCodes(focusCalls) " " JoinCodes(composerCalls) " " JoinCodes(actionCalls), "77| 1| focus|")
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

; --- orange (Report ready) flashes five times, then stays solid ---------------------
ms.chatLink := "https://claude.ai/chat/abc-1", ms.chatLinkFor := "rem-j7p"   ; unbinding above dropped the link
WriteChats("https://claude.ai/chat/abc-1|finished|9999||1|1|abc")
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"processing","since":"2026-09-30T10:08:00.000Z","project":"rem-j7p","red":false}')
Refresh()
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"","pushed_at":"' IsoAgo(0) '"}')
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"2026-09-30T10:09:00.000Z","project":"rem-j7p","red":false}')
Refresh()
Expect("report ready", ms.color " / " ms.label, "orange / Send cli")
Expect("bound main alerts", ms.unseen, true)
lit := 0
blinkOn := false
Loop 30 {
    Blink()
    if SubStr(ms.painted, 1, 6) = BLINK_COLOR
        lit++
}
Expect("orange lit five times", lit, 5)
Expect("then solid orange", SubStr(ms.painted, 1, 6), COLORS["orange"])
Expect("still unseen until clicked", ms.unseen, true)
FileDelete(ms.reportMetaFile)
Refresh()
Expect("then Your turn", ms.color " / " ms.label, "yellow / Your turn")
Expect("Your turn still unseen", ms.unseen, true)

; --- state model: one project through every colour ------------------------------
T9 := "rem-j7p-s9-aaaa", T10 := "rem-j7p-s10-bbbb"
Step("processing", IsoAgo(30), false, T9)
Expect("green CLI working", ms.color " / " ms.label, "green / CLI working")
Expect("tile shows the step", TileField("cli:main", "step"), "s9")
Expect("tile shows the timer", TileField("cli:main", "action") ~= "^Working 0:3\d$", 1)
; Running colours by time left, from the estimate the prompt hook writes to scope.json.
Expect("no estimate: short green", TileField("cli:main", "color"), "greenshort")
WriteScope(tag, estimate) {
    FileOpen(ms.scopeFile, "w", "UTF-8-RAW").Write('{"run_tag":"' tag '","found":true,"estimate":"' estimate '"}')
    Refresh()
}
Expect("no estimate: no strip", TileField("cli:main", "strip"), -1)
WriteScope(T9, "10m")
Expect("10m estimate, 30s in: blending", (TileField("cli:main", "color") " " TileField("cli:main", "blend")) ~= "^greenrun [67]$", 1)
Expect("tile shows elapsed against the estimate", TileField("cli:main", "action") ~= "^Working 0:3\d\x{A0}/\x{A0}10:00$", 1)
WriteScope(T9, "10h")
Expect("9 digits: breaks at the slash", TileField("cli:main", "action") ~= "^Working 0:3\d`n/\x{A0}10:00:00$", 1)
WriteScope(T9, "10m")
Expect("strip 5% in", TileField("cli:main", "strip") ~= "^[56]$", 1)
WriteScope(T9, "5m")
Expect("5m estimate, 30s in: blending", (TileField("cli:main", "color") " " TileField("cli:main", "blend")) ~= "^greenrun 1[3-6]$", 1)
WriteScope(T9, "2m")
halfway := TileField("cli:main", "blend")
Expect("2m estimate: about halfway", IsNumber(halfway) && halfway >= 50 && halfway <= 65, true)
Expect("old panel paints the same blend", SubStr(ms.painted, 1, 6), BlendHex(COLORS["greenrun"], COLORS["greenshort"], halfway))
WriteScope(T9, "1m")
Expect("1m estimate: short green", TileField("cli:main", "color") " / " SubStr(ms.painted, 1, 6), "greenshort / " COLORS["greenshort"])
WriteScope(T9, "20s")
Expect("past the estimate: overrun", TileField("cli:main", "color"), "overrun")
Expect("overrun strip full", TileField("cli:main", "strip"), 100)
Expect("overrun keeps the logic colour", ms.color " / " ms.label, "green / CLI working")
SetProgressStrip(false)
Expect("strip setting off", TileField("cli:main", "strip") " / " IniRead(SETTINGS_INI, "panel", "progressstrip", ""), "-1 / 0")
SetProgressStrip(true)
Expect("strip setting on", TileField("cli:main", "strip"), 100)
WriteScope("rem-j7p-s8-zzzz", "20s")
Expect("another run's estimate: short green", TileField("cli:main", "color"), "greenshort")
Expect("another run's estimate: no estimate shown", TileField("cli:main", "action") ~= "^Working 0:3\d$", 1)
FileDelete(ms.scopeFile)
Refresh()
Expect("scope file gone: short green", TileField("cli:main", "color"), "greenshort")
Step("waiting", IsoAgo(20), false, T9)
Expect("no report for the run: Check CLI", ms.color " / " ms.label, "red / Check CLI")
Expect("Check CLI alerts", ms.unseen, true)
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(10) '"}')
Refresh()
Expect("report not read: Send cli", ms.color " / " ms.label, "orange / Send cli")
WriteChats("https://claude.ai/chat/abc-1|finished|5|" T10 "|1|1|abc")
Refresh()
Expect("newer tag: Prompt ready", ms.color " / " ms.label, "purple / Prompt ready")
Expect("handover tile shows the new step only", TileField("cli:main", "step"), "→s10")
Expect("purple tile", TileField("cli:main", "color") " / " TileField("cli:main", "action"), "purple / Prompt ready")
arranged := []
ButtonClick("main")
Expect("purple click arranges, nothing more", JoinCodes(arranged), "main|")
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc")
Refresh()
Expect("no newer tag: Your turn", ms.color " / " ms.label, "yellow / Your turn")
Expect("yellow tile", TileField("cli:main", "color"), "yellow")
Expect("paired chat: both icons", TileField("cli:main", "icon"), "both")

; --- where the keyboard lands after a click ----------------------------------------
WriteTabs(1, "https://claude.ai/chat/abc-1")
chromeWindows := [{hwnd: 701, title: "abc chat - Claude - Google Chrome"}]
focusReply := Map("ok", true, "windowTitle", "abc chat - Claude")
composerCalls := [], activated := [], placed := [], actionCalls := [], pointed := []
Arrange(ms)
Expect("your turn: pointer to Chrome", JoinCodes(pointed), "701|")
Expect("your turn: cursor to the chat's message box", composerCalls.Length = 1 ? composerCalls[1] : composerCalls.Length, true)
Expect("your turn: Chrome placed last, VS Code not re-activated", JoinCodes(placed) "/" activated.Length, "99@1|701@2|/0")
Expect("your turn never types", JoinCodes(actionCalls), "focus|")

; --- Report ready: orange only types cli, and the extension decides on the live page --
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(0) '"}')
Refresh()
Expect("orange again", ms.color, "orange")
actionCalls := [], composerCalls := []
ms.cliSend := "sending"
Expect("orange sends a sendcli command, reports what the page did", Arrange(ms), "")
Expect("orange sends a sendcli command", JoinCodes(actionCalls), "sendcli|")
ms.cliSend := ""

; --- the orange tap (2.9): pale at once, then blocked, then again, then on ---------
Refresh()
seenDuring := [], realArrange := arrangeAction
arrangeAction := (t) => (seenDuring.Push(TileField("cli:main", "color") " / " TileField("cli:main", "action")), "focused")
ButtonClick("main")
Expect("tap: pale before anything else", JoinCodes(seenDuring), "paleorange / Sending cli|")
Refresh()
Expect("tap: blocked is orange", ms.color " / " ms.label, "orange / Send cli blocked")
Expect("tap: blocked tile is outlined", TileField("cli:main", "outline") " " TileField("cli:main", "color") " " TileField("cli:main", "cliTap"), "1 orange send")
Expect("tap: going blocked does not flash", ms.unseen, false)
arrangeAction := (t) => "sent"
ButtonClick("main")
Refresh()
Expect("tap: a blocked tile tries again", ms.color " / " ms.label, "paleorange / Sending cli")
Expect("tap: sending is not outlined, and takes no second tap", TileField("cli:main", "outline") " " TileField("cli:main", "cliTap"), "0 busy")
secondTap := []
arrangeAction := (t) => (secondTap.Push(t.code), "sent")
ButtonClick("main")
Expect("tap: a second tap does nothing", secondTap.Length, 0)
WriteChats("https://claude.ai/chat/abc-1|responding|0|" T9 "|1|1|abc")
Refresh()
Expect("tap: on to Claude writing", ms.color " / " ms.label " / " ms.cliSend, "green / Claude writing / ")
arrangeAction := realArrange
WriteChats("https://claude.ai/chat/abc-1|finished|0|" T9 "|1|1|abc")
Refresh()

; The real Arrange takes the outcome from the extension's reply.
focusReply := Map("ok", true, "windowTitle", "abc chat - Claude", "did", "sent")
ms.cliSend := "sending"
Expect("arrange returns sent", Arrange(ms), "sent")
focusReply := Map("ok", true, "windowTitle", "abc chat - Claude", "did", "focused")
Expect("arrange returns focused", Arrange(ms), "focused")
ms.cliSend := ""
focusReply := Map("ok", true, "windowTitle", "abc chat - Claude")

; --- the panel endpoint ---------------------------------------------------------
PanelReply(fields) => '{"ok":true,"projects":{"rem-j7p":{' fields '}}}'
ApplyPanelReply(PanelReply('"report_unread":false,"waiting_on_alex":true,"lane":"Main","lane_order":2'), IsoAgo(0))
Refresh()
Expect("waiting on Alex: tan", ms.color " / " ms.label, "tan / Waiting on SQL")
Expect("waiting on Alex: tan tile", TileField("cli:main", "color") " / " TileField("cli:main", "action"), "tan / Waiting on SQL")
Expect("lane on the tile", TileField("cli:main", "lane"), 2)
ApplyPanelReply(PanelReply('"report_unread":true,"waiting_on_alex":false,"lane":null,"lane_order":null'), IsoAgo(0))
WriteChats("https://claude.ai/chat/abc-1|finished|0|" T9 "|1|1|abc")
Refresh()
Expect("unread: orange", ms.color " / " ms.label, "orange / Send cli")
Expect("null lane is none", TileField("cli:main", "lane"), 0)
ApplyPanelReply(PanelReply('"report_unread":false,"waiting_on_alex":false,"lane":"Main","lane_order":2'), IsoAgo(0))
Refresh()
Expect("archived: clears", ms.color " / " ms.label, "yellow / Your turn")
Expect("lane back", TileField("cli:main", "lane"), 2)
ApplyPanelReply("not json", IsoAgo(0))
ApplyPanelReply('{"ok":false,"error":"unauthorized"}', IsoAgo(0))
Refresh()
Expect("a bad reply keeps the lanes", TileField("cli:main", "lane"), 2)
; Old news is not trusted for what's waiting; the lanes are only an order, so they stay.
ApplyPanelReply(PanelReply('"report_unread":true,"waiting_on_alex":true,"lane":"Main","lane_order":2'), IsoAgo(400))
Refresh()
Expect("a stale read: no tan", ms.color != "tan", true)
Expect("a stale read: lanes stay", TileField("cli:main", "lane"), 2)
panelKnown := Map(), panelAt := "", panelLanes := Map()
Refresh()
page := FileRead(PANEL_DIR "\ui\switchboard.html", "UTF-8")
Expect("page draws pale orange, black text", InStr(page, ".t-paleorange{background:#FFCC80;color:#000}") > 0, true)
Expect("page outlines a blocked tile", InStr(page, ".tile.sendblocked") > 0, true)
Expect("page goes pale on the tap itself", InStr(page, 'cliTap === "send"') > 0, true)

; --- a red latch: a tap only clears it, even with a report waiting ------------------
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"waiting","since":"' IsoAgo(1) '","project":"main","red":false,"run_tag":"' T9 '","outside_scope":"undeclared update: a.js"}')
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(0) '"}')
WriteChats("https://claude.ai/chat/abc-1|finished|0|" T9 "|1|1|abc")
Refresh()
Expect("latch over a waiting report", ms.color " / " ms.label, "red / Outside scope")
arranged := [], actionCalls := []
ButtonClick("main")
Expect("latch tap arranges nothing", arranged.Length, 0)
Expect("latch tap types nothing", actionCalls.Length, 0)
Expect("latch tap leaves no send", ms.cliSend, "")
Step("waiting", IsoAgo(1), false, T9)
FileOpen(ms.reportMetaFile, "w", "UTF-8-RAW").Write('{"run_tag":"' T9 '","pushed_at":"' IsoAgo(0) '"}')
Refresh()
; Not a latch: Check CLI and Approve still go to VS Code.
Step("approval", IsoAgo(1), true, T9)
arranged := []
ButtonClick("main")
Expect("Approve still arranges", JoinCodes(arranged), "main|")
Step("waiting", IsoAgo(1), false, T9)
Refresh()
actionCalls := [], composerCalls := []
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
Expect("Claude writing drawn short green", TileField("cli:main", "color"), "greenshort")
; The plan guard's latch: red over a running CLI, from the status file.
FileOpen(statusPath, "w", "UTF-8-RAW").Write('{"state":"processing","since":"' IsoAgo(1) '","project":"main","red":false,"run_tag":"' T9 '","outside_scope":"undeclared update: a.js"}')
Refresh()
Expect("outside scope: red", ms.color " / " ms.label, "red / Outside scope")
Expect("outside scope tile", TileField("cli:main", "color"), "red")
Step("waiting", IsoAgo(1), false, T9)
Expect("latch gone: green again", ms.color, "green")
FileDelete(BRIDGE_DIR "\chats.json")
Refresh()
Expect("no chat file: grey", ms.color " / " ms.label, "grey / chat unknown")
Expect("no chat: terminal icon only", TileField("cli:main", "icon"), "cli")

; --- Send link: paste only into the project's window, only into Claude's input ------
; Main is bound to rem-j7p here, so its prompts are rem-j7p's.
SP := "Run tag: rem-j7p-s7-abcd`nWindow: the main checkout`n`nSay hi.`n`nRun tag: rem-j7p-s7-abcd"
WritePrompt(tag := "rem-j7p-s7-abcd") {
    FileOpen(BRIDGE_DIR "\prompt-rem-j7p.json", "w", "UTF-8-RAW").Write(ToJson({at: IsoAgo(0), id: "p1", project: "rem-j7p", tag: tag, text: SP}))
    FileOpen(BRIDGE_DIR "\sent.json", "w", "UTF-8-RAW").Write('{"rem-j7p":"' tag '"}')
}
savedWindows := fakeWindows
fakeWindows := [{hwnd: 801, title: "notes.md - " ms.folder " - Visual Studio Code"}, {hwnd: 802, title: "other - Visual Studio Code"}]
IniWrite("Message Claude", SETTINGS_INI, "send", "input")
IniWrite("2", SETTINGS_INI, "send", "deliverySeconds")
focusNow := {name: "Message Claude", helpText: "", className: ""}
pasted := [], keys := [], activated := []
focusReader := () => focusNow
keySender := (k) => keys.Push(k)
pasteSender := (text) => (pasted.Push(text), true)
windowIsActive := (h) => h = 801
Step("waiting", IsoAgo(5), false, "rem-j7p-s6-zzzz")
WritePrompt()
Refresh()
Expect("send: pasted the prompt once", pasted.Length = 1 && pasted[1] == SP, true)
Expect("send: into the project's window", JoinCodes(activated), "801|")
Expect("send: no focus key needed", keys.Length, 0)
Expect("send: prompt file taken", FileExist(BRIDGE_DIR "\prompt-rem-j7p.json"), "")
Step("waiting", IsoAgo(1), false, "rem-j7p-s7-abcd")
Expect("send: delivered, nothing pending", ms.label != "Not delivered" && ms.sendTag = "", true)

; Focus in an editor or terminal: one press of the focus key, then focus is read again.
; focusSeq: what each read returns; the last one repeats.
focusSeq := []
focusReader := () => focusSeq.Length > 1 ? focusSeq.RemoveAt(1) : focusSeq[1]
editorEl := {name: "Editor content", helpText: "", className: "inputarea monaco-mouse-cursor-text"}
termEl := {name: "Terminal 1, bash", helpText: "", className: "xterm-helper-textarea"}
focusSeq := [editorEl, {name: "Message Claude", helpText: "", className: ""}]
pasted := [], keys := []
Step("waiting", IsoAgo(5), false, "rem-j7p-s7-abcd")
WritePrompt("rem-j7p-s8-efgh")
Refresh()
Expect("editor, then input: pasted once", pasted.Length = 1 && pasted[1] == SP, true)
Expect("editor, then input: focus key once", JoinCodes(keys), "^{Esc}|")
Expect("editor, then input: no Not sent", InStr(ms.label, "Not sent"), 0)
Step("waiting", IsoAgo(1), false, "rem-j7p-s8-efgh")
focusSeq := [termEl]
pasted := [], keys := []
WritePrompt("rem-j7p-s9-ijkl")
Refresh()
Expect("terminal stays: nothing pasted", pasted.Length, 0)
Expect("terminal stays: focus key once", JoinCodes(keys), "^{Esc}|")
Expect("terminal stays: red Not sent", ms.color " / " ms.label
    , "red / Not sent: the focus could not be moved to Claude's input: focus is in an editor or terminal")
Expect("terminal stays: tag freed for a retry", FileRead(BRIDGE_DIR "\sent.json", "UTF-8") ~= "rem-j7p-s9-ijkl", 0)
Expect("terminal stays: the link is told why", DeliveryFile("rem-j7p")
    , "rem-j7p-s9-ijkl|0|the focus could not be moved to Claude's input: focus is in an editor or terminal")
ButtonClick("main")
Refresh()
Expect("a tap clears Not sent", InStr(ms.label, "Not sent"), 0)
focusReader := () => focusNow

; Two windows for the project: refuse, never guess.
focusNow := {name: "Message Claude", helpText: "", className: ""}
fakeWindows.Push({hwnd: 803, title: ms.folder " - Visual Studio Code"})
pasted := []
WritePrompt("rem-j7p-s9-ijkl")
Refresh()
Expect("two windows: nothing pasted", pasted.Length, 0)
Expect("two windows: red", ms.label, "Not sent: 2 VS Code windows are titled " ms.folder)
fakeWindows.Pop()
ButtonClick("main")

; Running: refused.
Step("processing", IsoAgo(5), false, "rem-j7p-s6-zzzz")
WritePrompt("rem-j7p-s10-mnop")
Refresh()
Expect("running: nothing pasted", pasted.Length, 0)
Expect("running: red", ms.label, "Not sent: the CLI is running")
ButtonClick("main")

; Pasted, but the prompt hook never records it: Not delivered.
Step("waiting", IsoAgo(5), false, "rem-j7p-s6-zzzz")
WritePrompt("rem-j7p-s11-qrst")
Refresh()
Expect("missing: pasted", pasted.Length, 1)
ms.sendAt -= 3000
Refresh()
Expect("missing: Not delivered", ms.color " / " ms.label, "red / Not delivered")
Expect("missing: the link is told", DeliveryFile("rem-j7p"), "rem-j7p-s11-qrst|0|the prompt never reached the CLI")
ButtonClick("main")

; Pasted, and the prompt hook records it: the link says Sent.
Step("waiting", IsoAgo(5), false, "rem-j7p-s6-zzzz")
WritePrompt("rem-j7p-s11-abab")
Refresh()
Expect("pasted: nothing told yet", DeliveryFile("rem-j7p"), "")
Step("processing", IsoAgo(1), false, "rem-j7p-s11-abab")
Expect("delivered: the link is told", DeliveryFile("rem-j7p"), "rem-j7p-s11-abab|1|")
Step("waiting", IsoAgo(5), false, "rem-j7p-s6-zzzz")

; No checkout for the project: refused, and the link still hears.
FileOpen(BRIDGE_DIR "\prompt-nobody-x1y.json", "w", "UTF-8-RAW").Write(ToJson({at: IsoAgo(0), id: "p2", project: "nobody-x1y", tag: "nobody-x1y-s1-cdcd", text: "x"}))
Refresh()
Expect("no checkout: the link is told", DeliveryFile("nobody-x1y"), "nobody-x1y-s1-cdcd|0|no checkout for nobody-x1y")

; The host or extension refused: shown from prompt-result.json.
FileOpen(BRIDGE_DIR "\prompt-result.json", "w", "UTF-8-RAW").Write('{"id":"ext-9","ok":false,"tag":"rem-j7p-s12-uvwx","project":"rem-j7p","error":"the link is in an older reply"}')
Refresh()
Expect("host refusal shown", ms.label, "Not sent: the link is in an older reply")
Refresh()
ButtonClick("main")
Refresh()
Expect("an old refusal is not shown again", ms.label != "Not sent: the link is in an older reply", true)
FileDelete(BRIDGE_DIR "\prompt-result.json")
FileDelete(BRIDGE_DIR "\sent.json")
fakeWindows := savedWindows

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
FileDelete(BRIDGE_DIR "\chats.json")    ; abc-1 issued a rem-j7p tag, and that would win
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

; --- rebound again: the new chat's title has no code, but it issued the run tag ------
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"rem-j7p"}')
Refresh()
FileOpen(BINDING_FILE, "w", "UTF-8-RAW").Write('{"code":"next-q2z"}')
FileOpen(BRIDGE_DIR "\tabs.json", "w", "UTF-8-RAW").Write('{"at":"' IsoAgo(0) '","tabs":[{"tabId":3,"url":"https://claude.ai/chat/learned","title":"rem-j7p plan - Claude"},{"tabId":5,"url":"https://claude.ai/chat/untitled","title":"Claude"}]}')
WriteChats("https://claude.ai/chat/abc-1|finished|4|" T9 "|1|1|abc", "https://claude.ai/chat/untitled|finished|1|next-q2z-s1-ab12|1|5|")
Refresh()
Expect("rebind pairs with the chat that issued the tag", ms.chatLink, "https://claude.ai/chat/untitled")
Expect("tag-learned link saved for the new code", IniRead(SETTINGS_INI, "chatlinkcode", "main", ""), "next-q2z")
Expect("paired chat has no tile of its own", TileOf("chat:5").Count, 0)
FileDelete(BRIDGE_DIR "\chats.json")
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

Expect("real settings.ini untouched", FileExist(realIni) ? FileGetTime(realIni, "M") : "", realIniTime)

FileAppend(fails ? fails " failed`n" : "smoke passed`n", "*")
ExitApp(fails ? 1 : 0)

Trap(e, *) {
    FileAppend("ERROR " e.Message " | " e.What " | line " e.Line "`n", "*")
    ExitApp(3)
}
