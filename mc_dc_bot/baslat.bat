@echo off
cd /d "%~dp0"
title Yaren Discord Botu (kapatmak icin bu pencereyi kapat)
if not exist node_modules (
  echo Once kur.bat dosyasini calistir.
  pause
  exit /b 1
)
:basla
node discordbot.js
echo.
echo Bot kapandi. 10 saniye sonra yeniden baslatiliyor...
echo (Tamamen kapatmak icin bu pencereyi kapat.)
timeout /t 10 >nul
goto basla
