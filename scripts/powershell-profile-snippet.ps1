# ---------------------------------------------------------------------------
# Alfred git commands — paste this into your PowerShell profile BY HAND.
#
#   C:\Users\Alex\OneDrive\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1
#
# Replace the whole existing file with this. What is there now is four-line
# gitcom / gitcommit / gitpush functions, all of which run `git add .` — the
# sweep that twice pulled unrelated work into a commit.
#
# No CLI thread edits this file. The profile lives in OneDrive, so pasting it
# once syncs it to the Surface too.
#
# These four functions are thin wrappers. All the behaviour lives in the repo,
# under scripts/, where it is versioned and reviewable:
#
#   gitnewtree -> scripts/git-new-worktree.mjs
#   gitcom     -> scripts/git-commit-claimed.mjs
#   gitcommit  -> the same thing (it is an alias for gitcom, not a copy of it)
#   gitsync    -> scripts/git-sync.mjs
#   gitpush    -> scripts/git-push-worktrees.mjs
#
# The repo is found from wherever you are with `git rev-parse --show-toplevel`,
# so these work unchanged inside a worktree. gitnewtree and gitpush go on to act
# on the MAIN checkout whichever window you are in; gitcom and gitsync act on the
# checkout you are standing in.
#
# Every argument is forwarded, so each command can be one pasted line — which is
# the shape claude.ai gives them in. `--help` on any of them lists its options.
# A parameter answers a question the command would have asked; it never skips
# the plan or the final yes/no, so there is no --yes on any of them.
#
# Written for Windows PowerShell 5.1: no `&&`, no ternary, no null-coalescing.
# ---------------------------------------------------------------------------

function Invoke-AlfredGit {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string[]]$ScriptArgs
    )

    $root = git rev-parse --show-toplevel
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($root)) {
        Write-Host "Not inside a git repository." -ForegroundColor Yellow
        return
    }

    $path = Join-Path $root ("scripts/" + $Script)
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "Not found: $path" -ForegroundColor Yellow
        Write-Host "This checkout may predate the claims scripts, or they are not committed yet."
        return
    }

    if ($ScriptArgs -and $ScriptArgs.Count -gt 0) {
        node $path @ScriptArgs
    }
    else {
        node $path
    }
}

# Start a project in its own worktree: checks Step 0, branches from origin/main,
# copies the .worktreeinclude files, opens VS Code, offers to npm install.
#   gitnewtree claims-wq7
#   gitnewtree parallel_threads --install
function gitnewtree { Invoke-AlfredGit 'git-new-worktree.mjs' $args }

# Commit this thread's claimed, changed files. Asks about anything unclaimed.
# Never touches a file another thread has claimed.
#   gitcom
#   gitcom --include-unclaimed none --message "step 5: the answer parser"
function gitcom { Invoke-AlfredGit 'git-commit-claimed.mjs' $args }

# The old name, kept because it is in muscle memory. Calls gitcom.
function gitcommit { gitcom @args }

# Run inside a worktree: merge local main into this branch. No options — it asks
# one question and that one is always asked.
function gitsync { Invoke-AlfredGit 'git-sync.mjs' $args }

# Run from the main checkout: pick worktrees, merge them into main, push,
# release their claims. Finish or Checkpoint per worktree.
#   gitpush
#   gitpush main push
#   gitpush rem-j7p checkpoint --paths supabase/migrations/084_x.sql --release-db
function gitpush { Invoke-AlfredGit 'git-push-worktrees.mjs' $args }
