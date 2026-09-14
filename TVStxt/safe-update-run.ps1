param(
    [ValidateSet("StashMerge")]
    [string]$Mode = "StashMerge"
)

$ErrorActionPreference = "Stop"

$repoPath = "C:\VCP\VCPToolBox"
$upstreamRemote = "upstream"
$upstreamBranch = "main"
$localBranch = "personal/main"
$step = 0
$finalResult = "UNKNOWN"
$createdStash = $false
$stashName = ""

function Step-Title([string]$title) {
    $script:step++
    Write-Host ""
    Write-Host ("=== [{0}] {1} ===" -f $script:step, $title)
}

function Info([string]$msg) { Write-Host ("[INFO] " + $msg) }
function Ok([string]$msg) { Write-Host ("[OK] " + $msg) }
function Warn([string]$msg) { Write-Host ("[WARN] " + $msg) }
function Fail([string]$msg) { Write-Host ("[FAIL] " + $msg) }

try {
    Step-Title "Startup"
    if (-not (Test-Path $repoPath)) {
        throw "repo path not found: $repoPath"
    }
    Set-Location $repoPath
    Ok "repo path exists"
    Info ("mode: " + $Mode)

    Step-Title "Preflight repository state"
    $mergeHead = Join-Path $repoPath ".git\MERGE_HEAD"
    $rebaseMerge = Join-Path $repoPath ".git\rebase-merge"
    $rebaseApply = Join-Path $repoPath ".git\rebase-apply"
    $cherryPickHead = Join-Path $repoPath ".git\CHERRY_PICK_HEAD"
    $lockPath = Join-Path $repoPath ".git\index.lock"

    if (Test-Path $lockPath) {
        throw "index.lock detected; resolve lock before running update"
    }
    if ((Test-Path $mergeHead) -or (Test-Path $rebaseMerge) -or (Test-Path $rebaseApply) -or (Test-Path $cherryPickHead)) {
        throw "repository is in half-finished state; run safe-update-resolve first"
    }
    Ok "repository state is clean enough for update"

    Step-Title "Check current branch"
    $branch = (git -C $repoPath branch --show-current 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "failed to get current branch: $branch"
    }
    Info ("current branch: " + $branch)
    if ($branch -ne $localBranch) {
        throw "current branch is not expected local branch: $localBranch"
    }
    Ok "current branch matches expected local branch"

    Step-Title "Inspect working tree"
    $status = (git -C $repoPath status --short 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed: $status"
    }

    $trackedStatus = (git -C $repoPath diff --name-only 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "failed to inspect tracked changes: $trackedStatus"
    }

    $untrackedStatus = (git -C $repoPath ls-files --others --exclude-standard 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "failed to inspect untracked files: $untrackedStatus"
    }

    if ([string]::IsNullOrWhiteSpace($status)) {
        Ok "working tree clean; no stash needed"
    } else {
        if ([string]::IsNullOrWhiteSpace($trackedStatus)) {
            Warn "working tree has only untracked files; skip stash"
            if (-not [string]::IsNullOrWhiteSpace($untrackedStatus)) {
                $untrackedStatus -split "`r?`n" | ForEach-Object {
                    if ($_.Trim() -ne "") { Info ("untracked: " + $_) }
                }
            }
        } else {
            Warn "tracked changes detected; creating stash for tracked files only"
            $trackedStatus -split "`r?`n" | ForEach-Object {
                if ($_.Trim() -ne "") { Info ("tracked: " + $_) }
            }

            if (-not [string]::IsNullOrWhiteSpace($untrackedStatus)) {
                Warn "untracked files will remain in working tree"
                $untrackedStatus -split "`r?`n" | ForEach-Object {
                    if ($_.Trim() -ne "") { Info ("untracked: " + $_) }
                }
            }

            $script:stashName = "safe-update-" + (Get-Date -Format "yyyy-MM-dd-HH-mm-ss")
            $stashOutput = (git -C $repoPath stash push -m $script:stashName 2>&1 | Out-String).Trim()
            $stashExit = $LASTEXITCODE

            if (-not [string]::IsNullOrWhiteSpace($stashOutput)) {
                $stashOutput -split "`r?`n" | ForEach-Object {
                    if ($_.Trim() -ne "") { Info $_ }
                }
            }

            $afterList = (git -C $repoPath stash list 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "failed to inspect stash list after stash push: $afterList"
            }

            if ($afterList -match [regex]::Escape($script:stashName)) {
                $script:createdStash = $true
                Ok ("stash created: " + $script:stashName)
            } elseif ($stashExit -eq 0 -and $stashOutput -match "No local changes to save") {
                Ok "git reported no tracked local changes to save; continuing without stash"
                $script:createdStash = $false
            } else {
                throw "stash push failed or stash entry not found: $stashOutput"
            }
        }
    }

    Step-Title "Fetch upstream"
    $fetchOutput = (git -C $repoPath fetch $upstreamRemote 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "fetch upstream failed: $fetchOutput"
    }
    Ok "fetch upstream success"

    Step-Title "Check upstream commits"
    $newCommits = (git -C $repoPath log HEAD..$upstreamRemote/$upstreamBranch --oneline 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "failed to inspect upstream commits: $newCommits"
    }

    if ([string]::IsNullOrWhiteSpace($newCommits)) {
        Ok "no new upstream commits"
        if ($script:createdStash) {
            Step-Title "Restore stash"
            $popOutput = (git -C $repoPath stash pop 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "stash pop failed after no-op update: $popOutput"
            }
            Ok "stash restored successfully"
        }
        $finalResult = "SUCCESS"
    } else {
        Warn "new upstream commits detected"
        $newCommits -split "`r?`n" | ForEach-Object { Info $_ }

        Step-Title "Merge upstream"
        $mergeOutput = (git -C $repoPath merge $upstreamRemote/$upstreamBranch --no-edit 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            Warn "merge failed; trying merge --abort"
            $abortOutput = (git -C $repoPath merge --abort 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0) {
                Ok "merge aborted; repo restored to pre-merge state"
            } else {
                Warn ("merge --abort failed: " + $abortOutput)
            }
            throw "merge upstream failed: $mergeOutput"
        }
        Ok "merge successful"

        if ($script:createdStash) {
            Step-Title "Restore stash"
            $popOutput = (git -C $repoPath stash pop 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                Warn "stash pop has conflicts"
                $conflicts = (git -C $repoPath diff --name-only --diff-filter=U 2>&1 | Out-String).Trim()
                if (-not [string]::IsNullOrWhiteSpace($conflicts)) {
                    $conflicts -split "`r?`n" | ForEach-Object { Info ("conflicted: " + $_) }
                }
                throw "stash pop conflict"
            }
            Ok "stash restored successfully"
        }

        $finalResult = "SUCCESS"
    }
}
catch {
    $msg = $_.Exception.Message

    if ($msg -match "half-finished state") {
        $finalResult = "BLOCKED_BY_REPO_STATE"
    }
    elseif ($msg -match "index.lock") {
        $finalResult = "BLOCKED_BY_LOCK"
    }
    elseif ($msg -match "stash pop conflict") {
        $finalResult = "NEED_MANUAL_RESOLUTION"
    }
    else {
        $finalResult = "FAILED"
    }

    Fail $msg
}
finally {
    Step-Title "Final summary"
    Info ("final result: " + $finalResult)
    Write-Host ("RESULT: " + $finalResult)
}