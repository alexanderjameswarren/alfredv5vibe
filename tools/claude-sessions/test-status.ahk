; Run: AutoHotkey64.exe /ErrorStdOut test-status.ahk   (exit code 0 = all passed)
#Requires AutoHotkey v2.0
#Warn All, StdOut
#Include lib\status.ahk

fails := 0
Check(name, got, want) {
    global fails
    if (got !== want) {
        fails++
        FileAppend("FAIL " name ": got [" got "] want [" want "]`n", "*")
    }
}

denial := '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"timestamp":"2026-09-30T19:30:44.198Z"}'
esc := '{"type":"user","message":{"role":"user","content":"[Request interrupted by user]"},"timestamp":"2026-09-30T19:40:00.000Z"}'
quoted := '{"type":"assistant","message":{"content":[{"type":"text","text":"look for \"text\":\"[Request interrupted by user"}]},"timestamp":"2026-09-30T19:50:00.000Z"}'

Check("denial after since", FindInterrupt(denial, "2026-09-30T19:30:16.757Z"), "2026-09-30T19:30:44.198Z")
Check("denial before since", FindInterrupt(denial, "2026-09-30T19:31:00.000Z"), "")
Check("esc, string content", FindInterrupt(esc, "2026-09-30T19:39:00.000Z"), "2026-09-30T19:40:00.000Z")
Check("quoted text ignored", FindInterrupt(quoted, "2026-09-30T19:00:00.000Z"), "")
Check("latest wins", FindInterrupt(denial "`r`n" esc, "2026-09-30T19:00:00.000Z"), "2026-09-30T19:40:00.000Z")

Check("stamp", IsoToStamp("2026-09-30T19:30:44.198Z"), "20260930193044")
Check("elapsed m:ss", FormatElapsed(75), "1:15")
Check("elapsed h:mm:ss", FormatElapsed(3725), "1:02:05")
Check("entered today", FormatEntered("2026-09-30T19:30:44.198Z", -25200, "20260930"), "12:30")
Check("entered other day", FormatEntered("2026-09-29T19:30:44.198Z", -25200, "20260930"), "29 Sep 12:30")

Check("kind none", KindOf(false, "", false, false), "none")
Check("kind red latch", KindOf(true, "waiting", true, false), "red")
Check("kind interrupted", KindOf(true, "approval", true, true), "waiting")
Check("kind processing", KindOf(true, "processing", false, false), "processing")

Check("taskbar red", TaskbarFlag(["green", "red", "yellow"]), 4)
Check("taskbar purple is yellow", TaskbarFlag(["green", "purple"]), 8)
Check("taskbar orange is yellow", TaskbarFlag(["orange", "green"]), 8)
Check("taskbar green", TaskbarFlag(["grey", "green"]), 2)
Check("taskbar none", TaskbarFlag(["grey"]), 0)

Check("alert red", ShouldAlert("green", "red"), true)
Check("alert finish", ShouldAlert("green", "yellow"), true)
Check("alert purple", ShouldAlert("orange", "purple"), true)
Check("no alert to green", ShouldAlert("yellow", "green"), false)
Check("no alert to grey", ShouldAlert("green", "grey"), false)
Check("no alert first read", ShouldAlert("", "red"), false)

; --- the state model (bridge spec, section 5) ---
P(kind, chatState := "finished", opts := "") {
    fields := {free: false, closed: false, paused: false, kind: kind, runTag: "proj-abc-s9-aaaa", reportTag: "proj-abc-s9-aaaa"
        , reportAt: "2026-10-03T10:00:00.000Z", chatState: chatState, chatSince: "2026-10-03T10:05:00.000Z"
        , issuedTag: "", project: "proj-abc"}
    if IsObject(opts)
        for key, val in opts.OwnProps()
            fields.%key% := val
    return ViewOf(fields)
}
V(view) => view.color " / " view.label
Check("view approve", V(P("red")), "red / Approve")
Check("view check cli", V(P("waiting", , {reportTag: "proj-abc-s8-zzzz"})), "red / Check CLI")
Check("view no tag, no check", V(P("waiting", , {runTag: "", reportTag: ""})), "yellow / Your turn")
Check("view cli working", V(P("processing", "finished")), "green / CLI working")
Check("view claude writing", V(P("waiting", "responding")), "green / Claude writing")
Check("view both", V(P("processing", "responding")), "green / Both working")
Check("view send cli", V(P("waiting", , {chatSince: "2026-10-03T09:59:00.000Z"})), "orange / Send cli")
Check("view paste prompt", V(P("waiting", , {issuedTag: "proj-abc-s10-bbbb"})), "purple / Paste prompt")
Check("view other project's tag", V(P("waiting", , {issuedTag: "other-xyz-s10-bbbb"})), "yellow / Your turn")
Check("view your turn", V(P("waiting")), "yellow / Your turn")
Check("view chat unknown", V(P("waiting", "unknown")), "grey / chat unknown")
Check("view unpaired", V(P("waiting", "")), "grey / chat unknown")
Check("view paused", V(P("processing", , {paused: true})), "paused / paused")
Check("view no status", V(P("none")), "none / no status")

centre := WindowCentre(-8, -8, 1936, 1056)
Check("centre, monitor 1", centre.x "," centre.y, "960,520")
centre := WindowCentre(1912, -8, 1296, 2072)
Check("centre, monitor 2", centre.x "," centre.y, "2560,1028")
centre := WindowCentre(-1288, 200, 1280, 800)
Check("centre, monitor left of the main one", centre.x "," centre.y, "-648,600")
Check("keyboard: red to VS Code", FocusTarget("red", "Check CLI"), "code")
Check("keyboard: CLI working to VS Code", FocusTarget("green", "CLI working"), "code")
Check("keyboard: both working to VS Code", FocusTarget("green", "Both working"), "code")
Check("keyboard: Claude writing to Chrome", FocusTarget("green", "Claude writing"), "chrome")
Check("keyboard: purple to Chrome", FocusTarget("purple", "Paste prompt"), "chrome")
Check("keyboard: orange to Chrome", FocusTarget("orange", "Send cli"), "chrome")
Check("keyboard: grey to Chrome", FocusTarget("grey", "chat unknown"), "chrome")

Check("step", StepOf("proj-abc-s9b-x1y2"), "s9b")
Check("tag project", ProjectOfTag("switchboard_bridge-p8v-s10-g5wy"), "switchboard_bridge-p8v")
Check("step text", StepText("proj-abc-s9-aaaa", "", "proj-abc"), "s9")
Check("step text newer", StepText("proj-abc-s9-aaaa", "proj-abc-s10-bbbb", "proj-abc"), "s9 -> s10")
Check("step text same", StepText("proj-abc-s9-aaaa", "proj-abc-s9-aaaa", "proj-abc"), "s9")

Check("row writing", V(ChatRowView("responding", "", "")), "green / Claude writing")
Check("row finished unseen", V(ChatRowView("finished", "2026-10-03T10:05:00Z", "2026-10-03T10:00:00Z")), "yellow / finished")
Check("row finished seen", V(ChatRowView("finished", "2026-10-03T10:05:00Z", "2026-10-03T10:06:00Z")), "grey / seen")
Check("row unknown", V(ChatRowView("unknown", "", "")), "grey / unknown")

progressText := "# P`n- [x] **1. Plan.** done`n  - [ ] nested, not a step`n- [ ] **2. Host and install.** Written`n- [ ] **3. Third.**`n"
Check("progress summary", ProgressSummary(progressText), "Step 2 of 3: Host and install")
Check("progress all done", ProgressSummary("- [x] a`n- [x] b"), "Step 2 of 2: done")
Check("progress none", ProgressSummary("no steps"), "")
Check("project name", ProjectName("switchboard_bridge-p8v"), "switchboard_bridge")
learnTabs := [Map("url", "https://claude.ai/chat/z?x", "title", "proj-abc plan - Claude"), Map("url", "https://x/", "title", "proj-abc - Claude")]
Check("learn link", FindChatLinkByCode(learnTabs, "proj-abc"), "https://claude.ai/chat/z")
Check("learn nothing", FindChatLinkByCode(learnTabs, "other"), "")

Check("code title", CodeTitleMatches("switchboard-k7w", "", "claude-sessions.ahk - switchboard-k7w - Visual Studio Code"), true)
Check("code title, folder only", CodeTitleMatches("alfred-v5", "", "alfred-v5 - Visual Studio Code"), true)
Check("code title, not a substring", CodeTitleMatches("alfred-v5", "", "x - alfred-v5-old - Visual Studio Code"), false)
Check("code title, file named like it", CodeTitleMatches("k7w", "", "k7w.md - switchboard-k7w - Visual Studio Code"), false)
Check("code title override", CodeTitleMatches("alfred-v5", "my text", "my text - Visual Studio Code"), true)
Check("chrome title", ChromeTitleMatches("switchboard-k7w", "", "switchboard-k7w build - Claude - Google Chrome"), true)
Check("chrome title needs Claude", ChromeTitleMatches("switchboard-k7w", "", "switchboard-k7w - GitHub - Google Chrome"), false)
Check("chrome override", ChromeTitleMatches("x", "Panel chat", "Panel chat - Claude - Google Chrome"), true)
Check("first match", FirstMatch([{hwnd: 1, title: "a"}, {hwnd: 2, title: "b"}], (t) => t = "b"), 2)
Check("first match none", FirstMatch([], (t) => true), 0)
Check("resume uri", ResumeUri("64faa3c6-f1f8-43af-840c-2a21141f081e"), "vscode://anthropic.claude-code/open?session=64faa3c6-f1f8-43af-840c-2a21141f081e")
Check("resume uri bad id", ResumeUri("nope"), "")
Check("chat link", IsChatLink("https://claude.ai/chat/abc-123"), true)
Check("chat link other site", IsChatLink("https://example.com/chat"), false)

Check("address bare https", ChatLinkFromAddress("claude.ai/chat/8e26d69a-9511"), "https://claude.ai/chat/8e26d69a-9511")
Check("address full https", ChatLinkFromAddress("https://claude.ai/chat/abc"), "https://claude.ai/chat/abc")
Check("address http refused", ChatLinkFromAddress("http://claude.ai/chat/abc"), "")
Check("address other claude page", ChatLinkFromAddress("claude.ai/new"), "")
Check("address other site", ChatLinkFromAddress("mail.google.com/mail/u/1"), "")
Check("address lookalike", ChatLinkFromAddress("evil.com/claude.ai/chat/abc"), "")
Check("address empty", ChatLinkFromAddress(""), "")
Check("auto save on auto match", AutoSaveLink("", "claude.ai/chat/abc"), "https://claude.ai/chat/abc")
Check("no auto save with typed title", AutoSaveLink("Panel chat", "claude.ai/chat/abc"), "")

Check("count lines", CountLines(" M a.js`r`n?? b.js`n"), 2)
Check("count none", CountLines(""), 0)
Check("age minutes", FormatAge(12), "12m")
Check("age hours", FormatAge(125), "2h05m")
claimsX := [Map("item", "db:deploy", "owner", "sam-x", "claimed_at", "2026-10-01T08:00:00.000Z")
    , Map("item", "db:table:inbox", "owner", "k7w", "claimed_at", "2026-10-01T09:50:00.000Z")
    , Map("item", "docs/a.md", "owner", "k7w", "claimed_at", "2026-10-01T09:00:00.000Z")]
db := DbStrip(claimsX, "20261001100000")
Check("db strip text", db.text, "db: deploy · sam-x 2h00m | table:inbox · k7w 10m")
Check("db strip red past an hour", db.red, true)
Check("db strip free", DbStrip([claimsX[3]], "20261001100000").text, "db: free")
Check("db strip not red", DbStrip([claimsX[2]], "20261001100000").red, false)
Check("main strip", MainStrip("rem-j7p"), "main: rem-j7p")
Check("main strip free", MainStrip(""), "main: free")
Check("button main bound", ButtonName("main", "rem-j7p"), "main · rem-j7p")
Check("button main free", ButtonName("main", ""), "main")
Check("button worktree", ButtonName("k7w", "rem-j7p"), "k7w")
Check("chat code main bound", ChatCode("main", "rem-j7p"), "rem-j7p")
Check("chat code main free", ChatCode("main", ""), "main")
Check("chat code worktree", ChatCode("k7w", "rem-j7p"), "k7w")
Check("main free", IsFree("main", ""), true)
Check("main bound not free", IsFree("main", "rem-j7p"), false)
Check("worktree never free", IsFree("k7w", ""), false)
Check("link same code", StaleChatLink("https://claude.ai/chat/a", "rem-j7p", "rem-j7p"), false)
Check("link rebound", StaleChatLink("https://claude.ai/chat/a", "rem-j7p", "next-q2z"), true)
Check("link no code", StaleChatLink("https://claude.ai/chat/a", "", "rem-j7p"), true)
Check("no link", StaleChatLink("", "", "rem-j7p"), false)
Check("flashes 5", StillFlashing(4), true)
Check("then solid", StillFlashing(5), false)
Check("stamp key missing file", StampKey([A_Temp "\no-such-file-xyz.json"]), "|")
orphanList := Orphans([Map("owner", "zz-orphan"), Map("owner", "k7w"), Map("owner", "main")], [Map("owner", "zz-orphan")]
    , ["k7w", "old-x"], Map("k7w", "20261001090000", "old-x", "20260927090000"), "20261001100000")
Check("orphans", orphanList.Length = 2 ? orphanList[1] " / " orphanList[2] : orphanList.Length,"zz-orphan (2 held, no worktree) / old-x (idle 4d)")
wtDir := A_Temp "\claude-sessions-wt-test"
try DirDelete(wtDir, true)
DirCreate(wtDir "\live"), DirCreate(wtDir "\left")
FileAppend("gitdir: x", wtDir "\live\.git")
Check("worktree with .git", IsWorktreeDir(wtDir "\live"), true)
Check("leftover folder", IsWorktreeDir(wtDir "\left"), false)
Check("missing folder", IsWorktreeDir(wtDir "\none"), false)
DirDelete(wtDir, true)
Check("unread", IsUnread("20261001100000", "20261001090000"), true)
Check("read", IsUnread("20261001080000", "20261001090000"), false)
Check("no report", IsUnread("", "20261001090000"), false)

Check("url query and fragment dropped", NormaliseUrl("https://claude.ai/chat/a?x=1#y"), "https://claude.ai/chat/a")
Check("fresh at 45 s", IsFresh("2026-10-02T10:00:00.000Z", "20261002100045"), true)
Check("stale at 46 s", IsFresh("2026-10-02T10:00:00.000Z", "20261002100046"), false)
Check("no at is stale", IsFresh("", "20261002100000"), false)
tabList := [Map("tabId", 1, "url", "https://claude.ai/chat/a"), Map("tabId", 2, "url", "https://claude.ai/chat/b")]
Check("tab by link", FindTabByLink(tabList, "https://claude.ai/chat/b?x").Get("tabId"), 2)
Check("no tab for link", FindTabByLink(tabList, "https://claude.ai/chat/c"), "")
Check("no link, no tab", FindTabByLink(tabList, ""), "")
Check("window title prefix", WindowTitleStarts("Plan - Claude", "Plan - Claude - Google Chrome"), true)
Check("window title other", WindowTitleStarts("Plan - Claude", "Other - Google Chrome"), false)
Check("empty title never matches", WindowTitleStarts("", "Anything"), false)

left := {l: 0, t: 0, r: 1920, b: 1080}, right := {l: 1920, t: 0, r: 3840, b: 1080}
touchMon := {l: -974, t: 1080, r: 50, b: 1680}
Check("touch found", TouchMonitor([left, right, touchMon]), 3)
Check("no touch", TouchMonitor([left, right]), 0)
fb := FenceBox([left, touchMon, right])
Check("fence skips touch", fb.l "," fb.t "," fb.r "," fb.b, "0,0,3840,1080")
Check("no fence without touch", FenceBox([left, right]), "")
Check("no fence, touch only", FenceBox([touchMon]), "")

Check("tile colour kept", TileColor("purple"), "purple")
Check("tile colour grey", TileColor("paused"), "grey")
Ids(list) {
    s := ""
    for t in list
        s .= t.id
    return s
}
Tl(id, group, color) => {id: id, group: group, color: color}
mixed := [Tl("a", 0, "green"), Tl("b", 0, "red"), Tl("c", 1, "yellow"), Tl("d", 2, "grey"), Tl("e", 0, "grey"), Tl("f", 0, "purple"), Tl("g", 3, "grey"), Tl("h", 0, "orange"), Tl("i", 0, "yellow")]
Check("sort: group, then colour", Ids(TileSort(mixed, Map())), "bhfiaecdg")
Check("sort: ties keep previous order", Ids(TileSort([Tl("x", 0, "yellow"), Tl("y", 0, "yellow")], Map("y", 1, "x", 2))), "yx")
Check("sort: new tiles after known", Ids(TileSort([Tl("n", 0, "yellow"), Tl("k", 0, "yellow")], Map("k", 1))), "kn")
Check("tile name worktree", TileName("switchboard_touch-t4n", ""), "switchboard_touch")
Check("tile name free main", TileName("main", ""), "main")
Check("tile name bound main", TileName("main", "rem-j7p"), "main · rem")
Check("tile step plain", TileStep("s9"), "s9")
Check("tile step handover", TileStep("s10 -> s11") "|" TileStep("? -> s2"), "→s11|→s2")
Cmd(type, id) => (c := TouchCommand(type, id)).do ":" c.key
Check("tap cli", Cmd("tap", "cli:switchboard_touch-t4n"), "click:switchboard_touch-t4n")
Check("tap chat", Cmd("tap", "chat:1477446406"), "chat:1477446406")
Check("hold cli pauses", Cmd("hold", "cli:main"), "pause:main")
Check("hold chat ignored", Cmd("hold", "chat:9"), "none:")
Check("tap orphan ignored", Cmd("tap", "orphan:gone-x1y"), "none:")
Check("refresh git", Cmd("git", ""), "git:")
Check("unknown ignored", Cmd("jump", ""), "none:")
Check("top bar moves", Cmd("move", ""), "move:")
Check("right-click cli", Cmd("menu", "cli:main"), "menu:main")
Check("right-click chat ignored", Cmd("menu", "chat:9"), "none:")
Place(p) => p.mode " " p.noTouch " " p.x "," p.y " " p.w "x" p.h " " p.zoom
primaryMon := {l: 0, t: 0, r: 1920, b: 1080}, otherMon := {l: 1920, t: 0, r: 3840, b: 1080}, touchScreen := {l: -1024, t: 470, r: 0, b: 1070}
Check("docked", Place(TouchPlacement([primaryMon, otherMon, touchScreen], "touch", 1)), "touch 0 -1024,470 1024x600 1")
Check("main mode, centred", Place(TouchPlacement([primaryMon, otherMon, touchScreen], "main", 1)), "main 0 320,165 1280x750 1.25")
Check("main mode, 150% scale fits", Place(TouchPlacement([primaryMon, otherMon, touchScreen], "main", 1, 1.5)), "main 0 130,54 1659x972 1.08")
Check("no touch screen", Place(TouchPlacement([primaryMon, otherMon], "touch", 1)), "main 1 320,165 1280x750 1.25")
Check("primary is the touch screen", Place(TouchPlacement([touchScreen, primaryMon], "main", 1)), "main 0 320,165 1280x750 1.25")
Apps(list) => (a := AppMonitors(list)).code "," a.chrome
Check("apps: today's layout", Apps([primaryMon, otherMon, touchScreen]), "1,2")
Check("apps: renumbered after replug", Apps([touchScreen, otherMon, primaryMon]), "3,2")
Check("apps: right monitor numbered first", Apps([otherMon, primaryMon]), "2,1")
Check("apps: one main monitor", Apps([touchScreen, primaryMon]), "2,2")
Check("apps: three main monitors", Apps([otherMon, {l: -1920, t: 0, r: 0, b: 1080}, primaryMon]), "2,1")
Check("apps: touch screen only", Apps([touchScreen]), "1,1")
Check("next mode", NextTouchMode("touch", true) "|" NextTouchMode("main", true) "|" NextTouchMode("main", false), "main|touch|main")
Check("icons", TileIcon("cli", false) "|" TileIcon("cli", true) "|" TileIcon("chat", false) "|" TileIcon("orphan", false), "cli|both|chat|")
Check("short age", ShortAge(5) "|" ShortAge(130) "|" ShortAge(3000), "5m|2h|2d")
ActionArgs(label, more := "") {
    fields := {color: "", label: label, kind: "waiting", free: false, closed: false, paused: false, elapsed: 221, age: 130}
    if more != ""
        fields.%more% := true
    return fields
}
Check("action working", CliAction(ActionArgs("CLI working")), "Working 3:41")
Check("action approve", CliAction(ActionArgs("Approve")), "Approve")
Check("action chat writing", CliAction(ActionArgs("Claude writing")), "Chat writing")
Check("action paused", CliAction(ActionArgs("Your turn", "paused")), "Paused 2h")
Check("action closed", CliAction(ActionArgs("Your turn", "closed")), "Closed, tap to reopen")
Check("action free", CliAction(ActionArgs("free", "free")), "Free")
Check("chat action ready", ChatAction("finished") "|" ChatAction("Claude writing") "|" ChatAction("seen"), "Reply ready|Writing|Seen")
oo := OrphanOwners([Map("owner", "gone-x1y"), Map("owner", "main"), Map("owner", "live-a1b")], [Map("owner", "gone-x1y")], ["live-a1b"])
Check("orphan owners", oo.Length = 1 ? oo[1].owner " " oo[1].n : oo.Length, "gone-x1y 2")
Check("idle under 3 days", IdleDays("20261001000000", "20261003000000"), 0)
Check("idle over 3 days", IdleDays("20261001000000", "20261005120000"), 4)
Check("json", ToJson(Map("a", 1, "b", ["q", 2], "c", 'say "hi"`n'))
    , '{"a":1,"b":["q",2],"c":"say \"hi\"\n"}')
Check("json control char", ToJson("x`ay"), '"x\u0007y"')

; #Warn only prints, so load this file again with /validate and fail on any warning.
warnOut := A_Temp "\claude-sessions-test-warnings.txt"
RunWait(A_ComSpec ' /c ""' A_AhkPath '" /ErrorStdOut /validate "' A_ScriptFullPath '" > "' warnOut '" 2>&1"', , "Hide")
Check("loads with no warnings", Trim(FileRead(warnOut), " `r`n"), "")

FileAppend(fails ? fails " failed`n" : "all passed`n", "*")
ExitApp(fails ? 1 : 0)
