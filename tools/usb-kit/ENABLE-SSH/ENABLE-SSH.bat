@echo off
title Enable SSH on Dad's Laptop
echo.
echo   Turning on SSH so Claude can connect over the network...
echo   A blue "Yes" prompt will appear - click Yes.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable-SSH.ps1"
