# MC DC BOT (Yaren) — satış sürümü

Minecraft'ta odun kesen, taş kıran, tarla toplayan bir NPC (Yaren). Sen key
satarsın, müşteri keyi Discord'da girer, ona özel bir oda açılır ve botunu
oradan yönetir. Her müşterinin botu senin makinende ayrı çalışır.

## Kurulum (satıcı)

1. Node.js 18 veya üstü kur. Bu klasörde: `npm install`
2. `ayarlar.ornek.json` dosyasını **`ayarlar.json`** adıyla kopyala ve doldur:
   - `discord_token`: Developer Portal > Bot > Reset Token
   - `guild_id`: satış yaptığın Discord sunucusu
   - `log_kanal_id`: satışların, başlatmaların ve hataların düşeceği kanal (sadece sen gör)
   - `discord_sahip_id`: senin Discord ID'n (key üretir, her odayı görürsün)
   - `anthropic_api_key`: yapay zeka için (boşsa yapay zeka kapalı)
   - `max_bot`: aynı anda en fazla kaç müşteri botu çalışsın. Her bot yaklaşık
     150 MB RAM yer, 20 bot için en az 4 GB RAM'li bir VPS al.
   - `ai_gunluk_limit`: müşteri başı günlük yapay zeka isteği (0 = sınırsız).
     Yapay zeka parasını sen ödersin, bu sınır faturanı korur.
   - `musteri_kategori_id`: boş bırakırsan bot "Yaren Odaları" kategorisini açar.
3. Botu sunucuna **Yönetici** izniyle davet et (en kolayı). Vermek istemezsen
   en az şunlar lazım: Kanalları Gör, Mesaj Gönder, Mesaj Geçmişini Oku,
   Bağlantı Yerleştir, Tepki Ekle, Uygulama Komutlarını Kullan, Thread'lerde
   Mesaj Gönder, Thread Oluştur, Kanalları Yönet, Rolleri Yönet. Bot açılınca
   eksik izin varsa log kanalına yazar.
4. `node discordbot.js` (ya da `npm start`). Bilgisayar/VPS kapanınca botlar da
   kapanır; açınca çalışan müşteri botları kendiliğinden geri gelir.
5. Müşterilerin göreceği bir kanalda `/panel-kur` yaz: "Key Gir" butonlu panel.

`ayarlar.json`, `anahtar.txt` ve `veri/` klasörü git'e girmez. `veri/lisanslar.json`
bütün müşterilerin: **yedeğini al**. Keyler orada sadece özet olarak durur;
bir key sadece üretildiği an bir kere gösterilir.

## Satıcı komutları (sadece sen)

| Komut | Ne yapar |
|---|---|
| `/key-olustur gun:30 adet:5 ai:true` | Key üretir (`gun:0` = süresiz, `ai:false` = yapay zekasız) |
| `/key-liste` | Boşta / kullanılmış / iptal keyler |
| `/key-iptal key:YAREN-XXXX` | Satılmamış bir keyi iptal eder |
| `/lisanslar` | Müşteriler, bitiş tarihleri, çalışan botlar |
| `/lisans-uzat kullanici:@ali gun:7` | Süre ekler (`gun:0` = süresiz yapar) |
| `/lisans-iptal kullanici:@ali` | Botunu durdurur, odasını kilitler, yeni key giremez |
| `/panel-kur` | Bulunduğun kanala satış panelini koyar |

Müşterinin odasında sen de onun komutlarını kullanabilirsin (destek için).

## Müşteri akışı

1. Panelde **Key Gir** (ya da `/key-gir`), keyi yazar. Ona özel oda açılır.
2. Odasında: `/baslat host:oyna.sunucu.com sahip:OyunAdı` (sonraki seferlerde
   sadece `/baslat`). `sahip`: botun oyunda sadece onun komutlarını dinlemesi için.
3. `/gorev` `/durum` `/soyle` `/durdur` odada; `/bilgi` ve `/odam` her yerde.
4. Süre bitmeden 1 gün önce uyarılır. Bitince botu durur, odası kilitlenir.
   Yeni key girerse süresi kaldığı yerden uzar, oda tekrar açılır.

## Oyun içi: odun, balta ve sandıklar

- **Odun:** kütükleri baltayla keser, ağacın yapraklarını **elle** kırar (balta
  yaprakta boşuna aşınmaz), düşen fidanları toplar ve diker. Sadece kestiği
  ağacın doğal yapraklarına dokunur; uzanamadığı yapraklar kendiliğinden dökülür.
- **Alet bakımı:** baltanın (kazmanın) 10'dan az dayanıklılığı kalınca
  envanterdeki sağlam olanına geçer; yoksa gösterilen sandıklardan alır. Hiç
  yoksa sohbetten haber verir ve eskisiyle devam eder. Büyülü aleti kırılmasın
  diye kullanmaz.
- **Sandıklar:** oyunda sandığın dibinde dur ve `!sandik ekle` yaz (ya da
  `!sandik ekle x y z`, Discord'da `/sandik`). En fazla 10 sandık; sunucu başına
  ayrı kaydedilir. `!sandik liste`, `!sandik sil`, `!sandik temizle`.
- **Boşaltma:** envanter yarı dolunca (36 yuvanın 18'i) topladıklarını en yakın
  sandıktan başlayarak bırakır ve işine geri döner. `!bosalt` ile hemen boşaltır.
  Yanında kalanlar: sağlam en iyi 2 aleti, 16 fidan, 32 tohum, 32 iskele bloğu
  (toprak/cobblestone), 16 yemek. Kırılmak üzere aletler (sağlamı varsa) tamir
  için sandığa gider. Zırh, yay gibi eşyalara dokunmaz.

## Bilmen gerekenler

- Botlar senin makinende çalışır. Müşteriler `localhost` veya yerel ağ
  adresine bağlatamaz, sadece internetteki sunuculara.
- Bot düşerse (sunucu kapandı, atıldı) 30 sn arayla 3 kez tekrar bağlanır.
- Yapay zekanın kendi süresi vardır: sadece `ai:true` keyler onu uzatır.
  Süresi dolunca bot yapay zekasız devam eder.
- Süresi dolalı / iptal edileli 14 gün olan müşterilerin odaları silinir
  (Discord sunucusu en fazla 500 kanal alır). Yeni key girerlerse oda geri gelir.
- Her müşteri botu en fazla 384 MB bellek kullanabilir; aşan sadece kendisi kapanır.
- Hataların tam dökümü ve yapay zeka faturası hataları sadece senin log
  kanalına düşer, müşteri görmez.
- Microsoft (premium) girişi her müşterinin kendi klasöründe saklanır. Giriş
  kodu müşterinin odasına düşer.
- Birçok Minecraft sunucusu botları yasaklar. Müşterilerine kendi
  sunucularında ya da botlara izin veren sunucularda kullanmalarını söyle.
- `ses.py` (sesli komut) sadece botu kendi bilgisayarında elle çalıştıran
  için geçerli (`node gorevbot.js`); satış sürümünde kullanılmaz.
