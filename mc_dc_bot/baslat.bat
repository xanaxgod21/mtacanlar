@echo off
cd /d "%~dp0"
title Yaren Discord Botu (kapatmak icin bu pencereyi kapat)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi.
  echo https://nodejs.org adresinden LTS surumunu indir ve kur,
  echo sonra bu dosyayi tekrar calistir.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)"
if errorlevel 1 (
  echo Node.js surumun eski, en az 18.17 lazim: https://nodejs.org adresinden LTS surumunu kur.
  pause
  exit /b 1
)
if not exist "node_modules\.package-lock.json" (
  if exist node_modules (
    echo Onceki kurulum yarida kalmis, paketler yeniden indiriliyor...
    rmdir /s /q node_modules
  )
  echo Gerekli paketler indiriliyor, 1-2 dakika surebilir...
  call npm install
  if errorlevel 1 (
    echo npm install basarisiz oldu. Internet baglantini kontrol edip tekrar dene.
    pause
    exit /b 1
  )
)
:basla
node discordbot.js
if %errorlevel%==5 goto duzelt
echo.
echo Bot kapandi. 10 saniye sonra yeniden baslatiliyor...
echo (Tamamen kapatmak icin bu pencereyi kapat.)
timeout /t 10 >nul
goto basla
:duzelt
echo.
echo Yukaridaki sorunu duzelttikten sonra botu yeniden acmak icin bir tusa bas.
pause >nul
goto basla
