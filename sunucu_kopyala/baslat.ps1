# Sunucu kopyalayiciyi baslatir.
#
# Token'i ilk calistirmada sorar, istersen Windows kullanici ortam
# degiskenine (DISCORD_TOKEN) kaydeder; sonraki calistirmalarda sormaz.
#
#   .\baslat.ps1                 normal calistir
#   .\baslat.ps1 -TokenSifirla   kayitli token'i sil ve yenisini sor
#
# "running scripts is disabled" hatasi alirsan:
#   powershell -ExecutionPolicy Bypass -File .\baslat.ps1

param([switch]$TokenSifirla)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if ($TokenSifirla) {
    [Environment]::SetEnvironmentVariable('DISCORD_TOKEN', $null, 'User')
    $env:DISCORD_TOKEN = $null
    Write-Host 'Kayitli token silindi.'
}

if (-not $env:DISCORD_TOKEN) {
    $env:DISCORD_TOKEN = [Environment]::GetEnvironmentVariable('DISCORD_TOKEN', 'User')
}

if (-not $env:DISCORD_TOKEN) {
    $secure = Read-Host 'Discord token' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim().Trim('"')
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if (-not $token) { throw 'Token bos olamaz.' }
    $env:DISCORD_TOKEN = $token

    $kaydet = Read-Host 'Token bu bilgisayara kaydedilsin mi? Bir dahakine sormaz (e/h)'
    if ($kaydet -match '^e') {
        [Environment]::SetEnvironmentVariable('DISCORD_TOKEN', $token, 'User')
        Write-Host 'Kaydedildi. Silmek icin: .\baslat.ps1 -TokenSifirla'
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js bulunamadi. https://nodejs.org adresinden 20.18 veya ustunu kur.'
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'Paketler kuruluyor...'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install basarisiz oldu.' }
}

node index.js
