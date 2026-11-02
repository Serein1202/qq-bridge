@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title 小鲸鱼 · 写日记
cd /d "%~dp0"

rem ═══════════════════════════════════════════════════════════
rem  双击 = 让她自己写一条日记（不用你打字）
rem
rem  想自己手打：写日记.bat 手动
rem  日记默认存在：packages\companion\data\diary
rem ═══════════════════════════════════════════════════════════

set "DIARY=%~dp0packages\companion\src\diary.js"
set "CFG=%~dp0packages\companion\config.json"

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

rem 第一次用：自动生成 config.json + role.md，然后开记事本让他填 key
if not exist "%CFG%" (
    if exist "%~dp0packages\companion\config.example.json" (
        copy "%~dp0packages\companion\config.example.json" "%CFG%" >nul
        if not exist "%~dp0packages\companion\role.md" copy "%~dp0packages\companion\role.example.md" "%~dp0packages\companion\role.md" >nul
        echo.
        echo  第一次用：已经帮你生成了 config.json
        echo  把 apiKey 那行换成你自己的 key（platform.deepseek.com 注册就有）
        echo  保存、关掉记事本，再双击一次这个文件。
        echo.
        start notepad "%CFG%"
        pause
        exit /b 0
    )
    echo 找不到 packages\companion\config.example.json - 仓库下载不完整
    pause
    exit /b 1
)

if /i "%~1"=="手动" goto manual

echo.
echo ──────────────────────────────
echo   写日记 · 她自己写，你看着就行
echo ──────────────────────────────
node "%DIARY%" auto
if errorlevel 1 (
    echo.
    echo 没写成。常见原因：apiKey 不对、没网、或者余额用光了。
    pause
    exit /b 1
)

echo.
echo ── 最近 3 条 ──
node "%DIARY%" list -n 3
echo.
pause
exit /b 0

:manual
echo.
echo ──────────────────────────────
echo   手动写 · 写完回车，多写几条也行
echo   （注意：内容里别用英文双引号 " ）
echo ──────────────────────────────
echo.

:again
set "TEXT="
set "MOOD="
set "TITLE="
set /p TEXT=今天发生了什么：
if "!TEXT!"=="" (
    echo 空的就不写
    goto end
)
set /p MOOD=心情（两三个字，可留空）：
set /p TITLE=标题（可留空）：

node "%DIARY%" add "!TEXT!" --mood "!MOOD!" --title "!TITLE!"
echo.
set /p MORE=再写一条？(y/N)：
if /i "!MORE!"=="y" goto again

echo.
echo ── 最近 3 条 ──
node "%DIARY%" list -n 3

:end
echo.
pause
endlocal
