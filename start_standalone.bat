@echo off
echo =======================================
echo MCP SuperAssistant Standalone Startup
echo =======================================
echo.

REM Change to the script's directory
cd /d "%~dp0"

REM Check if Node.js is available
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in your PATH.
    echo Please install it from https://nodejs.org/
    pause
    exit /b 1
)

echo Starting the MCP Proxy Server...
echo This window must remain open for the browser extension to work.
echo.

node start_proxy.js
