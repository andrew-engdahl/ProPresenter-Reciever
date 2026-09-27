@echo off
rem Runs kiosk.ps1 (double-click friendly). Arguments are passed through.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0kiosk.ps1" %*
