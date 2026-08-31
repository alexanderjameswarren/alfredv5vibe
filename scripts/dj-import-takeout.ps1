# DJ Takeout bulk import - per-batch dry-run-then-confirm.
#
# ASCII ONLY IN THIS FILE, AND IT IS SAVED AS UTF-8 WITH BOM. Both, deliberately.
#
# Without a BOM, PowerShell 5.1 reads a .ps1 as Windows-1252. An em-dash (U+2014
# = E2 80 94) and a box-drawing char (U+2500 = E2 94 80) both contain byte 0x94,
# which in Windows-1252 is U+201D RIGHT DOUBLE QUOTATION MARK - and PowerShell
# accepts curly quotes as string delimiters. Each one inside a Write-Host string
# therefore injects a phantom closing quote. An earlier version of this file had
# 39 of them, an odd number, so the final string never closed and the parser
# failed at the last line with a misleading "missing terminator" plus knock-on
# brace errors 70 lines earlier.
#
# The BOM alone would fix it. ASCII alone would fix it. Keep both: the BOM is
# easy to lose to an editor or a git filter, and ASCII output is what a Windows
# console renders correctly anyway.
#
# The batch files go straight from disk to the Edge Function. The data never
# passes through a model, which is the entire point: ~16,800 rows cannot travel
# through a conversation's context, and a model acting as transport can corrupt
# a title into an insert-only match_key.
#
# The endpoint calls record_dj_plays itself - it never reimplements it - so the
# single-implementation guarantee that ruled out a direct PostgREST write holds.
#
# GET THE TOKEN (browser console, on the Alfred tab, signed in):
#
#   for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i);
#     if(/^sb-.*-auth-token$/.test(k)){const v=JSON.parse(localStorage.getItem(k));
#     copy(v.access_token||v.currentSession.access_token);console.log('copied');}}
#
# USAGE, from the repo root:
#
#   .\scripts\dj-import-takeout.ps1 -Token "<paste>" -DryRunOnly     # never writes
#   .\scripts\dj-import-takeout.ps1 -Token "<paste>"                 # batch 1 only
#   .\scripts\dj-import-takeout.ps1 -Token "<paste>" -From 1 -To 34  # all of them
#
# Each batch: dry run, print the numbers, then ASK. Nothing is written without a
# keypress. 34 confirmations is a keypress each, not a transcription risk each -
# solving transport by removing the review gate would be a bad trade.

param(
    [Parameter(Mandatory = $true)][string]$Token,
    [int]$From = 1,
    [int]$To = 1,
    [switch]$DryRunOnly,
    [string]$BatchDir = "workshop\data\dj\takeout-batches",
    [string]$Url = "https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/mcp/import-takeout"
)

$ErrorActionPreference = "Stop"
$headers = @{ Authorization = "Bearer $Token"; "Content-Type" = "application/json" }

function Invoke-Batch($file, $mode) {
    $body = [System.IO.File]::ReadAllText($file)
    try {
        return Invoke-RestMethod -Uri "$Url`?mode=$mode" -Method Post -Headers $headers -Body $body
    } catch {
        $resp = $_.ErrorDetails.Message
        Write-Host ""
        Write-Host "  REQUEST FAILED ($mode)" -ForegroundColor Red
        Write-Host "  $resp" -ForegroundColor Red
        Write-Host ""
        Write-Host "  If this was a CONFIRM, read the message above carefully: a" -ForegroundColor Yellow
        Write-Host "  part-way failure reports exactly how many rows COMMITTED, and" -ForegroundColor Yellow
        Write-Host "  re-running the same batch is safe. The unique index absorbs" -ForegroundColor Yellow
        Write-Host "  what already landed." -ForegroundColor Yellow
        throw
    }
}

Write-Host ""
Write-Host "  DJ Takeout import - batches $From..$To" -ForegroundColor Cyan
if ($DryRunOnly) { Write-Host "  DRY RUN ONLY - nothing will be written" -ForegroundColor Yellow }
Write-Host ""

foreach ($i in $From..$To) {
    $name = "batch_{0:D3}.json" -f $i
    $file = Join-Path $BatchDir $name
    if (-not (Test-Path $file)) { Write-Host "  $name  MISSING - skipped" -ForegroundColor Yellow; continue }

    Write-Host "  ---- $name ----------------------------------" -ForegroundColor DarkGray
    $d = Invoke-Batch $file "dry_run"

    Write-Host ("     submitted {0}   would insert {1}   already held {2}" -f `
        $d.plays_submitted, $d.would_insert, $d.already_held)
    Write-Host ("     tracks: {0} seen, {1} would create, {2} known" -f `
        $d.tracks_seen, $d.tracks_would_create, $d.tracks_already_known)
    Write-Host ("     covers {0} .. {1}" -f $d.covered_from, $d.covered_to)

    # Per batch, not aggregated at the end: a third split act among the ~1,241
    # artists the alias map cannot anticipate should be visible in the batch
    # that surfaced it, while there is still a decision to make about it.
    if ($d.artist_disagreements -and $d.artist_disagreements.Count -gt 0) {
        Write-Host ""
        Write-Host ("     ARTIST DISAGREEMENTS: {0}" -f $d.artist_disagreements.Count) -ForegroundColor Yellow
        foreach ($a in $d.artist_disagreements) {
            Write-Host ("       {0}  stored={1}  submitted={2}" -f $a.video_id, $a.stored, $a.submitted) -ForegroundColor Yellow
        }
        Write-Host "     A new alias-map entry may be owed (spec 4.1.4)." -ForegroundColor Yellow
    }

    if ($DryRunOnly) { Write-Host "     (dry run only)" -ForegroundColor DarkGray; Write-Host ""; continue }

    Write-Host ""
    $ans = Read-Host "     Write these $($d.would_insert) row(s)? [y/N/q]"
    if ($ans -eq "q") { Write-Host "     stopped." -ForegroundColor Yellow; break }
    if ($ans -ne "y") { Write-Host "     skipped." -ForegroundColor DarkGray; Write-Host ""; continue }

    $w = Invoke-Batch $file "confirm"
    Write-Host ("     WROTE  inserted {0}   already held {1}   tracks created {2}" -f `
        $w.plays_inserted, $w.plays_already_held, $w.tracks_created) -ForegroundColor Green

    if ($w.plays_inserted -ne $d.would_insert) {
        Write-Host ("     !! PREDICTION MISMATCH: dry run said {0}, write did {1}." -f `
            $d.would_insert, $w.plays_inserted) -ForegroundColor Red
        Write-Host "     The dry run shares row derivation with the write, so a" -ForegroundColor Red
        Write-Host "     mismatch means something changed between the two calls or" -ForegroundColor Red
        Write-Host "     the shared path diverged. STOP and investigate." -ForegroundColor Red
        break
    }
    if ($w.canonical_links_made -gt 0) {
        Write-Host ("     canonical links made: {0}" -f $w.canonical_links_made) -ForegroundColor Cyan
    }
    Write-Host ""
}

Write-Host ""
Write-Host "  done." -ForegroundColor Cyan
