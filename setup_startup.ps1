# MCP SuperAssistant Auto-Startup Setup Script
# This script sets up MCP SuperAssistant to start automatically on Windows boot

param(
    [switch]$RemoveStartup
)

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "MCP SuperAssistant (Silent).lnk"
$vbsFilePath = Join-Path $scriptPath "start_silent.vbs"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " MCP SuperAssistant Auto-Startup Setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if ($RemoveStartup) {
    Write-Host "Removing auto-startup..." -ForegroundColor Yellow

    # Remove from Startup folder
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force
        Write-Host "  ✓ Removed from Startup folder" -ForegroundColor Green
    } else {
        Write-Host "  ! No startup shortcut found" -ForegroundColor Yellow
    }

    # Note: pm2 startup is primarily for Linux systems.
    # On Windows, auto-startup is handled via the shortcut in the Startup folder.
    Write-Host "  ! PM2 auto-start configuration is not applicable for Windows init systems." -ForegroundColor Yellow

    Write-Host ""
    Write-Host "Auto-startup removal complete!" -ForegroundColor Green
    Write-Host "MCP SuperAssistant will no longer start automatically on boot." -ForegroundColor Cyan
    exit
}

# Setup auto-startup
Write-Host "Setting up auto-startup..." -ForegroundColor Green

# Check if VBScript file exists
if (!(Test-Path $vbsFilePath)) {
    Write-Host "  ✗ Error: start_silent.vbs not found at $vbsFilePath" -ForegroundColor Red
    Write-Host "  Please ensure start_silent.vbs is in the same directory as this script." -ForegroundColor Red
    exit 1
}

# Create shortcut in Startup folder
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $vbsFilePath
$shortcut.WorkingDirectory = $scriptPath
$shortcut.Description = "MCP SuperAssistant - Starts silently and automatically on boot"
$shortcut.Save()

Write-Host "  ✓ Created startup shortcut in Startup folder" -ForegroundColor Green

# Note: pm2 startup is primarily for Linux systems.
# On Windows, auto-startup is handled via the shortcut in the Startup folder.
Write-Host "  ! PM2 auto-start configuration is not applicable for Windows init systems." -ForegroundColor Yellow
Write-Host "  Auto-startup will be managed via the Windows Startup folder shortcut." -ForegroundColor Yellow

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " SETUP COMPLETE!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "MCP SuperAssistant is now configured to start automatically on boot." -ForegroundColor Green
Write-Host ""
Write-Host "To test the startup:" -ForegroundColor Cyan
Write-Host "  1. Restart your computer" -ForegroundColor White
Write-Host "  2. Check that MCP SuperAssistant starts automatically" -ForegroundColor White
Write-Host ""
Write-Host "Management commands:" -ForegroundColor Cyan
Write-Host "  • Check status: pm2 status" -ForegroundColor White
Write-Host "  • Stop service: pm2 stop MCP-SuperAssistant" -ForegroundColor White
Write-Host "  • Start service: pm2 start MCP-SuperAssistant" -ForegroundColor White
Write-Host "  • View logs: pm2 logs MCP-SuperAssistant" -ForegroundColor White
Write-Host ""
Write-Host "To remove auto-startup:" -ForegroundColor Yellow
Write-Host "  .\setup_startup.ps1 -RemoveStartup" -ForegroundColor White
Write-Host ""

Write-Host "==========================================" -ForegroundColor Cyan
