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

; Taskbar progress state for the kinds of the unpaused sessions:
; 4 red beats 8 yellow beats 2 green; 0 clears it.
TaskbarFlag(kinds) {
    flag := 0
    for k in kinds {
        if k = "red"
            return 4
        if k = "waiting"
            flag := 8
        else if k = "processing" && !flag
            flag := 2
    }
    return flag
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

IsUnread(reportStamp, lastClick) => reportStamp != "" && (lastClick = "" || reportStamp > lastClick)

; Bring the panel forward and blink: on turning red, or on finishing a turn.
ShouldAlert(old, new) => old != "" && old != new && (new = "red" || (new = "waiting" && old = "processing"))
