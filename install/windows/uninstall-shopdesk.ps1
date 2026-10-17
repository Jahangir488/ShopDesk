#Requires -RunAsAdministrator
# Remove Shop Desk startup, firewall rule and shortcuts. Shop data is kept.
param(
  [string]$InstallDir = "C:\ShopDesk",
  [int]$Port = 8765,
  [switch]$RemoveData
)
$ErrorActionPreference = "Continue"
Stop-ScheduledTask -TaskName "Shop Desk" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Shop Desk" -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "Shop Desk (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
$desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
Remove-Item (Join-Path $desktop "Shop Desk.url") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $desktop "Shop Desk - Connect a phone.url") -Force -ErrorAction SilentlyContinue
if ($RemoveData) {
  $answer = Read-Host "This deletes the shop database in $InstallDir. Type DELETE to confirm"
  if ($answer -eq "DELETE") { Remove-Item -Recurse -Force $InstallDir } else { Write-Host "Data kept." }
} else {
  Write-Host "Startup, firewall rule and shortcuts removed. Data is still in $InstallDir\data."
  Write-Host "Delete that folder yourself only after you have a verified backup."
}
