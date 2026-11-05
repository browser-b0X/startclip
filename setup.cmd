@echo off
rem Startclip setup for Windows: runs setup.ps1 (next to this file) with any arguments,
rem e.g. setup.cmd -DryRun or setup.cmd -Uninstall. Double-click works too.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set rc=%errorlevel%
echo.
pause
exit /b %rc%
