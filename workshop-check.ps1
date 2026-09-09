# Workshop Health Check
#
# Pings both hosts, and reports whether YouTube still ACCEPTS the stored
# credential — which /health cannot tell you.
#
# ===========================================================================
# WHY THE CREDENTIAL SECTION EXISTS
# ===========================================================================
# /health reports `credential_readable`, which means the file exists and can be
# opened. The tool's own docs say that is not proof YouTube still accepts it,
# and a cookie expires while the file sits there perfectly readable.
#
# That one file is the single point of failure for the daily sync, the weekly
# review, the jazz thread and the concert skill. So this reports the last time
# YouTube actually accepted it, and how long ago that was.
#
# Usage:
#   .\workshop-check.ps1           status, then an explicit prompt
#   .\workshop-check.ps1 -Deep     probe immediately, no keypress, no prompt
#   .\workshop-check.ps1 -Reauth   just print the recovery procedure

param(
    [switch]$Deep,
    [switch]$Reauth
)

$hosts = @(
    @{ Name = "Dev (desktop)"; Base = "https://workshop-dev.alexanderjameswarren.com" },
    @{ Name = "Surface";       Base = "https://workshop.alexanderjameswarren.com" }
)

function Format-Age {
    param([int]$Seconds)
    if ($Seconds -lt 0) { return "just now" }
    $t = [TimeSpan]::FromSeconds($Seconds)
    if ($t.TotalDays -ge 1)  { return ("{0}d {1}h" -f [int]$t.TotalDays, $t.Hours) }
    if ($t.TotalHours -ge 1) { return ("{0}h {1}m" -f [int]$t.TotalHours, $t.Minutes) }
    if ($t.TotalMinutes -ge 1) { return ("{0}m" -f [int]$t.TotalMinutes) }
    return "under a minute"
}

function Format-Stamp {
    param([string]$Iso)
    if (-not $Iso) { return "never" }
    try { return ([datetime]$Iso).ToLocalTime().ToString("ddd d MMM, HH:mm") }
    catch { return $Iso }
}

function Show-ReauthProcedure {
    # =======================================================================
    # WRITTEN TO BE FOLLOWED COLD.
    # =======================================================================
    # This is done roughly never — once, in Phase 4, weeks ago. By the time it
    # matters nobody remembers it, so "run the reauth tile" is not a procedure,
    # it is a reminder that a procedure existed.
    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor Yellow
    Write-Host "  RECOVERING THE YOUTUBE CREDENTIAL" -ForegroundColor Yellow
    Write-Host "  ============================================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Do this ON THE SURFACE. The credential is per-host." -ForegroundColor Gray
    Write-Host "  (You may instead capture on any machine and copy browser.json" -ForegroundColor DarkGray
    Write-Host "   across - it is tied to the Google account, not the machine." -ForegroundColor DarkGray
    Write-Host "   NEVER solve this by committing the file.)" -ForegroundColor DarkGray
    Write-Host ""

    Write-Host "  1. CAPTURE THE HEADERS - Firefox only." -ForegroundColor White
    Write-Host "     Chrome 151 removed 'Copy request headers' and hides the Raw toggle." -ForegroundColor DarkGray
    Write-Host "     a) Open music.youtube.com in Firefox, signed in." -ForegroundColor Gray
    Write-Host "     b) Ctrl+Shift+E                      (Network tab)" -ForegroundColor Gray
    Write-Host "     c) Type  browse  in the filter box." -ForegroundColor Gray
    Write-Host "     d) Click about the page so a request appears." -ForegroundColor Gray
    Write-Host "     e) Right-click a POST with status 200  <- must be POST, not GET" -ForegroundColor Gray
    Write-Host "     f) Copy  ->  Copy Request Headers" -ForegroundColor Gray
    Write-Host ""

    Write-Host "  2. PASTE INTO THE HEADERS FILE" -ForegroundColor White
    Write-Host "     workshop\data\dj\headers.txt" -ForegroundColor Cyan
    Write-Host "     (in the same Workshop folder the Start Workshop shortcut points at;" -ForegroundColor DarkGray
    Write-Host "      on the desktop that is C:\Users\Alex\projects\alfred-v5\workshop)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "     !! THIS IS A FULL GOOGLE SESSION COOKIE, not just a YouTube one." -ForegroundColor Red
    Write-Host "        Never paste it into a chat, a note, or anywhere but that file." -ForegroundColor Red
    Write-Host "        Only a Google password change invalidates a leaked one." -ForegroundColor Red
    Write-Host ""

    Write-Host "  3. CONVERT IT" -ForegroundColor White
    Write-Host "     cd <workshop folder>" -ForegroundColor Cyan
    Write-Host "     .\.venv\Scripts\python.exe scripts\dj_auth.py" -ForegroundColor Cyan
    Write-Host "     Expect:  Wrote ...\data\dj\browser.json" -ForegroundColor DarkGray
    Write-Host "     If it says 'No Cookie header found' you copied a GET. Redo step 1e." -ForegroundColor DarkGray
    Write-Host ""

    Write-Host "  4. FIX OWNERSHIP - the step that is always forgotten." -ForegroundColor White
    Write-Host "     The Surface repo was built by rdpuser; Workshop RUNS as alexa." -ForegroundColor DarkGray
    Write-Host "     A file alexa cannot read fails exactly like a missing one." -ForegroundColor DarkGray
    Write-Host '     icacls "<workshop folder>\data\dj" /grant "alexa:(OI)(CI)RX" /T' -ForegroundColor Cyan
    Write-Host ""

    Write-Host "  5. RESTART WORKSHOP, then re-run this script with -Deep." -ForegroundColor White
    Write-Host "     Tap 'Refresh Workshop' on the tablet." -ForegroundColor Gray
    Write-Host "     !! Workshop autostarts under pythonw.exe, so a failure prints" -ForegroundColor Yellow
    Write-Host "        NOTHING VISIBLE. Verify with -Deep or data\workshop.log," -ForegroundColor Yellow
    Write-Host "        never by watching for a window." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  6. DELETE headers.txt when it works." -ForegroundColor White
    Write-Host ""
}

function Show-CredentialStatus {
    # Prints the credential lines for one host. Returns $true if it looks bad.
    #
    # ⚠️ A FUNCTION CALLED IN-PROCESS, NOT A RE-INVOCATION OF THE SCRIPT.
    # The interactive path used to run `& $PSCommandPath -Deep`. That WORKED —
    # and then the parent fell off the end, so the console window closed before
    # the output could be read. The probe ran; nobody saw it, which from the
    # outside is indistinguishable from it never running. Staying in-process
    # keeps the window under the control of the loop at the bottom, which
    # always ends blocked on a prompt.
    param(
        [hashtable]$HostEntry,
        [switch]$Probe
    )

    $url = "$($HostEntry.Base)/credential"
    $timeout = 8
    if ($Probe) { $url = "$url`?deep=1"; $timeout = 30 }

    try { $c = Invoke-RestMethod -Uri $url -TimeoutSec $timeout }
    catch {
        Write-Host "                  YouTube:    " -NoNewline -ForegroundColor DarkGray
        Write-Host "endpoint not available - Workshop predates the probe" -ForegroundColor Yellow
        return $false
    }

    $looksBad = $false
    Write-Host "                  YouTube:    " -NoNewline -ForegroundColor DarkGray

    if ($c.never_recorded) {
        Write-Host "never confirmed" -ForegroundColor Yellow -NoNewline
        Write-Host "  - nothing has called YouTube since this was deployed" -ForegroundColor DarkGray
        $looksBad = $true
    }
    else {
        $age  = Format-Age $c.last_success_age_seconds
        $when = Format-Stamp $c.last_success

        if ($c.failing) {
            # A failure NEWER than the last success. The last-success stamp is
            # still printed - "dead, and it last worked on the 12th" is the
            # whole of the information, not half of it.
            Write-Host "FAILING" -ForegroundColor Red
            Write-Host ("                              last worked {0} ago ({1})" -f $age, $when) -ForegroundColor Gray
            Write-Host ("                              failed {0} ago: {1}" -f (Format-Age $c.last_failure_age_seconds), $c.last_failure_kind) -ForegroundColor Yellow
            if ($c.last_failure_detail) {
                Write-Host ("                              {0}" -f $c.last_failure_detail) -ForegroundColor DarkGray
            }
            if ($c.last_failure_kind -eq "auth_expired") { $looksBad = $true }
            else {
                Write-Host "                              upstream_error - may be transient, press 1 to retry" -ForegroundColor DarkGray
            }
        }
        elseif ($c.stale) {
            # Nothing failed. Nothing succeeded either, for longer than a daily
            # sync could explain - so the sync is not running. A different
            # fault, revealed by the same number.
            Write-Host "STALE" -ForegroundColor Yellow -NoNewline
            Write-Host ("   last confirmed working {0} ago ({1})" -f $age, $when) -ForegroundColor Gray
            Write-Host "                              no failure recorded - so nothing is CALLING YouTube." -ForegroundColor Yellow
            Write-Host "                              the daily sync runs every day; check it is running." -ForegroundColor DarkGray
        }
        else {
            Write-Host "ok" -ForegroundColor Green -NoNewline
            Write-Host ("      last confirmed working {0} ago ({1})" -f $age, $when) -ForegroundColor DarkGray
        }
    }

    if ($Probe -and $c.probed) {
        if ($c.probe_ok -eq $true) {
            Write-Host ("                              probe OK - {0}" -f $c.probe_detail) -ForegroundColor Green
        }
        elseif ($c.probe_ok -eq $false) {
            Write-Host ("                              probe FAILED - {0}" -f $c.probe_detail) -ForegroundColor Red
            $looksBad = $true
        }
        else {
            # Inconclusive: the call worked but returned nothing. Not recorded
            # either way, because guessing hides a dead cookie or invents one.
            Write-Host ("                              probe INCONCLUSIVE - {0}" -f $c.probe_detail) -ForegroundColor Yellow
        }
    }

    return $looksBad
}

function Invoke-StatusPass {
    param([switch]$Probe)

    Write-Host ""
    Write-Host "  Workshop Health Check" -ForegroundColor Cyan
    if ($Probe) {
        Write-Host "  $(Get-Date -Format 'ddd HH:mm:ss')  - probing YouTube, this takes a moment" -ForegroundColor DarkGray
    }
    else {
        Write-Host "  $(Get-Date -Format 'ddd HH:mm:ss')" -ForegroundColor DarkGray
    }
    Write-Host ""

    $downNames = @()
    $credLooksBad = $false

    foreach ($h in $hosts) {
        Write-Host ("  {0,-16}" -f $h.Name) -NoNewline

        try {
            $r = Invoke-RestMethod -Uri "$($h.Base)/health" -TimeoutSec 8

            $up = [TimeSpan]::FromSeconds($r.uptime_seconds)
            if     ($up.TotalDays  -ge 1) { $uptime = "{0}d {1}h" -f [int]$up.TotalDays, $up.Hours }
            elseif ($up.TotalHours -ge 1) { $uptime = "{0}h {1}m" -f [int]$up.TotalHours, $up.Minutes }
            else                          { $uptime = "{0}m" -f [int]$up.TotalMinutes }

            Write-Host "UP" -ForegroundColor Green -NoNewline
            Write-Host ("   host={0}  sha={1}  tools={2}  up={3}" -f $r.host, $r.git_sha, $r.tool_count, $uptime) -ForegroundColor DarkGray
        }
        catch {
            $downNames += $h.Name
            $code = $null
            if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }

            if ($code -eq 502) {
                Write-Host "DOWN" -ForegroundColor Red -NoNewline
                Write-Host "  502 - tunnel is up, server is not running" -ForegroundColor Yellow
            }
            elseif ($code) {
                Write-Host "DOWN" -ForegroundColor Red -NoNewline
                Write-Host ("  HTTP {0}" -f $code) -ForegroundColor Yellow
            }
            else {
                Write-Host "DOWN" -ForegroundColor Red -NoNewline
                Write-Host "  no response - tunnel down or host offline" -ForegroundColor Yellow
            }
            continue
        }

        if (Show-CredentialStatus -HostEntry $h -Probe:$Probe) { $credLooksBad = $true }
    }

    Write-Host ""

    # Only the hosts that are ACTUALLY down get a remedy. Printing both hints
    # whenever either is down told Alex to refresh a Surface that was up - a
    # diagnostic saying something untrue, which is the failure this file exists
    # to stop rather than commit.
    if ($downNames -contains "Dev (desktop)") {
        Write-Host "  Dev is down:     run the Start Workshop Dev shortcut" -ForegroundColor DarkGray
    }
    if ($downNames -contains "Surface") {
        Write-Host "  Surface is down: tap Refresh Workshop on the tablet" -ForegroundColor DarkGray
    }
    if ($downNames.Count -gt 0) { Write-Host "" }

    if ($credLooksBad) { Show-ReauthProcedure }
}

# ---------------------------------------------------------------------------

if ($Reauth) {
    Show-ReauthProcedure
    [void](Read-Host "  Press Enter to close")
    exit
}

Invoke-StatusPass -Probe:$Deep

# -Deep is the non-interactive form: it has already probed, so it exits without
# prompting. Everything below is the interactive path.
if ($Deep) { exit }

# ===========================================================================
# 🛑 THE PROMPT NEVER FALLS THROUGH SILENTLY, AND NEVER ENDS UNBLOCKED.
# ===========================================================================
# The old prompt was "Press 1 to check now, Enter to close" — two behaviours on
# one keypress, where THE FAILURE MODE WAS THAT THE USEFUL ONE SILENTLY DID NOT
# HAPPEN. Two separate faults produced the same symptom:
#
#   * anything that was not exactly "1" closed the window without saying why;
#   * and "1" DID run the probe, in a child invocation, after which the parent
#     script ended and the window closed before the output could be read.
#
# Both look identical from the outside: the window shuts and you cannot tell
# whether anything happened. So:
#
#   * unrecognised input SAYS WHAT IT RECEIVED and asks again
#   * probing runs in-process and loops back to the prompt
#   * only an empty line closes, and the prompt says so
while ($true) {
    $answer = Read-Host "  Press 1 to check YouTube now, or Enter to close"
    if ($null -eq $answer) { break }          # Ctrl+C or a closed input stream
    $answer = $answer.Trim()

    if ($answer -eq "") { break }

    if ($answer -eq "1") {
        Invoke-StatusPass -Probe
        continue
    }

    # Explicit about the non-match. A stray space, a stray letter, a paste —
    # all used to close the window and read as the probe having failed.
    Write-Host ("  Didn't recognise '{0}'. Press 1 to check YouTube, or Enter to close." -f $answer) -ForegroundColor Yellow
}
