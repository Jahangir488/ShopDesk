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

# ---- Safe path helpers --------------------------------------------------
# These use .NET instead of Join-Path/Test-Path, which throw a terminating error
# when a path names a drive letter that does not exist (for example F: on a PC
# without that drive). That used to stop the installer. The .NET checks below
# simply return false for a missing drive.
function Join-SafePath([string]$Base, [string]$Child) {
  if ([string]::IsNullOrWhiteSpace($Base)) { return $Child }
  return [System.IO.Path]::Combine($Base, $Child)
}
function Test-AppFile([string]$folder) {
  if ([string]::IsNullOrWhiteSpace($folder)) { return $false }
  try { return [System.IO.File]::Exists([System.IO.Path]::Combine($folder, "app\server.mjs")) } catch { return $false }
}
function Test-FileExists([string]$file) {
  if ([string]::IsNullOrWhiteSpace($file)) { return $false }
  try { return [System.IO.File]::Exists($file) } catch { return $false }
}
$TaskName = "Shop Desk"
$MarkerDir = Join-SafePath $env:ProgramData "ShopDesk"
$MarkerFile = Join-SafePath $MarkerDir "install.json"
$SourceDir = (Resolve-Path (Join-SafePath $PSScriptRoot "..\..")).Path
$script:Step = 1
$script:Problems = @()
$script:TaskRegistered = $false

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
  if ($folder -match '^[A-Za-z]:\\') {
    try {
      $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($folder))
      if (-not $drive.IsReady) { return "The $($drive.Name.TrimEnd([char]92)) drive is not ready. Connect or unlock it, or choose a ready drive such as C:\ShopDesk." }
    } catch { return "Could not access the selected drive. Connect or unlock it, or choose a ready drive such as C:\ShopDesk." }
  }
  return ""
}
function Find-ExistingInstall() {
  $marker = Read-Marker
  if ($marker -and (Test-AppFile $marker.installDir)) { return $marker.installDir }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $action = @($task.Actions)[0]
    if ($action -and $action.Arguments -match '/c\s+"?([^"]+run-shop\.cmd)"?') {
      $folder = Split-Path $Matches[1] -Parent
      if (Test-AppFile $folder) { return $folder }
    }
  }
  if (Test-AppFile "C:\ShopDesk") { return "C:\ShopDesk" }
  # A failed install may never have written the marker: look for ShopDesk folders on every drive.
  # Test-AppFile never throws, so a missing drive letter is simply skipped.
  foreach ($letter in [char[]]"CDEFGHIJKLMNOPQRSTUVWXYZ") {
    $candidate = "${letter}:\ShopDesk"
    if (Test-AppFile $candidate) { return $candidate }
  }
  return ""
}
function Read-Marker() {
  if (-not (Test-Path $MarkerFile)) { return $null }
  try { return Get-Content $MarkerFile -Raw | ConvertFrom-Json } catch { return $null }
}
function Add-Problem($message) {
  $script:Problems += $message
}

# Paths inside the install folder are written as %~dp0... so that a folder name
# with Bangla or other non-English characters still works in an ASCII .cmd file.
function CmdPath($fullPath, $baseDir) {
  $base = $baseDir.TrimEnd('\')
  if ($fullPath.TrimEnd('\') -ieq $base) { return "%~dp0." }
  if ($fullPath.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    return "%~dp0" + $fullPath.Substring($base.Length + 1)
  }
  return $fullPath
}
function ShortPath($path) {
  try {
    $fso = New-Object -ComObject Scripting.FileSystemObject
    if (Test-Path -PathType Container $path) { return $fso.GetFolder($path).ShortPath }
    return $fso.GetFile($path).ShortPath
  } catch { return $path }
}
function Write-UrlShortcut([string]$path, [string]$url, [string]$iconPath) {
  if ($iconPath -match '[^\x00-\x7F]') { $iconPath = ShortPath $iconPath }
  $contents = "[InternetShortcut]`r`nURL=$url`r`nIconFile=$iconPath`r`nIconIndex=0`r`n"
  [System.IO.File]::WriteAllText($path, $contents, [System.Text.Encoding]::ASCII)
}
function Wait-Healthy([int]$seconds) {
  Write-Host "  Waiting for the local server" -NoNewline -ForegroundColor Gray
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2).StatusCode -eq 200) {
        Write-Host " ready" -ForegroundColor DarkGreen
        return $true
      }
    } catch { }
    Write-Host "." -NoNewline -ForegroundColor Gray
    Start-Sleep -Seconds 1
  }
  Write-Host " timed out" -ForegroundColor Yellow
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

$AppDir = Join-SafePath $InstallDir "app"
if ($SourceDir.TrimEnd('\') -ieq $AppDir.TrimEnd('\')) {
  Fail "This copy of Shop Desk is already installed at $InstallDir. Run the installer from a newly downloaded folder to update it."
}
$LogDir = Join-SafePath $InstallDir "logs"
$RunFile = Join-SafePath $InstallDir "run-shop.cmd"
$isUpdate = Test-FileExists (Join-SafePath $AppDir "server.mjs")

if (-not $DataDir) {
  if ($isUpdate -and $existingMarker -and $existingMarker.dataDir) {
    $DataDir = $existingMarker.dataDir
  } else {
    $DataDir = Join-SafePath $InstallDir "data"
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
try {
  New-Item -ItemType Directory -Force -Path $AppDir, $LogDir, $DataDir -ErrorAction Stop | Out-Null
} catch {
  Fail "Could not create $AppDir or $DataDir. Check that the drive letter exists and the folder is writable. ($($_.Exception.Message))"
}
$robocopy = Start-Process -FilePath "robocopy.exe" -ArgumentList @(
  "`"$SourceDir`"", "`"$AppDir`"", "/E", "/R:2", "/W:2",
  "/XD", "data", "vendor", "node_modules", "tools", ".git", "backups", "releases",
  "/XF", "*.sqlite3", "*.sqlite3-shm", "*.sqlite3-wal", "server.log", "*.pem",
  "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
) -Wait -PassThru -NoNewWindow
if ($robocopy.ExitCode -ge 8) { Fail "Could not copy the Shop Desk files (robocopy exit $($robocopy.ExitCode))." }
Write-Host "  Copied to $AppDir" -ForegroundColor DarkGreen

# ---- 3. Startup command ------------------------------------------------
Write-Step "Writing the startup command"
$cmdNode = if ($nodeExe -match '[^\x00-\x7F]') { ShortPath $nodeExe } else { $nodeExe }
if ($cmdNode -match '[^\x00-\x7F]') {
  Add-Problem "Node.js is installed in a folder with non-English characters. If Shop Desk does not start, reinstall Node.js to C:\Program Files\nodejs."
}
$cmdData = CmdPath $DataDir $InstallDir
if ($cmdData -match '[^\x00-\x7F]') {
  Add-Problem "The data folder path contains non-English characters. The Windows startup file cannot store them; use a folder such as $InstallDir\data."
}
$lines = @(
  "@echo off",
  "cd /d `"%~dp0app`"",
  "set `"PORT=$Port`"",
  "set `"SHOP_HOST=0.0.0.0`"",
  "set `"SHOP_DATA_DIR=$cmdData`""
)
if ($SetupCode) { $lines += "set `"SHOP_SETUP_CODE=$SetupCode`"" }
if ($GoogleClientId) { $lines += "set `"SHOP_GOOGLE_CLIENT_ID=$GoogleClientId`"" }
if ($GoogleClientSecret) { $lines += "set `"SHOP_GOOGLE_CLIENT_SECRET=$GoogleClientSecret`"" }
if ($PublicUrl) { $lines += "set `"SHOP_PUBLIC_URL=$PublicUrl`""; $lines += "set `"SHOP_TRUST_PROXY=1`"" }
$lines += "`"$cmdNode`" server.mjs >> `"$(CmdPath $LogDir $InstallDir)\server.log`" 2>&1"
Set-Content -Path $RunFile -Value $lines -Encoding ASCII
Write-Host "  $RunFile" -ForegroundColor DarkGreen

# ---- 4. Automatic start ------------------------------------------------
Write-Step "Registering automatic startup"
try {
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$RunFile`""
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "Runs the Shop Desk billing and stock server." -Force -ErrorAction Stop | Out-Null
  $script:TaskRegistered = $true
  Write-Host "  Scheduled task `"$TaskName`" starts at boot" -ForegroundColor DarkGreen
} catch {
  Add-Problem "Automatic startup was not registered. Shop Desk will not start by itself after a reboot."
  Write-Host "  Could not register the startup task: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ---- 5. Firewall and shortcuts ----------------------------------------
Write-Step "Opening the firewall and creating shortcuts"
if (-not $SkipFirewall) {
  try {
    Get-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile @("Private","Domain") -Description "Shop Desk web app on the shop network" -ErrorAction Stop | Out-Null
    Write-Host "  Firewall: inbound TCP $Port for private networks" -ForegroundColor DarkGreen
  } catch {
    Add-Problem "The firewall rule was not created. Phones on the shop Wi-Fi may not be able to connect."
    Write-Host "  Could not create the firewall rule: $($_.Exception.Message)" -ForegroundColor Yellow
  }
} else {
  Write-Host "  Firewall skipped (-SkipFirewall)" -ForegroundColor Yellow
}

try {
  $desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
  if (-not $desktop) { $desktop = [Environment]::GetFolderPath("Desktop") }
  $iconFile = Join-SafePath $AppDir "icons\shopdesk.ico"
  Write-UrlShortcut (Join-SafePath $desktop "Shop Desk.url") "http://127.0.0.1:$Port/" $iconFile
  Write-UrlShortcut (Join-SafePath $desktop "Shop Desk - Connect a phone.url") "http://127.0.0.1:$Port/join" $iconFile
  Write-Host "  Desktop shortcuts created" -ForegroundColor DarkGreen
} catch {
  Add-Problem "The desktop shortcuts were not created."
  Write-Host "  Could not create the desktop shortcuts: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Helper launchers in the install folder. They are written before the service
# starts, so a failed step can always be fixed later with Repair Shop Desk.bat.
$uninstallBat = Join-SafePath $InstallDir "Uninstall Shop Desk.bat"
$repairBat = Join-SafePath $InstallDir "Repair Shop Desk.bat"
$batHeader = @(
  "@echo off",
  "setlocal",
  "net session >nul 2>&1",
  "if errorlevel 1 (",
  "  echo Asking for administrator permission...",
  "  powershell -NoProfile -ExecutionPolicy Bypass -Command `"Start-Process -FilePath '%~f0' -Verb RunAs`"",
  "  exit /b",
  ")"
)
$uninstallLines = $batHeader + @(
  "title Shop Desk - Uninstall",
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\install\windows\uninstall-shopdesk.ps1`" %*",
  "echo.",
  "pause"
)
Set-Content -Path $uninstallBat -Value $uninstallLines -Encoding ASCII
$repairLines = $batHeader + @(
  "title Shop Desk - Repair",
  "powershell -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\install\windows\repair-shopdesk.ps1`" -InstallDir `"$InstallDir`" %*",
  "echo.",
  "pause"
)
Set-Content -Path $repairBat -Value $repairLines -Encoding ASCII
Write-Host "  Repair and uninstall shortcuts created" -ForegroundColor DarkGreen

# Remember the choices for updates, repair and uninstall.
try {
  New-Item -ItemType Directory -Force -Path $MarkerDir -ErrorAction Stop | Out-Null
  [pscustomobject]@{
    installDir = $InstallDir
    dataDir = $DataDir
    port = $Port
    installedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -Path $MarkerFile -Encoding UTF8 -ErrorAction Stop
} catch {
  Add-Problem "The install location could not be saved. Updates and uninstall may need the folder entered by hand."
}

# ---- 6. Start ----------------------------------------------------------
Write-Step "Starting Shop Desk"
if ($script:TaskRegistered) {
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
  catch {
    Add-Problem "The startup task could not be started now."
    Write-Host "  Could not start the task: $($_.Exception.Message)" -ForegroundColor Yellow
  }
} else {
  # Automatic start failed: run the server now so the shop can still use it today.
  try {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$RunFile`"" -WindowStyle Hidden -ErrorAction Stop
    Add-Problem "Shop Desk is running now, but it will not start again after a reboot until the startup task is repaired."
  } catch {
    Add-Problem "Shop Desk could not be started. Run $RunFile by hand to see the error."
  }
}
$healthy = Wait-Healthy 40
if (-not $healthy) {
  Add-Problem "Shop Desk did not answer on port $Port. Check $LogDir\server.log"
  Write-Host "  Shop Desk did not answer yet. Check $LogDir\server.log" -ForegroundColor Yellow
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Sort-Object -Property InterfaceMetric | Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
if ($healthy -and $script:Problems.Count -eq 0) {
  Write-Host "  Shop Desk is installed and running." -ForegroundColor Green
} elseif ($healthy) {
  Write-Host "  Shop Desk is installed and running, with warnings." -ForegroundColor Yellow
} else {
  Write-Host "  Shop Desk is installed, but it has not answered yet." -ForegroundColor Yellow
}
Write-Host "==============================================" -ForegroundColor Green
if ($script:Problems.Count -gt 0) {
  Write-Host "  Needs attention:" -ForegroundColor Yellow
  foreach ($item in $script:Problems) { Write-Host "   - $item" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "  Fix these in one step by running:" -ForegroundColor Yellow
  Write-Host "    $repairBat" -ForegroundColor Yellow
  Write-Host ""
}
Write-Host "  Open on this PC : http://127.0.0.1:$Port/"
if ($lanIp) { Write-Host "  Open on phones  : http://${lanIp}:$Port/   (same Wi-Fi)" }
Write-Host "  Connect a phone : http://127.0.0.1:$Port/join"
Write-Host ""
Write-Host "  Install folder  : $InstallDir"
Write-Host "  Data folder     : $DataDir"
Write-Host "  Logs            : $LogDir\server.log"
Write-Host ""
Write-Host "  First run: open Shop Desk, then find the setup code in the log file"
Write-Host "  above if the page asks for it."
Write-Host ""
Write-Host "  Repair automatic start: $repairBat"
Write-Host "  Remove Shop Desk:       $uninstallBat"
Write-Host "==============================================" -ForegroundColor Green

if (-not $NoBrowser -and -not $Yes) { Start-Process "http://127.0.0.1:$Port/" }
exit 0
