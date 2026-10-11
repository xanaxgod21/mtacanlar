# Sunucu kopyalayıcı

Bir Discord sunucusundaki kategori, kanal, rol ve **mesajları** başka bir sunucuya taşır. Sunucu taşımak için yazıldı.

> **Uyarı:** Bu araç kullanıcı hesabının token'ıyla çalışır (selfbot). Bu Discord kurallarına aykırıdır ve hesabın kapatılabilir. Token'ını kimseyle paylaşma.

## Hızlı başlangıç (Windows)

Node.js 20.18 veya üstü kurulu olmalı: https://nodejs.org

`baslat.bat` dosyasına çift tıkla. Ya da PowerShell'de:

```powershell
cd sunucu_kopyala
.\baslat.ps1
```

- İlk çalıştırmada token'ı sorar. Yazarken ekranda görünmez.
- Kaydedilsin mi diye sorar. **e** dersen Windows kullanıcı ortam değişkenine (`DISCORD_TOKEN`) kaydeder ve bir daha sormaz.
- Paketler kurulu değilse `npm install` kendisi çalışır.
- Token'ı değiştirmek ya da silmek için: `.\baslat.ps1 -TokenSifirla`

"running scripts is disabled" hatası alırsan şöyle çalıştır:

```powershell
powershell -ExecutionPolicy Bypass -File .\baslat.ps1
```

Token'ı PowerShell'den elle de ayarlayabilirsin:

```powershell
$env:DISCORD_TOKEN = "TOKEN"                                                # sadece bu pencere için
[Environment]::SetEnvironmentVariable('DISCORD_TOKEN', 'TOKEN', 'User')     # kalıcı (yeni pencerelerde geçerli)
```

## Ayarlar

`index.js` dosyasının başındaki `AYARLAR` bölümünden değiştirebilirsin:

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `kaynakSunucu` | `1291429958895407248` | Kopyalanacak (eski) sunucu |
| `hedefSunucu` | `1555467184984293416` | Kopyalanacağı (yeni) sunucu |
| `rolleriKopyala` | `true` | Roller de kopyalansın mı |
| `mesajlariKopyala` | `true` | Mesajlar da taşınsın mı |
| `tarihEkle` | `true` | Her mesajın altına orijinal tarihini küçük yazıyla ekler |
| `bekleme` | `1500` | Kanal/rol oluşturma arası bekleme (ms) |
| `mesajBekleme` | `1200` | Mesajlar arası bekleme (ms) |

İki sunucu ID'si de doluysa program **çalıştırdığın an hiçbir şey sormadan** her şeyi taşır. İkisini de boş (`''`) bırakırsan sunucuları ve kanalları tek tek seçtirir. Sunucuları `KAYNAK_SUNUCU` ve `HEDEF_SUNUCU` ortam değişkenleriyle de verebilirsin.

## Ne yapar

1. **Roller:** isim, renk, ayrı gösterim, izinler ve sıra, ayrıca `@everyone` izinleri. Hedefte aynı isimde rol zaten varsa yenisini açmaz, onu kullanır. Bot rollerini atlar.
2. **Kategoriler ve kanallar:** yazı, ses, duyuru, sahne, forum ve medya kanalları. Konu, NSFW, yavaş mod, bitrate, kişi limiti, forum etiketleri ve kanal izinleri de gelir.
3. **Mesajlar:** her kanalı tek tek, eskiden yeniye taşır. Mesajlar webhook ile gönderilir, bu yüzden her mesaj **orijinal yazarın adı ve profil fotoğrafıyla** görünür. Dosyalar ve bot embed'leri de gelir.
   - Hiç kimse etiketlenmez. `@everyone`, rol ve kişi etiketleri yazı olarak kalır ama bildirim gitmez.
   - Hedef sunucunun yükleme sınırını (boost yoksa 10 MB) aşan dosyalar link olarak gönderilir.
   - Sistem mesajları (katıldı, sabitlendi vb.) atlanır.

## Yarıda kalırsa

İlerleme `ilerleme_<kaynak>_<hedef>.json` dosyasına kaydedilir. **Ctrl+C** ile durdurup sonra tekrar çalıştırırsan kanalları yeniden açmaz, mesajlara kaldığı yerden devam eder. Baştan başlamak istersen bu dosyayı sil.

## Taşınmayanlar

- Thread'ler, forum gönderileri, tepkiler (reaction), anketler, emojiler, çıkartmalar (sadece adı yazılır) ve üyeler.
- Hedef sunucuda Topluluk (Community) açık değilse duyuru, sahne ve forum kanalları normal yazı ya da ses kanalı olarak açılır.
- Hedefte hiçbir şey silinmez.

## Süre

Mesaj başına yaklaşık 1,2 saniye beklenir. 10.000 mesaj yaklaşık 3,5 saat sürer. Bekleme sürelerini düşürme: hızlı istek atmak hesabın kapatılma riskini ciddi şekilde artırır.

## Gerekli yetkiler

- Kaynak sunucuda: kanalları görme ve mesaj geçmişini okuma.
- Hedef sunucuda: **Kanalları Yönet**, **Rolleri Yönet** ve **Webhook'ları Yönet**. Sahibi olduğun için bunlar zaten var.
