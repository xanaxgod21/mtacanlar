# Starts the key server and the Discord bot on Windows, each in its own window.
# Double-click baslat.bat, or run:  powershell -ExecutionPolicy Bypass -File .\baslat.ps1
# Run kur.ps1 first.

$Port = 8080
# 0.0.0.0: reachable from other computers. Use 127.0.0.1 behind a reverse proxy such as Caddy.
$ListenHost = '0.0.0.0'

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$python = '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath 'keys.db')) {
    Write-Host 'Önce kur.bat ile kurulumu yap.' -ForegroundColor Red
    exit 1
}

function Start-Window([string]$title, [string]$arguments) {
    # cmd /k keeps the window open, so an error stays readable.
    Start-Process -FilePath 'cmd.exe' -WorkingDirectory $PSScriptRoot `
        -ArgumentList "/k title $title & $python -X utf8 $arguments"
}

Start-Window 'Key Sunucusu' "keyserver.py serve --host $ListenHost --port $Port"
Write-Host "Key sunucusu açıldı (port $Port)." -ForegroundColor Green

if (Test-Path -LiteralPath 'bot.env') {
    Start-Window 'Discord Bot' 'discord_bot.py'
    Write-Host 'Discord bot açıldı.' -ForegroundColor Green
}
else {
    Write-Host 'bot.env yok, Discord bot başlatılmadı. kur.bat ile ayarla.' -ForegroundColor Yellow
}
Write-Host 'Kapatmak için açılan pencereleri kapat.'
