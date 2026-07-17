@echo off
setlocal
cd /d "%~dp0"

REM Safe upstream synchronization. Pass any PowerShell options through, for example:
REM   update.bat -DryRun
REM   update.bat -Operation Continue
REM   update.bat -Operation Abort
call "%~dp0sync-upstream.cmd" %*
set "SYNC_EXIT=%ERRORLEVEL%"

if not "%SYNC_EXIT%"=="0" (
    echo.
    echo Upstream synchronization did not complete. Exit code: %SYNC_EXIT%
    exit /b %SYNC_EXIT%
)

echo.
echo Source synchronization complete.
echo Dependency installation is intentionally separate; review changed manifests first.
exit /b 0
