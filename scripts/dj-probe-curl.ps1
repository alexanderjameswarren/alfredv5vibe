# Probe the import endpoint with curl.exe, not Invoke-RestMethod.
#
# WHY curl AND NOT THE IMPORT SCRIPT. The last two probe runs each changed more
# than one thing at a time - first the file encoding, then the file encoding AND
# the request body type together - so neither can attribute its result. This
# removes PowerShell's HTTP stack from the experiment entirely: curl sends the
# file with --data-binary, which is the bytes on disk and nothing else.
#
# It also prints the RAW response body and the HTTP status. The import script
# reported an EMPTY body on the 500s, and the endpoint always returns JSON with
# an `error` field - so an empty body suggests the response is not coming from
# the handler at all, and that distinction decides where to look next.
#
# Nothing is written: every request is mode=dry_run.

param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$ProbeDir = "C:\Users\Alex\projects\alfred-v5\workshop\data\dj\takeout-probe",
    [string]$Url = "https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/mcp/import-takeout"
)

$curl = "$env:SystemRoot\System32\curl.exe"
if (-not (Test-Path $curl)) { throw "curl.exe not found at $curl" }

Write-Host ""
Write-Host "  curl probe - mode=dry_run only, nothing is written" -ForegroundColor Cyan
Write-Host ""

foreach ($f in (Get-ChildItem -Path $ProbeDir -Filter "batch_*.json" | Sort-Object Name)) {
    $bytes = (Get-Item $f.FullName).Length
    Write-Host ("  ---- {0}  ({1:N0} bytes) ----" -f $f.Name, $bytes) -ForegroundColor DarkGray

    # -s silent, -S still show errors, -w appends the status line, -D- dumps
    # response headers so a gateway response is distinguishable from ours.
    $out = & $curl -s -S -X POST `
        "$Url`?mode=dry_run" `
        -H "Authorization: Bearer $Token" `
        -H "Content-Type: application/json" `
        --data-binary "@$($f.FullName)" `
        -D - `
        -w "`n[HTTP %{http_code}  sent %{size_upload} bytes  in %{time_total}s]" 2>&1

    $text = ($out | Out-String)
    # Keep the status line and anything that looks like a body or a telling header.
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^\s*$') { continue }
        if ($line -match '^(HTTP/|x-|cf-|server:|content-type:|content-length:)' -or
            $line -match '^\[HTTP' -or $line -match '[{}]' -or $line -match 'error') {
            $colour = if ($line -match '^\[HTTP (2|3)') { "Green" }
                      elseif ($line -match '^\[HTTP') { "Red" }
                      else { "Gray" }
            Write-Host ("     " + $line.Trim()) -ForegroundColor $colour
        }
    }
    Write-Host ""
}
Write-Host "  done." -ForegroundColor Cyan
