@echo off
REM ===================================================================
REM  JAT Remote Access - one-time setup for Dad's laptop.
REM  Just double-click this file. It will ask for admin once, then do
REM  everything on its own. Nothing to type or paste.
REM ===================================================================
title JAT Remote Access Setup
echo.
echo   Setting up remote access so Pierre can revive JAT if it stops.
echo   Approve the administrator prompt when it appears.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Remote.ps1"
