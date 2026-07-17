[CmdletBinding()]
param(
    [ValidateSet("Sync", "Continue", "Abort", "Status")]
    [string]$Operation = "Sync",

    [string]$UpstreamRemote = "upstream",
    [string]$UpstreamBranch = "main",
    [string]$LocalBranch = "personal/main",
    [string]$ForkRemote = "origin",

    [string]$RepositoryPath = "",

    [switch]$Push,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "[FAIL] $Message" -ForegroundColor Red }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "Git was not found in PATH."
    exit 10
}

$repoProbePath = if ([string]::IsNullOrWhiteSpace($RepositoryPath)) { $PSScriptRoot } else { $RepositoryPath }
$repoProbe = @(& git -C $repoProbePath rev-parse --show-toplevel 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Fail "This script is not inside a Git repository."
    $repoProbe | ForEach-Object { Write-Host $_ }
    exit 10
}

$script:RepoRoot = [System.IO.Path]::GetFullPath(($repoProbe | Select-Object -Last 1).ToString().Trim())

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$Silent
    )

    $output = @(& git -C $script:RepoRoot @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $textLines = @($output | ForEach-Object { $_.ToString() })

    if (-not $Silent) {
        $textLines | ForEach-Object { Write-Host $_ }
    }

    if (($exitCode -ne 0) -and (-not $AllowFailure)) {
        $renderedArgs = $Arguments -join " "
        throw "git $renderedArgs failed with exit code $exitCode."
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Lines = $textLines
        Text = ($textLines -join "`n").Trim()
    }
}

function Get-GitText([string[]]$Arguments) {
    return (Invoke-Git -Arguments $Arguments -Silent).Text.Trim()
}

function Resolve-GitPath([string]$RelativeGitPath) {
    $rawPath = Get-GitText @("rev-parse", "--git-path", $RelativeGitPath)
    if ([System.IO.Path]::IsPathRooted($rawPath)) {
        return [System.IO.Path]::GetFullPath($rawPath)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $script:RepoRoot $rawPath))
}

$script:StatePath = Resolve-GitPath "vcp-upstream-sync-state.json"
$script:RunnerPath = Resolve-GitPath "vcp-upstream-sync-runner.ps1"

function Install-RecoveryRunner {
    $sourcePath = [System.IO.Path]::GetFullPath($PSCommandPath)
    $targetPath = [System.IO.Path]::GetFullPath($script:RunnerPath)
    if (-not $sourcePath.Equals($targetPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        [System.IO.File]::WriteAllBytes($targetPath, [System.IO.File]::ReadAllBytes($sourcePath))
    }
}

function Remove-RecoveryRunner {
    if (Test-Path -LiteralPath $script:RunnerPath) {
        Remove-Item -LiteralPath $script:RunnerPath -Force
    }
}

function Get-RecoveryCommand([string]$NextOperation) {
    return ('pwsh -NoLogo -NoProfile -File "{0}" -RepositoryPath "{1}" -Operation {2}' -f $script:RunnerPath, $script:RepoRoot, $NextOperation)
}

function Save-State($State) {
    $State.updatedAt = (Get-Date).ToString("o")
    $json = $State | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($script:StatePath, $json, [System.Text.UTF8Encoding]::new($false))
}

function Load-State {
    if (-not (Test-Path -LiteralPath $script:StatePath)) {
        return $null
    }
    return (Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json)
}

function Remove-State {
    if (Test-Path -LiteralPath $script:StatePath) {
        Remove-Item -LiteralPath $script:StatePath -Force
    }
}

function Get-CurrentBranch {
    return Get-GitText @("branch", "--show-current")
}

function Get-UnmergedFiles {
    $result = Invoke-Git -Arguments @("diff", "--name-only", "--diff-filter=U") -Silent -AllowFailure
    if ([string]::IsNullOrWhiteSpace($result.Text)) {
        return @()
    }
    return @($result.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Test-MergeInProgress {
    $result = Invoke-Git -Arguments @("rev-parse", "-q", "--verify", "MERGE_HEAD") -Silent -AllowFailure
    return ($result.ExitCode -eq 0)
}

function Assert-NoForeignGitOperation {
    $gitDir = Get-GitText @("rev-parse", "--git-dir")
    if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
        $gitDir = Join-Path $script:RepoRoot $gitDir
    }

    $markers = @(
        (Join-Path $gitDir "rebase-merge"),
        (Join-Path $gitDir "rebase-apply"),
        (Join-Path $gitDir "CHERRY_PICK_HEAD"),
        (Join-Path $gitDir "REVERT_HEAD"),
        (Join-Path $gitDir "BISECT_LOG"),
        (Join-Path $gitDir "index.lock")
    )

    foreach ($marker in $markers) {
        if (Test-Path -LiteralPath $marker) {
            throw "Another Git operation is active: $marker"
        }
    }

    if (Test-MergeInProgress) {
        throw "A merge is already active and was not started by this script."
    }
}

function Find-StashReference([string]$StashCommit) {
    if ([string]::IsNullOrWhiteSpace($StashCommit)) {
        return $null
    }

    $list = Invoke-Git -Arguments @("stash", "list", "--format=%H%x09%gd") -Silent -AllowFailure
    foreach ($line in $list.Lines) {
        $parts = $line -split "`t", 2
        if (($parts.Count -eq 2) -and ($parts[0] -eq $StashCommit)) {
            return $parts[1]
        }
    }
    return $null
}

function Drop-SavedStash($State) {
    if ([string]::IsNullOrWhiteSpace([string]$State.stashCommit)) {
        return
    }

    $stashRef = Find-StashReference ([string]$State.stashCommit)
    if ($null -eq $stashRef) {
        Write-Warn "The saved stash is no longer in the stash list; it will not be dropped."
        return
    }

    Invoke-Git -Arguments @("stash", "drop", $stashRef) | Out-Null
    Write-Ok "Temporary stash removed: $stashRef"
}

function Restore-SavedStash($State) {
    if ([string]::IsNullOrWhiteSpace([string]$State.stashCommit)) {
        Write-Ok "No working-tree changes need to be restored."
        return $true
    }

    Write-Step "Restoring saved working-tree changes"
    $apply = Invoke-Git -Arguments @("stash", "apply", "--index", ([string]$State.stashCommit)) -AllowFailure
    if ($apply.ExitCode -eq 0) {
        Drop-SavedStash $State
        Write-Ok "Working-tree changes restored."
        return $true
    }

    $conflicts = @(Get-UnmergedFiles)
    $State.phase = "stash-conflict"
    Save-State $State
    Write-Fail "The upstream merge succeeded, but restoring uncommitted changes caused conflicts."
    if ($conflicts.Count -gt 0) {
        Write-Host "Resolve these files:"
        $conflicts | ForEach-Object { Write-Host "  $_" }
    }
    Write-Host "After resolving them, run:"
    Write-Host "  $(Get-RecoveryCommand 'Continue')"
    Write-Host "The original stash is still retained as $($State.stashCommit)."
    return $false
}

function Push-IfRequested {
    param([switch]$Enabled)
    if (-not $Enabled) {
        return
    }

    Write-Step "Pushing $LocalBranch to $ForkRemote"
    Invoke-Git -Arguments @("push", $ForkRemote, ("HEAD:refs/heads/{0}" -f $LocalBranch)) | Out-Null
    Write-Ok "Fork branch updated."
}

function Complete-Sync($State, [switch]$PushAfter) {
    $State.phase = "merged"
    Save-State $State

    if (-not (Restore-SavedStash $State)) {
        return $false
    }

    Remove-State
    Remove-RecoveryRunner
    Push-IfRequested -Enabled:$PushAfter
    Write-Ok "Upstream synchronization completed."
    Write-Host "Rollback branch: $($State.backupBranch)"
    return $true
}

function Show-SyncStatus {
    $state = Load-State
    Write-Host "Repository : $script:RepoRoot"
    Write-Host "Branch     : $(Get-CurrentBranch)"
    if ($null -eq $state) {
        Write-Host "Sync state : idle"
    }
    else {
        Write-Host "Sync state : $($state.phase)"
        Write-Host "Target     : $($state.upstreamRemote)/$($state.upstreamBranch)"
        Write-Host "Backup     : $($state.backupBranch)"
        if (-not [string]::IsNullOrWhiteSpace([string]$state.stashCommit)) {
            Write-Host "Stash      : $($state.stashCommit)"
        }
    }
    Invoke-Git -Arguments @("status", "--short", "--branch") | Out-Null
}

function Start-Sync {
    if ($null -ne (Load-State)) {
        throw "An earlier sync is unfinished. Run with -Operation Status, Continue, or Abort."
    }

    Assert-NoForeignGitOperation

    $currentBranch = Get-CurrentBranch
    if ($currentBranch -ne $LocalBranch) {
        throw "Current branch is '$currentBranch'; expected '$LocalBranch'."
    }

    $remoteCheck = Invoke-Git -Arguments @("remote", "get-url", $UpstreamRemote) -Silent -AllowFailure
    if ($remoteCheck.ExitCode -ne 0) {
        throw "Remote '$UpstreamRemote' does not exist. Add it with: git remote add $UpstreamRemote https://github.com/lioensky/VCPToolBox.git"
    }

    Write-Step "Fetching $UpstreamRemote"
    Invoke-Git -Arguments @("fetch", "--prune", $UpstreamRemote) | Out-Null

    $target = "$UpstreamRemote/$UpstreamBranch"
    Invoke-Git -Arguments @("rev-parse", "--verify", "$target^{commit}") -Silent | Out-Null

    $headCommit = Get-GitText @("rev-parse", "HEAD")
    $targetCommit = Get-GitText @("rev-parse", $target)
    $counts = Get-GitText @("rev-list", "--left-right", "--count", "HEAD...$target")
    $countParts = $counts -split "\s+"
    if ($countParts.Count -ge 2) {
        Write-Host "Local-only commits: $($countParts[0]); upstream-only commits: $($countParts[1])"
    }

    $ancestor = Invoke-Git -Arguments @("merge-base", "--is-ancestor", $target, "HEAD") -Silent -AllowFailure
    if ($ancestor.ExitCode -eq 0) {
        Write-Ok "Already contains all commits from $target."
        if ($DryRun) {
            Write-Ok "Dry run complete; no remote or local state was changed except fetched remote-tracking refs."
        }
        else {
            Push-IfRequested -Enabled:$Push
        }
        return 0
    }
    if ($ancestor.ExitCode -ne 1) {
        throw "Could not compare HEAD with $target."
    }

    Write-Host "Newest incoming commits (up to 30):"
    Invoke-Git -Arguments @("log", "--oneline", "--no-decorate", "--max-count=30", "HEAD..$target") | Out-Null
    if (($countParts.Count -ge 2) -and ([int]$countParts[1] -gt 30)) {
        Write-Host "... $([int]$countParts[1] - 30) older incoming commits omitted from this preview."
    }

    if ($DryRun) {
        Write-Ok "Dry run complete; no branch, stash, or working-tree changes were made."
        return 0
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $shortHead = Get-GitText @("rev-parse", "--short=8", "HEAD")
    $backupBranch = "backup/upstream-sync/$timestamp-$shortHead"
    Write-Step "Creating rollback branch"
    Invoke-Git -Arguments @("branch", $backupBranch, "HEAD") | Out-Null
    Write-Ok "Created $backupBranch"

    $state = [pscustomobject]@{
        version = 1
        phase = "preparing"
        localBranch = $LocalBranch
        upstreamRemote = $UpstreamRemote
        upstreamBranch = $UpstreamBranch
        targetCommit = $targetCommit
        startingCommit = $headCommit
        backupBranch = $backupBranch
        stashCommit = ""
        stashMessage = ""
        createdAt = (Get-Date).ToString("o")
        updatedAt = (Get-Date).ToString("o")
    }
    Save-State $state
    Install-RecoveryRunner

    $porcelain = Get-GitText @("status", "--porcelain=v1", "--untracked-files=all")
    if (-not [string]::IsNullOrWhiteSpace($porcelain)) {
        Write-Step "Saving tracked and untracked working-tree changes"
        $stashMessage = "vcp-upstream-sync-$timestamp"
        Invoke-Git -Arguments @("stash", "push", "--include-untracked", "--message", $stashMessage) | Out-Null
        $state.stashCommit = Get-GitText @("rev-parse", "refs/stash")
        $state.stashMessage = $stashMessage
        Save-State $state
        Write-Ok "Saved working tree as $($state.stashCommit)."
    }
    else {
        Write-Ok "Working tree is clean; no stash needed."
    }

    $remaining = Get-GitText @("status", "--porcelain=v1", "--untracked-files=all")
    if (-not [string]::IsNullOrWhiteSpace($remaining)) {
        throw "Working tree is still not clean after stashing. Ignored files may be blocking the update."
    }

    $state.phase = "merging"
    Save-State $state
    Write-Step "Merging $target"
    $merge = Invoke-Git -Arguments @("merge", "--no-edit", $target) -AllowFailure
    if ($merge.ExitCode -eq 0) {
        if (Complete-Sync $state -PushAfter:$Push) {
            return 0
        }
        return 4
    }

    $conflicts = @(Get-UnmergedFiles)
    if ($conflicts.Count -gt 0) {
        $state.phase = "merge-conflict"
        Save-State $state
        Write-Fail "Git needs your decision for $($conflicts.Count) conflicted file(s)."
        $conflicts | ForEach-Object { Write-Host "  $_" }
        Write-Host "Resolve the files, run git add for each one, then run:"
        Write-Host "  $(Get-RecoveryCommand 'Continue')"
        Write-Host "To return to the pre-update state, run:"
        Write-Host "  $(Get-RecoveryCommand 'Abort')"
        return 2
    }

    Write-Warn "Merge failed without content conflicts; restoring the pre-update state."
    if (Test-MergeInProgress) {
        Invoke-Git -Arguments @("merge", "--abort") -AllowFailure | Out-Null
    }
    if (Restore-SavedStash $state) {
        Remove-State
        Remove-RecoveryRunner
    }
    throw "Merge failed. See Git output above."
}

function Continue-Sync {
    $state = Load-State
    if ($null -eq $state) {
        throw "There is no unfinished sync to continue."
    }
    if ((Get-CurrentBranch) -ne [string]$state.localBranch) {
        throw "Switch back to '$($state.localBranch)' before continuing."
    }

    $conflicts = @(Get-UnmergedFiles)
    if ($conflicts.Count -gt 0) {
        Write-Fail "Conflicts are still unresolved:"
        $conflicts | ForEach-Object { Write-Host "  $_" }
        return 2
    }

    switch ([string]$state.phase) {
        "merge-conflict" {
            if (Test-MergeInProgress) {
                Write-Step "Committing the resolved upstream merge"
                Invoke-Git -Arguments @("commit", "--no-edit") | Out-Null
            }
            else {
                $containsTarget = Invoke-Git -Arguments @("merge-base", "--is-ancestor", ([string]$state.targetCommit), "HEAD") -Silent -AllowFailure
                if ($containsTarget.ExitCode -ne 0) {
                    throw "The merge is no longer active and HEAD does not contain the recorded upstream commit."
                }
                Write-Ok "The resolved merge was already committed."
            }

            if (Complete-Sync $state -PushAfter:$Push) {
                return 0
            }
            return 4
        }
        "stash-conflict" {
            Write-Step "Finishing the resolved stash restoration"
            Drop-SavedStash $state
            Remove-State
            Remove-RecoveryRunner
            Push-IfRequested -Enabled:$Push
            Write-Ok "Upstream synchronization completed; resolved working-tree changes remain in place."
            Write-Host "Rollback branch: $($state.backupBranch)"
            return 0
        }
        "merged" {
            if (Complete-Sync $state -PushAfter:$Push) {
                return 0
            }
            return 4
        }
        default {
            throw "Sync state '$($state.phase)' cannot be continued automatically. Use -Operation Status for details."
        }
    }
}

function Abort-Sync {
    $state = Load-State
    if ($null -eq $state) {
        throw "There is no unfinished sync to abort."
    }
    if ((Get-CurrentBranch) -ne [string]$state.localBranch) {
        throw "Switch back to '$($state.localBranch)' before aborting."
    }

    if ([string]$state.phase -eq "stash-conflict") {
        throw "The merge is already committed and stash restoration has conflicts. Resolve them, then use -Operation Continue. The rollback branch is '$($state.backupBranch)'."
    }

    Write-Step "Aborting unfinished upstream merge"
    if (Test-MergeInProgress) {
        Invoke-Git -Arguments @("merge", "--abort") | Out-Null
    }

    $currentHead = Get-GitText @("rev-parse", "HEAD")
    if ($currentHead -ne [string]$state.startingCommit) {
        throw "HEAD moved after the sync began. No destructive rollback was attempted. Backup branch: $($state.backupBranch)"
    }

    if (-not (Restore-SavedStash $state)) {
        return 4
    }
    Remove-State
    Remove-RecoveryRunner
    Write-Ok "Sync aborted; the pre-update branch and working tree were restored."
    return 0
}

try {
    Set-Location -LiteralPath $script:RepoRoot
    switch ($Operation) {
        "Sync" { $result = Start-Sync }
        "Continue" { $result = Continue-Sync }
        "Abort" { $result = Abort-Sync }
        "Status" { Show-SyncStatus; $result = 0 }
    }
    exit ([int]$result)
}
catch {
    Write-Fail $_.Exception.Message
    Write-Host "Run '.\sync-upstream.ps1 -Operation Status' to inspect the repository."
    exit 10
}
