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

; Mouse lock. `monitors`: [{l, t, r, b}, ...] in physical pixels.
; The touch screen's index (the 1024x600 one), or 0 when none is connected.
TouchMonitor(monitors) {
    for m in monitors
        if m.r - m.l = 1024 && m.b - m.t = 600
            return A_Index
    return 0
}

; The box around every monitor but the touch screen, or "" when there is nothing
; to fence: no touch screen, or no other monitor.
FenceBox(monitors) {
    touch := TouchMonitor(monitors), box := ""
    if !touch
        return ""
    for m in monitors
        if A_Index != touch
            box := box = "" ? {l: m.l, t: m.t, r: m.r, b: m.b}
                : {l: Min(box.l, m.l), t: Min(box.t, m.t), r: Max(box.r, m.r), b: Max(box.b, m.b)}
    return box
}

; --- Touch page state (docs\history\technical-spec-switchboard_touch-t4n.md, "Layout") ---

; Colours the page draws; everything else is grey.
TileColor(c) => c ~= "^(red|orange|purple|yellow|green)$" ? c : "grey"
TileColorRank(c) {
    static ranks := Map("red", 0, "orange", 1, "purple", 2, "yellow", 3, "green", 4)
    return ranks.Get(c, 5)
}

; Sorted by group (0 active CLI, 1 chats, 2 paused CLI, 3 orphans), then colour.
; Ties keep the previous order (`prev`: id -> position); new tiles follow, in input order.
TileSort(tiles, prev) {
    keyed := []
    for t in tiles
        keyed.Push({t: t, k: Format("{}{}{:06}{:06}", t.group, TileColorRank(t.color), prev.Get(t.id, 999999), A_Index)})
    out := []
    for e in keyed {           ; insertion sort: a dozen tiles
        i := out.Length + 1
        while i > 1 && StrCompare(out[i - 1].k, e.k) > 0
            i--
        out.InsertAt(i, e)
    }
    for i, e in out
        out[i] := e.t
    return out
}

; "Switchboard touch" from "switchboard_touch-t4n"; main shows its bound project.
TileName(code, mainProject) => code = "main"
    ? (mainProject != "" && mainProject != "main" ? "main · " ProjectName(mainProject) : "main")
    : ProjectName(code)

; The tile's step: "s9", or only the new one, "→s10", during a handover ("Paste prompt" says the rest).
TileStep(stepText) => InStr(stepText, " -> ") ? "→" SubStr(stepText, InStr(stepText, " -> ") + 4) : stepText

; What a tap or long-press on the touch page does: {do, key}. do is "click" (a CLI
; tile, key = code), "chat" (key = tabId), "pause" (long-press on a CLI tile), "git" or "none".
TouchCommand(type, id) {
    kind := RegExReplace(id, ":.*"), key := SubStr(id, StrLen(kind) + 2)
    if type = "git"
        return {do: "git", key: ""}
    if type = "move"
        return {do: "move", key: ""}
    if type = "menu" && kind = "cli"
        return {do: "menu", key: key}
    if type = "tap" && kind = "cli"
        return {do: "click", key: key}
    if type = "tap" && kind = "chat"
        return {do: "chat", key: key}
    if type = "hold" && kind = "cli"
        return {do: "pause", key: key}
    return {do: "none", key: ""}
}

; Main screen mode shows the 1024x600 page this much larger, so it reads at desk distance.
TOUCH_MAIN_ZOOM := 1.25

; Where the touch window goes. mode: the remembered "touch" or "main". primary: the
; primary monitor's index; scale: that monitor's DPI scale (1 at 96 dpi). With no touch
; screen it opens on the main screen, noTouch 1. Returns {mode, noTouch, x, y, w, h, zoom}.
TouchPlacement(monitors, mode, primary, scale := 1) {
    touch := TouchMonitor(monitors)
    if touch && mode != "main" {
        m := monitors[touch]
        return {mode: "touch", noTouch: 0, x: m.l, y: m.t, w: m.r - m.l, h: m.b - m.t, zoom: 1}
    }
    main := primary != touch ? primary : (touch = 1 ? 2 : 1)    ; never the touch screen
    m := monitors[Min(main, monitors.Length)]
    ; At most 90% of the monitor either way; the zoom shrinks with it.
    fit := Min(1, 0.9 * (m.r - m.l) / (1024 * TOUCH_MAIN_ZOOM * scale), 0.9 * (m.b - m.t) / (600 * TOUCH_MAIN_ZOOM * scale))
    zoom := Round(TOUCH_MAIN_ZOOM * fit, 2)
    w := Round(1024 * zoom * scale), h := Round(600 * zoom * scale)
    return {mode: "main", noTouch: touch ? 0 : 1, x: m.l + (m.r - m.l - w) // 2, y: m.t + (m.b - m.t - h) // 2
        , w: w, h: h, zoom: zoom}
}

; The mode a top-bar tap switches to. With no touch screen there is nothing to dock to.
NextTouchMode(shown, touchPresent) => shown = "main" ? (touchPresent ? "touch" : "main") : "main"

; Bottom-left icon: "cli" (no chat connected), "both" (CLI with its chat), "chat" (standalone tab).
TileIcon(kind, hasChat) => kind = "chat" ? "chat" : kind = "cli" ? (hasChat ? "both" : "cli") : ""

ShortAge(minutes) => minutes < 60 ? Max(0, minutes) "m" : minutes < 1440 ? minutes // 60 "h" : minutes // 1440 "d"

; A CLI tile's action line. p: color, label, kind, free, closed, paused, elapsed
; (seconds in the current state) and age (minutes since it changed).
CliAction(p) {
    if p.free
        return "Free"
    if p.closed
        return "Closed, tap to reopen"
    if p.paused
        return "Paused " ShortAge(p.age)
    if p.kind = "none"
        return "No status"
    switch p.label {
        case "CLI working": return "Working " FormatElapsed(p.elapsed)
        case "Both working": return "Both working " FormatElapsed(p.elapsed)
        case "Claude writing": return "Chat writing"
        case "chat unknown": return "Chat unknown"
    }
    return p.label
}

; A standalone chat tile's action line, from ChatRowView's label. No timer.
ChatAction(label) => label = "Claude writing" ? "Writing" : label = "finished" ? "Reply ready"
    : label = "seen" ? "Seen" : "Unknown"

; Owners of claims or reservations with no checkout, as [{owner, n}].
OrphanOwners(claims, reservations, worktrees) {
    known := Map("main", true), counts := Map(), out := []
    for w in worktrees
        known[w] := true
    for list in [claims, reservations]
        for c in list
            if !known.Has(owner := c.Get("owner", ""))
                counts[owner] := counts.Get(owner, 0) + 1
    for owner, n in counts
        out.Push({owner: owner, n: n})
    return out
}

; Whole days idle when over the 3-day orphan threshold, else 0.
IdleDays(stamp, now) => stamp != "" && DateDiff(now, stamp, "Hours") > 72 ? DateDiff(now, stamp, "Days") : 0

; Compact JSON for the page: Arrays, Maps and Objects; numbers stay numbers.
ToJson(v) {
    if v is Array {
        s := ""
        for x in v
            s .= (A_Index > 1 ? "," : "") ToJson(x)
        return "[" s "]"
    }
    if IsObject(v) {
        s := ""
        for k, x in (v is Map ? v : v.OwnProps())
            s .= (A_Index > 1 ? "," : "") ToJson(String(k)) ":" ToJson(x)
        return "{" s "}"
    }
    if v is Number
        return String(v)
    s := StrReplace(StrReplace(v, "\", "\\"), '"', '\"')
    s := StrReplace(StrReplace(StrReplace(s, "`n", "\n"), "`r", "\r"), "`t", "\t")
    while RegExMatch(s, "[\x00-\x1F]", &m)
        s := StrReplace(s, m[0], Format("\u{:04x}", Ord(m[0])))
    return '"' s '"'
}

; Which monitor VS Code and Chrome go to, as AutoHotkey monitor numbers: the leftmost
; and rightmost of those that are not the touch screen, which is today's assignment
; (VS Code on the left, Chrome on the right). One left: both on it. Returns {code, chrome}.
AppMonitors(monitors) {
    touch := TouchMonitor(monitors), leftmost := 0, rightmost := 0
    for m in monitors {
        if A_Index = touch
            continue
        if !leftmost || m.l < monitors[leftmost].l
            leftmost := A_Index
        if !rightmost || m.l > monitors[rightmost].l
            rightmost := A_Index
    }
    if !leftmost               ; only the touch screen
        leftmost := rightmost := 1
    return {code: leftmost, chrome: rightmost}
}

; Every monitor as {l, t, r, b}. Physical pixels when the caller is per-monitor DPI aware.
MonitorRects() {
    list := []
    Loop MonitorGetCount() {
        MonitorGet(A_Index, &l, &t, &r, &b)
        list.Push({l: l, t: t, r: r, b: b})
    }
    return list
}
