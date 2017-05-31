@setlocal enableextensions
@cd /d "%~dp0/lib"

START cmd.exe /k "node proxy.js"