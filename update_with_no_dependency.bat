@echo off
setlocal
cd /d "%~dp0"

REM Compatibility entry point for source-only upstream synchronization.
call "%~dp0sync-upstream.cmd" %*
exit /b %ERRORLEVEL%
