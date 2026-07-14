@echo off
setlocal

set "SERVER_IP=111.88.147.132"
set "SERVER_USER=invaiders"

rem Пути заданы относительно расположения этого скрипта (scripts\upload.bat),
rem поэтому репозиторий можно клонировать в любую папку.

rem Ключ vero лежит рядом с папкой репозитория (на уровень выше ifc-viewer)
set "SSH_KEY=%~dp0..\..\vero"

rem Папка dist в корне репозитория (создаётся `npm run build`)
set "LOCAL_DIST=%~dp0..\dist"

set "REMOTE_DIR=/home/invaiders/agr-viewer"

echo ========================================
echo Files check
echo ========================================

if not exist "%SSH_KEY%" (
    echo ERROR: SSH key not found:
    echo %SSH_KEY%
    exit /b 1
)

if not exist "%LOCAL_DIST%\" (
    echo ERROR: dist directory not found:
    echo %LOCAL_DIST%
    exit /b 1
)

echo ========================================
echo Removing old version
echo ========================================

ssh -i "%SSH_KEY%" ^
    -o BatchMode=yes ^
    %SERVER_USER%@%SERVER_IP% ^
    "rm -rf %REMOTE_DIR% && mkdir -p %REMOTE_DIR%"

if errorlevel 1 goto error

echo ========================================
echo Uploading dist
echo ========================================

scp -i "%SSH_KEY%" ^
    -r "%LOCAL_DIST%\*" ^
    %SERVER_USER%@%SERVER_IP%:%REMOTE_DIR%/

if errorlevel 1 goto error

echo ========================================
echo Restarting nginx
echo ========================================

ssh -i "%SSH_KEY%" ^
    -o BatchMode=yes ^
    %SERVER_USER%@%SERVER_IP% ^
    "sudo systemctl restart nginx"

if errorlevel 1 goto error

echo ========================================
echo Upload completed successfully
echo ========================================

exit /b 0

:error
echo ========================================
echo ERROR: deployment failed
echo ========================================

exit /b 1
