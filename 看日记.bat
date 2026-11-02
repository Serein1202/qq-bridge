@echo off
setlocal
chcp 65001 >nul
title 小鲸鱼 · 看日记
cd /d "%~dp0"

rem 双击就能翻她的日记（最近 5 条）
rem 想看某一天：该天在 packages\companion\data\diary\YYYY-MM-DD.md

set "DIARY=%~dp0packages\companion\src\diary.js"

rem 便携版 node 优先，其次系统
if exist "%~dp0_runtime\node\node.exe" (
    set "PATH=%~dp0_runtime\node;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
    echo 没找到 node - 先跑一遍 安装.bat
    pause
    exit /b 1
)
if not exist "%DIARY%" (
    echo 找不到 diary.js - 仓库下载不完整
    pause
    exit /b 1
)

echo.
echo ── 最近 5 条 ──
node "%DIARY%" list -n 5
echo.
echo ── 一共写了多少 ──
node "%DIARY%" stats
echo.
pause
endlocal
