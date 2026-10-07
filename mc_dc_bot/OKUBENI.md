# MC DC BOT (Yaren) — satış sürümü

Minecraft'ta odun kesen, taş kıran, tarla toplayan bir NPC (Yaren). Sen
**yönetim panelinden** süresini seçip key verirsin; müşteri keyini **key
kanalına** yazar, bot kontrol eder: doğruysa ona özel bir oda açar, yanlışsa
hata verir. Müşteri botunu o odadan yönetir. Süreler panelde canlı görünür,
süre bitince oda kendiliğinden silinir. Her müşterinin botu senin makinende
ayrı çalışır.

## Kurulum (satıcı, Windows)

1. **Node.js** kur: https://nodejs.org adresinden **LTS** sürümünü indir, hep
   "Next" diyerek kur.
2. Bu klasörde **`kur.bat`** dosyasına çift tıkla. Paketleri indirir,
   `ayarlar.json` dosyasını oluşturup Not Defteri'nde açar.
3. `ayarlar.json` içini doldur, kaydet:
   - `discord_token`: Developer Portal > uygulaman > Bot > **Reset Token**
   - `guild_id`: satış yaptığın Discord sunucusu
   - `log_kanal_id`: satışların, başlatmaların ve hataların düşeceği kanal (sadece sen gör)
   - `key_log_kanal_id`: **key logu** için ayrı kanal (sadece sen gör). Kim hangi
     keyi ne zaman üretti, kime verdi, kim ne zaman kullandı, kim iptal etti; lisans
     uzatma/bitirme/iptal ve süresi dolanlar buraya saatiyle düşer. Boş bırakırsan
     bunlar `log_kanal_id` kanalına gider. Ayrıca `veri/key_log.txt` dosyasına da yazılır.
   - `discord_sahip_id`: senin Discord ID'n (key üretir, her odayı görürsün)
   - `yetkili_rol_id`: ekibin varsa bu roldekiler de key verip lisans yönetebilir
     (boş = sadece sen). Komutları görmeleri için: Sunucu Ayarları > Entegrasyonlar >
     bot > komutlara bu rolü ekle.
   - `oda_silme_saat`: süre bitince müşterinin odası kaç saat sonra silinsin
     (0 = hemen silinir; örneğin 24 yazarsan oda 1 gün kilitli bekler, sonra silinir)
   - `anthropic_api_key`: yapay zeka için (boşsa yapay zeka kapalı)
   - `max_bot`: aynı anda en fazla kaç müşteri botu çalışsın (her müşteri 1 bot,
     her bot kendi sunucusuna girer). Ölçülen: bot başı ~140 MB RAM; boştayken
     neredeyse CPU yemez, görev yaparken (odun/taş) bot başı ~0,2 çekirdek.
     20 bot için en az **4 GB RAM, 4 çekirdekli** bir VPS al. Daha fazla müşteri
     için sayıyı artır, RAM'i ona göre büyüt (40 bot ≈ 6-8 GB).
   - `ai_gunluk_limit`: müşteri başı günlük yapay zeka isteği (0 = sınırsız).
     Yapay zeka parasını sen ödersin, bu sınır faturanı korur.
   - `musteri_kategori_id`: boş bırakırsan bot "Yaren Odaları" kategorisini açar.
4. Botu sunucuna **Yönetici** izniyle davet et (en kolayı). Developer Portal >
   OAuth2 > URL Generator: `bot` ve `applications.commands` kutularını, altta
   `Administrator` iznini seç, çıkan linki aç. Yönetici vermek istemezsen en az:
   Kanalları Gör, Mesaj Gönder, Mesaj Geçmişini Oku, Bağlantı Yerleştir, Tepki
   Ekle, Uygulama Komutlarını Kullan, Thread'lerde Mesaj Gönder, Thread Oluştur,
   Kanalları Yönet, Rolleri Yönet, **Mesajları Yönet** (key kanalına yazılan keyleri
   silmek için). Bot açılınca eksik izin varsa log kanalına yazar.
   Ayrıca Developer Portal > uygulaman > **Bot** sayfasında **Message Content
   Intent**i aç ve kaydet: müşteri keyini kanala yazarak girebilsin diye. Kapalıysa
   sadece "Key Gir" butonu çalışır (bot açılırken bunu kendisi anlar).
5. **`baslat.bat`** ile başlat (kapanırsa 10 sn sonra kendisi yeniden açılır).
   Bilgisayar/VPS kapanınca botlar da kapanır; açınca çalışan müşteri botları
   kendiliğinden geri gelir.
6. Müşterilerin göreceği bir kanal aç (örneğin `#key-gir`) ve orada `/panel-kur`
   yaz. Burası **key kanalı** olur: müşteri keyini buraya yazar (mesajı hemen
   silinir, kimse görmez) ya da "Key Gir" butonuna basar.
7. Kendi kanalında `/yonetim-kur` yaz: **yönetim paneli** kurulur. Herkese açık bir
   kanalda yazarsan bot sana (ve yetkililere) özel `#yaren-yonetim` kanalını açıp
   paneli oraya koyar.

Linux VPS'te: `npm install`, `cp ayarlar.ornek.json ayarlar.json`, `nano ayarlar.json`,
sonra sürekli çalışsın ve VPS yeniden açılınca kendiliğinden başlasın diye:
`sudo npm install -g pm2`, `pm2 start discordbot.js --name yaren`, `pm2 save`, `pm2 startup`.

**Güncellerken** yeni dosyaları üstüne kopyala ama `ayarlar.json` ve `veri/`
klasörüne dokunma (bütün müşteriler orada).

`ayarlar.json`, `anahtar.txt` ve `veri/` klasörü git'e girmez. `veri/lisanslar.json`
bütün müşterilerin: **yedeğini al**. Keyler orada sadece özet olarak durur;
bir key sadece üretildiği an bir kere gösterilir.

## Yönetim paneli

`/yonetim-kur` ile kurulan paneldeki tablo bütün aktif müşterileri ve **kalan
sürelerini** gösterir (Discord geri sayar, en önce biten en üstte, 🟢 = botu
çalışıyor). Biri key girince, süre uzayınca/bitince tablo kendiliğinden
güncellenir. Butonlar (sadece sen ve yetkili rolü basabilir):

| Buton | Ne yapar |
|---|---|
| 🎁 **Key Ver** | Kişiyi, süreyi (saat/gün/hafta/ay/süresiz) ve yapay zekayı seçersin; key ona **DM ile gider**. DM'i kapalıysa key sana gösterilir |
| 🔑 **Key Oluştur** | Süreyi ve kaç tane olduğunu seçersin, keyler sana gösterilir (bir kez), kendin dağıtırsın |
| ⏩ **Süre Uzat** | Kişiye süre ekler; süresi bitip odası silindiyse odası geri açılır |
| ⛔ **Lisans Bitir** | "Süresini şimdi bitir" (yeni key alırsa devam eder) ya da "İptal et" (bir daha key giremez). Onay sorar; botu durur, odası silinir, kişiye DM gider |
| 🔎 **Key Sorgula** | Bir keyin geçmişi: kim üretti, kime verildi, kim ne zaman kullandı / iptal etti |
| 🔍 **Kişi Sorgula** | Bir kişinin bitişi, yapay zekası, botu, odası, sahibi, kullandığı keyler |
| 📋 **Lisanslar** / 🗝️ **Keyler** | Bütün müşteriler / bütün keyler (boşta, kullanılmış, iptal) |
| 🗑️ **Key İptal** | Henüz kullanılmamış bir keyi iptal eder |
| 🔄 **Yenile** | Tabloyu hemen günceller |

## Key logu

`key_log_kanal_id` kanalına her olay ayrı bir kart olarak düşer (saat herkesin kendi
saatinde görünür):

| Kart | Ne zaman |
|---|---|
| 🆕 Key üretildi | Key Oluştur: kim, kaç tane, süre, keylerin önekleri |
| 🎁 Key verildi | Key Ver: veren, alan, önek, DM gitti mi |
| 🔑 Key kullanıldı | Kim kullandı, hangi key, nereden (kanal/buton/komut), yeni bitiş, keyi kimin ne zaman ürettiği. Key başkasına verilmişse ⚠️ uyarısı |
| ⚠️ Geçersiz key denemesi | Başkasının kullandığı ya da iptal edilmiş bir keyi deneyen |
| ⚠️ Çok fazla yanlış key | 10 dakikada 5 yanlış key deneyen (10 dk bekletilir) |
| 🗑️ Key iptal edildi | İptal eden, hangi key, kime verilmişti |
| ⏩ ⏹️ ⛔ ⌛ | Lisans uzatıldı / bitirildi / iptal edildi / süresi doldu |

Güvenlik için keyin **tamamı loga yazılmaz**, sadece öneki (`YAREN-AB12…`).
Logu gören biri keyi kullanamaz; öneki `/key-sorgu` ve Key İptal'de kullanırsın.

## Satıcı (ve yetkili) komutları

Panelin yaptığı her şey komutla da yapılır. Süreyi `birim` (saat / gün / hafta /
ay / süresiz) ve `miktar` ile seçersin. **Süre, müşteri keyi girdiği an
başlar**; key beklerken süre yanmaz.

| Komut | Ne yapar |
|---|---|
| `/key-olustur birim:gün miktar:30 adet:5 ai:true` | Key üretir, sana gösterir (bir kez). `ai:false` = yapay zekasız |
| `/key-ver kullanici:@ali birim:hafta miktar:2` | Key üretip Ali'ye **DM ile gönderir**. Ali keyi girince odası açılır. DM'i kapalıysa key sana gösterilir |
| `/key-liste` | Boşta / kullanılmış / iptal keyler ve süreleri |
| `/key-sorgu key:YAREN-XXXX` | Keyin geçmişi: üreten, verildiği kişi, kullanan, iptal eden ve saatleri |
| `/key-iptal key:YAREN-XXXX` | Satılmamış bir keyi iptal eder |
| `/lisanslar` | Müşteriler, kalan süreleri (geri sayımlı), çalışan botlar |
| `/lisans-uzat kullanici:@ali birim:gün miktar:7` | Süre ekler; süresi bitip odası silindiyse odası geri açılır |
| `/lisans-bitir kullanici:@ali` | Süresini hemen bitirir: botu durur, odası silinir. Yeni key girerse devam eder |
| `/lisans-iptal kullanici:@ali` | Botunu durdurur, odasını siler, bir daha key giremez (kaldırmak için `/lisans-uzat`) |
| `/panel-kur` | Bulunduğun kanalı key kanalı yapar ("Key Gir" butonlu panel). Kanala yazılan her mesaj silinir; senin ve yetkililerin key olmayan mesajları (duyuru) kalır |
| `/panel-kaldir` | Bulunduğun kanal artık key kanalı olmaz (yanlış kanalda kurduysan) |
| `/yonetim-kur` | Butonlu yönetim panelini kurar |

Müşterinin odasında sen de onun komutlarını kullanabilirsin (destek için).

## Müşteri akışı

1. Keyini **key kanalına yazar** (ya da "Key Gir" butonu / `/key-gir`). Bot keyi
   kontrol eder: yanlışsa, kullanılmışsa ya da iptal edilmişse hata verir ve oda
   açılmaz; doğruysa ona özel oda açılır ve süresi o an başlar. Kanaldaki cevap
   birkaç saniye sonra kendiliğinden silinir, oda linki ona DM ile de gider.
   10 dakikada 5 yanlış key deneyen 10 dakika bekletilir. Bot kapalıyken
   kanala yazılan keyler bot açılınca sahiplerine işlenir (başkası kapamaz).
2. Odasında `/baslat host:oyna.sunucu.com` yazar, bot sunucuya girer (sonraki
   seferlerde sadece `/baslat`).
3. Bot girince odasında `/sahip ad:OyundakiAdı` yazar (örn. `/sahip ad:xdarkoum`).
   Bot artık oyunda **sadece o oyuncunun** yazdıklarını yapar: `!odun` `!tas`
   `!farm` `!gel` `!dur` `!durum`, ya da "Yaren biraz odun lazım" gibi konuşur.
   Büyük/küçük harf fark etmez, istediği zaman `/sahip` ile değiştirir; boş
   `/sahip` şu anki sahibi gösterir. Sahip yazılmadıysa bot kimseyi dinlemez.
4. `/gorev` `/durum` `/soyle` `/sandik` `/durdur` odada; `/bilgi` ve `/odam` her yerde.
5. Kalan süreyi odada, `/bilgi`'de ve oda başlığında görür (geri sayım). Bitişe
   1 gün ve 1 saat kala uyarılır.
6. Süre bitince botu durur, **odası silinir** ve DM ile haber verilir. Yeni key
   girerse odası yeniden açılır; botunun ayarları, sandıkları, deneyimleri kaybolmaz.
   Süresi bitmeden yeni key girerse süre kalan sürenin üstüne eklenir.

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
- Süresi biten ve iptal edilen müşterilerin odaları silinir (`oda_silme_saat`).
  Discord sunucusu en fazla 500 kanal alır; bu sayede dolmaz.
- Her müşteri botu en fazla 384 MB bellek kullanabilir; aşan sadece kendisi kapanır.
- Hataların tam dökümü ve yapay zeka faturası hataları sadece senin log
  kanalına düşer, müşteri görmez.
- Microsoft (premium) girişi her müşterinin kendi klasöründe saklanır. Giriş
  kodu müşterinin odasına düşer.
- Birçok Minecraft sunucusu botları yasaklar. Müşterilerine kendi
  sunucularında ya da botlara izin veren sunucularda kullanmalarını söyle.
- `ses.py` (sesli komut) sadece botu kendi bilgisayarında elle çalıştıran
  için geçerli (`node gorevbot.js`); satış sürümünde kullanılmaz.
