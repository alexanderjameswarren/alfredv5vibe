# Creates (or overwrites) a "Switchboard" shortcut in the Start menu and in Startup,
# each running this checkout's claude-sessions.ahk with alfred.ico. Safe to rerun.
# -Remove deletes both shortcuts.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$ahk = 'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe'
$dir = $PSScriptRoot
$script = Join-Path $dir 'claude-sessions.ahk'
$icon = Join-Path $dir 'alfred.ico'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$links = @((Join-Path $programs 'Switchboard.lnk'), (Join-Path $programs 'Startup\Switchboard.lnk'))

if ($Remove) {
    foreach ($link in $links) {
        if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link; "removed $link" }
        else { "not there: $link" }
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $ahk)) { throw "AutoHotkey v2 not found at $ahk" }
$shell = New-Object -ComObject WScript.Shell
foreach ($link in $links) {
    $s = $shell.CreateShortcut($link)
    $s.TargetPath = $ahk
    $s.Arguments = '"' + $script + '"'
    $s.WorkingDirectory = $dir
    $s.Description = 'Switchboard: Claude Code sessions on alfred-v5'
    if (Test-Path -LiteralPath $icon) { $s.IconLocation = "$icon,0" }
    $s.Save()
    "wrote $link"
}
