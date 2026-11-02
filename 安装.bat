@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title 小鲸鱼 · 一键安装
cd /d "%~dp0"

rem ═══════════════════════════════════════════════════════════
rem  小鲸鱼安装器 —— 把 qq-bridge 装好、依赖装好、配置生成好
rem  作者：平安（pinganbbOvO）
rem  仓库：github.com/pinganbbOvO/ai-companion-kit
rem
rem  ① 检查 Node.js（没有就自动下便携版）  ② 下载 qq-bridge
rem  ③ 跑 npm install                       ④ 生成 config.json
rem  ⑤ 打开记事本让你填三个值
rem ═══════════════════════════════════════════════════════════

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║           小鲸鱼 · 一键安装（qq-bridge）             ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

rem ── 选安装目录 ────────────────────────────────────────────
set "TARGET=%~1"
if "%TARGET%"=="" (
    echo  装到哪个文件夹？
    echo  （直接回车 = D:\qq-bridge，推荐）
    echo.
    set /p TARGET= 路径：
)
if "%TARGET%"=="" set "TARGET=D:\qq-bridge"
echo.
echo  安装到：!TARGET!
echo.

rem ── ① 检查 Node.js：便携版优先，其次系统 ─────────────────
echo  [1/5] 检查 Node.js...
if exist "%~dp0_runtime\node\node.exe" (
    set "PATH=%~dp0_runtime\node;!PATH!"
    echo        OK  使用便携版 Node（_runtime\node）
    goto :node_ready
)
where node >nul 2>nul
if not errorlevel 1 goto :node_ready

echo.
echo        系统里没有 Node.js
echo        自动下载便携版（约 30MB，只给这套东西用）…
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1" -Dest "%~dp0_runtime\node"
if errorlevel 1 goto :node_failed
set "PATH=%~dp0_runtime\node;%PATH%"

:node_ready
for /f "delims=" %%v in ('node -v 2>nul') do set "NODEV=%%v"
if not defined NODEV goto :node_failed
echo        OK  Node.js !NODEV!

where npm >nul 2>nul
if errorlevel 1 (
    echo  ╳ 有 node 但没找到 npm — 这个 Node 不完整
    echo    系统安装的：卸载后重装一次
    echo    便携版：删掉 _runtime\node 再跑一次本脚本
    pause
    exit /b 1
)
echo        OK  npm
goto :node_done

:node_failed
echo.
echo  ╳ Node.js 不可用（便携版下载失败或损坏）
echo.
echo  两个办法，任选一个：
echo    A. 再跑一次本脚本（镜像偶尔抽风）
echo    B. 自己去官网装：
echo       1. 浏览器搜索 "Node.js 官网"
echo       2. 下载 LTS 版本（左边那个按钮）
echo       3. 双击安装，一路"下一步"
echo       4. ★装完重启一次电脑★
echo.
pause
exit /b 1

:node_done

rem ── ② 下载 qq-bridge（多镜像回退） ───────────────────────
echo.
echo  [2/5] 下载 qq-bridge...

if exist "!TARGET!\src\bridge.js" (
    echo        已经装过了，跳过下载
    goto :skip_download
)
if exist "!TARGET!" (
    echo        !! 目录已存在但不是完整的 qq-bridge
    echo        换个目录，或者先把它删掉
    pause
    exit /b 1
)

mkdir "!TARGET!" 2>nul
set "ZIP=%TEMP%\qq-bridge-%RANDOM%.zip"
set "TMPX=%TEMP%\qqb-tmp-%RANDOM%"

rem 依次尝试：gh-proxy 加速 → GitHub 直连
set "URL1=https://gh-proxy.com/https://github.com/Derpyu520/qq-bridge/archive/refs/heads/main.zip"
set "URL2=https://github.com/Derpyu520/qq-bridge/archive/refs/heads/main.zip"

echo        正在下载（可能要一两分钟）...
powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%URL1%' -OutFile '%ZIP%' -UseBasicParsing -TimeoutSec 300; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    echo        镜像失败，尝试 GitHub 直连...
    powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%URL2%' -OutFile '%ZIP%' -UseBasicParsing -TimeoutSec 300; exit 0 } catch { exit 1 }"
)
if errorlevel 1 (
    echo.
    echo  ╳ 下载失败（两个源都试过了）
    echo.
    echo  手动来：
    echo    1. 浏览器打开 github.com/Derpyu520/qq-bridge
    echo    2. 绿色 Code 按钮 → Download ZIP
    echo    3. 解压到 !TARGET!
    echo    4. 再跑一次这个脚本（它会跳过下载）
    echo.
    pause
    exit /b 1
)

echo        正在解压...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%TMPX%' -Force; $d = Get-ChildItem '%TMPX%' -Directory | Select-Object -First 1; Copy-Item ($d.FullName + '\*') '!TARGET!' -Recurse -Force"
if errorlevel 1 (
    echo  ╳ 解压失败
    pause
    exit /b 1
)
del "%ZIP%" >nul 2>nul
rmdir /s /q "%TMPX%" >nul 2>nul
echo        OK  解压完成

:skip_download

rem ── ③ npm install（失败自动换国内镜像重试） ───────────────
echo.
echo  [3/5] 安装依赖（npm install）...
echo        这一步最慢，可能三五分钟，别关窗口
echo.
pushd "!TARGET!"
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo  !! npm install 报错了，改用国内镜像重试...
    call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)
if errorlevel 1 (
    echo.
    echo  !! npm install 仍然失败
    echo  手动执行：
    echo    cd /d !TARGET!
    echo    npm install --registry=https://registry.npmmirror.com
    echo.
    pause
    popd
    exit /b 1
)
popd
echo        OK  依赖装好了

rem ── ④ 生成 config.json ───────────────────────────────────
echo.
echo  [4/5] 生成配置文件...

if exist "!TARGET!\config.json" (
    echo        已有 config.json，不覆盖
    goto :skip_config
)
if not exist "!TARGET!\config.example.json" (
    echo        !! 没找到 config.example.json，下载可能不完整
    goto :skip_config
)
copy "!TARGET!\config.example.json" "!TARGET!\config.json" >nul
echo        OK  已生成 config.json

:skip_config

rem ── ⑤ 打开记事本 ─────────────────────────────────────────
echo.
echo  [5/5] 打开配置文件，你要填三个地方
echo.
echo   ══════════════════════════════════════════════════
echo    ① ownerQQ          →  改成【你的】QQ 号
echo    ② allow.private    →  里面两个数字，一个是你的号，
echo                           另一个改成【她】的 QQ 号
echo    ③ snowluma.accessToken
echo                       →  填 SnowLuma 界面里那串"访问令牌"
echo   ══════════════════════════════════════════════════
echo.
echo   改完保存（Ctrl+S），关掉记事本，然后按任意键继续
echo.
pause
start notepad "!TARGET!\config.json"

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║  装好了                                              ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo  接下来：
echo.
echo    ① 确认 SnowLuma 已经登录（它那个窗口还开着吗？）
echo    ② 确认 DeepSeek Harness 已经打开
echo    ③ 双击这个文件夹里的  启动.bat
echo.
echo  （系统里没有 Node 的话，安装器已经下了一份便携版在
echo    _runtime\node，不用另外装，也不会进系统环境变量）
echo.
echo  装在哪： !TARGET!
echo.
pause
endlocal
