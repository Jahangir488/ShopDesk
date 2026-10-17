#Requires -RunAsAdministrator
<#
  Shop Desk installer for Windows.
  Run "install-shopdesk.bat" as administrator (it calls this file), or:
    powershell -ExecutionPolicy Bypass -File install-shopdesk.ps1

  What it does:
    * copies the app to C:\ShopDesk\app and data to C:\ShopDesk\data
    * starts Shop Desk automatically at boot and at sign-in (Scheduled Task)
    * opens the private-network firewall port
    * creates desktop shortcuts (Shop Desk, Connect a phone)
    * waits for /healthz and prints the shop Wi-Fi address

  Uninstall: powershell -ExecutionPolicy Bypass -File uninstall-shopdesk.ps1
  Update:    powershell -ExecutionPolicy Bypass -File update-shopdesk.ps1 -SourceDir <new files>
#>
param(
  [string]$InstallDir = "C:\ShopDesk",
  [int]$Port = 8765,
  [string]$DataDir = "",
  [string]$SetupCode = "",
  [string]$GoogleClientId = "",
  [string]$GoogleClientSecret = "",
  [string]$PublicUrl = "",
  [switch]$SkipFirewall
)

$ErrorActionPreference = "Stop"
$AppDir = Join-Path $InstallDir "app"
$LogDir = Join-Path $InstallDir "logs"
$RunFile = Join-Path $InstallDir "run-shop.cmd"
if (-not $DataDir) { $DataDir = Join-Path $InstallDir "data" }
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TaskName = "Shop Desk"

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Fail($message) { Write-Host "`nERROR: $message" -ForegroundColor Red; exit 1 }

Write-Host "Shop Desk installer" -ForegroundColor Green
Write-Host "App:  $AppDir"
Write-Host "Data: $DataDir"
Write-Host "Port: $Port"

# ---- 1. Node.js ----
Write-Step "Checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { Fail "Node.js is not installed. Install Node.js 22.13 or newer from https://nodejs.org (choose the LTS MSI for all users), then run this installer again." }
$nodeExe = $nodeCommand.Source
$nodeVersion = (& $nodeExe -v).TrimStart("v")
if ([version]$nodeVersion -lt [version]"22.13.0") { Fail "Node.js $nodeVersion is too old. Shop Desk needs 22.13 or newer." }
Write-Host "Node.js $nodeVersion at $nodeExe"
if ($nodeExe -like "*\Users\*") {
  Write-Warning "Node.js is installed inside a user profile. The background service runs as SYSTEM and may not see it. Install the Node.js MSI for all users if Shop Desk does not start after rebooting."
}

# ---- 2. Copy files ----
Write-Step "Copying Shop Desk to $AppDir"
New-Item -ItemType Directory -Force -Path $AppDir, $LogDir, $DataDir | Out-Null
$robocopy = Start-Process -FilePath "robocopy.exe" -ArgumentList @(
  "`"$SourceDir`"", "`"$AppDir`"", "/E",
  "/XD", "data", "vendor", "node_modules", ".git", "backups",
  "/XF", "*.sqlite3", "*.sqlite3-shm", "*.sqlite3-wal", "server.log",
  "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
) -Wait -PassThru -NoNewWindow
if ($robocopy.ExitCode -ge 8) { Fail "Could not copy the Shop Desk files (robocopy exit $($robocopy.ExitCode))." }

Write-Host "The vendor licence signing key is never copied to a shop PC."

# ---- 3. Startup command ----
Write-Step "Writing the startup command"
$lines = @(
  "@echo off",
  "cd /d `"$AppDir`"",
  "set `"PORT=$Port`"",
  "set `"SHOP_HOST=0.0.0.0`"",
  "set `"SHOP_DATA_DIR=$DataDir`""
)
if ($SetupCode) { $lines += "set `"SHOP_SETUP_CODE=$SetupCode`"" }
if ($GoogleClientId) { $lines += "set `"SHOP_GOOGLE_CLIENT_ID=$GoogleClientId`"" }
if ($GoogleClientSecret) { $lines += "set `"SHOP_GOOGLE_CLIENT_SECRET=$GoogleClientSecret`"" }
if ($PublicUrl) { $lines += "set `"SHOP_PUBLIC_URL=$PublicUrl`""; $lines += "set `"SHOP_TRUST_PROXY=1`"" }
$lines += "`"$nodeExe`" server.mjs >> `"$LogDir\server.log`" 2>&1"
Set-Content -Path $RunFile -Value $lines -Encoding ASCII

# ---- 4. Scheduled task (starts at boot and at sign-in) ----
Write-Step "Registering the automatic startup task"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$RunFile`""
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "Runs the Shop Desk billing and stock server." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

# ---- 5. Firewall ----
if (-not $SkipFirewall) {
  Write-Step "Allowing phones on the shop Wi-Fi to connect"
  Get-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule | Out-Null
  New-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private, Domain -Description "Shop Desk web app on the shop network" | Out-Null
  Write-Host "Firewall rule created for private and domain networks."
}

# ---- 6. Shortcuts ----
Write-Step "Creating desktop shortcuts"
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
if (-not $desktop) { $desktop = [Environment]::GetFolderPath("Desktop") }
$shortcut = $shell.CreateShortcut((Join-Path $desktop "Shop Desk.url"))
$shortcut.TargetPath = "http://localhost:$Port/"
$shortcut.Save()
$phone = $shell.CreateShortcut((Join-Path $desktop "Shop Desk - Connect a phone.url"))
$phone.TargetPath = "http://localhost:$Port/join"
$phone.Save()

# ---- 7. Health check ----
Write-Step "Waiting for Shop Desk to start"
$healthy = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Seconds 2
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
}
if (-not $healthy) {
  Write-Warning "Shop Desk did not answer on port $Port yet. Check $LogDir\server.log."
} else {
  Write-Host "Shop Desk is running." -ForegroundColor Green
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Sort-Object -Property InterfaceMetric | Select-Object -First 1).IPAddress
Write-Host "`n=====================================================" -ForegroundColor Green
Write-Host " Shop Desk is installed." -ForegroundColor Green
Write-Host " This PC:        http://localhost:$Port/"
if ($lanIp) { Write-Host " Phones/tablets: http://${lanIp}:$Port/   (shop Wi-Fi)" }
Write-Host " Connect a phone: http://localhost:$Port/join  (QR code)"
Write-Host " Setup code:     shown in $LogDir\server.log on first run"
Write-Host " Data folder:    $DataDir"
Write-Host " Logs:           $LogDir\server.log"
Write-Host "=====================================================" -ForegroundColor Green
Write-Host "`nNext steps:"
Write-Host "  1. Open the shortcut, create the owner account, and finish shop settings."
Write-Host "  2. In Backup and restore, connect Google Drive for encrypted offsite backups."
Write-Host "  3. Enter your licence key in Settings -> Licence & plan."
Write-Host "`nWindows may show a firewall prompt after a reboot; choose Allow."
