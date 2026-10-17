#Requires -RunAsAdministrator
<#
  Shop Desk installer for Windows.

  Easiest way: double-click "1 - Install Shop Desk.bat" in the Shop Desk folder.
  It asks where to install, copies the files, starts Shop Desk automatically at
  boot, opens the private-network firewall and opens the browser when ready.

  Advanced / silent use:
    powershell -ExecutionPolicy Bypass -File install-shopdesk.ps1 -InstallDir "D:\ShopDesk"
    powershell -ExecutionPolicy Bypass -File install-shopdesk.ps1 -InstallDir "D:\ShopDesk" -Yes
#>
param(
  [string]$InstallDir = "",
  [int]$Port = 8765,
  [string]$DataDir = "",
  [string]$SetupCode = "",
  [string]$GoogleClientId = "",
  [string]$GoogleClientSecret = "",
  [string]$PublicUrl = "",
  [switch]$SkipFirewall,
  [switch]$Yes,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$TaskName = "Shop Desk"
$MarkerDir = Join-Path $env:ProgramData "ShopDesk"
$MarkerFile = Join-Path $MarkerDir "install.json"
$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:Step = 1

function Write-Step($message) { Write-Host ("`n[{0}/6] {1}" -f $script:Step, $message) -ForegroundColor Cyan; $script:Step++ }
function Fail($message) { Write-Host "`nERROR: $message" -ForegroundColor Red; exit 1 }
function Ask($prompt, $default) {
  $answer = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}
function Normalize-Folder($value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $expanded = [Environment]::ExpandEnvironmentVariables($value.Trim().Trim('"'))
  # Require a full path so an elevated install never lands in C:\Windows\System32.
  if ($expanded -notmatch '^[A-Za-z]:[\\/]' -and $expanded -notmatch '^\\\\') { return "" }
  try { $full = [System.IO.Path]::GetFullPath($expanded) } catch { return "" }
  return $full.TrimEnd('\')
}
function Test-Folder($folder) {
  if (-not $folder) { return "Enter the full path of a folder, for example D:\ShopDesk." }
  if ($folder -match '^[A-Za-z]:$') { return "Choose a folder on a drive, not the whole drive." }
  $win = [System.IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\')
  if ($folder -eq $win -or $folder.StartsWith($win + '\')) { return "Do not install inside the Windows folder." }
  if ($folder -match '["<>|?*]') { return "The folder name contains a character Windows does not allow." }
  return ""
}
function Find-ExistingInstall() {
  if (Test-Path $MarkerFile) {
    try {
      $info = Get-Content $MarkerFile -Raw | ConvertFrom-Json
      if ($info.installDir -and (Test-Path (Join-Path $info.installDir "app\server.mjs"))) { return $info.installDir }
    } catch { }
  }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $action = @($task.Actions)[0]
    if ($action -and $action.Arguments -match '/c\s+"?([^"]+run-shop\.cmd)"?') {
      $folder = Split-Path $Matches[1] -Parent
      if (Test-Path (Join-Path $folder "app\server.mjs")) { return $folder }
    }
  }
  if (Test-Path "C:\ShopDesk\app\server.mjs") { return "C:\ShopDesk" }
  return ""
}
function Read-Marker() {
  if (-not (Test-Path $MarkerFile)) { return $null }
  try { return Get-Content $MarkerFile -Raw | ConvertFrom-Json } catch { return $null }
}
function Wait-Healthy([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    try {
      if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3).StatusCode -eq 200) { return $true }
    } catch { }
  }
  return $false
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  Shop Desk - Install" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green

# ---- Where to install --------------------------------------------------
$existing = Find-ExistingInstall
$existingMarker = Read-Marker
if ($InstallDir) {
  $InstallDir = Normalize-Folder $InstallDir
} else {
  $default = if ($existing) { $existing } else { "C:\ShopDesk" }
  while ($true) {
    Write-Host ""
    if ($existing) {
      Write-Host "Shop Desk is already installed at $existing."
      Write-Host "Press Enter to update it, or type another folder for a new installation."
    } else {
      Write-Host "Where should Shop Desk be installed? Press Enter for the default."
    }
    $InstallDir = Normalize-Folder (Ask "  Install folder" $default)
    $problem = Test-Folder $InstallDir
    if (-not $problem) { break }
    Write-Host "  $problem" -ForegroundColor Yellow
  }
}
$problem = Test-Folder $InstallDir
if ($problem) { Fail $problem }

$AppDir = Join-Path $InstallDir "app"
if ($SourceDir.TrimEnd('\') -ieq $AppDir.TrimEnd('\')) {
  Fail "This copy of Shop Desk is already installed at $InstallDir. Run the installer from a newly downloaded folder to update it."
}
$LogDir = Join-Path $InstallDir "logs"
$RunFile = Join-Path $InstallDir "run-shop.cmd"
$isUpdate = Test-Path (Join-Path $AppDir "server.mjs")

if (-not $DataDir) {
  if ($isUpdate -and $existingMarker -and $existingMarker.dataDir) {
    $DataDir = $existingMarker.dataDir
  } else {
    $DataDir = Join-Path $InstallDir "data"
  }
}
$DataDir = Normalize-Folder $DataDir
if (-not $DataDir) { Fail "Enter a data folder." }

Write-Host ""
Write-Host "  Install folder : $InstallDir"
Write-Host "  Program files  : $AppDir"
Write-Host "  Data folder    : $DataDir"
Write-Host "  Port           : $Port"
if ($isUpdate) { Write-Host "  This folder already has Shop Desk. It will be updated and the data kept." -ForegroundColor Yellow }
if (-not $Yes) {
  $answer = Ask "`nInstall Shop Desk now? (Y/n)" "Y"
  if ($answer -notmatch '^(y|yes)$') { Write-Host "`nCancelled. Nothing was changed."; exit 0 }
}

# ---- 1. Node.js --------------------------------------------------------
Write-Step "Checking Node.js"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Host "  Node.js is not installed." -ForegroundColor Yellow
  Write-Host "  Opening the Node.js download page. Install the LTS version for all users, then run this installer again."
  if (-not $Yes) { Start-Process "https://nodejs.org/en/download" }
  Fail "Node.js 22.13 or newer is required."
}
$nodeExe = $nodeCommand.Source
$nodeVersion = (& $nodeExe -v).TrimStart("v")
if ([version]$nodeVersion -lt [version]"22.13.0") { Fail "Node.js $nodeVersion is too old. Install Node.js 22.13 or newer from https://nodejs.org." }
Write-Host "  Node.js $nodeVersion at $nodeExe" -ForegroundColor DarkGreen
if ($nodeExe -like "*\Users\*") {
  Write-Warning "Node.js is installed inside a user profile. The background task runs as SYSTEM and may not see it. Install the Node.js MSI for all users if Shop Desk does not start after rebooting."
}

# ---- 2. Copy files -----------------------------------------------------
Write-Step "Copying files"
if ($isUpdate) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
New-Item -ItemType Directory -Force -Path $AppDir, $LogDir, $DataDir | Out-Null
$robocopy = Start-Process -FilePath "robocopy.exe" -ArgumentList @(
  "`"$SourceDir`"", "`"$AppDir`"", "/E",
  "/XD", "data", "vendor", "node_modules", ".git", "backups", "releases",
  "/XF", "*.sqlite3", "*.sqlite3-shm", "*.sqlite3-wal", "server.log",
  "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
) -Wait -PassThru -NoNewWindow
if ($robocopy.ExitCode -ge 8) { Fail "Could not copy the Shop Desk files (robocopy exit $($robocopy.ExitCode))." }
Write-Host "  Copied to $AppDir" -ForegroundColor DarkGreen

# ---- 3. Startup command ------------------------------------------------
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
Write-Host "  $RunFile" -ForegroundColor DarkGreen

# ---- 4. Automatic start ------------------------------------------------
Write-Step "Registering automatic startup"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$RunFile`""
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Triggers $triggers -Principal $principal -Settings $settings -Description "Runs the Shop Desk billing and stock server." -Force | Out-Null
Write-Host "  Scheduled task `"$TaskName`" starts at boot" -ForegroundColor DarkGreen

# ---- 5. Firewall and shortcuts ----------------------------------------
Write-Step "Opening the firewall and creating shortcuts"
if (-not $SkipFirewall) {
  Get-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile @("Private","Domain") -Description "Shop Desk web app on the shop network" | Out-Null
  Write-Host "  Firewall: inbound TCP $Port for private networks" -ForegroundColor DarkGreen
} else {
  Write-Host "  Firewall skipped (-SkipFirewall)" -ForegroundColor Yellow
}
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
if (-not $desktop) { $desktop = [Environment]::GetFolderPath("Desktop") }
$shortcut = $shell.CreateShortcut((Join-Path $desktop "Shop Desk.url"))
$shortcut.TargetPath = "http://localhost:$Port/"
$shortcut.Save()
$phone = $shell.CreateShortcut((Join-Path $desktop "Shop Desk - Connect a phone.url"))
$phone.TargetPath = "http://localhost:$Port/join"
$phone.Save()
Write-Host "  Desktop shortcuts created" -ForegroundColor DarkGreen

# A ready-to-use uninstaller in the chosen install folder.
$uninstallBat = Join-Path $InstallDir "Uninstall Shop Desk.bat"
$batLines = @(
  "@echo off",
  "setlocal",
  "title Shop Desk - Uninstall",
  "net session >nul 2>&1",
  "if errorlevel 1 (",
  "  echo Asking for administrator permission...",
  "  powershell -NoProfile -ExecutionPolicy Bypass -Command `"Start-Process -FilePath '%~f0' -Verb RunAs`"",
  "  exit /b",
  ")",
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\install\windows\uninstall-shopdesk.ps1`" %*",
  "echo.",
  "pause"
)
Set-Content -Path $uninstallBat -Value $batLines -Encoding ASCII
Write-Host "  Uninstaller: $uninstallBat" -ForegroundColor DarkGreen

# Remember the choices for updates and uninstall.
New-Item -ItemType Directory -Force -Path $MarkerDir | Out-Null
[pscustomobject]@{
  installDir = $InstallDir
  dataDir = $DataDir
  port = $Port
  installedAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -Path $MarkerFile -Encoding UTF8

# ---- 6. Start ----------------------------------------------------------
Write-Step "Starting Shop Desk"
Start-ScheduledTask -TaskName $TaskName
$healthy = Wait-Healthy 40
if (-not $healthy) {
  Write-Host "  Shop Desk did not answer yet. Check $LogDir\server.log" -ForegroundColor Yellow
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Sort-Object -Property InterfaceMetric | Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
if ($healthy) {
  Write-Host "  Shop Desk is installed and running." -ForegroundColor Green
} else {
  Write-Host "  Shop Desk is installed, but it has not answered yet." -ForegroundColor Yellow
}
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  Open on this PC : http://localhost:$Port/"
if ($lanIp) { Write-Host "  Open on phones  : http://${lanIp}:$Port/   (same Wi-Fi)" }
Write-Host "  Connect a phone : http://localhost:$Port/join"
Write-Host ""
Write-Host "  Install folder  : $InstallDir"
Write-Host "  Data folder     : $DataDir"
Write-Host "  Logs            : $LogDir\server.log"
Write-Host ""
Write-Host "  First run: open Shop Desk, then find the setup code in the log file"
Write-Host "  above if the page asks for it."
Write-Host ""
Write-Host "  To remove Shop Desk later, run:"
Write-Host "    $uninstallBat"
Write-Host "==============================================" -ForegroundColor Green

if (-not $NoBrowser -and -not $Yes) { Start-Process "http://localhost:$Port/" }
exit 0
