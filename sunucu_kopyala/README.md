# Sunucu kopyalayıcı

Bir Discord sunucusundaki seçtiğin kategori ve kanalları, istersen rollerle birlikte başka bir sunucuya kopyalar. Sunucu taşımak için yazıldı.

> **Uyarı:** Bu araç kullanıcı hesabının token'ıyla çalışır (selfbot). Bu Discord kurallarına aykırıdır ve hesabın kapatılabilir. Token'ını kimseyle paylaşma.

## Kurulum

Node.js 20.18 veya üstü gerekiyor.

```sh
cd sunucu_kopyala
npm install
npm start
```

Token'ı her seferinde sormasın istersen ortam değişkeni olarak ver:

```sh
DISCORD_TOKEN=... npm start                  # Linux / macOS
$env:DISCORD_TOKEN="..."; npm start          # PowerShell
```

Token hiçbir dosyaya kaydedilmez.

## Kullanım

1. Hesabının bulunduğu sunucular listelenir. **Kaynak** ve **hedef** sunucunun numarasını girersin.
2. Kaynaktaki kategori ve kanallar numaralı olarak listelenir. Kopyalanacakları seçersin: `1,3,5-8` ya da `hepsi`. Bir kategoriyi seçersen altındaki bütün kanallar da gelir.
3. Rollerin de kopyalanıp kopyalanmayacağını seçersin.
4. Özeti onaylayınca kopyalama başlar.

## Neler kopyalanır

- **Kategoriler ve kanallar:** yazı, ses, duyuru, sahne, forum, medya.
- **Kanal ayarları:** konu, NSFW, yavaş mod, bitrate (hedefin boost seviyesine göre sınırlanır), kişi limiti, forum etiketleri.
- **Kanal izinleri:** roller hedefteki karşılıklarıyla eşlenir. Kişiye özel izinler, o kişi hedef sunucudaysa korunur.
- **Roller (isteğe bağlı):** isim, renk, ayrı gösterim, bahsedilebilirlik, izinler ve sıra, ayrıca `@everyone` izinleri. Hedefte aynı isimde bir rol zaten varsa yenisi açılmaz, o kullanılır.

## Neler kopyalanmaz

- Mesajlar, webhook'lar, emojiler, çıkartmalar, üyeler ve bot rolleri.
- Hedef sunucu Topluluk (Community) özelliği açık değilse duyuru, sahne ve forum kanalları açılamaz. Bunlar normal yazı ya da ses kanalı olarak oluşturulur.
- Hedefte hiçbir şey silinmez. Önce hedefi boşaltmak istersen bunu elle yap.

## Gerekli yetkiler

Hedef sunucuda hesabının **Kanalları Yönet** ve **Rolleri Yönet** yetkileri olmalı. Sunucu senin olduğu için sahip olarak bunlar zaten var.

İşlemler arasında 1,5 saniye beklenir (`index.js` içinde `DELAY_MS`). Çok sayıda kanal varsa biraz sürebilir. Hızlı istek atmak hesabın kapatılma riskini artırdığı için bu süreyi düşürme.
