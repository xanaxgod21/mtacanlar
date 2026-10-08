@echo off
cd /d "%~dp0"
title Yaren Discord Botu (kapatmak icin bu pencereyi kapat)
if not exist node_modules (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu indir ve kur.
    pause
    exit /b 1
  )
  echo Ilk acilis: gerekli paketler indiriliyor, 1-2 dakika surebilir...
  call npm install
  if errorlevel 1 (
    echo npm install basarisiz oldu. Internet baglantini kontrol edip tekrar dene.
    pause
    exit /b 1
  )
)
:basla
node discordbot.js
echo.
echo Bot kapandi. 10 saniye sonra yeniden baslatiliyor...
echo (Tamamen kapatmak icin bu pencereyi kapat.)
timeout /t 10 >nul
goto basla
