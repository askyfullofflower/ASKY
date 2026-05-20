@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "PYTHON=%ROOT%..\.venv\Scripts\python.exe"

rem 清理旧日志文件，避免目录产生过多文件
del /q "%ROOT%backend\backend.log" >nul 2>&1
del /q "%ROOT%backend\frontend.log" >nul 2>&1
del /q "%ROOT%backend\backend-*.log" >nul 2>&1
del /q "%ROOT%backend\frontend-*.log" >nul 2>&1

if not exist "%PYTHON%" (
  echo [错误] 未找到 Python 解释器: %PYTHON%
  echo 请先在工作区根目录创建并配置 .venv 环境。
  exit /b 1
)

if not defined MYSQL_URL (
  for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v MYSQL_URL 2^>nul ^| findstr /I "MYSQL_URL"') do set "MYSQL_URL=%%B"
)

if not defined MYSQL_URL (
  echo [错误] 未检测到 MYSQL_URL，无法以 MySQL 模式启动。
  echo 请先执行:
  echo   setx MYSQL_URL "mysql+pymysql://root:123456@127.0.0.1:3306/digital_twin?charset=utf8mb4"
  echo 然后重新打开终端或直接双击本脚本。
  exit /b 1
)

if not defined MYSQL_ENABLE set "MYSQL_ENABLE=1"

for /f %%C in ('powershell -NoProfile -Command "$c=@(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).Count; $c"') do set "PORT8000_COUNT=%%C"
for /f %%C in ('powershell -NoProfile -Command "$c=@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count; $c"') do set "PORT3000_COUNT=%%C"

echo [1/3] 启动后端 (MySQL 模式, http://localhost:8000) ...
if "%PORT8000_COUNT%"=="0" (
  start /b "" "%PYTHON%" -m uvicorn main:app --host 0.0.0.0 --port 8000 --app-dir "%ROOT%backend" >nul 2>&1
) else (
  echo [提示] 端口 8000 已被占用，跳过后端启动。若需重启请先执行: taskkill /F /IM python.exe
)

echo [2/3] 启动前端 (http://localhost:3000) ...
if "%PORT3000_COUNT%"=="0" (
  start /b "" "%PYTHON%" -m http.server 3000 --directory "%ROOT%pc-client" >nul 2>&1
) else (
  echo [提示] 端口 3000 已被占用，跳过前端启动。
)

echo [3/3] 等待服务就绪...
timeout /t 3 >nul
start "" "http://localhost:3000"

echo 已在后台启动（不生成日志文件）。
echo 停止服务: taskkill /F /IM python.exe

endlocal
