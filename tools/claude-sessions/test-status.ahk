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
Check("view report ready", V(P("waiting", , {chatSince: "2026-10-03T09:59:00.000Z"})), "orange / Report ready")
Check("view prompt to paste", V(P("waiting", , {issuedTag: "proj-abc-s10-bbbb"})), "purple / Prompt to paste")
Check("view other project's tag", V(P("waiting", , {issuedTag: "other-xyz-s10-bbbb"})), "yellow / Your turn")
Check("view your turn", V(P("waiting")), "yellow / Your turn")
; Precedence: Waiting on SQL, Prompt to paste, Report ready, Running, Your turn; reds over all.
Check("view prompt beats running", V(P("processing", , {issuedTag: "proj-abc-s10-bbbb"})), "purple / Prompt to paste")
Check("view prompt beats report", V(P("waiting", , {issuedTag: "proj-abc-s10-bbbb", chatSince: "2026-10-03T09:59:00.000Z"})), "purple / Prompt to paste")
Check("view sql beats prompt", V(P("waiting", , {issuedTag: "proj-abc-s10-bbbb", sqlWaiting: true})), "tan / Waiting on SQL")
Check("view outside scope while running", V(P("processing", , {outsideScope: "undeclared update: a.js"})), "red / Outside scope")
Check("view outside scope beats sql", V(P("waiting", , {outsideScope: "x", sqlWaiting: true})), "red / Outside scope")
Check("view approve beats outside scope", V(P("red", , {outsideScope: "x"})), "red / Approve")
Check("taskbar tan is yellow", TaskbarFlag(["tan", "green"]), 8)
Check("alert your turn", ShouldAlert("green", "yellow"), true)
Check("alert report ready", ShouldAlert("green", "orange"), true)
Check("tile colour blue is grey", TileColor("blue"), "grey")
Check("tile colour tan", TileColor("tan"), "tan")
Check("view chat unknown", V(P("waiting", "unknown")), "grey / chat unknown")
Check("view unpaired", V(P("waiting", "")), "grey / chat unknown")
Check("view paused", V(P("processing", , {paused: true})), "paused / paused")
Check("view no status", V(P("none")), "none / no status")
Check("view wrong window", V(P("wrong")), "red / Wrong window")
Check("view already pasted", V(P("wrong", , {event: "duplicate run tag"})), "red / Already pasted")
Check("view wrong, other event", V(P("wrong", , {event: "UserPromptSubmit"})), "red / Wrong window")
Check("kind wrong beats red", KindOf(true, "wrong", true, false), "wrong")
; Reported means pushed after the last typed prompt, tagged or not.
Check("view prompt, no report since", V(P("waiting", , {promptAt: "2026-10-03T10:01:00.000Z"})), "red / Check CLI")
Check("view tagged report since", V(P("waiting", , {promptAt: "2026-10-03T09:00:00.000Z"})), "yellow / Your turn")
Check("view untagged reply", V(P("waiting", , {promptAt: "2026-10-03T09:00:00.000Z", reportTag: ""})), "orange / Reply (untagged)")
Check("view untagged reply, next message sent", V(P("processing", , {promptAt: "2026-10-03T10:30:00.000Z", reportTag: ""})), "green / CLI working")

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
Check("keyboard: purple to Chrome", FocusTarget("purple", "Prompt to paste"), "chrome")
Check("keyboard: orange to Chrome", FocusTarget("orange", "Report ready"), "chrome")
Check("keyboard: your turn to Chrome", FocusTarget("yellow", "Your turn"), "chrome")
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
tagChats := [Map("url", "https://claude.ai/chat/old", "issuedTag", "proj-abc-s1-aaaa")
    , Map("url", "https://claude.ai/chat/new?x", "issuedTag", "proj-abc-s2-bbbb")
    , Map("url", "https://claude.ai/chat/none", "issuedTag", "")
    , Map("url", "https://x/", "issuedTag", "other-xyz-s1-cccc")]
Check("tag: exact run tag wins", FindChatLinkByTag(tagChats, "proj-abc-s2-bbbb", "proj-abc"), "https://claude.ai/chat/new")
Check("tag: else the project's", FindChatLinkByTag(tagChats, "", "proj-abc"), "https://claude.ai/chat/old")
Check("tag: other project", FindChatLinkByTag(tagChats, "", "next-q2z"), "")
Check("tag: old project's run tag ignored", FindChatLinkByTag(tagChats, "proj-abc-s2-bbbb", "next-q2z"), "")
Check("tag: not a chat address", FindChatLinkByTag(tagChats, "other-xyz-s1-cccc", "other-xyz"), "")
Check("tag: no project, no run tag", FindChatLinkByTag(tagChats, "", ""), "")

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
Check("sort: group, then arrival, never colour", Ids(TileSort(mixed, Map())), "abefhicdg")
Check("sort: a colour change does not move a tile", Ids(TileSort([Tl("x", 0, "red"), Tl("y", 0, "green")], Map("y", 1, "x", 2))), "yx")
Check("sort: a removed tile closes the gap", Ids(TileSort([Tl("a", 0, "red"), Tl("c", 0, "red")], Map("a", 1, "b", 2, "c", 3))), "ac")
Check("sort: ties keep previous order", Ids(TileSort([Tl("x", 0, "yellow"), Tl("y", 0, "yellow")], Map("y", 1, "x", 2))), "yx")
Check("sort: new tiles after known", Ids(TileSort([Tl("n", 0, "yellow"), Tl("k", 0, "yellow")], Map("k", 1))), "kn")
Codes(list) {
    s := ""
    for c in list
        s .= c " "
    return Trim(s)
}
startsX := Map("b-1", "20261012090000", "c-2", "20261011090000", "a-3", "", "main", "20261010090000")
Check("startup: main, then oldest session first, then unknown by name", Codes(StartupOrder(["main", "a-3", "b-1", "c-2", "d-4"], startsX)), "main c-2 b-1 a-3 d-4")
Check("startup: no starts known, by name", Codes(StartupOrder(["main", "z-1", "m-2"], Map())), "main m-2 z-1")
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
Check("tap orphan: the page opens its panel", Cmd("tap", "orphan:gone-x1y"), "none:")
Check("release orphan", Cmd("release", "orphan:gone-x1y"), "release:gone-x1y")
Check("release a cli tile ignored", Cmd("release", "cli:main"), "none:")
Check("release a strange owner ignored", Cmd("release", 'orphan:x" & del'), "none:")
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
oi := OrphanOwners([Map("owner", "gone-x1y", "item", "docs/a.md")], [Map("owner", "gone-x1y", "item", "db:deploy")], [])
Check("orphan items for the panel", oi[1].items[1] "|" oi[1].items[2], "docs/a.md|db:deploy (reserved)")
Check("idle under 3 days", IdleDays("20261001000000", "20261003000000"), 0)
Check("idle over 3 days", IdleDays("20261001000000", "20261005120000"), 4)
Check("json", ToJson(Map("a", 1, "b", ["q", 2], "c", 'say "hi"`n'))
    , '{"a":1,"b":["q",2],"c":"say \"hi\"\n"}')
Check("json control char", ToJson("x`ay"), '"x\u0007y"')
Check("orphan gone once it holds nothing", OrphanOwners([Map("owner", "main")], [], []).Length, 0)

; --- claim blocks: the same cases as scripts\lib\claim-blocks.test.mjs ---
Cl(owner, item) => Map("owner", owner, "item", item)
Bk(waiter, holder, item) => Map("waiter", waiter, "holder", holder, "item", item)
Check("overlap same, any case", ItemsOverlap("src/A.js", "src/a.js"), true)
Check("overlap folder", ItemsOverlap("src/", "src/a.js") && ItemsOverlap("src/a.js", "src/"), true)
Check("overlap folder named bare", ItemsOverlap("src/items/", "src/items"), true)
Check("no overlap sibling", ItemsOverlap("src/items/", "src/items-old/a.js"), false)
Check("no overlap db", ItemsOverlap("db:deploy", "db:deploy/"), false)
claimsB := [Cl("h", "src/"), Cl("w", "lib/x.js")]
liveB := LiveBlocks([Bk("w", "h", "src/a.js"), Bk("w", "gone", "src/b.js"), Bk("x", "h", "docs/z.md")], claimsB)
Check("live: holder still holds it", liveB.Length = 1 ? liveB[1]["holder"] : liveB.Length, "h")

bnames := BlockNames(["main", "restructure_p1-h4nz"], "claim_blocks-h3n")
Check("block names: main by its project alone", bnames["main"] " / " BlockName(bnames, "restructure_p1-h4nz"), "claim_blocks / restructure p1")
Check("block names: unbound main", BlockNames(["main"], "")["main"], "main")
Line(owner, view, step := "s3b", git := "") {
    r := BlockLine({owner: owner, view: view, names: bnames, step: step, git: git})
    return r.blocked "|" r.step "|" r.git "|" r.note "|" r.icon
}
chain := BlockView([Bk("restructure_p1-h4nz", "main", "src/b.js"), Bk("x", "restructure_p1-h4nz", "src/a.js")])
Check("waiter: padlock and main's project", Line("restructure_p1-h4nz", chain), "1|||claim blocks|lock")
Check("holder line", Line("main", chain), "0|s3b||· Blocking 1|none")
Check("holder keeps git when it fits", Line("main", chain, "s3", "±2"), "0|s3|±2|· Blocking 1|none")
Check("holder drops git when it does not", Line("main", chain, "s11", "±12 ↑3"), "0|s11||· Blocking 1|none")
Check("untouched tile keeps its icon", Line("other", chain, "s2", "±1"), "0|s2|±1||")
two := BlockView([Bk("a", "b", "src/x.js"), Bk("b", "a", "src/y.js"), Bk("c", "a", "src/y.js")])
Check("deadlock", Line("a", two), "1|||⇄ b|none")
Check("deadlock: other side", Line("b", two), "1|||⇄ a|none")
Check("not in the deadlock", Line("c", two), "1|||a|lock")
three := BlockView([Bk("a", "b", "1.js"), Bk("b", "c", "2.js"), Bk("c", "a", "3.js")])
Check("three-ring", Line("a", three) " / " Line("c", three), "1|||⇄ b|none / 1|||⇄ a|none")
Check("blocking count", BlockView([Bk("a", "h", "1.js"), Bk("b", "h", "2.js"), Bk("a", "h", "3.js")])["h"].waiters, 2)
; At real width; parts are joined by en spaces (14px, counted as 8 + 6).
for fitText in ["⇄ restructure p1", "s11 · Blocking 1", "1 held · Blocking 1"]
    Check("fits: " fitText, TileTextWidth(fitText) + 6 * 2 <= TileInfoWidth("none"), true)
for fitText in ["restructure p1", "claim blocks", "warren buffet"]
    Check("fits beside the padlock: " fitText, TileTextWidth(fitText) <= TileInfoWidth("lock"), true)
Check("status command", Cmd("status", ""), "status:")
Check("status monitor: primary", StatusMonitor([{l: 0, t: 0, r: 1920, b: 1080}, {l: -1024, t: 0, r: 0, b: 600}], 1), 1)
Check("status monitor: never touch", StatusMonitor([{l: -1024, t: 0, r: 0, b: 600}, {l: 0, t: 0, r: 1920, b: 1080}], 1), 2)

; The button's two lines, moved out of the panel (0.7).
bl := {unread: true, changed: 3, ahead: "", free: true, kind: "", closed: false, paused: false
    , interruptAt: "", since: "", state: "", step: "", label: ""}
Check("label free", ButtonLabel(bl, "main", 0, "20260930193115"), "main   • new   ±3`nfree")
bl.free := false, bl.unread := false, bl.changed := "", bl.ahead := 2, bl.kind := "none"
Check("label no status", ButtonLabel(bl, "x", 0, "20260930193115"), "x   ↑2`nno status")
bl.ahead := "", bl.kind := "processing", bl.since := "2026-09-30T19:30:00.000Z", bl.step := "s9", bl.label := "Claude working"
Check("label processing", ButtonLabel(bl, "x", 0, "20260930193115"), "x`ns9 · Claude working · 1:15")
bl.kind := "waiting", bl.state := "waiting", bl.since := "2026-09-29T19:30:44.198Z", bl.closed := true, bl.paused := true
Check("label closed paused", ButtonLabel(bl, "x", -25200, "20260930193115"), "x`nclosed · paused · waiting 29 Sep 12:30")
bl.closed := false, bl.paused := false, bl.interruptAt := "2026-09-29T19:30:44.198Z", bl.step := "", bl.label := "Your turn"
Check("label interrupted", ButtonLabel(bl, "x", -25200, "20260930193115"), "x`nYour turn · interrupted 29 Sep 12:30")
Check("git text both", GitText(3, 2), "±3 ↑2")
Check("git text ahead only", GitText("", 2), "↑2")
Check("git text none", GitText(0, ""), "")
Check("chat row title", ChatRowTitle("Plan the week - Claude"), "Plan the week")
Check("chat row title long", ChatRowTitle(StrRepeat("a", 50)), StrRepeat("a", 43) "…")
; Send link, panel side (1.3): the window, the focus, the delivery.
wins := [{hwnd: 1, title: "a.js - switchboard2-h8r - Visual Studio Code"}, {hwnd: 2, title: "b.md - alfred-v5 - Visual Studio Code"}]
Check("send window: right one", PickSendWindow(wins, "switchboard2-h8r").hwnd, 1)
Check("send window: none", PickSendWindow(wins, "jobs-ax4").error, "no VS Code window titled jobs-ax4")
wins.Push({hwnd: 3, title: "switchboard2-h8r - Visual Studio Code"})
Check("send window: two", PickSendWindow(wins, "switchboard2-h8r").error, "2 VS Code windows are titled switchboard2-h8r")
Check("send window: two, no hwnd", PickSendWindow(wins, "switchboard2-h8r").hwnd, 0)
Check("send window: not the active one", PickSendWindow([], "x").hwnd, 0)
inputs := ["Message Claude"]
Check("focus: Claude's input", FocusVerdict({name: "Message Claude", helpText: "", className: "ProseMirror"}, inputs), "")
Check("focus: by placeholder", FocusVerdict({name: "", helpText: "message claude", className: ""}, inputs), "")
Check("focus: editor", FocusVerdict({name: "Editor content;Press Alt+F1 for Accessibility Options.", helpText: "", className: "inputarea monaco-mouse-cursor-text"}, inputs), "focus is in an editor or terminal")
Check("focus: terminal", FocusVerdict({name: "Terminal 1, bash", helpText: "", className: "xterm-helper-textarea"}, inputs), "focus is in an editor or terminal")
Check("focus: elsewhere", FocusVerdict({name: "Search", helpText: "", className: ""}, inputs), "focus is not in Claude's input (Search)")
Check("focus: a name that only contains it", FocusVerdict({name: "Message Claude history", helpText: "", className: ""}, inputs), "focus is not in Claude's input (Message Claude history)")
Check("focus: unreadable", FocusVerdict("", inputs), "the focused element could not be read")
Check("focus: not set up", FocusVerdict({name: "Message Claude", helpText: "", className: ""}, []), "Claude's input is not set up: run lib\focus-check.ahk")
Check("delivery confirmed", DeliveryState("p-s3-abcd", "p-s3-abcd", 1000, 2000, 8000), "delivered")
Check("delivery waiting", DeliveryState("p-s3-abcd", "p-s2-zzzz", 1000, 5000, 8000), "waiting")
Check("delivery missing", DeliveryState("p-s3-abcd", "p-s2-zzzz", 1000, 9001, 8000), "missing")
Check("send session: worktree", SessionForProject(["main", "sb-h8r"], "jobs-ax4", "sb-h8r"), "sb-h8r")
Check("send session: main bound", SessionForProject(["main", "sb-h8r"], "jobs-ax4", "jobs-ax4"), "main")
Check("send session: none", SessionForProject(["main", "sb-h8r"], "", "jobs-ax4"), "")
Check("send refused: no checkout", SendRefusal("", "waiting", "jobs-ax4"), "no checkout for jobs-ax4")
Check("send refused: running", SendRefusal("sb-h8r", "processing", "sb-h8r"), "the CLI is running")
Check("send refused: approval", SendRefusal("sb-h8r", "red", "sb-h8r"), "the CLI is waiting for an approval")
Check("send allowed: idle", SendRefusal("sb-h8r", "waiting", "sb-h8r"), "")
Check("send view: note wins", SendView({color: "green", label: "CLI working"}, "Not sent: the CLI is running").label, "Not sent: the CLI is running")
Check("send view: red", SendView({color: "purple", label: "Paste prompt"}, "Not delivered").color, "red")
Check("send view: none", SendView({color: "purple", label: "Paste prompt"}, "").label, "Paste prompt")
inNames := InputNames(" Message Claude | Ask Claude|")
Check("input names: pipe list", inNames.Length " " inNames[1] " / " inNames[2], "2 Message Claude / Ask Claude")
Check("input names: empty", InputNames("").Length, 0)

StrRepeat(s, n) {
    out := ""
    Loop n
        out .= s
    return out
}

; #Warn only prints, so load this file again with /validate and fail on any warning.
warnOut := A_Temp "\claude-sessions-test-warnings.txt"
RunWait(A_ComSpec ' /c ""' A_AhkPath '" /ErrorStdOut /validate "' A_ScriptFullPath '" > "' warnOut '" 2>&1"', , "Hide")
Check("loads with no warnings", Trim(FileRead(warnOut), " `r`n"), "")

FileAppend(fails ? fails " failed`n" : "all passed`n", "*")
ExitApp(fails ? 1 : 0)
