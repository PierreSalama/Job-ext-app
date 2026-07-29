@echo off
title JAT - Fix Dad's Laptop
echo.
echo   Fixing Dad's JAT / Firefox... a blue "Yes" prompt will appear - click Yes.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Fix-Dad.ps1"
echo.
pause
