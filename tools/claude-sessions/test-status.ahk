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

Check("taskbar red", TaskbarFlag(["processing", "red", "waiting"]), 4)
Check("taskbar yellow", TaskbarFlag(["processing", "waiting"]), 8)
Check("taskbar green", TaskbarFlag(["none", "processing"]), 2)
Check("taskbar none", TaskbarFlag([]), 0)

Check("alert red", ShouldAlert("processing", "red"), true)
Check("alert finish", ShouldAlert("processing", "waiting"), true)
Check("no alert red to waiting", ShouldAlert("red", "waiting"), false)
Check("no alert first read", ShouldAlert("", "red"), false)

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
orphanList := Orphans([Map("owner", "zz-orphan"), Map("owner", "k7w"), Map("owner", "main")], [Map("owner", "zz-orphan")]
    , ["k7w", "old-x"], Map("k7w", "20261001090000", "old-x", "20260927090000"), "20261001100000")
Check("orphans", orphanList.Length = 2 ? orphanList[1] " / " orphanList[2] : orphanList.Length,"zz-orphan (2 held, no worktree) / old-x (idle 4d)")
Check("unread", IsUnread("20261001100000", "20261001090000"), true)
Check("read", IsUnread("20261001080000", "20261001090000"), false)
Check("no report", IsUnread("", "20261001090000"), false)

; #Warn only prints, so load this file again with /validate and fail on any warning.
warnOut := A_Temp "\claude-sessions-test-warnings.txt"
RunWait(A_ComSpec ' /c ""' A_AhkPath '" /ErrorStdOut /validate "' A_ScriptFullPath '" > "' warnOut '" 2>&1"', , "Hide")
Check("loads with no warnings", Trim(FileRead(warnOut), " `r`n"), "")

FileAppend(fails ? fails " failed`n" : "all passed`n", "*")
ExitApp(fails ? 1 : 0)
