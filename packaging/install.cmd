@echo off
setlocal
set "APP_DIR=%LOCALAPPDATA%\Programs\XieXin"
if not exist "%APP_DIR%" mkdir "%APP_DIR%"
copy /Y "%~dp0XieXin.exe" "%APP_DIR%\XieXin.exe" >nul
copy /Y "%~dp0WebView2Loader.dll" "%APP_DIR%\WebView2Loader.dll" >nul
start "XieXin" "%APP_DIR%\XieXin.exe"
exit /b 0