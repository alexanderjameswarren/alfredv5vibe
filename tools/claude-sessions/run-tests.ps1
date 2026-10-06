# Runs the Switchboard panel's AutoHotkey tests: test-status.ahk, then smoke-test.ahk,
# then the bridge host's node tests (bridge/host.test.mjs).
# An AHK test passes only if it exits 0 AND its last line ends in "passed" ("all passed",
# "smoke passed"). Exit 0 without that line is "did not finish": the panel it includes
# can exit 0 partway, from the tray's Exit or #SingleInstance Force.
# Each is stopped after 90 s and prints its output. Exit code 0 only if all pass.
# -Tests runs only the AHK files named (relative to this folder, or absolute), no host tests.
param([string[]]$Tests)
$ErrorActionPreference = 'Stop'
$ahk = 'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe'
$dir = $PSScriptRoot
# Per run, so two runs at once cannot read each other's output.
$run = "$PID-$(Get-Random)"
$out = Join-Path $env:TEMP "claude-sessions-tests-$run.out.txt"
$err = Join-Path $env:TEMP "claude-sessions-tests-$run.err.txt"
$failed = 0
$withHost = -not $Tests
if (-not $Tests) { $Tests = 'test-status.ahk', 'smoke-test.ahk' }

foreach ($test in $Tests) {
    $p = Start-Process -FilePath $ahk -ArgumentList '/ErrorStdOut', "`"$test`"" -WorkingDirectory $dir `
        -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle   # without this, ExitCode can come back empty
    if (-not $p.WaitForExit(90000)) {
        $p.Kill()
        Write-Output "$test TIMED OUT (a dialog may be open)"
        $failed++
    } else {
        $last = @(Get-Content $out -Encoding UTF8 | Where-Object { $_.Trim() -ne '' }) | Select-Object -Last 1
        if ($p.ExitCode -ne 0) {
            Write-Output "$test exit $($p.ExitCode)"
            $failed++
        } elseif ($last -notmatch 'passed\s*$') {
            Write-Output "$test DID NOT FINISH (exit 0, but its last line is not its passed line)"
            $failed++
        } else {
            Write-Output "$test exit 0"
        }
    }
    Get-Content $out -Encoding UTF8
    Get-Content $err -Encoding UTF8
}

if ($withHost) {
    $p = Start-Process -FilePath 'node' -ArgumentList '--test', 'bridge/host.test.mjs' -WorkingDirectory $dir `
        -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle
    if (-not $p.WaitForExit(90000)) { $p.Kill(); Write-Output 'host.test.mjs TIMED OUT'; $failed++ }
    else {
        Write-Output "host.test.mjs exit $($p.ExitCode)"
        if ($p.ExitCode -ne 0) { $failed++; Get-Content $out -Encoding UTF8 }
    }
}

Remove-Item $out, $err -ErrorAction SilentlyContinue
if ($failed) { Write-Output "$failed test file(s) failed"; exit 1 }
Write-Output 'all Switchboard tests passed'
exit 0
