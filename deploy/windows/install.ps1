# Sets the Receiver up to run on this Windows PC:
#   * a firewall rule so other machines can open the control panel/output and discovery works
#   * a scheduled task that starts the server hidden when you log on
#   * optionally, a second task that opens the full-screen output after the server is up
#
#   deploy\windows\install.cmd                               (double-click; asks for admin)
#   deploy\windows\install.cmd -Kiosk -Monitor 2
#   deploy\windows\install.cmd -Kiosk -KioskPath "/display?bg=chroma" -Port 9090
param(
  [int]$Port = 8080,
  [string]$DataDir = '',
  [switch]$Kiosk,
  [string]$KioskPath = '/display?bg=black',
  [int]$Monitor = 1,
  [string]$User = "$env:USERDOMAIN\$env:USERNAME"
)
$ErrorActionPreference = 'Stop'

# Scheduled logon tasks and firewall rules need admin. Relaunch elevated, passing the
# original user so the tasks run in that user's session.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Port', $Port, '-Monitor', $Monitor, '-User', "`"$User`"", '-KioskPath', "`"$KioskPath`"")
  if ($DataDir) { $relaunch += @('-DataDir', "`"$DataDir`"") }
  if ($Kiosk) { $relaunch += '-Kiosk' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
  exit
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS (then open a new window)' }
$version = [version]((& $node --version).TrimStart('v'))
if ($version.Major -lt 18) { throw "Node.js 18 or newer is needed (found $version)" }

$here = $PSScriptRoot
$app = (Resolve-Path (Join-Path $here '..\..')).Path
if ($app -like "$env:ProgramFiles*" -and -not $DataDir) {
  Write-Warning "The app is under Program Files, where settings can't be saved. Use -DataDir or move the app (e.g. C:\ProPresenterReceiver)."
}

# Firewall: allow Node on private/domain networks. This covers the web port (TCP) and
# the mDNS replies used for discovery (UDP).
Get-NetFirewallRule -DisplayName 'ProPresenter Receiver' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'ProPresenter Receiver' -Direction Inbound -Program $node -Action Allow -Profile Private, Domain | Out-Null
Write-Host "Firewall: allowed $node on Private and Domain networks"

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User

$serverArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$here\run-server.ps1`" -Port $Port"
if ($DataDir) { $serverArgs += " -DataDir `"$DataDir`"" }
$action = New-ScheduledTaskAction -Execute $ps -Argument $serverArgs -WorkingDirectory $app
Register-ScheduledTask -TaskName 'ProPresenter Receiver' -Description 'ProPresenter Receiver server' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Task 'ProPresenter Receiver': starts the server at logon for $User"

if ($Kiosk) {
  $kioskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$here\kiosk.ps1`" -Path `"$KioskPath`" -Monitor $Monitor -Port $Port"
  $action = New-ScheduledTaskAction -Execute $ps -Argument $kioskArgs -WorkingDirectory $app
  Register-ScheduledTask -TaskName 'ProPresenter Receiver Output' -Description 'ProPresenter Receiver full-screen output' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "Task 'ProPresenter Receiver Output': opens $KioskPath on monitor $Monitor at logon"
} else {
  Unregister-ScheduledTask -TaskName 'ProPresenter Receiver Output' -Confirm:$false -ErrorAction SilentlyContinue
}

# Start the server now, and give it a moment before reporting.
Start-ScheduledTask -TaskName 'ProPresenter Receiver'
Start-Sleep -Seconds 3
$ip = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp, Manual -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host "Control panel: http://localhost:$Port/   (from other machines: http://${ip}:$Port/)"
Write-Host "Output:        http://localhost:$Port/display"
Write-Host ''
Read-Host 'Done. Press Enter to close'
