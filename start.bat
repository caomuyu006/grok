@echo off
chcp 65001 >nul
title Grok Proxy (Deno)
cd /d %~dp0
echo ========================================
echo  Grok 3 API Proxy 启动中 (Deno)
echo  地址: http://localhost:8000
echo  健康检查: http://localhost:8000/health
echo  关闭窗口即停止服务
echo ========================================
if not defined GROK_COOKIE (
    echo [提示] 未设置 GROK_COOKIE,使用匿名免登录模式
) else (
    echo [提示] 已使用 Cookie 模式
)
deno run --allow-net --allow-read --allow-env src/deno_index.ts
pause
