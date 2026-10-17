#Requires -RunAsAdministrator
<#
  Update Shop Desk safely.
    powershell -ExecutionPolicy Bypass -File update-shopdesk.ps1 -SourceDir "D:\ShopDesk-download"
  or with a zip released by the supplier:
    powershell -ExecutionPolicy Bypass -File update-shopdesk.ps1 -ZipPath "D:\ShopDesk-12.zip"

  The update stops the server, keeps a rollback copy of the app and the database,
  swaps in the new files, starts the server, and checks /healthz. If the new
  version does not start, it restores the previous app and database automatically.
#>
param(
  [string]$InstallDir = "",
  [int]$Port = 0,
  [string]$SourceDir = "",
  [string]$ZipPath = ""
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
$MarkerFile = Join-SafePath $env:ProgramData "ShopDesk\install.json"

# Find the folder chosen during installation (C:\ShopDesk is only a fallback).
$marker = $null
if (Test-Path $MarkerFile) { try { $marker = Get-Content $MarkerFile -Raw | ConvertFrom-Json } catch { } }
if (-not $InstallDir -and $marker -and $marker.installDir) { $InstallDir = $marker.installDir }
if (-not $InstallDir) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $action = @($task.Actions)[0]
    if ($action -and $action.Arguments -match '/c\s+"?([^"]+run-shop\.cmd)"?') { $InstallDir = Split-Path $Matches[1] -Parent }
  }
}
if (-not $InstallDir) { $InstallDir = "C:\ShopDesk" }
if (-not $Port -and $marker -and $marker.port) { $Port = [int]$marker.port }
if (-not $Port) { $Port = 8765 }
$AppDir = Join-SafePath $InstallDir "app"
$DataDir = if ($marker -and $marker.dataDir) { $marker.dataDir } else { Join-SafePath $InstallDir "data" }
$LogDir = Join-SafePath $InstallDir "logs"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$StageDir = Join-SafePath $InstallDir "app.new"
$BackupDir = Join-SafePath $InstallDir "update-backup-$stamp"

function Fail($message) { Write-Host "`nUPDATE FAILED: $message" -ForegroundColor Red; exit 1 }
function Wait-Healthy([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
  }
  return $false
}

if (-not (Test-FileExists (Join-SafePath $AppDir "server.mjs"))) { Fail "Shop Desk is not installed at $AppDir. Run install-shopdesk.ps1 first." }
if (-not $SourceDir -and -not $ZipPath) { Fail "Provide -SourceDir <folder with the new Shop Desk files> or -ZipPath <release zip>." }

$temp = Join-SafePath $env:TEMP "shopdesk-update-$stamp"
if ($ZipPath) {
  Expand-Archive -Path $ZipPath -DestinationPath $temp -Force
  $SourceDir = (Get-ChildItem $temp -Directory | Select-Object -First 1).FullName
  if (-not $SourceDir) { $SourceDir = $temp }
}
$SourceDir = (Resolve-Path $SourceDir).Path
if (-not (Test-FileExists (Join-SafePath $SourceDir "server.mjs"))) { Fail "The update folder does not contain server.mjs." }

Write-Host "Stopping Shop Desk…"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Creating a rollback copy in $BackupDir"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
robocopy $AppDir $BackupDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item (Join-SafePath $DataDir "shop.sqlite3") $BackupDir -Force -ErrorAction SilentlyContinue
Copy-Item (Join-SafePath $DataDir "shop.sqlite3-wal") $BackupDir -Force -ErrorAction SilentlyContinue
Copy-Item (Join-SafePath $DataDir "shop.sqlite3-shm") $BackupDir -Force -ErrorAction SilentlyContinue

# Rebuild the app folder, keeping data.
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
robocopy $SourceDir $StageDir /E /XD data node_modules .git vendor licences private releases /XF *.sqlite3 *.sqlite3-wal *.sqlite3-shm *.pem licences.csv "3 - Build Licence Kit.bat" /NFL /NDL /NJH /NJS /NP | Out-Null

Write-Host "Swapping files…"
Rename-Item $AppDir "app.old-$stamp"
Rename-Item $StageDir "app"
Start-ScheduledTask -TaskName $TaskName

Write-Host "Checking the new version…"
if (Wait-Healthy 60) {
  Write-Host "Update complete. The previous version is kept in $BackupDir and app.old-$stamp." -ForegroundColor Green
  exit 0
}

Write-Host "The new version did not start. Rolling back…" -ForegroundColor Yellow
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
Rename-Item "app.old-$stamp" "app"
Copy-Item (Join-SafePath $BackupDir "shop.sqlite3") (Join-SafePath $DataDir "shop.sqlite3") -Force -ErrorAction SilentlyContinue
Copy-Item (Join-SafePath $BackupDir "shop.sqlite3-wal") (Join-SafePath $DataDir "shop.sqlite3-wal") -Force -ErrorAction SilentlyContinue
Copy-Item (Join-SafePath $BackupDir "shop.sqlite3-shm") (Join-SafePath $DataDir "shop.sqlite3-shm") -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Fail "Rolled back to the previous version. Check $LogDir\server.log for the cause."
