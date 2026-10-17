#Requires -RunAsAdministrator
<#
  Repair a Shop Desk installation without touching the shop data.

  Use this when the installer reported a problem, when Shop Desk no longer starts
  by itself after a reboot, or when phones cannot connect.

  Double-click "Repair Shop Desk.bat" in the Shop Desk folder, or run:
    powershell -ExecutionPolicy Bypass -File repair-shopdesk.ps1
    powershell -ExecutionPolicy Bypass -File repair-shopdesk.ps1 -InstallDir "E:\ShopDesk"

  It re-creates the startup task, firewall rule, desktop shortcuts and the
  install marker, restores a missing run-shop.cmd from the saved settings, and
  starts the server. The database and backups are never modified.
#>
param(
  [string]$InstallDir = "",
  [int]$Port = 0,
  [string]$DataDir = ""
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
$script:Problems = @()

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Done($label) { Write-Host ("  {0,-42} done" -f $label) -ForegroundColor DarkGreen }
function Add-Problem($message) {
  $script:Problems += $message
  Write-Host "  $message" -ForegroundColor Yellow
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
function Read-Marker() {
  if (-not (Test-Path $MarkerFile)) { return $null }
  try { return Get-Content $MarkerFile -Raw | ConvertFrom-Json } catch { return $null }
}
function Find-InstallFolder() {
  if (Test-AppFile $InstallDir) { return $InstallDir }
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
  foreach ($letter in [char[]]"CDEFGHIJKLMNOPQRSTUVWXYZ") {
    $candidate = "${letter}:\ShopDesk"
    if (Test-AppFile $candidate) { return $candidate }
  }
  return ""
}
function Wait-Healthy([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
  }
  return $false
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Shop Desk - Repair" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

$marker = Read-Marker
$InstallDir = Find-InstallFolder
if (-not $InstallDir) {
  Write-Host ""
  Write-Host "Shop Desk was not found on this PC." -ForegroundColor Yellow
  Write-Host "Install it again with `"1 - Install Shop Desk.bat`", or run this repair with:"
  Write-Host '  powershell -ExecutionPolicy Bypass -File repair-shopdesk.ps1 -InstallDir "E:\ShopDesk"'
  Write-Host ""
  exit 1
}
$InstallDir = $InstallDir.TrimEnd('\')
$AppDir = Join-SafePath $InstallDir "app"
$LogDir = Join-SafePath $InstallDir "logs"
$RunFile = Join-SafePath $InstallDir "run-shop.cmd"

if (-not $DataDir) {
  $DataDir = if ($marker -and $marker.dataDir) { $marker.dataDir } else { Join-SafePath $InstallDir "data" }
}
if (-not $Port) {
  if ($marker -and $marker.port) {
    $Port = [int]$marker.port
  } elseif (Test-Path $RunFile) {
    $match = Select-String -Path $RunFile -Pattern 'set "PORT=(\d+)"' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { $Port = [int]$match.Matches[0].Groups[1].Value }
  }
}
if (-not $Port) { $Port = 8765 }

Write-Host ""
Write-Host "  Install folder : $InstallDir"
Write-Host "  Data folder    : $DataDir"
Write-Host "  Port           : $Port"

# ---- 1. Startup command -------------------------------------------------
Write-Step "Checking the startup command"
if (-not (Test-Path $RunFile)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Add-Problem "Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org, then run this repair again."
  } else {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $cmdNode = if ($node -match '[^\x00-\x7F]') { ShortPath $node } else { $node }
    $cmdData = CmdPath $DataDir $InstallDir
    if ($cmdData -match '[^\x00-\x7F]') {
      Add-Problem "The data folder path contains non-English characters. The Windows startup file cannot store them; use a folder such as $InstallDir\data."
    }
    $lines = @(
      "@echo off",
      "cd /d `"%~dp0app`"",
      "set `"PORT=$Port`"",
      "set `"SHOP_HOST=0.0.0.0`"",
      "set `"SHOP_DATA_DIR=$cmdData`"",
      "`"$cmdNode`" server.mjs >> `"$(CmdPath $LogDir $InstallDir)\server.log`" 2>&1"
    )
    Set-Content -Path $RunFile -Value $lines -Encoding ASCII
    Done "Recreated run-shop.cmd"
  }
} else {
  # v12.0.4 wrote the app's server.mjs command but left this launcher in the
  # install root. Preserve all its settings while correcting only its working directory.
  try {
    $runContents = [System.IO.File]::ReadAllText($RunFile)
    $oldWorkingDir = 'cd /d "%~dp0"'
    if ($runContents.Contains($oldWorkingDir)) {
      $runContents = $runContents.Replace($oldWorkingDir, 'cd /d "%~dp0app"')
      [System.IO.File]::WriteAllText($RunFile, $runContents, [System.Text.Encoding]::ASCII)
      Done "Corrected run-shop.cmd working directory"
    } else {
      Done "run-shop.cmd is present"
    }
  } catch {
    Add-Problem "Could not correct run-shop.cmd. Re-run the installer or check that the file is writable."
  }
}

# ---- 2. Automatic startup ----------------------------------------------
Write-Step "Registering automatic startup"
$taskOk = $false
try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$RunFile`""
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "Runs the Shop Desk billing and stock server." -Force -ErrorAction Stop | Out-Null
  $taskOk = $true
  Done "Startup task registered"
} catch {
  Add-Problem "The startup task could not be registered: $($_.Exception.Message)"
}

# ---- 3. Firewall --------------------------------------------------------
Write-Step "Checking the firewall"
try {
  Get-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile @("Private","Domain") -Description "Shop Desk web app on the shop network" -ErrorAction Stop | Out-Null
  Done "Firewall allows TCP $Port on private networks"
} catch {
  Add-Problem "The firewall rule could not be created: $($_.Exception.Message)"
}

# ---- 4. Shortcuts and launchers ----------------------------------------
Write-Step "Creating shortcuts"
try {
  $desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
  if (-not $desktop) { $desktop = [Environment]::GetFolderPath("Desktop") }
  $iconFile = Join-SafePath $InstallDir "app\icons\shopdesk.ico"
  Write-UrlShortcut (Join-SafePath $desktop "Shop Desk.url") "http://127.0.0.1:$Port/" $iconFile
  Write-UrlShortcut (Join-SafePath $desktop "Shop Desk - Connect a phone.url") "http://127.0.0.1:$Port/join" $iconFile
  Done "Desktop shortcuts"
} catch {
  Add-Problem "The desktop shortcuts could not be created: $($_.Exception.Message)"
}

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
try {
  $uninstallBat = Join-SafePath $InstallDir "Uninstall Shop Desk.bat"
  $repairBat = Join-SafePath $InstallDir "Repair Shop Desk.bat"
  Set-Content -Path $uninstallBat -Value ($batHeader + @(
    "title Shop Desk - Uninstall",
    "powershell -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\install\windows\uninstall-shopdesk.ps1`" %*",
    "echo.", "pause")) -Encoding ASCII
  Set-Content -Path $repairBat -Value ($batHeader + @(
    "title Shop Desk - Repair",
    "powershell -NoProfile -ExecutionPolicy Bypass -File `"$AppDir\install\windows\repair-shopdesk.ps1`" -InstallDir `"$InstallDir`" %*",
    "echo.", "pause")) -Encoding ASCII
  Done "Repair and uninstall shortcuts"
} catch {
  Add-Problem "The repair/uninstall shortcuts could not be written: $($_.Exception.Message)"
}

# ---- 5. Saved location --------------------------------------------------
Write-Step "Saving the install location"
try {
  New-Item -ItemType Directory -Force -Path $MarkerDir -ErrorAction Stop | Out-Null
  [pscustomobject]@{
    installDir = $InstallDir
    dataDir = $DataDir
    port = $Port
    installedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -Path $MarkerFile -Encoding UTF8 -ErrorAction Stop
  Done "Install marker"
} catch {
  Add-Problem "The install location could not be saved: $($_.Exception.Message)"
}

# ---- 6. Start -----------------------------------------------------------
Write-Step "Starting Shop Desk"
try {
  if ($taskOk) { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
  else { Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$RunFile`"" -WindowStyle Hidden }
} catch {
  Add-Problem "Shop Desk could not be started: $($_.Exception.Message)"
}
$healthy = Wait-Healthy 40

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
if ($healthy -and $script:Problems.Count -eq 0) {
  Write-Host "  Shop Desk is repaired and running." -ForegroundColor Green
} elseif ($healthy) {
  Write-Host "  Shop Desk is running, with warnings." -ForegroundColor Yellow
} else {
  Write-Host "  Shop Desk could not be started yet." -ForegroundColor Yellow
}
Write-Host "==============================================" -ForegroundColor Green
if ($script:Problems.Count -gt 0) {
  Write-Host "  Needs attention:"
  foreach ($item in $script:Problems) { Write-Host "   - $item" -ForegroundColor Yellow }
  Write-Host ""
} else {
  Write-Host "  Startup, firewall, shortcuts and saved location are all in place."
}
Write-Host "  Open on this PC : http://127.0.0.1:$Port/"
Write-Host "  Data folder     : $DataDir"
Write-Host "  Logs            : $LogDir\server.log"
Write-Host "==============================================" -ForegroundColor Green
if (-not $healthy) { Write-Host "`nIf it still does not start, open the log above and check the last lines." }
exit 0
