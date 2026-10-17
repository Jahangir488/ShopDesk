#Requires -RunAsAdministrator
<#
  Remove Shop Desk from this PC.

  Easiest way: double-click "2 - Uninstall Shop Desk.bat" in the Shop Desk folder.
  It finds the installation, asks whether to keep the shop data, and prints a
  summary of exactly what was removed.

  Command line:
    powershell -ExecutionPolicy Bypass -File uninstall-shopdesk.ps1
    powershell -ExecutionPolicy Bypass -File uninstall-shopdesk.ps1 -RemoveData
    powershell -ExecutionPolicy Bypass -File uninstall-shopdesk.ps1 -RemoveData -Yes
#>
param(
  [string]$InstallDir = "",
  [int]$Port = 0,
  [switch]$RemoveData,
  [switch]$Yes
)

$ErrorActionPreference = "Continue"
$TaskName = "Shop Desk"
$MarkerDir = Join-Path $env:ProgramData "ShopDesk"
$MarkerFile = Join-Path $MarkerDir "install.json"

function Ask($prompt, $default) {
  $answer = Read-Host "$prompt [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}
function Done($label) { Write-Host ("  {0,-36} done" -f $label) -ForegroundColor DarkGreen }
function Read-Marker() {
  if (-not (Test-Path $MarkerFile)) { return $null }
  try { return Get-Content $MarkerFile -Raw | ConvertFrom-Json } catch { return $null }
}
function Find-ExistingInstall() {
  if ($InstallDir -and (Test-Path (Join-Path $InstallDir "app\server.mjs"))) { return $InstallDir }
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
function Test-SafeDataFolder($folder) {
  if (-not $folder) { return $false }
  if ($folder -match '^[A-Za-z]:$') { return $false }
  $win = [System.IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\')
  if ($folder -eq $win -or $folder.StartsWith($win + '\')) { return $false }
  return $true
}
function Show-DataFiles($folder) {
  if (-not (Test-Path $folder)) { Write-Host "  Data folder: $folder (not found)"; return }
  $db = Join-Path $folder "shop.sqlite3"
  if (Test-Path $db) {
    $size = [math]::Round((Get-Item $db).Length / 1048576, 2)
    Write-Host ("    shop.sqlite3       {0} MB" -f $size)
  }
  $key = Join-Path $folder "offsite.key"
  if (Test-Path $key) { Write-Host "    offsite.key        needed to open Google Drive backups" }
  $backups = Join-Path $folder "backups"
  if (Test-Path $backups) {
    $count = @(Get-ChildItem $backups -File -ErrorAction SilentlyContinue).Count
    Write-Host ("    backups\           {0} file(s)" -f $count)
  }
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Yellow
Write-Host "  Shop Desk - Uninstall" -ForegroundColor Yellow
Write-Host "==============================================" -ForegroundColor Yellow

$marker = Read-Marker
$InstallDir = Find-ExistingInstall
if (-not $InstallDir) {
  Write-Host ""
  Write-Host "Shop Desk was not found on this PC." -ForegroundColor Yellow
  Write-Host "Nothing to remove. If you installed it in a custom folder, run:"
  Write-Host '  powershell -ExecutionPolicy Bypass -File uninstall-shopdesk.ps1 -InstallDir "D:\ShopDesk"'
  Write-Host ""
  exit 1
}
$InstallDir = $InstallDir.TrimEnd('\')
$AppDir = Join-Path $InstallDir "app"
$DataDir = if ($marker -and $marker.dataDir) { $marker.dataDir } else { Join-Path $InstallDir "data" }
$LogDir = Join-Path $InstallDir "logs"
$RunFile = Join-Path $InstallDir "run-shop.cmd"

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
Write-Host "  Found Shop Desk at: $InstallDir"
Write-Host "  Data folder       : $DataDir"
Write-Host "  Port              : $Port"
Write-Host ""

$removeData = [bool]$RemoveData
if (-not $RemoveData -and -not $Yes) {
  Write-Host "What do you want to remove?"
  Write-Host "  [1] The program only - keep shop data and backups  (recommended)"
  Write-Host "  [2] Everything        - delete the program, shop data and backups"
  $choice = Ask "`nChoose 1 or 2" "1"
  if ($choice -eq "2") { $removeData = $true }
}

if ($removeData) {
  if (-not (Test-SafeDataFolder $DataDir)) {
    Write-Host "Refusing to delete $DataDir automatically. Remove it yourself if it is really the shop data folder." -ForegroundColor Red
    $removeData = $false
  } else {
    Write-Host ""
    Write-Host "  This permanently deletes the shop database and backups in:" -ForegroundColor Yellow
    Write-Host "    $DataDir" -ForegroundColor Yellow
    if (Test-Path (Join-Path $DataDir "offsite.key")) {
      Write-Host "  The offsite.key file is also deleted. Without it, Google Drive backups cannot be opened." -ForegroundColor Yellow
    }
    if (-not $Yes) {
      $answer = Read-Host "`nType DELETE to confirm"
      if ($answer -ne "DELETE") { Write-Host "`nCancelled. Nothing was removed."; exit 0 }
    }
  }
}

Write-Host ""
Write-Host "Removing Shop Desk..." -ForegroundColor Cyan

# 1. Stop and remove the startup task.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Done "Stopped Shop Desk"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Done "Removed the startup task"

Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like "Shop Desk (TCP*" } |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Done "Removed the firewall rule"

$desktops = @(
  [Environment]::GetFolderPath("CommonDesktopDirectory"),
  [Environment]::GetFolderPath("Desktop")
) | Where-Object { $_ }
foreach ($desktop in $desktops) {
  Remove-Item (Join-Path $desktop "Shop Desk.url") -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $desktop "Shop Desk - Connect a phone.url") -Force -ErrorAction SilentlyContinue
}
Done "Removed the desktop shortcuts"

Remove-Item $RunFile -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $InstallDir "Uninstall Shop Desk.bat") -Force -ErrorAction SilentlyContinue
Get-ChildItem $InstallDir -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "update-backup-*" -or $_.Name -like "app.old-*" -or $_.Name -eq "app.new" } |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $LogDir -Recurse -Force -ErrorAction SilentlyContinue
Done "Removed the program files"

if ($removeData) {
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $MarkerDir -Recurse -Force -ErrorAction SilentlyContinue
  if ((Test-Path $InstallDir) -and -not (Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue)) {
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Done "Deleted the shop data and backups"
} else {
  Remove-Item $MarkerFile -Force -ErrorAction SilentlyContinue
  if ((Test-Path $MarkerDir) -and -not (Get-ChildItem $MarkerDir -Force -ErrorAction SilentlyContinue)) {
    Remove-Item $MarkerDir -Force -ErrorAction SilentlyContinue
  }
  Done "Kept the shop data"
}

Write-Host ""
if ($removeData) {
  Write-Host "==============================================" -ForegroundColor Green
  Write-Host "  Shop Desk was removed completely." -ForegroundColor Green
  Write-Host "==============================================" -ForegroundColor Green
  Write-Host "  The program, database, backups and shortcuts are gone."
  Write-Host "  If you still have an offsite backup in Google Drive, keep your"
  Write-Host "  offsite.key safe so it can be restored on another PC."
  Write-Host "==============================================" -ForegroundColor Green
} else {
  Write-Host "==============================================" -ForegroundColor Green
  Write-Host "  Shop Desk has been removed." -ForegroundColor Green
  Write-Host "==============================================" -ForegroundColor Green
  Write-Host "  Your shop data was KEPT here:"
  Write-Host "    $DataDir"
  Show-DataFiles $DataDir
  Write-Host ""
  Write-Host "  To install Shop Desk again later, run `"1 - Install Shop Desk.bat`""
  Write-Host "  and choose this folder: $InstallDir"
  Write-Host "==============================================" -ForegroundColor Green
}
Write-Host ""
exit 0
