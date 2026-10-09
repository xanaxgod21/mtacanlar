# MC DC BOT (Yaren) — satış sürümü

Minecraft'ta odun kesen, taş kıran, tarla toplayan bir NPC (Yaren). Sen
**yönetim panelinden** süresini seçip key verirsin; müşteri keyini **key
kanalına** yazar, bot kontrol eder: doğruysa ona özel bir oda açar, yanlışsa
hata verir. Müşteri botunu o odadan yönetir. Süreler panelde canlı görünür,
süre bitince oda kendiliğinden silinir. Her müşterinin botu senin makinende
ayrı çalışır.

## Yenilikler (son sürüm)

- **Tek komutla kurulum:** dosya düzenlemek yok. `baslat.bat` açılınca token'ı
  sorar (yapıştır, Enter), botu sunucuna ekleme linkini açar; sunucunda `/kur`
  yazınca bot log kanallarını, Yaren Log / Yaren Müşteri rollerini, key
  kanalını ve yönetim panelini kendisi açar, ayarları kaydeder.
- **Sunucuya otomatik giriş:** sunucu girişte `/register` ya da `/login` isterse
  bot kendisi yazar. Müşteri şifreyi bir kere odasında `/giris sifre:...` ile verir.
  Şifre yanlışsa bot döngüye girmez, odaya "şifre yanlış" yazar. Şifre hiçbir
  log'a, kanala ve yedeğe yazılmaz; müşterinin klasöründe sunucu başına durur.
- **Sohbet köprüsü:** oyun sohbeti müşterinin odasına düşer (`/sohbet` ile
  kapatır), müşteri `/yaz mesaj:...` ile odadan oyuna yazar (`/komut` da olur).
- **Otomatik yemek:** bot acıkınca yanındaki en iyi yemeği yer (çürük et, örümcek
  gözü gibi kötüleri ve altın elmayı yemez). Yemek yoksa oyunda söyler.
- **AFK koruması:** bot boştayken arada etrafa bakar, zıplar, kolunu sallar;
  sunucu "AFK" diye atmaz.
- **Müşteri rolü (`musteri_rol_id`):** key giren herkese otomatik verilir, süresi
  bitince / iptal edilince alınır. Müşterilere özel kanalları bu rolle açarsın.
- **Günlük yedek:** bütün müşteri ve key kayıtları her gün `veri/yedekler`
  klasörüne kopyalanır (son 14 gün) ve sana DM ile gelir. `/yedek` ile istediğin an.
- **Key logu ve `/key-sorgu`:** kim hangi keyi ne zaman üretti / kullandı (aşağıda).
- **`/sahip`:** müşteri bot girdikten sonra oyundaki adını yazar, bot sadece onu dinler.
- **Yönetim paneli ve key kanalı:** butonlarla key ver, süre uzat, bitir; müşteri
  keyini kanala yazar, bot kontrol edip odasını açar.

## Kurulum (satıcı, Windows)

Adım adım anlatım: **`KURULUM.txt`**. Kısaca, dosya düzenlemek yok:

1. Developer Portal'da Yaren için **yeni bir uygulama** aç, Bot > **Reset Token**
   ile token'ı kopyala. Başka bir bot programının token'ını kullanma: Yaren
   açılırken sunucudaki slash komutlarını kendi listesiyle değiştirir.
2. **Node.js LTS** kur (https://nodejs.org), sonra **`baslat.bat`**'a çift tıkla.
   İlk açılışta paketleri kendisi indirir (`kur.bat` da aynısını yapar).
3. **Token'ı sorar:** Windows'ta küçük bir pencere açılır, token'ı kutuya yapıştırıp
   Tamam'a basarsın. Pencere çıkmazsa siyah pencerede `Token:` sorulur; kopyaladıktan
   sonra sadece Enter'a basmak yeter (panodan alır), ya da yapıştırıp Enter (her harf
   `*` görünür). Son çare: klasöre `token.txt` koyup içine token'ı yaz (okunur, silinir).
   Bot token'ı Discord'a sorup dener, doğruysa `ayarlar.json`'a kaydeder. Yanlışsa
   tekrar sorar.
   Token sonradan sıfırlanırsa (Reset Token) bir sonraki açılışta yenisini sorar.
   Message Content Intent kapalıysa bot onu Discord'un izin verdiği yoldan
   kendisi açmayı dener (100'den az sunucudaki botlarda olur).
4. Bot **davet linkini** yazar ve tarayıcıda açar (Yönetici izniyle). Sunucunu
   seç, Yetkilendir.
5. Sunucunda herhangi bir kanala **`/kur`** yaz (sunucu sahibi ya da Yönetici).
   Bot kendisi açar ve `ayarlar.json`'a yazar:
   - **Yaren Yönetim** kategorisi (herkese kapalı): `#yaren-log`,
     `#yaren-key-log` ve sadece senin gördüğün `#yaren-yonetim` (yönetim paneli)
   - herkese açık **`#key-gir`** ve içinde "Key Gir" paneli
   - **@Yaren Log** rolü: sana verilir; kime verirsen log kanallarını görür
     (sadece okur, key veremez, paneli görmez)
   - **@Yaren Müşteri** rolü: key girene verilir, süresi bitince alınır

`/kur`'u tekrar yazarsan var olanları kullanır, silinen kanalı yeniden açar.
Kurulduktan sonra `/kur`'u sadece satıcı (ilk `/kur` yazan) yazabilir; satıcı
sunucudan çıkmışsa sunucu sahibi devralır (eski satıcının kanal ve oda izinleri
silinir). Bot sunucudan atılırsa ayarlar durur, geri eklenince kaldığı yerden
devam eder; bu arada başka bir sunucunun sahibi botu ekleyip `/kur` ile ele
geçiremez (sadece kayıtlı satıcı). Bot başka sunucuya taşınırsa müşteriler orada
yeni oda alır, ayarları ve sandıkları kalır.

Key verme ve lisans işleri satıcıya özeldir. Ekibine de bu yetkiyi vermek
istersen bir rol aç, ID'sini `ayarlar.json`'da `yetkili_rol_id`'ye yaz (o rolü
verebilen herkesin key basabileceğini unutma).

**`baslat.bat`** kapanırsa botu 10 sn sonra yeniden açar. Bilgisayar/VPS
kapanınca botlar da kapanır; açınca çalışan müşteri botları kendiliğinden geri gelir.

### ayarlar.json (bot doldurur, istersen elle değiştirirsin)

- `discord_token`: token (konsolda sorulur)
- `guild_id`, `log_kanal_id`, `key_log_kanal_id`, `discord_sahip_id`,
  `log_rol_id`, `musteri_rol_id`: `/kur` doldurur. Key logu kim hangi keyi ne
  zaman üretti, kime verdi, kim kullandı, kim iptal etti; lisans uzatma/bitirme/iptal
  ve süresi dolanlar saatiyle düşer, ayrıca `veri/key_log.txt` dosyasına yazılır.
- `yetkili_rol_id`: elle (isteğe bağlı) — bu roldekiler de key verip lisans yönetir.
- `gunluk_yedek`: `true` ise her gün yedek alınır ve sana DM ile gelir.
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

Elle kurmak istersen (eski yol) `/panel-kur` bulunduğun kanalı key kanalı,
`/yonetim-kur` yönetim panelini kurar. Botu Yönetici olmadan eklediysen en az:
Kanalları Gör, Mesaj Gönder, Mesaj Geçmişini Oku, Bağlantı Yerleştir, Dosya Ekle,
Tepki Ekle, Uygulama Komutlarını Kullan, Thread'lerde Mesaj Gönder, Thread Oluştur,
Kanalları Yönet, Rolleri Yönet, **Mesajları Yönet** izinleri lazım; `/kur` eksik
izni söyler.

Linux VPS'te: `npm install`, sonra bir kere `node discordbot.js` ile aç, token'ı
yapıştır, sunucunda `/kur` yaz, Ctrl+C ile kapat. Sonra sürekli çalışsın ve VPS
yeniden açılınca kendiliğinden başlasın diye:
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
| `/yedek` | Bütün müşteri ve key kayıtlarının yedeğini şimdi alır, dosyaları sana gösterir |
| `/kur` | Log kanallarını, rolleri, key kanalını ve yönetim panelini açar ya da eksikleri tamamlar (sadece satıcı) |

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
4. Sunucu girişte şifre istiyorsa (`/login`, `/register`) odasında
   `/giris sifre:BotunŞifresi` yazar; bot her girişte kendisi yazar (ilk seferde
   kayıt olur). Boş `/giris` kayıtlı şifre var mı gösterir, `/giris sifre:sil` siler.
   Şifre her sunucu için ayrı saklanır ve hiçbir yerde gösterilmez.
5. Oyun sohbeti odasına düşer: `/sohbet durum:kapalı` ile kapatır. `/yaz mesaj:selam`
   ile bot oyunda yazar (`/yaz mesaj:/warp maden` gibi komut da olur).
6. `/gorev` `/durum` `/soyle` `/sandik` `/durdur` odada; `/bilgi` ve `/odam` her yerde.
7. Kalan süreyi odada, `/bilgi`'de ve oda başlığında görür (geri sayım). Bitişe
   1 gün ve 1 saat kala uyarılır.
8. Süre bitince botu durur, **odası silinir** ve DM ile haber verilir. Yeni key
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

## Yedekten geri yükleme

Bilgisayar bozulur ya da `veri/lisanslar.json` silinirse: botu kapat, yeni kurulumda
`veri/` klasörüne en son yedekteki `lisanslar.json` (ve varsa `paneller.json`,
`key_log.txt`) dosyalarını koy (DM'deki dosyaların başındaki tarihi silerek), botu aç.
Bütün müşteriler, keyler ve kalan süreler geri gelir. Müşterilerin sunucu şifreleri
yedekte yoktur (güvenlik için); gerekirse `/giris` ile tekrar yazarlar.

## Bilmen gerekenler

- Bot acıkınca kendisi yer, boştayken AFK'dan atılmasın diye arada hareket eder.
  Yemek yoksa oyunda "acıktım" der; envanterine ya da sandığa yemek koymak yeter.

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
