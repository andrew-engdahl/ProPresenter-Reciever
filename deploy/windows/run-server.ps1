# Runs the Receiver server and restarts it if it exits (the Windows version of the
# systemd unit). The "ProPresenter Receiver" scheduled task runs this hidden at logon.
# Output goes to receiver.log in the data folder.
#   powershell -ExecutionPolicy Bypass -File deploy\windows\run-server.ps1 [-Port 8080] [-DataDir C:\path]
param(
  [int]$Port = 8080,
  [string]$DataDir = ''
)
$ErrorActionPreference = 'Stop'
$app = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $app

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS' }

$env:PORT = "$Port"
if ($DataDir) { $env:RECEIVER_DATA = $DataDir } else { $DataDir = Join-Path $app 'data' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$log = Join-Path $DataDir 'receiver.log'
$script = Join-Path $app 'server\index.js'

# Node writes to stderr; don't let PowerShell treat that as a terminating error.
$ErrorActionPreference = 'Continue'
while ($true) {
  # Keep the log from growing without limit.
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }
  Add-Content $log "--- $(Get-Date -Format s) starting on port $Port"
  # Redirect through cmd so the log stays plain text (PowerShell 5.1 would write UTF-16).
  & cmd.exe /c "`"`"$node`" `"$script`" >> `"$log`" 2>&1`""
  Add-Content $log "--- $(Get-Date -Format s) exited with code $LASTEXITCODE; restarting in 2 s"
  Start-Sleep -Seconds 2
}
