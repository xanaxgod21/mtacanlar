@echo off
cd /d "%~dp0"
title Yaren kurulum
echo === Yaren kurulum ===
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi.
  echo https://nodejs.org adresinden LTS surumunu indir ve kur,
  echo sonra bu dosyayi tekrar calistir.
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js surumun eski, en az 18 lazim: https://nodejs.org
  pause
  exit /b 1
)
echo Gerekli paketler indiriliyor (1-2 dakika surebilir)...
call npm install
if errorlevel 1 (
  echo npm install basarisiz oldu. Internet baglantini kontrol edip tekrar dene.
  pause
  exit /b 1
)
echo.
echo Kurulum bitti. Bot simdi aciliyor: token sorarsa yapistir ve Enter'a bas.
echo.
call "%~dp0baslat.bat"
