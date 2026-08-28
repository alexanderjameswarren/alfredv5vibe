# Workshop Health Check
# Pings both hosts and reports status.

$hosts = @(
    @{ Name = "Dev (desktop)"; Url = "https://workshop-dev.alexanderjameswarren.com/health" },
    @{ Name = "Surface";       Url = "https://workshop.alexanderjameswarren.com/health" }
)

Write-Host ""
Write-Host "  Workshop Health Check" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'ddd HH:mm:ss')" -ForegroundColor DarkGray
Write-Host ""

$anyDown = $false

foreach ($h in $hosts) {
    Write-Host ("  {0,-16}" -f $h.Name) -NoNewline

    try {
        $r = Invoke-RestMethod -Uri $h.Url -TimeoutSec 8

        $up = [TimeSpan]::FromSeconds($r.uptime_seconds)
        if     ($up.TotalDays  -ge 1) { $uptime = "{0}d {1}h" -f [int]$up.TotalDays, $up.Hours }
        elseif ($up.TotalHours -ge 1) { $uptime = "{0}h {1}m" -f [int]$up.TotalHours, $up.Minutes }
        else                          { $uptime = "{0}m" -f [int]$up.TotalMinutes }

        Write-Host "UP" -ForegroundColor Green -NoNewline
        Write-Host ("   host={0}  sha={1}  tools={2}  up={3}" -f $r.host, $r.git_sha, $r.tool_count, $uptime) -ForegroundColor DarkGray
    }
    catch {
        $anyDown = $true
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
    }
}

Write-Host ""

if ($anyDown) {
    Write-Host "  Dev down?     run the Start Workshop Dev shortcut" -ForegroundColor DarkGray
    Write-Host "  Surface down? tap Refresh Workshop on the tablet" -ForegroundColor DarkGray
    Write-Host ""
}

Read-Host "  Press Enter to close"