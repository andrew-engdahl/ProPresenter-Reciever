# Removes the scheduled tasks and firewall rule created by install.ps1, and stops the
# server. The app folder and its settings (data\config.json) are left in place.
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}

foreach ($name in 'ProPresenter Receiver', 'ProPresenter Receiver Output') {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed task '$name'"
  }
}
# Stopping the task ends the PowerShell wrapper; also end the node process it started.
$app = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$app\server\index.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Get-NetFirewallRule -DisplayName 'ProPresenter Receiver' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Removed the firewall rule'
Read-Host 'Done. Press Enter to close'
