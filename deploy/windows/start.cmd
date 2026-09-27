@echo off
rem Runs the server in this window; Ctrl+C to stop. For another port: set PORT=9090 first.
cd /d "%~dp0..\.."
node server\index.js
pause
