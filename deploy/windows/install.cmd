@echo off
rem Runs install.ps1 (double-click friendly). Arguments are passed through.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
