# Runs the Switchboard panel's AutoHotkey tests: test-status.ahk, then smoke-test.ahk,
# then the bridge host's node tests (bridge/host.test.mjs).
# Each fails on any #Warn warning, is stopped after 90 s, and prints its output.
# Exit code 0 only if both pass.
$ErrorActionPreference = 'Stop'
$ahk = 'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe'
$dir = $PSScriptRoot
$out = Join-Path $env:TEMP 'claude-sessions-tests.out.txt'
$err = Join-Path $env:TEMP 'claude-sessions-tests.err.txt'
$failed = 0

foreach ($test in 'test-status.ahk', 'smoke-test.ahk') {
    $p = Start-Process -FilePath $ahk -ArgumentList '/ErrorStdOut', $test -WorkingDirectory $dir `
        -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle   # without this, ExitCode can come back empty
    if (-not $p.WaitForExit(90000)) {
        $p.Kill()
        Write-Output "$test TIMED OUT (a dialog may be open)"
        $failed++
    } else {
        Write-Output "$test exit $($p.ExitCode)"
        if ($p.ExitCode -ne 0) { $failed++ }
    }
    Get-Content $out -Encoding UTF8
    Get-Content $err -Encoding UTF8
}

$p = Start-Process -FilePath 'node' -ArgumentList '--test', 'bridge/host.test.mjs' -WorkingDirectory $dir `
    -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$null = $p.Handle
if (-not $p.WaitForExit(90000)) { $p.Kill(); Write-Output 'host.test.mjs TIMED OUT'; $failed++ }
else {
    Write-Output "host.test.mjs exit $($p.ExitCode)"
    if ($p.ExitCode -ne 0) { $failed++; Get-Content $out -Encoding UTF8 }
}

if ($failed) { Write-Output "$failed test file(s) failed"; exit 1 }
Write-Output 'all Switchboard tests passed'
exit 0
