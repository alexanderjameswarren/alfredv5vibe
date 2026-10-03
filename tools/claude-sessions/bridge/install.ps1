# Registers the Switchboard bridge host with Chrome, for this user only.
# Spec: docs/technical-spec-switchboard_bridge.md, section 1.
#
#   install.ps1 -ExtensionId <daily>,<test>   write the manifest and the registry entry
#   install.ps1 -Remove                       delete both
#   -DryRun                                   print what would happen, change nothing
#
# The manifest goes to %LOCALAPPDATA%\claude-sessions\bridge\ (-BridgeDir overrides it) and
# points at the host.bat beside this script, so run it from the checkout that should serve
# Chrome: main, once the project is finished.
param(
    [string[]]$ExtensionId = @(),
    [switch]$Remove,
    [switch]$DryRun,
    [string]$BridgeDir = (Join-Path $env:LOCALAPPDATA 'claude-sessions\bridge'),
    [string]$RegistryKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.alfred.switchboard'
)
$ErrorActionPreference = 'Stop'
$hostName = 'com.alfred.switchboard'
$manifestPath = Join-Path $BridgeDir "$hostName.json"
$hostBat = Join-Path $PSScriptRoot 'host.bat'

if ($Remove) {
    if ($DryRun) {
        Write-Output "would delete $manifestPath"
        Write-Output "would delete $RegistryKey"
        exit 0
    }
    if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force -Confirm:$false }
    if (Test-Path $RegistryKey) { Remove-Item $RegistryKey -Force -Confirm:$false }
    Write-Output "removed $hostName"
    exit 0
}

# "-ExtensionId a,b" arrives as one string from cmd, or as two from PowerShell.
$ids = @($ExtensionId | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($ids.Count -eq 0) { throw 'Give at least one id: -ExtensionId <daily>,<test> (from chrome://extensions).' }
foreach ($id in $ids) {
    if ($id -notmatch '^[a-p]{32}$') { throw "Not a Chrome extension id: '$id' (32 letters a to p)." }
}
if (-not (Test-Path $hostBat)) { throw "host.bat not found beside this script: $hostBat" }

$manifest = Get-Content (Join-Path $PSScriptRoot 'host-manifest.template.json') -Raw | ConvertFrom-Json
$manifest.path = $hostBat
$manifest.allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
$json = $manifest | ConvertTo-Json -Depth 4

if ($DryRun) {
    Write-Output "would write $manifestPath :"
    Write-Output $json
    Write-Output "would set $RegistryKey (Default) = $manifestPath"
    exit 0
}

New-Item -ItemType Directory -Force $BridgeDir | Out-Null
# No BOM: Chrome reads the manifest as plain UTF-8.
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding $false))
if (-not (Test-Path $RegistryKey)) { New-Item -Path $RegistryKey -Force | Out-Null }
Set-Item -Path $RegistryKey -Value $manifestPath
Write-Output "installed $hostName"
Write-Output "  manifest: $manifestPath"
Write-Output "  host:     $hostBat"
Write-Output "  origins:  $($manifest.allowed_origins -join ', ')"
