@echo off
REM ===================================================================
REM  JAT SERVER - turn this laptop into an always-on auto-apply node.
REM  Double-click this file, approve the admin prompt, wait for DONE.
REM  Nothing to type or paste.
REM ===================================================================
title JAT Server Setup
echo.
echo   Setting this laptop up as Pierre's always-on auto-apply server.
echo   Approve the administrator prompt when it appears, then wait.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Server.ps1"
