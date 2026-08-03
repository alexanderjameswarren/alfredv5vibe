# Workshop — Manual Setup

Everything in this file is done by hand. The CLI does not do any of it.

Hostnames:

- `workshop-dev.alexanderjameswarren.com` → desktop (staging)
- `workshop.alexanderjameswarren.com` → Surface (production)

Supabase authorization server: `https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1`

---

## Phase A — Desktop prerequisites (do before any CLI work)

### A1. Python

Install Python 3.11 or newer from python.org. Check "Add python.exe to PATH".

```powershell
python --version
```

Must print 3.11+. If PowerShell opens the Microsoft Store instead, the PATH entry
didn't take — reinstall with the checkbox ticked.

### A2. Nothing else yet

Do not create the tunnel yet. Build and verify the server on `127.0.0.1:7777`
first; a tunnel pointing at nothing just adds a second unknown.

---

## Phase B — Cloudflare tunnel, desktop (after CLI Step 3 verifies locally)

Two ways to run a named tunnel. **Use the dashboard-managed path.** Locally-managed
tunnels keep their config in a YAML file whose location changes when `cloudflared`
runs as a Windows service, and that discrepancy is a classic afternoon-loser.

### B1. Zero Trust org

Cloudflare dashboard → **Zero Trust**. First visit asks you to pick a team name and
a plan; choose **Free**. You may be asked for a payment method even on Free — that's
normal, nothing is charged at this tier.

### B2. Create the tunnel

Zero Trust → **Networks → Tunnels → Create a tunnel** → **Cloudflared**.

Name it `workshop-dev`. The dashboard shows an install command containing a long
token. Copy the **Windows** variant.

> Menu paths in the Zero Trust dashboard move around. If Networks → Tunnels isn't
> there, look for Access → Tunnels or search "tunnel" in the dashboard.

### B3. Install as a service

Run the copied command in an **Administrator** PowerShell. It downloads
`cloudflared`, installs it as a Windows service, and connects using the token.

```powershell
Get-Service cloudflared
```

Should show Running.

### B4. Route the hostname

Back in the tunnel's config, **Public Hostname** tab → Add a public hostname:

| Field | Value |
|---|---|
| Subdomain | `workshop-dev` |
| Domain | `alexanderjameswarren.com` |
| Type | `HTTP` |
| URL | `127.0.0.1:7777` |

`HTTP` not `HTTPS` — the hop from cloudflared to your local process is plaintext on
loopback. Cloudflare terminates TLS at the edge; the public URL is still https.

DNS is created automatically. Verify:

```powershell
Invoke-RestMethod https://workshop-dev.alexanderjameswarren.com/health
```

Should return the same JSON as `http://127.0.0.1:7777/health`.

### B5. What this gets you

`cloudflared` and the Python server are two independent services. Restarting Python
does not touch the tunnel — the connector sees a few seconds of 502 and recovers. You
can redeploy all day without re-authenticating anything.

---

## Phase C — Register the connector (after CLI Step 5)

Claude.ai → **Settings → Connectors → Add custom connector**

| Field | Value |
|---|---|
| Name | `Workshop (Dev)` |
| Remote MCP server URL | `https://workshop-dev.alexanderjameswarren.com/mcp` |
| OAuth Client ID | *leave blank* |
| OAuth Client Secret | *leave blank* |

Blank is deliberate. Supabase advertises a `registration_endpoint`, so Claude
registers itself dynamically. If it fails and asks for a client ID, that's real
information — tell me, don't work around it.

Click Connect. A Supabase login should appear. Sign in with Google.

**Then read the server log.** Pass 1 logs full decoded token claims. That output is
the input to CLI Step 6.

---

## Phase D — Surface deployment (after CLI Step 7)

Do all of this over **Remote Desktop from the desktop machine**. Full keyboard, once.
The Surface should never see a credential prompt again.

### D1. Sleep

Settings → System → Power → **When plugged in, put my device to sleep after: Never**.

On battery it will still enter connected standby and the tunnel will drop. That's
expected. Workshop is a mains-powered service.

### D2. Python + git

Install Python 3.11+ (PATH checkbox) and Git for Windows.

### D3. Git credentials, typed once

Generate an SSH key on the Surface:

```powershell
ssh-keygen -t ed25519 -C "surface-workshop" -f $env:USERPROFILE\.ssh\id_ed25519 -N '""'
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

Add the printed key to GitHub as a **deploy key** on the `alfred-v5` repo,
**read-only**. The Surface never pushes.

### D4. Sparse checkout

```powershell
cd C:\
git clone --filter=blob:none --sparse git@github.com:<you>/alfred-v5.git C:\workshop-repo
cd C:\workshop-repo
git sparse-checkout set workshop
```

Only `workshop/` lands on disk. No React app, no Edge Functions.

### D5. Virtualenv

```powershell
cd C:\workshop-repo\workshop
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

### D6. Environment

Copy `.env.example` to `.env` and set:

```
WORKSHOP_HOST_ID=surface
WORKSHOP_AUTH_MODE=strict
```

`.env` is gitignored and lives only on the machine. It is never pulled or reset.

### D7. Second tunnel

Repeat Phase B with tunnel name `workshop` and hostname
`workshop.alexanderjameswarren.com`. Separate tunnel, separate token, same steps.

### D8. Run as a scheduled task, not a service

`cloudflared` runs as SYSTEM, which is fine — it only needs network. **Workshop must
run as you**, or DPAPI-protected secrets and anything in your user profile become
invisible to it.

Task Scheduler → Create Task:

- **General**: Run whether user is logged on or not. Do *not* check "Run with highest
  privileges" — it doesn't need admin.
- **Triggers**: At startup. Delay 30 seconds.
- **Actions**: Start a program
  - Program: `C:\workshop-repo\workshop\.venv\Scripts\python.exe`
  - Arguments: `run.py`
  - Start in: `C:\workshop-repo\workshop`
- **Settings**: Restart every 1 minute, up to 3 times. Uncheck "Stop the task if it
  runs longer than".

Name it `Workshop`. It will ask for your Windows password — that's what
"whether logged on or not" requires.

### D9. Register the second connector

Same as Phase C, named `Workshop (Surface)`, URL
`https://workshop.alexanderjameswarren.com/mcp`.

You now have two connectors. `get_workshop_status` returns `host: surface` or
`host: desktop` so you always know which answered.

---

## Phase E — The refresh button

Save as `C:\workshop-repo\refresh.ps1` on the Surface. **This file is not in the
repo** — it must survive `git reset --hard`.

```powershell
# Workshop — Refresh Code
$ErrorActionPreference = "Stop"
$repo = "C:\workshop-repo"
$app  = "$repo\workshop"
$py   = "$app\.venv\Scripts\python.exe"
$pip  = "$app\.venv\Scripts\pip.exe"

function Say($msg, $color = "White") { Write-Host "`n$msg" -ForegroundColor $color }

try {
    Say "1/5  Fetching..." Cyan
    Set-Location $repo
    $before = git rev-parse HEAD
    git fetch --all --prune
    git reset --hard origin/main          # NEVER pull — reset cannot conflict
    $after = git rev-parse HEAD

    if ($before -eq $after) {
        Say "     No new commits ($($after.Substring(0,7)))" DarkGray
    } else {
        Say "     $($before.Substring(0,7)) -> $($after.Substring(0,7))" Green
        git log --oneline "$before..$after" | Select-Object -First 10 | ForEach-Object { Write-Host "       $_" }
    }

    Say "2/5  Dependencies..." Cyan
    & $pip install -q -r "$app\requirements.txt"

    Say "3/5  Restarting Workshop..." Cyan
    Stop-ScheduledTask  -TaskName "Workshop" -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName "Workshop"

    Say "4/5  Waiting for startup..." Cyan
    Start-Sleep -Seconds 5

    Say "5/5  Health check..." Cyan
    $ok = $false
    foreach ($attempt in 1..6) {
        try {
            $h = Invoke-RestMethod "http://127.0.0.1:7777/health" -TimeoutSec 3
            Say "     HEALTHY  host=$($h.host)  sha=$($h.git_sha)  tools=$($h.tool_count)" Green
            $ok = $true
            break
        } catch {
            Write-Host "     attempt $attempt/6..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 3
        }
    }
    if (-not $ok) {
        Say "     UNHEALTHY — server did not respond" Red
        Say "     Recent log:" Yellow
        Get-Content "$app\data\workshop.log" -Tail 25 -ErrorAction SilentlyContinue
    }

    Say "Tunnel:" Cyan
    $svc = Get-Service cloudflared -ErrorAction SilentlyContinue
    if ($svc) { Say "     cloudflared is $($svc.Status)" ($(if($svc.Status -eq 'Running'){"Green"}else{"Red"})) }
    else      { Say "     cloudflared service NOT FOUND" Red }

} catch {
    Say "FAILED: $($_.Exception.Message)" Red
}

Say "`nDone. Tap to close." DarkGray
Read-Host
```

### The shortcut

Right-click desktop → New → Shortcut:

```
powershell.exe -ExecutionPolicy Bypass -NoExit -File C:\workshop-repo\refresh.ps1
```

Name it **Refresh Workshop**. Right-click → Pin to Start. Make the tile large.

`-NoExit` matters. A window that flashes and closes tells you nothing, and you cannot
scroll back what isn't there.

### Why reset and not pull

`git pull` can merge, a merge can conflict, and resolving a conflict is interactive.
On a touch-only tablet that is a wedged machine. `git reset --hard` makes the Surface
a read-only mirror that cannot diverge, so it cannot conflict.

---

## Troubleshooting order

When something is wrong, work outside-in:

1. `Get-Service cloudflared` — is the tunnel process alive?
2. `Invoke-RestMethod http://127.0.0.1:7777/health` — is Workshop alive locally?
3. `Invoke-RestMethod https://workshop.alexanderjameswarren.com/health` — does the
   tunnel reach it?
4. `Get-Content data\workshop.log -Tail 50` — what did it say?

`/health` is deliberately unauthenticated so step 2 and 3 work before auth is in play.
It returns host, version, git sha, uptime, and tool count. Nothing sensitive.
