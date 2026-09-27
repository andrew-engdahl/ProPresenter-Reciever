# Opens the display output full screen (the Windows version of deploy/kiosk.sh).
#   powershell -ExecutionPolicy Bypass -File deploy\windows\kiosk.ps1
#   ... kiosk.ps1 -Path "/display?bg=chroma" -Monitor 2
# -Monitor is 1-based, in the order Windows lists the displays (1 = primary).
# Uses Google Chrome when it's installed, otherwise Microsoft Edge.
param(
  [string]$Path = '/display?bg=black',
  [int]$Monitor = 1,
  [int]$Port = 8080
)
$ErrorActionPreference = 'Stop'
$base = "http://localhost:$Port"
$url = $base + $Path

# Wait for the server to come up (useful at logon).
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$base/api/state" | Out-Null; break } catch { Start-Sleep -Seconds 1 }
}

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { throw 'Install Google Chrome or Microsoft Edge' }

# Place the window on the chosen monitor before it goes full screen.
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { -not $_.Primary }, { $_.Bounds.X }, { $_.Bounds.Y })
$screen = $screens[[Math]::Min([Math]::Max($Monitor, 1), $screens.Count) - 1]
$b = $screen.Bounds

# A separate profile keeps the kiosk window apart from normal browsing, and lets it
# start in kiosk mode even when the browser is already open.
$browserArgs = @(
  '--kiosk', '--no-first-run', '--noerrdialogs', '--disable-infobars',
  '--disable-session-crashed-bubble', '--disable-features=Translate,TranslateUI',
  '--autoplay-policy=no-user-gesture-required',
  "--window-position=$($b.X),$($b.Y)", "--window-size=$($b.Width),$($b.Height)",
  "--user-data-dir=`"$env:LOCALAPPDATA\propresenter-receiver-kiosk`""
)
if ($browser -like '*msedge.exe') { $browserArgs += '--edge-kiosk-type=fullscreen' }
$browserArgs += $url

Start-Process -FilePath $browser -ArgumentList $browserArgs
