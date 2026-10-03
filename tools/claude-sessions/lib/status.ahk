; Pure helpers for claude-sessions.ahk, kept apart from the GUI so
; test-status.ahk can run them.

; Timestamp of the latest interrupt line in `text` that is later than `since`
; (both ISO UTC), or "". Raw quotes only, so the words quoted inside a message
; (where they are escaped as \") never match.
FindInterrupt(text, since) {
    static interruptRe := '(?<!\\)"(?:text|content)":"\[Request interrupted by user'
    static timestampRe := '(?<!\\)"timestamp":"([^"]+)"'
    found := ""
    Loop Parse text, "`n", "`r" {
        if !RegExMatch(A_LoopField, interruptRe)
            continue
        if RegExMatch(A_LoopField, timestampRe, &m) && StrCompare(m[1], since) > 0 && StrCompare(m[1], found) > 0
            found := m[1]
    }
    return found
}

; "2026-09-30T19:30:44.198Z" -> "20260930193044", still UTC.
IsoToStamp(iso) => RegExReplace(SubStr(iso, 1, 19), "[-T:]")

FormatElapsed(seconds) {
    seconds := Max(0, seconds)
    h := seconds // 3600, m := Mod(seconds, 3600) // 60, s := Mod(seconds, 60)
    return h ? Format("{}:{:02}:{:02}", h, m, s) : Format("{}:{:02}", m, s)
}

; Local "HH:mm" today, otherwise "d MMM HH:mm". `offset` is local minus UTC, in seconds.
FormatEntered(iso, offset, today := "") {
    if !iso
        return ""
    if today = ""
        today := SubStr(A_Now, 1, 8)
    t := DateAdd(IsoToStamp(iso), offset, "Seconds")
    return FormatTime(t, SubStr(t, 1, 8) = today ? "HH:mm" : "d MMM HH:mm")
}

; What a button shows: "none", "red", "waiting" or "processing".
; An interrupt shows as waiting with red cleared; red otherwise wins.
KindOf(hasStatus, state, red, interrupted) {
    if !hasStatus
        return "none"
    if interrupted
        return "waiting"
    if red
        return "red"
    return state = "processing" ? "processing" : "waiting"
}

; Taskbar progress state for the colours of the active buttons and chat rows:
; 4 red beats 8 (purple, orange and yellow: the bar has no other colours) beats 2 green.
TaskbarFlag(colors) {
    flag := 0
    for c in colors {
        if c = "red"
            return 4
        if c = "purple" || c = "orange" || c = "yellow"
            flag := 8
        else if c = "green" && !flag
            flag := 2
    }
    return flag
}

IsAttention(color) => color = "red" || color = "purple" || color = "orange" || color = "yellow"

; "s9b" from "proj-abc-s9b-x1y2", or "".
StepOf(tag) {
    return RegExMatch(tag, "-(s\d+[a-z]?)-[a-z0-9]{4}$", &m) ? m[1] : ""
}

; "proj-abc" from "proj-abc-s9b-x1y2", or "".
ProjectOfTag(tag) {
    return RegExMatch(tag, "^(.+)-s\d+[a-z]?-[a-z0-9]{4}$", &m) ? m[1] : ""
}

; Claude has issued a tag for this project that the CLI has not received.
NewerTag(runTag, issuedTag, project) => issuedTag != "" && issuedTag != runTag && ProjectOfTag(issuedTag) = project

; "s9", or "s9 -> s10" when Claude has issued a newer tag.
StepText(runTag, issuedTag, project) {
    s := StepOf(runTag)
    return NewerTag(runTag, issuedTag, project) ? (s = "" ? "?" : s) " -> " StepOf(issuedTag) : s
}

; A session's colour and label (spec section 5). p: free, closed, paused, kind
; (the CLI: none, red, waiting, processing), runTag, reportTag, reportAt, chatState
; ("" when unpaired or stale), chatSince, issuedTag, project. Times are ISO UTC.
ViewOf(p) {
    if p.free
        return {color: "free", label: "free"}
    if p.closed
        return {color: "closed", label: "closed"}
    if p.paused
        return {color: "paused", label: "paused"}
    if p.kind = "none"
        return {color: "none", label: "no status"}
    if p.kind = "red"
        return {color: "red", label: "Approve"}
    cliIdle := p.kind = "waiting"
    if cliIdle && p.runTag != "" && p.reportTag != p.runTag
        return {color: "red", label: "Check CLI"}
    writing := p.chatState = "responding"
    if !cliIdle || writing
        return {color: "green", label: !cliIdle && writing ? "Both working" : writing ? "Claude writing" : "CLI working"}
    if p.chatState != "finished"
        return {color: "grey", label: "chat unknown"}
    if p.reportAt != "" && StrCompare(p.chatSince, p.reportAt) <= 0
        return {color: "orange", label: "Send cli"}
    if NewerTag(p.runTag, p.issuedTag, p.project)
        return {color: "purple", label: "Paste prompt"}
    return {color: "yellow", label: "Your turn"}
}

; The centre of a window from WinGetPos, as {x, y} screen coordinates.
WindowCentre(x, y, w, h) => {x: x + w // 2, y: y + h // 2}

; Which window a click leaves the keyboard in: "code" for red and while the CLI
; works, otherwise "chrome" (the chat's message box).
FocusTarget(color, label) => color = "red" || (color = "green" && label != "Claude writing") ? "code" : "chrome"

; An unpaired chat row: green writing, yellow finished and not viewed since, grey otherwise.
ChatRowView(state, since, viewedAt) {
    if state = "responding"
        return {color: "green", label: "Claude writing"}
    if state = "finished"
        return viewedAt = "" || StrCompare(viewedAt, since) < 0
            ? {color: "yellow", label: "finished"} : {color: "grey", label: "seen"}
    return {color: "grey", label: "unknown"}
}

; "Step N of M: <name>" from a progress file: top-level "- [ ]" lines are steps,
; N is the first unticked one. "" when the file has none.
ProgressSummary(text) {
    total := 0, cur := 0, name := ""
    Loop Parse text, "`n", "`r" {
        if !RegExMatch(A_LoopField, "^- \[([ xX])\]\s*(.*)$", &m)
            continue
        total++
        if !cur && m[1] = " " {
            cur := total
            name := RegExMatch(m[2], "\*\*(.+?)\*\*", &b) ? b[1] : SubStr(m[2], 1, 60)
            name := RegExReplace(RegExReplace(name, "^\d+[a-z]?\.\s*"), "\.\s*$")
        }
    }
    if !total
        return ""
    return cur ? "Step " cur " of " total ": " name : "Step " total " of " total ": done"
}

; The project's progress file name: the code without its thread suffix.
ProjectName(code) => RegExReplace(code, "-[a-z0-9]+$")

; With no saved link: a claude.ai chat tab whose title carries the code, as an address, or "".
FindChatLinkByCode(tabs, code) {
    for t in tabs {
        if !IsObject(t)
            continue
        url := NormaliseUrl(t.Get("url", ""))
        if RegExMatch(url, "^https://claude\.ai/chat/\S+$") && ChromeTitleMatches(code, "", t.Get("title", ""))
            return url
    }
    return ""
}

; VS Code's default title is "<file> - <folder> - Visual Studio Code": match the
; folder as a whole segment. Hand-typed override text just has to appear.
CodeTitleMatches(folder, override, title) {
    if override != ""
        return InStr(title, override) > 0
    return RegExMatch(title, "i)(^|\s[-—]\s)\Q" folder "\E(\s[-—]\s|$)") > 0
}

; A claude.ai tab's window title: "<chat title> - Claude - Google Chrome".
ChromeTitleMatches(code, override, title) {
    if override != ""
        return InStr(title, override) > 0
    return InStr(title, code) > 0 && InStr(title, "Claude") > 0
}

FirstMatch(windows, test) {
    for w in windows
        if test(w.title)
            return w.hwnd
    return 0
}

; The extension ignores an id that is not a UUID, so an empty or bad one gives "".
ResumeUri(sessionId) {
    if !RegExMatch(sessionId, "i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        return ""
    return "vscode://anthropic.claude-code/open?session=" sessionId
}

IsChatLink(url) => RegExMatch(url, "i)^https://claude\.ai/\S+$") > 0

; An address-bar value to a chat link, or "". Chrome shows https addresses
; without the scheme, so a bare "claude.ai/chat/…" counts as https; an explicit
; http:// or any other site does not.
ChatLinkFromAddress(address) {
    address := Trim(address)
    if RegExMatch(address, "i)^claude\.ai/chat/\S+$")
        address := "https://" address
    return RegExMatch(address, "i)^https://claude\.ai/chat/\S+$") ? address : ""
}

; Only an automatic title match may save a link: with hand-typed Chrome title
; text the matched window could be any chat, so nothing is saved.
AutoSaveLink(override, address) => override != "" ? "" : ChatLinkFromAddress(address)

; An address without its query or fragment, as the extension sends it.
NormaliseUrl(url) => RegExReplace(url, "[?#].*$")

; tabs.json's `at` (ISO UTC) is no older than `maxSeconds` at `nowUtc`.
IsFresh(at, nowUtc, maxSeconds := 45) {
    if at = ""
        return false
    try return DateDiff(nowUtc, IsoToStamp(at), "Seconds") <= maxSeconds
    return false
}

; The tab (a Map from tabs.json) whose address is the saved chat link, or "".
FindTabByLink(tabs, link) {
    if link = ""
        return ""
    want := NormaliseUrl(link)
    for t in tabs
        if IsObject(t) && NormaliseUrl(t.Get("url", "")) == want
            return t
    return ""
}

; Chrome's window title is the active tab's title plus " - Google Chrome".
WindowTitleStarts(prefix, title) => prefix != "" && SubStr(title, 1, StrLen(prefix)) == prefix

CountLines(text) {
    n := 0
    Loop Parse text, "`n", "`r"
        if A_LoopField != ""
            n++
    return n
}

FormatAge(minutes) => minutes < 60 ? minutes "m" : (minutes // 60) "h" Format("{:02}", Mod(minutes, 60)) "m"

; claims: the claims file's `claims` array (Maps). Returns {text, red}: red when
; any db: claim is older than an hour. `nowUtc` is a YYYYMMDDHH24MISS UTC stamp.
DbStrip(claims, nowUtc) {
    parts := "", red := false
    for c in claims {
        item := c.Get("item", "")
        if SubStr(item, 1, 3) != "db:"
            continue
        age := Max(0, DateDiff(nowUtc, IsoToStamp(c.Get("claimed_at", "")), "Minutes"))
        red := red || age > 60
        parts .= (parts = "" ? "" : " | ") SubStr(item, 4) " · " c.Get("owner", "?") " " FormatAge(age)
    }
    return {text: "db: " (parts = "" ? "free" : parts), red: red}
}

MainStrip(code) => "main: " (code != "" ? code : "free")

; Main's button names its bound project (from the binding file, not its status file).
ButtonName(code, mainProject) => code = "main" && mainProject != "" && mainProject != "main"
    ? "main · " mainProject : code

; The text a session's claude.ai chat title carries. Main's follows the binding
; file, like its label; it used to follow the last status write, which goes stale.
ChatCode(code, mainProject) => code = "main" && mainProject != "" ? mainProject : code

; Main with no binding is free: grey, "free", no alert, out of the taskbar colour.
IsFree(code, mainProject) => code = "main" && mainProject = ""

; An attention colour flashes 5 times, then stays solid until clicked or it changes.
ATTENTION_FLASHES := 5
StillFlashing(flashes) => flashes < ATTENTION_FLASHES

; Modified times of `files` as one string, "" for a missing one, so a commit,
; merge, push or a binding change shows up as a different key.
StampKey(files) {
    key := ""
    for f in files {
        t := ""
        try t := FileGetTime(f, "M")
        key .= t "|"
    }
    return key
}

; Owners holding claims or reservations that are neither main nor a worktree
; folder, then worktrees idle for more than 3 days. `activity` maps a worktree
; name to its newest local modified stamp ("" if none).
Orphans(claims, reservations, worktrees, activity, now) {
    known := Map("main", true), out := []
    for w in worktrees
        known[w] := true
    counts := Map()
    for list in [claims, reservations]
        for c in list {
            owner := c.Get("owner", "")
            if !known.Has(owner)
                counts[owner] := counts.Get(owner, 0) + 1
        }
    for owner, n in counts
        out.Push(owner " (" n " held, no worktree)")
    for w in worktrees {
        stamp := activity.Get(w, "")
        if stamp != "" && DateDiff(now, stamp, "Hours") > 72
            out.Push(w " (idle " DateDiff(now, stamp, "Days") "d)")
    }
    return out
}

; A folder in .claude\worktrees is a live worktree only while git's `.git` pointer
; file is in it. `git worktree remove` can leave the folder behind, empty.
IsWorktreeDir(dir) => FileExist(dir "\.git") != ""

IsUnread(reportStamp, lastClick) => reportStamp != "" && (lastClick = "" || reportStamp > lastClick)

; Bring the panel forward and blink when a colour turns into an attention colour.
; Never on the first read.
ShouldAlert(old, new) => old != "" && old != new && IsAttention(new)
