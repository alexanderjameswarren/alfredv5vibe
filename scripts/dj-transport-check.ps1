# Measure what Invoke-RestMethod actually puts on the wire.
#
# A dry run reported: stored="Michael Buble" (correct) vs a submitted value
# carrying a U+FFFD replacement character. The batch files are verified
# byte-identical to the Takeout export, so the corruption happens IN TRANSIT,
# and the only transit is the import script. This measures that instead of
# reasoning about it: a local HttpListener receives the POST, and the bytes it
# receives are compared against the bytes on disk.
#
# No internet, no token, nothing written. Run from anywhere.

$ErrorActionPreference = "Stop"
$PROBE = "C:\Users\Alex\projects\alfred-v5\workshop\data\dj\takeout-probe"
$PORT = 8899

function Test-Transport($file, $contentType, $useBytes) {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$PORT/")
    $listener.Start()
    $pending = $listener.GetContextAsync()

    $onDisk = [System.IO.File]::ReadAllBytes($file)
    if ($useBytes) {
        $payload = $onDisk
    } else {
        $payload = [System.IO.File]::ReadAllText($file)   # exactly what the import script does
    }
    $headers = @{ Authorization = "Bearer x"; "Content-Type" = $contentType }
    try {
        Invoke-RestMethod -Uri "http://localhost:$PORT/" -Method Post -Headers $headers -Body $payload -TimeoutSec 20 | Out-Null
    } catch {}

    $ctx = $pending.GetAwaiter().GetResult()
    $ms = New-Object System.IO.MemoryStream
    $ctx.Request.InputStream.CopyTo($ms)
    $got = $ms.ToArray()
    $ctx.Response.StatusCode = 200
    $ctx.Response.Close()
    $listener.Stop(); $listener.Close()

    $firstDiff = -1
    $n = [Math]::Min($onDisk.Length, $got.Length)
    for ($i = 0; $i -lt $n; $i++) {
        if ($onDisk[$i] -ne $got[$i]) { $firstDiff = $i; break }
    }
    if ($firstDiff -lt 0 -and $onDisk.Length -ne $got.Length) { $firstDiff = $n }

    $label = if ($useBytes) { "byte[] body" } else { "string body" }
    Write-Host ("  {0,-13} Content-Type: {1}" -f $label, $contentType)
    Write-Host ("     on disk {0} bytes   received {1} bytes" -f $onDisk.Length, $got.Length)
    if ($firstDiff -lt 0) {
        Write-Host "     IDENTICAL - transport is clean" -ForegroundColor Green
    } else {
        $hiA = [Math]::Min($firstDiff + 5, $onDisk.Length - 1)
        $hiB = [Math]::Min($firstDiff + 5, $got.Length - 1)
        $a = ($onDisk[$firstDiff..$hiA] | ForEach-Object { "{0:X2}" -f $_ }) -join " "
        $b = ($got[$firstDiff..$hiB] | ForEach-Object { "{0:X2}" -f $_ }) -join " "
        Write-Host ("     CORRUPTED at byte {0}" -f $firstDiff) -ForegroundColor Red
        Write-Host ("        disk: {0}" -f $a) -ForegroundColor Red
        Write-Host ("        wire: {0}" -f $b) -ForegroundColor Red
    }
    try {
        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        [void]$strict.GetString($got)
        Write-Host "     received bytes ARE valid UTF-8"
    } catch {
        Write-Host "     received bytes are NOT valid UTF-8 - a strict parser rejects this" -ForegroundColor Red
    }
    Write-Host ""
}

foreach ($f in @("batch_002.json", "batch_003.json")) {
    Write-Host "=== $f ===" -ForegroundColor Cyan
    $path = Join-Path $PROBE $f
    Test-Transport $path "application/json" $false
    Test-Transport $path "application/json; charset=utf-8" $false
    Test-Transport $path "application/json" $true
}
