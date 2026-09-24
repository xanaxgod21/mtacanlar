# 2 haneli isim uretici + Discord webhook gonderici (PowerShell)
#
# NE YAPAR:
#   - Belirledigin karakterlerden tum 2 haneli kombinasyonlari uretir.
#   - Bunlari senin webhook'una mesaj olarak (parcalayip) gonderir.
#     Sen listeye elinle bakarsin.
#
# NE YAPMAZ:
#   - Discord'a "bu isim bos mu / alinabilir mi" diye SORMAZ (kontrol YOK).
#   - Arka planda calismaz; tek sefer calisir ve biter.
#   - Hicbir seyi otomatik almaz / snipe etmez.
#
# CALISTIRMA (PowerShell'de):
#   powershell -ExecutionPolicy Bypass -File .\isim_uretici.ps1
# veya dosyaya sag tik -> "PowerShell ile calistir"

# ----------------- AYARLAR -----------------
$Charset      = @([char[]](97..122)) + @([char[]](48..57))  # a-z + 0-9 (istersen degistir)
$PerMessage   = 50            # her mesajda kac isim
$DelaySeconds = 1             # mesajlar arasi bekleme (sn)
$ConfigName   = "config.txt"  # webhook adresinin kaydedildigi dosya
# -------------------------------------------

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$configPath = Join-Path $scriptDir $ConfigName
$tick       = [char]96  # ` karakteri (Discord'da kod formati icin)

function Get-Webhook {
    if (Test-Path $configPath) {
        $url = (Get-Content $configPath -Raw).Trim()
        if ($url) { return $url }
    }
    $url = (Read-Host "Discord webhook adresini yapistir").Trim()
    if ($url) {
        Set-Content -Path $configPath -Value $url -NoNewline -Encoding UTF8
        Write-Host "Kaydedildi -> $configPath"
    }
    return $url
}

function Send-Chunk($webhook, $content) {
    $body = @{ content = $content } | ConvertTo-Json -Compress
    for ($try = 0; $try -lt 5; $try++) {
        try {
            Invoke-RestMethod -Uri $webhook -Method Post -ContentType 'application/json' -Body $body -ErrorAction Stop | Out-Null
            return
        } catch {
            $code = 0
            try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            if ($code -eq 429) { Start-Sleep -Seconds 2; continue }  # rate limit -> bekle, tekrar dene
            throw
        }
    }
}

# --- 2 haneli tum kombinasyonlari uret ---
# (3 haneli istersen bir ic dongu daha ekle: foreach ($c in $Charset) { ... "$a$b$c" })
$names = New-Object System.Collections.Generic.List[string]
foreach ($a in $Charset) {
    foreach ($b in $Charset) {
        $names.Add("$a$b")
    }
}

$webhook = Get-Webhook
if (-not $webhook) { Write-Host "Webhook girilmedi, cikiliyor."; return }

Write-Host "$($names.Count) adet isim uretildi, webhook'a gonderiliyor..."
for ($i = 0; $i -lt $names.Count; $i += $PerMessage) {
    $end   = [Math]::Min($i + $PerMessage, $names.Count)
    $chunk = $names[$i..($end - 1)]
    $content = ($chunk | ForEach-Object { "discord.gg/$_" }) -join "`n"
    Send-Chunk $webhook $content
    Write-Host "  $end/$($names.Count) gonderildi"
    Start-Sleep -Seconds $DelaySeconds
}

Write-Host "Bitti."
Read-Host "Kapatmak icin Enter'a bas" | Out-Null
