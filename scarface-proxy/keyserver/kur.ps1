# Windows setup for the key server and the Discord bot.
# Double-click kur.bat, or run:  powershell -ExecutionPolicy Bypass -File .\kur.ps1
# Safe to run again: existing keys, the signing key and bot.env are kept unless you say otherwise.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$MinPython = [version]'3.10'
$BotPermissions = 18432  # Send Messages + Embed Links
$BuildSettingsFile = 'proxy-derleme-ayarlari.txt'

function Write-Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host "    $text" -ForegroundColor DarkGray }
function Write-Warn([string]$text) { Write-Host "    $text" -ForegroundColor Yellow }
function Stop-Setup([string]$text) { Write-Host ''; Write-Host "HATA: $text" -ForegroundColor Red; exit 1 }

function Read-YesNo([string]$question, [bool]$default = $true) {
    $hint = if ($default) { '(E/h)' } else { '(e/H)' }
    $answer = "$(Read-Host "    $question $hint")".Trim().ToLower()
    if (-not $answer) { return $default }
    return $answer -in @('e', 'evet', 'y', 'yes')
}

function Read-Text([string]$question, [string]$pattern, [string]$problem, [string]$default = '', [bool]$optional = $false) {
    while ($true) {
        $prompt = if ($default) { "    $question [$default]" } else { "    $question" }
        $answer = "$(Read-Host $prompt)".Trim()
        if (-not $answer) {
            if ($default) { return $default }
            if ($optional) { return '' }
            Write-Warn 'Boş bırakılamaz.'
            continue
        }
        if ($answer -match $pattern) { return $answer }
        Write-Warn $problem
    }
}

function Read-Token {
    while ($true) {
        $secure = Read-Host "    Bot token'ı (yapıştır, ekranda görünmez)" -AsSecureString
        $token = (New-Object System.Net.NetworkCredential('', $secure)).Password.Trim()
        if ($token -match '^[\w-]+\.[\w-]+\.[\w-]+$') { return $token }
        Write-Warn "Bu bir bot token'ına benzemiyor (3 parçalı, noktalı olmalı). Client Secret'ı değil, Bot sekmesindeki token'ı yapıştır."
    }
}

function Get-ClientId([string]$token) {
    # The first part of a bot token is the bot's id in base64.
    $part = $token.Split('.')[0].Replace('-', '+').Replace('_', '/')
    $part += '=' * ((4 - $part.Length % 4) % 4)
    try { $id = [Text.Encoding]::ASCII.GetString([Convert]::FromBase64String($part)) } catch { return $null }
    if ($id -match '^\d+$') { return $id }
    return $null
}

function Find-Python {
    $candidates = @(@('py', '-3'), @('python'), @('python3'))
    foreach ($dir in @("$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles")) {
        if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
        Get-ChildItem -LiteralPath $dir -Filter 'Python3*' -Directory | Sort-Object Name -Descending | ForEach-Object {
            $exe = Join-Path $_.FullName 'python.exe'
            if (Test-Path -LiteralPath $exe) { $candidates += , @($exe) }
        }
    }
    foreach ($candidate in $candidates) {
        $exe = $candidate[0]
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        $extra = @($candidate | Select-Object -Skip 1)
        try { $version = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null } catch { continue }
        if ($LASTEXITCODE -eq 0 -and $version -and [version]"$version".Trim() -ge $MinPython) { return , $candidate }
    }
    return $null
}

function Get-VenvPython {
    foreach ($path in @('.venv\Scripts\python.exe', '.venv/bin/python')) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

Write-Host ''
Write-Host '  Scarface Proxy key sunucusu + Discord bot kurulumu' -ForegroundColor White

foreach ($file in @('keyserver.py', 'keybot.py', 'discord_bot.py', 'discord_ui.py', 'requirements-bot.txt')) {
    if (-not (Test-Path -LiteralPath $file)) {
        Stop-Setup "$file bulunamadı. Bu scripti ScarfaceProxy\keyserver klasörünün içinden çalıştır."
    }
}

# --- Python ---------------------------------------------------------------------

Write-Step 'Python'
$python = Find-Python
if (-not $python) {
    Write-Warn "Python $MinPython veya üstü bulunamadı."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Stop-Setup ("Python'u https://www.python.org/downloads/ adresinden kur ('Add python.exe to PATH' kutusunu" +
            ' işaretle), sonra bu scripti tekrar çalıştır.')
    }
    if (-not (Read-YesNo 'Python 3.12 winget ile kurulsun mu?')) { Stop-Setup 'Python olmadan devam edilemez.' }
    winget install --exact --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $python = Find-Python
    if (-not $python) { Stop-Setup 'Python kuruldu ama bulunamadı. Bu pencereyi kapatıp scripti yeniden çalıştır.' }
}
Write-Ok "Bulundu: $($python -join ' ')"

# --- Virtual environment and packages ---------------------------------------------

Write-Step 'Paketler (.venv)'
if (-not (Get-VenvPython)) {
    $pythonArgs = @($python | Select-Object -Skip 1)
    & $python[0] @pythonArgs -m venv .venv
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'Sanal ortam (.venv) oluşturulamadı.' }
}
$venvPython = Get-VenvPython
& $venvPython -m pip install --disable-pip-version-check --quiet -r requirements-bot.txt
if ($LASTEXITCODE -ne 0) { Stop-Setup 'Paketler kurulamadı, internet bağlantını kontrol et.' }
Write-Ok 'discord.py ve cryptography kuruldu.'

# --- Key server -----------------------------------------------------------------

Write-Step 'Key sunucusu'
if (Test-Path -LiteralPath 'signing_key.pem') {
    Write-Ok 'İmza anahtarı (signing_key.pem) zaten var, dokunulmadı.'
    if (Test-Path -LiteralPath $BuildSettingsFile) { Write-Note "Proxy derleme ayarları: $BuildSettingsFile" }
}
else {
    Write-Note "Proxy'nin key kontrolü için bağlanacağı adres, ör. https://keys.siten.com"
    Write-Note 'Henüz yoksa boş bırak, proxy derlerken yazarsın.'
    $url = Read-Text 'Sunucu adresi' '^https?://[^/\s]+$' 'http:// veya https:// ile başlamalı, sonunda / ya da yol olmamalı.' -optional $true
    $initArgs = @('keyserver.py', 'init')
    if ($url) { $initArgs += @('--url', $url) }
    & $venvPython @initArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Setup 'Key sunucusu kurulamadı.' }
    $publicKey = "$(& $venvPython keyserver.py pubkey)".Trim()
    if (-not $url) { $url = '<sunucu-adresi>' }
    $buildSettings = @(
        'Scarface Proxy derleme ayarlari (key sistemi acik)',
        '',
        "Public key: $publicKey",
        '',
        "cmake -B build -DCMAKE_BUILD_TYPE=Release -DGTPROXY_LICENSE_SERVER=$url -DGTPROXY_LICENSE_PUBLIC_KEY=$publicKey",
        'cmake --build build --config Release'
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath $BuildSettingsFile -Value $buildSettings -Encoding ASCII
    Write-Ok 'keys.db ve signing_key.pem oluşturuldu.'
    Write-Ok "Proxy'yi derlerken kullanacağın komut $BuildSettingsFile dosyasına yazıldı."
    Write-Warn 'signing_key.pem dosyasını yedekle ve kimseyle paylaşma!'
}

# --- Firewall -------------------------------------------------------------------

if ($env:OS -eq 'Windows_NT') {
    Write-Step 'Güvenlik duvarı'
    $firewallRule = 'Scarface Key Sunucusu'
    $firewallPort = 8080  # keep in sync with $Port in baslat.ps1
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (Get-NetFirewallRule -DisplayName $firewallRule -ErrorAction SilentlyContinue) {
        Write-Ok "Port $firewallPort zaten açık."
    }
    elseif ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        New-NetFirewallRule -DisplayName $firewallRule -Direction Inbound -Protocol TCP -LocalPort $firewallPort -Action Allow | Out-Null
        Write-Ok "Port $firewallPort güvenlik duvarında açıldı."
    }
    else {
        Write-Warn "Port $firewallPort açılamadı: kur.bat'a sağ tıklayıp 'Yönetici olarak çalıştır' de."
    }
}

# --- Discord bot ------------------------------------------------------------------

Write-Step 'Discord bot ayarları'
$token = $null
$writeEnv = $true
if (Test-Path -LiteralPath 'bot.env') {
    $writeEnv = Read-YesNo 'bot.env zaten var. Baştan doldurulsun mu?' $false
}
if ($writeEnv) {
    Write-Note 'Token: https://discord.com/developers/applications > uygulaman > Bot > Reset Token'
    $token = Read-Token
    Write-Note "Sunucu ID: Discord'da Ayarlar > Gelişmiş > Geliştirici Modu'nu aç, sunucuna sağ tıkla > Sunucu ID'sini Kopyala"
    $guildId = Read-Text 'Sunucu ID' '^\d{15,21}$' 'Sadece rakamlardan oluşan bir ID olmalı.'
    Write-Note "Boş bırakırsan /key komutlarını ve yönetim panelini sadece Yönetici yetkisi olanlar kullanır."
    $roleIds = Read-Text "Yetkili rol ID'leri (virgülle ayır)" '^\d{15,21}(\s*,\s*\d{15,21})*$' "Rol ID'leri rakam olmalı, virgülle ayır." -optional $true
    $logChannelId = Read-Text 'Log kanalı ID (boş = log yok)' '^\d{15,21}$' 'Sadece rakamlardan oluşan bir ID olmalı.' -optional $true
    $cooldown = Read-Text 'Üyeler HWID sıfırlamayı kaç günde bir yapabilsin (0 = sınırsız)' '^\d{1,4}$' 'Bir sayı yaz.' -default '7'

    $envText = @(
        '# Discord bot settings, written by kur.ps1. Never share this file: it contains the bot token.',
        "DISCORD_TOKEN=$token",
        "GUILD_ID=$guildId",
        "ADMIN_ROLE_IDS=$($roleIds -replace '\s', '')",
        "LOG_CHANNEL_ID=$logChannelId",
        "HWID_RESET_COOLDOWN_DAYS=$cooldown"
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'bot.env'), $envText + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false))
    Write-Ok 'bot.env kaydedildi.'
}
else {
    $line = Get-Content -LiteralPath 'bot.env' | Where-Object { $_ -match '^\s*DISCORD_TOKEN\s*=' } | Select-Object -First 1
    if ($line) { $token = ($line -split '=', 2)[1].Trim().Trim('"', "'") }
}

# --- Done -----------------------------------------------------------------------

Write-Step 'Kurulum tamam!'
$clientId = if ($token) { Get-ClientId $token } else { $null }
if ($clientId) {
    Write-Host '    1. Botu sunucuna davet et (tarayıcıda aç):'
    Write-Host "       https://discord.com/oauth2/authorize?client_id=$clientId&scope=bot%20applications.commands&permissions=$BotPermissions" -ForegroundColor White
}
else {
    Write-Host "    1. Botu sunucuna davet et: Developer Portal > OAuth2 > URL Generator ('bot' + 'applications.commands')."
}
Write-Host '    2. baslat.bat ile key sunucusunu ve botu başlat.'
Write-Host "    3. Discord'da /key panel yaz; yönetim panelini yetkili kanalına, üye panelini herkese açık kanala kur."
Write-Host "    4. Müşterilere verdiğin exe bu sunucunun public key'iyle derlenmiş olmalı ($BuildSettingsFile)."
Write-Host ''

if (Read-YesNo 'Key sunucusu ve bot şimdi başlatılsın mı?') {
    & (Join-Path $PSScriptRoot 'baslat.ps1')
}
