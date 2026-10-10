@echo off
rem dsh-api-heal 安装入口。
rem 直接双击或 `install.cmd` 即可 —— 内部用 -ExecutionPolicy Bypass 绕过
rem 当前用户策略(RemoteSigned 会拒绝未签名脚本)。
setlocal
set "SCRIPT=%~dp0install.ps1"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
echo.
pause
