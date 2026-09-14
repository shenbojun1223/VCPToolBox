param()

$ErrorActionPreference = "Stop"

$repoPath = "C:\VCP\VCPToolBox"
$upstreamRemote = "upstream"
$upstreamBranch = "main"
$localBranch = "personal/main"
$templatePath = "C:\VCP\VCPToolBox\TVStxt\VSearch.merged.template.js"
$targetFile = "Plugin/VSearch/VSearch.js"
$step = 0
$finalResult = "UNKNOWN"

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
    if (-not (Test-Path $templatePath)) {
        throw "template file not found: $templatePath"
    }
    Set-Location $repoPath
    Ok "repo path exists"
    Ok "template file exists"

    Step-Title "Preflight"
    $branch = (git -C $repoPath branch --show-current 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "failed to get current branch: $branch"
    }
    Info ("current branch: " + $branch)
    if ($branch -ne $localBranch) {
        throw "current branch is not expected local branch: $localBranch"
    }

    $mergeHead = Join-Path $repoPath ".git\MERGE_HEAD"
    if (Test-Path $mergeHead) {
        throw "repository is already in merge state"
    }

    Step-Title "Fetch upstream"
    $fetchOutput = (git -C $repoPath fetch $upstreamRemote 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "fetch upstream failed: $fetchOutput"
    }
    Ok "fetch upstream success"

    Step-Title "Merge upstream"
    $mergeOutput = (git -C $repoPath merge $upstreamRemote/$upstreamBranch --no-edit 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
        Ok "merge successful without conflict"
        $finalResult = "SUCCESS"
    } else {
        Warn "merge reported conflicts; inspecting conflict set"
        $conflicts = (git -C $repoPath diff --name-only --diff-filter=U 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "failed to inspect conflicts: $conflicts"
        }

        $conflictList = @()
        if (-not [string]::IsNullOrWhiteSpace($conflicts)) {
            $conflictList = $conflicts -split "`r?`n" | Where-Object { $_.Trim() -ne "" }
            $conflictList | ForEach-Object { Info ("conflicted: " + $_) }
        }

        if ($conflictList.Count -eq 1 -and $conflictList[0] -eq $targetFile) {
            Step-Title "Apply curated template"
            Copy-Item -Path $templatePath -Destination (Join-Path $repoPath $targetFile) -Force
            Ok "template copied onto conflicted VSearch.js"

            $addOutput = (git -C $repoPath add $targetFile 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "git add failed after template apply: $addOutput"
            }
            Ok "git add successful"

            $continueOutput = (git -C $repoPath commit --no-edit 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) {
                throw "git commit after template apply failed: $continueOutput"
            }
            Ok "merge commit completed using curated template"
            $finalResult = "SUCCESS"
        } else {
            Warn "conflicts are not limited to curated VSearch target; aborting merge"
            $abortOutput = (git -C $repoPath merge --abort 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0) {
                Ok "merge aborted"
            } else {
                Warn ("merge --abort failed: " + $abortOutput)
            }
            throw "merge has unsupported conflict set"
        }
    }
}
catch {
    $finalResult = "FAILED"
    Fail $_.Exception.Message
}
finally {
    Step-Title "Final summary"
    Info ("final result: " + $finalResult)
    Write-Host ("RESULT: " + $finalResult)
}