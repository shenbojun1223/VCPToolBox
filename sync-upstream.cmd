@echo off
setlocal
cd /d "%~dp0"

where pwsh.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-upstream.ps1" %*
) else (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-upstream.ps1" %*
)

exit /b %ERRORLEVEL%
