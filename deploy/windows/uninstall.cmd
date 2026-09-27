@echo off
rem Runs uninstall.ps1 (double-click friendly). Arguments are passed through.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
