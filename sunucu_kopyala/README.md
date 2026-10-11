# Sunucu kopyalayıcı

Bir Discord sunucusundaki kategori, kanal, rol ve **mesajları** başka bir sunucuya taşır. Sunucu taşımak için yazıldı.

> **Uyarı:** Bu araç kullanıcı hesabının token'ıyla çalışır (selfbot). Bu Discord kurallarına aykırıdır ve hesabın kapatılabilir. Token'ını kimseyle paylaşma.

## Hızlı başlangıç (Windows)

Node.js 20.18 veya üstü kurulu olmalı: https://nodejs.org

PowerShell'de klasöre girip çalıştır:

```powershell
cd sunucu_kopyala
powershell -ExecutionPolicy Bypass -File .\baslat.ps1
```

Parametresiz çalıştırırsan sırayla şunları sorar:

1. Token. İlk seferde sorar, kaydedersen bir daha sormaz.
2. Çekilecek (eski) sunucu ID'si.
3. Aktarılacak (yeni) sunucu ID'si.
4. Roller kopyalansın mı, mesajlar aktarılsın mı, mesajlara tarih eklensin mi.

Sunucu sorularında **Enter**'a basarsan son kullandığın ID geçerli olur. **L** yazarsan program sunucuları ve kanalları listeleyip seçtirir.

### Her şeyi komutla vermek

Böyle çalıştırırsan hiçbir şey sormadan başlar:

```powershell
.\baslat.ps1 -Kaynak 1291429958895407248 -Hedef 1555467184984293416
```

| Parametre | Ne yapar |
|---|---|
| `-Kaynak <ID>` | Çekilecek (eski) sunucu |
| `-Hedef <ID>` | Aktarılacak (yeni) sunucu |
| `-RolYok` | Rolleri kopyalama |
| `-MesajYok` | Mesajları aktarma, sadece kanal ve rol |
| `-TarihYok` | Mesajların altına orijinal tarihi ekleme |
| `-Liste` | Sunucuları ve kanalları programda listeden seç |
| `-TokenSifirla` | Kayıtlı token'ı silip yenisini sor |

Örnekler:

```powershell
.\baslat.ps1 -Kaynak 111... -Hedef 222... -MesajYok      # sadece kanallar ve roller
.\baslat.ps1 -Kaynak 111... -Hedef 222... -RolYok         # roller hariç her şey
.\baslat.ps1 -Liste                                       # belirli kanalları seçmek için
```

Sunucu ID'sini almak için Discord'da Ayarlar > Gelişmiş > Geliştirici Modu'nu aç. Sonra sunucuya sağ tıklayıp **Sunucu ID'sini Kopyala**'ya bas.

`baslat.bat` dosyasına çift tıklarsan da aynısı olur, soruları sorar.

### Token'ı elle ayarlamak

```powershell
$env:DISCORD_TOKEN = "TOKEN"                                                # sadece bu pencere için
[Environment]::SetEnvironmentVariable('DISCORD_TOKEN', 'TOKEN', 'User')     # kalıcı
```

## Ayarlar

`baslat.ps1` ile verdiğin değerler bu ayarların yerine geçer. Aşağıdakiler `node index.js` ile doğrudan çalıştırdığında geçerli olan varsayılanlar. `index.js` dosyasının başındaki `AYARLAR` bölümünden değiştirebilirsin.

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `kaynakSunucu` | `1291429958895407248` | Çekilecek (eski) sunucu |
| `hedefSunucu` | `1555467184984293416` | Aktarılacak (yeni) sunucu |
| `rolleriKopyala` | `true` | Roller de kopyalansın mı |
| `mesajlariKopyala` | `true` | Mesajlar da taşınsın mı |
| `tarihEkle` | `true` | Her mesajın altına orijinal tarihini küçük yazıyla ekler |
| `bekleme` | `1500` | Kanal/rol oluşturma arası bekleme (ms) |
| `mesajBekleme` | `1200` | Mesajlar arası bekleme (ms) |

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
