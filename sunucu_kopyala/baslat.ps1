# Sunucu kopyalayiciyi baslatir.
#
# Parametresiz calistirirsan her seyi sorar:
#   .\baslat.ps1
#
# Ya da hepsini komutla verirsin, hicbir sey sormaz:
#   .\baslat.ps1 -Kaynak 1291429958895407248 -Hedef 1555467184984293416
#   .\baslat.ps1 -Kaynak 111 -Hedef 222 -MesajYok        # sadece kanal + rol
#   .\baslat.ps1 -Kaynak 111 -Hedef 222 -RolYok -TarihYok
#   .\baslat.ps1 -Kaynak 111 -Hedef 222 -Limit 500         # 500'den fazla mesaji olan kanallari atla (0 = atlama)
#   .\baslat.ps1 -Kaynak 111 -Hedef 222 -Paralel 5         # ayni anda 5 kanal
#   .\baslat.ps1 -Kaynak 111 -Hedef 222 -BirlestirmeYok    # ardisik mesajlari birlestirme
#   .\baslat.ps1 -Liste                                  # sunucu/kanal listeden secilir
#   .\baslat.ps1 -TokenSifirla                           # kayitli token'i sil, yenisini sor
#
# Token ilk calistirmada sorulur, istersen Windows kullanici ortam
# degiskenine (DISCORD_TOKEN) kaydedilir. Son kullanilan sunucu ID'leri de
# hatirlanir; bir dahaki sefere Enter'a basman yeterli.
#
# "running scripts is disabled" hatasi alirsan:
#   powershell -ExecutionPolicy Bypass -File .\baslat.ps1

param(
    [string]$Kaynak,
    [string]$Hedef,
    [switch]$RolYok,
    [switch]$MesajYok,
    [switch]$TarihYok,
    [int]$Limit = -1,
    [int]$Paralel = 3,
    [switch]$BirlestirmeYok,
    [switch]$Liste,
    [switch]$TokenSifirla
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Get-UserVar($name) { [Environment]::GetEnvironmentVariable($name, 'User') }
function Set-UserVar($name, $value) { [Environment]::SetEnvironmentVariable($name, $value, 'User') }

function Read-YesNo($soru, [bool]$varsayilan = $true) {
    $ipucu = if ($varsayilan) { 'E/h' } else { 'e/H' }
    $cevap = Read-Host "$soru ($ipucu)"
    if (-not $cevap) { return $varsayilan }
    return $cevap -match '^e'
}

# Sunucu ID'si sorar. Enter = son kullanilan, L = programda listeden sec.
function Read-GuildId($soru, $son) {
    while ($true) {
        $ipucu = if ($son) { " [Enter = $son, L = listeden sec]" } else { ' [L = listeden sec]' }
        $cevap = (Read-Host "$soru$ipucu").Trim()
        if (-not $cevap -and $son) { return $son }
        if ($cevap -match '^[lL]') { return '' }
        if ($cevap -match '^\d{17,20}$') { return $cevap }
        Write-Host 'Gecersiz ID. Sunucu ID 17-20 haneli bir sayi olmali (sunucuya sag tik > Sunucu ID''sini Kopyala).' -ForegroundColor Yellow
    }
}

function Test-GuildId($deger, $ad) {
    if ($deger -and $deger -notmatch '^\d{17,20}$') { throw "$ad gecersiz: $deger (17-20 haneli sayi olmali)" }
}

# ----------------- token -----------------

if ($TokenSifirla) {
    Set-UserVar 'DISCORD_TOKEN' $null
    $env:DISCORD_TOKEN = $null
    Write-Host 'Kayitli token silindi.'
}

if (-not $env:DISCORD_TOKEN) { $env:DISCORD_TOKEN = Get-UserVar 'DISCORD_TOKEN' }

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

    if (Read-YesNo 'Token bu bilgisayara kaydedilsin mi? Bir dahakine sormaz' $false) {
        Set-UserVar 'DISCORD_TOKEN' $token
        Write-Host 'Kaydedildi. Silmek icin: .\baslat.ps1 -TokenSifirla'
    }
}

# ----------------- sunucular ve secenekler -----------------

Test-GuildId $Kaynak 'Kaynak'
Test-GuildId $Hedef 'Hedef'

$sonKaynak = Get-UserVar 'SUNUCU_KOPYALA_KAYNAK'
$sonHedef = Get-UserVar 'SUNUCU_KOPYALA_HEDEF'
if (-not $sonKaynak) { $sonKaynak = '1291429958895407248' }
if (-not $sonHedef) { $sonHedef = '1555467184984293416' }

$roller = -not $RolYok
$mesajlar = -not $MesajYok
$tarih = -not $TarihYok

if ($Liste) {
    # Program sunuculari ve kanallari kendisi listeleyip sorar.
    $Kaynak = ''
    $Hedef = ''
} elseif (-not $Kaynak -or -not $Hedef) {
    Write-Host ''
    if (-not $Kaynak) { $Kaynak = Read-GuildId 'Cekilecek (eski) sunucu ID' $sonKaynak }
    while ($Kaynak -and -not $Hedef) {
        $Hedef = Read-GuildId 'Aktarilacak (yeni) sunucu ID' $sonHedef
        if (-not $Hedef) { $Kaynak = ''; break }
        if ($Hedef -eq $Kaynak) {
            Write-Host 'Cekilecek sunucuyla ayni olamaz.' -ForegroundColor Yellow
            $Hedef = ''
        }
    }

    # Listeden secimde roller/mesajlar sorusunu program kendisi sorar.
    if ($Kaynak -and $Hedef) {
        if (-not $RolYok) { $roller = Read-YesNo 'Roller kopyalansin mi?' }
        if (-not $MesajYok) { $mesajlar = Read-YesNo 'Mesajlar aktarilsin mi?' }
        if ($mesajlar -and -not $TarihYok) { $tarih = Read-YesNo 'Mesajlarin altina orijinal tarihi eklensin mi?' }
        while ($mesajlar -and $Limit -lt 0) {
            $cevap = (Read-Host 'Kac mesajdan fazlasi olan kanallar atlansin? [Enter = 200, 0 = hicbirini atlama]').Trim()
            if (-not $cevap) { $Limit = 200 }
            elseif ($cevap -match '^\d+$') { $Limit = [int]$cevap }
            else { Write-Host 'Sayi girmelisin.' -ForegroundColor Yellow }
        }
    }
}

if (-not $Kaynak -or -not $Hedef) {
    $Kaynak = ''
    $Hedef = ''
} else {
    if ($Kaynak -eq $Hedef) { throw 'Cekilecek ve aktarilacak sunucu ayni olamaz.' }
    Set-UserVar 'SUNUCU_KOPYALA_KAYNAK' $Kaynak
    Set-UserVar 'SUNUCU_KOPYALA_HEDEF' $Hedef

    $eh = { param($b) if ($b) { 'evet' } else { 'hayir' } }
    Write-Host ''
    Write-Host "Cekilecek sunucu : $Kaynak"
    Write-Host "Aktarilacak sunucu: $Hedef"
    Write-Host "Roller: $(& $eh $roller)   Mesajlar: $(& $eh $mesajlar)   Tarih: $(& $eh $tarih)"
}

# PowerShell'de bos deger atamak degiskeni siler; liste modu ayri bayrakla bildirilir.
$env:KAYNAK_SUNUCU = $Kaynak
$env:HEDEF_SUNUCU = $Hedef
$env:SUNUCU_LISTE = if ($Kaynak) { $null } else { '1' }
$env:ROLLERI_KOPYALA = if ($roller) { '1' } else { '0' }
$env:MESAJLARI_KOPYALA = if ($mesajlar) { '1' } else { '0' }
$env:TARIH_EKLE = if ($tarih) { '1' } else { '0' }
if ($Limit -lt 0) { $Limit = 200 }
if ($Paralel -lt 1) { $Paralel = 1 }
$env:MESAJ_LIMITI = "$Limit"
$env:PARALEL_KANAL = "$Paralel"
$env:MESAJ_BIRLESTIR = if ($BirlestirmeYok) { '0' } else { '1' }

# ----------------- calistir -----------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js bulunamadi. https://nodejs.org adresinden 20.18 veya ustunu kur.'
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'Paketler kuruluyor...'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install basarisiz oldu.' }
}

node index.js
