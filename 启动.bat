@echo off
setlocal
chcp 65001 >nul
title 小鲸鱼 · 运行中（别关这个窗口）
cd /d "%~dp0"

rem ═══════════════════════════════════════════════════════════
rem  启动 qq-bridge
rem  用法：启动.bat [bridge目录]   （默认脚本所在目录）
rem  这个窗口【要一直开着】★ 关了就等于她下线了
rem ═══════════════════════════════════════════════════════════

rem 支持参数指定 bridge 目录；默认取脚本所在目录
set "BRIDGE=%~1"
if "%BRIDGE%"=="" set "BRIDGE=%~dp0"
if not "%BRIDGE:~-1%"=="\" set "BRIDGE=%BRIDGE%\"

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║                  小鲸鱼 · 启动中                     ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

rem ── 检查前置 ─────────────────────────────────────────────
if not exist "%BRIDGE%config.json" (
    echo  ╳ 没有 config.json
    echo    先跑一次 安装.bat
    pause
    exit /b 1
)
if not exist "%BRIDGE%src\bridge.js" (
    echo  ╳ 没找到 src\bridge.js，目录不对：%BRIDGE%
    echo    用法：启动.bat [bridge目录]
    pause
    exit /b 1
)

rem 便携版 node 优先，其次系统
if exist "%~dp0_runtime\node\node.exe" (
    set "PATH=%~dp0_runtime\node;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
    echo  ╳ 没找到 node - 先跑一次 安装.bat
    pause
    exit /b 1
)

echo  检查前置服务...
echo.

rem SnowLuma OneBot API（3000 端口）
powershell -NoProfile -Command "if ((Test-NetConnection 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }"
if errorlevel 1 (
    echo    XX   SnowLuma 没在跑
    echo         去双击它的 launcher.bat，扫码登录
    echo.
    pause
    exit /b 1
) else (
    echo    OK   SnowLuma（QQ 连接）
)

rem DeepSeek Harness / DSH web（3080 端口）
powershell -NoProfile -Command "if ((Test-NetConnection 127.0.0.1 -Port 3080 -WarningAction SilentlyContinue).TcpTestSucceeded) { exit 0 } else { exit 1 }"
if errorlevel 1 (
    echo    !!   DeepSeek Harness 好像没开
    echo         如果她不理你，八成是这个原因
) else (
    echo    OK   DeepSeek Harness（大脑）
)

echo.
echo  ══════════════════════════════════════════════════════
echo   正在启动。下面会刷很多行字，那是正常的。
echo.
echo   ★ 这个窗口不要关 ★
echo   最小化它，去 QQ 里跟她说话就行
echo.
echo   想让她下线：直接关掉这个窗口
echo  ══════════════════════════════════════════════════════
echo.

cd /d "%BRIDGE%"
node src\bridge.js
set "EXITCODE=%ERRORLEVEL%"

echo.
echo  她下线了。（退出码 %EXITCODE%）
echo.
pause
endlocal & exit /b %EXITCODE%
