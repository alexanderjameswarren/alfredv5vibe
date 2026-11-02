# Seeds the Switchboard repo from alfred-v5: a plain copy by path-map.json, with the import paths that change
# rewritten, project-level hooks at their new paths, and a README naming the commit it came from.
# Spec: docs/technical-spec-switchboard2-h8r.md 9.1. An approved exception to the Edit and Write rule (s49).
#
# It runs no git command and changes nothing in alfred-v5. Alex runs it, then creates the repo and commits.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\switchboard-seed\seed.ps1 -Commit <sha> [-Target <folder>]
#
# Written for Windows PowerShell 5.1.
param(
    [Parameter(Mandatory = $true)][string]$Commit,
    [string]$Target = 'C:\Users\Alex\projects\switchboard'
)
$ErrorActionPreference = 'Stop'

if ($Commit -notmatch '^[0-9a-f]{7,40}$') { throw "Not a commit id: $Commit" }
$source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$map = Get-Content (Join-Path $PSScriptRoot 'path-map.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)

$Target = [IO.Path]::GetFullPath($Target)
if (($Target + '\').StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "The target is inside alfred-v5: $Target" }
if ((Test-Path $Target) -and @(Get-ChildItem -LiteralPath $Target -Force).Count -gt 0) { throw "The target exists and isn't empty: $Target" }

# Every file: its old path to its new one.
$files = @{}
foreach ($entry in $map.paths) {
    $from = Join-Path $source ($entry.from -replace '/', '\')
    if (-not (Test-Path -LiteralPath $from)) { throw "Not found in alfred-v5: $($entry.from)" }
    if ($entry.from.EndsWith('/')) {
        foreach ($f in Get-ChildItem -LiteralPath $from -Recurse -File -Force) {
            $rel = $f.FullName.Substring($from.Length).TrimStart('\') -replace '\\', '/'
            $files[$entry.from + $rel] = $entry.to + $rel
        }
    } else {
        $files[$entry.from] = $entry.to
    }
}

function Join-Posix([string]$dir, [string]$rel) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($p in (($dir + '/' + $rel) -split '/')) {
        if ($p -eq '' -or $p -eq '.') { continue }
        if ($p -eq '..') { if ($parts.Count -gt 0) { $parts.RemoveAt($parts.Count - 1) }; continue }
        [void]$parts.Add($p)
    }
    return ($parts -join '/')
}

function Get-Dir([string]$path) {
    $at = $path.LastIndexOf('/')
    if ($at -lt 0) { return '' }
    return $path.Substring(0, $at)
}

function Get-Relative([string]$fromDir, [string]$to) {
    $a = @($fromDir -split '/' | Where-Object { $_ -ne '' })
    $b = @($to -split '/' | Where-Object { $_ -ne '' })
    $i = 0
    while ($i -lt $a.Count -and $i -lt ($b.Count - 1) -and $a[$i] -ceq $b[$i]) { $i++ }
    $up = ''
    for ($j = $i; $j -lt $a.Count; $j++) { $up += '../' }
    if ($up -eq '') { $up = './' }
    return $up + (($b[$i..($b.Count - 1)]) -join '/')
}

# Copy byte for byte: this carries the binaries, and keeps every file the rewrites don't touch exact.
foreach ($old in $files.Keys) {
    $dest = Join-Path $Target ($files[$old] -replace '/', '\')
    [void](New-Item -ItemType Directory -Force -Path (Split-Path $dest))
    Copy-Item -LiteralPath (Join-Path $source ($old -replace '/', '\')) -Destination $dest
}

# Import paths: what each moved file imports, wherever that went.
$importRe = [regex]'(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["''])(\.\.?/[^"'']+)\2'
$rewritten = New-Object System.Collections.ArrayList
$unresolved = New-Object System.Collections.ArrayList
foreach ($old in ($files.Keys | Sort-Object)) {
    if ($old -notmatch '\.(mjs|js)$') { continue }
    $new = $files[$old]
    $dest = Join-Path $Target ($new -replace '/', '\')
    $text = [IO.File]::ReadAllText($dest, $utf8)
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator] {
        param($m)
        $was = $m.Groups[3].Value
        $target = Join-Posix (Get-Dir $old) $was
        if (-not $files.ContainsKey($target)) {
            if (Test-Path -LiteralPath (Join-Path $source ($target -replace '/', '\'))) { [void]$unresolved.Add("$new : $was") }
            return $m.Value
        }
        $now = Get-Relative (Get-Dir $new) $files[$target]
        if ($now -ceq $was) { return $m.Value }
        [void]$rewritten.Add("$new : $was -> $now")
        return $m.Groups[1].Value + $m.Groups[2].Value + $now + $m.Groups[2].Value
    }
    $after = $importRe.Replace($text, $evaluator)
    if ($after -cne $text) { [IO.File]::WriteAllText($dest, $after, $utf8) }
}

# The other paths that change. One that finds nothing stops the seed: the map is out of date.
foreach ($r in $map.rewrites) {
    $dest = Join-Path $Target ($r.file -replace '/', '\')
    $text = [IO.File]::ReadAllText($dest, $utf8)
    if (-not $text.Contains($r.from)) { throw "Rewrite found nothing in $($r.file): $($r.from)" }
    [IO.File]::WriteAllText($dest, $text.Replace($r.from, $r.to), $utf8)
    [void]$rewritten.Add("$($r.file) : $($r.from) -> $($r.to)")
}

# Project-level hooks at their new paths, so the repo is guarded from its first prompt.
$settings = Get-Content (Join-Path $source '.claude\settings.local.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$allow = @($settings.permissions.allow | Where-Object { $_ -match 'scripts/claims\.mjs' } | ForEach-Object { $_ -replace 'scripts/claims\.mjs', 'claims/claims.mjs' })
$out = [ordered]@{ permissions = @{ allow = $allow }; hooks = $settings.hooks }
$json = ($out | ConvertTo-Json -Depth 20) -replace '/\.claude/hooks/', '/hooks/'
[void](New-Item -ItemType Directory -Force -Path (Join-Path $Target '.claude'))
[IO.File]::WriteAllText((Join-Path $Target '.claude\settings.local.json'), $json, $utf8)

$readme = "# Switchboard`n`nThe CLI tooling, panel and bridge behind Alfred's CLI threads. Spec: alfred-v5, ``docs/technical-spec-switchboard2-h8r.md``.`n`nSeeded by a plain copy from alfred-v5 commit $Commit. The earlier history is in alfred-v5.`n"
[IO.File]::WriteAllText((Join-Path $Target 'README.md'), $readme, $utf8)
[IO.File]::WriteAllText((Join-Path $Target '.gitignore'), ".clip/`nnode_modules/`n", $utf8)
# jsdom is for the extension's page tests, which skip themselves without it.
[IO.File]::WriteAllText((Join-Path $Target 'package.json'), "{`n  `"private`": true,`n  `"type`": `"module`",`n  `"devDependencies`": { `"jsdom`": `"^24.0.0`" }`n}`n", $utf8)

Write-Output "Seeded $($files.Count) files into $Target, from alfred-v5 commit $Commit."
Write-Output "Rewritten: $($rewritten.Count)"
$rewritten | ForEach-Object { Write-Output "  $_" }
if ($unresolved.Count) {
    Write-Output "NOT MOVED, so these imports don't resolve: $($unresolved.Count)"
    $unresolved | ForEach-Object { Write-Output "  $_" }
}
