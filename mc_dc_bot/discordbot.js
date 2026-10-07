// Discord kontrol botu (satış sürümü)
//
// Nasıl çalışır:
//  1. Sen (satıcı) yönetim panelinden (/yonetim-kur) ya da komutlarla süresini
//     seçip key verirsin: "Key Ver" (bot keyi kişiye DM'den gönderir) ya da
//     "Key Oluştur" (kopyalayıp sen verirsin). Panel bütün lisansların kalan
//     süresini canlı gösterir; oradan süre uzatır, bitirir, iptal edersin.
//  2. Müşteri key kanalına (/panel-kur yazdığın kanal) keyini yazar ya da
//     "Key Gir" butonuna basar. Bot keyi kontrol eder: yanlışsa hata verir,
//     doğruysa ona özel oda açar ve süresi o andan saymaya başlar.
//  3. Odayı sadece o, sen (ve yetkili rolü) ve bot görür.
//  4. Müşteri kendi odasında /baslat /durdur /durum /gorev /soyle /bilgi
//     kullanır. Botunun bütün logları o odaya düşer.
//  5. Süre bitince botu durur ve odası silinir. Yeni key girerse odası
//     yeniden açılır (ayarları ve sandıkları kaybolmaz).
//
// Kurulum: npm install, ayarlar.ornek.json -> ayarlar.json, node discordbot.js
// Botu sunucuna davet ederken şu izinleri ver (en kolayı Yönetici): Kanalları
// Gör, Mesaj Gönder, Mesaj Geçmişini Oku, Bağlantı Yerleştir, Kanalları Yönet,
// Rolleri Yönet, Mesajları Yönet. Ardından müşterilerin göreceği bir kanalda
// /panel-kur, kendi yönetim kanalında /yonetim-kur yaz.
// Müşteri keyini kanala yazarak girebilsin diye Developer Portal > Bot >
// "Message Content Intent"i aç (kapalıysa sadece buton çalışır).

const fs = require('fs')
const net = require('net')
const path = require('path')
const {
  Client,
  Events,
  GatewayIntentBits,
  IntentsBitField,
  Routes,
  ApplicationFlags,
  ApplicationCommandOptionType,
  MessageFlags,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  ModalBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js')
const ayarlar = require('./ayarlar')
const { LisansDeposu, bitisYazi, sureYazi, keySuresi, GUN, SAAT } = require('./lisans')
const { BotYonetici, hedefKontrol } = require('./botyonetici')

// ---------- AYARLAR ----------
// Hepsi ayarlar.json'dan (ya da aynı isimli ortam değişkenlerinden) okunur.
// Token'ı ASLA koda yazma: kodu paylaşınca token da gider.
const DISCORD_TOKEN = ayarlar.discordToken    // Developer Portal > Bot > Token
const GUILD_ID = ayarlar.guildId              // Discord sunucunun ID'si
const LOG_CHANNEL_ID = ayarlar.logKanalId     // satıcı logu: satışlar, başlatmalar, hatalar
const ADMIN_ID = ayarlar.discordSahipId       // satıcı (sen): key üretir, her odaya girer
const YETKILI_ROL_ID = ayarlar.yetkiliRolId   // bu roldekiler de key verip lisans yönetebilir
const ODA_SILME_SAAT = ayarlar.odaSilmeSaat   // süre bitince oda kaç saat sonra silinsin (0 = hemen)
const KATEGORI_ID = ayarlar.musteriKategoriId // müşteri odaları bu kategoriye (boşsa bot açar)
const DEFAULT_BOT_NAME = 'GorevBot'
const VERI_DIR = path.join(__dirname, 'veri') // lisanslar ve müşteri klasörleri (git'e girmez)
// -----------------------------

const eksik = Object.entries({
  discord_token: DISCORD_TOKEN,
  guild_id: GUILD_ID,
  log_kanal_id: LOG_CHANNEL_ID,
  discord_sahip_id: ADMIN_ID,
})
  .filter(([, v]) => !v)
  .map(([k]) => k)
if (eksik.length > 0) {
  console.error(`ayarlar.json içinde eksik: ${eksik.join(', ')}`)
  console.error('ayarlar.ornek.json dosyasını ayarlar.json adıyla kopyalayıp doldur.')
  process.exit(1)
}

let depo
try {
  // adminLog aşağıda tanımlı: açılışta (dosya kurtarma) yazılan log sonraya ertelenir
  depo = new LisansDeposu(path.join(VERI_DIR, 'lisanslar.json'), (m) => setImmediate(() => adminLog(m)))
} catch (e) {
  console.error('Lisans dosyası okunamadı:', e.message)
  process.exit(1)
}
const yonetici = new BotYonetici({
  script: path.join(__dirname, 'gorevbot.js'),
  veriKoku: VERI_DIR,
  maxBot: ayarlar.maxBot,
  apiKey: ayarlar.apiKey,
  aiGunlukLimit: ayarlar.aiGunlukLimit,
})
// GuildMessages: key kanalına yazılan mesajları görmek için. Mesajın içeriğini
// okumak için ayrıca Message Content Intent lazım, o açılışta eklenir (girisYap).
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] })
let mesajOkunur = false // Message Content Intent açık mı
const gizli = (content) => ({ content, flags: MessageFlags.Ephemeral })

// Discord mesajı en fazla 2000 karakter: sığmayan satırları say, mesaj patlamasın
function sigdir(ust, satirlar, sinir = 1900) {
  let metin = ust
  let n = 0
  for (const s of satirlar) {
    if (metin.length + s.length + 40 > sinir) break
    metin += '\n' + s
    n++
  }
  if (n < satirlar.length) metin += `\n(+${satirlar.length - n} tane daha)`
  return metin
}
// Satıcı (sen) ya da yetkili rolündekiler
function adminMi(i) {
  if (i.user.id === ADMIN_ID) return true
  if (!YETKILI_ROL_ID) return false
  const roller = i.member?.roles
  return roller?.cache ? roller.cache.has(YETKILI_ROL_ID) : Array.isArray(roller) && roller.includes(YETKILI_ROL_ID)
}
let yetkiliRol = null // açılışta doğrulanır; yanlış ID oda açmayı bozmasın

// Discord zaman damgası: herkes kendi saatinde görür, "3 gün içinde" kendiliğinden güncellenir
const zaman = (ms, bicim = 'f') => `<t:${Math.floor(ms / 1000)}:${bicim}>`
const bitisDiscord = (l) => (l.bitis === null ? '**süresiz**' : `**${zaman(l.bitis)}** (${zaman(l.bitis, 'R')})`)

// Kişiye özelden mesaj (DM'leri kapalıysa false)
async function dmGonder(userId, content) {
  try {
    const u = await client.users.fetch(userId)
    await u.send(content)
    return true
  } catch (_) {
    return false
  }
}

// ---------- LOG KUYRUĞU ----------
// Her kanalın kendi kuyruğu var (müşteri odaları + satıcı log kanalı).
// Rate limit olmasın diye 2 sn'de bir toplu gönderilir.
const MAX_KUYRUK = 300 // Discord'a ulaşılamazsa bellek şişmesin
const kuyruklar = new Map() // kanalId -> { satirlar, atlanan, gonderiliyor }

function log(kanalId, line) {
  if (!kanalId) return
  let k = kuyruklar.get(kanalId)
  if (!k) kuyruklar.set(kanalId, (k = { satirlar: [], atlanan: 0, gonderiliyor: false }))
  const time = new Date().toLocaleTimeString('tr-TR')
  k.satirlar.push(`[${time}] ${line}`)
  if (k.satirlar.length > MAX_KUYRUK) {
    k.atlanan += k.satirlar.length - MAX_KUYRUK
    k.satirlar.splice(0, k.satirlar.length - MAX_KUYRUK)
  }
}
const adminLog = (line) => {
  console.log('[satıcı]', line)
  log(LOG_CHANNEL_ID, line)
}

async function kanalaGonder(kanalId, k) {
  // önceki gönderim bitmeden yenisi başlarsa satırlar karışık sırayla düşer
  if (k.gonderiliyor || k.satirlar.length === 0 || !client.isReady()) return
  k.gonderiliyor = true
  // Tek seferde en fazla ~3 mesaj; fazlası sonraki tura kalır (Discord kanal
  // başına 5 mesaj/5 sn sınırı var, bir oda diğerlerini bekletmesin)
  let boy = 0
  let adet = 0
  while (adet < k.satirlar.length && boy + k.satirlar[adet].length < 5600) boy += k.satirlar[adet++].length + 1
  const lines = k.satirlar.splice(0, Math.max(1, adet))
  if (k.atlanan > 0) {
    lines.unshift(`(${k.atlanan} log satırı sığmadığı için atlandı)`)
    k.atlanan = 0
  }
  const text = lines.join('\n').replace(/```/g, "'''")
  try {
    const ch = await client.channels.fetch(kanalId)
    for (let i = 0; i < text.length; i += 1900) {
      await ch.send({
        content: '```\n' + text.slice(i, i + 1900) + '\n```',
        allowedMentions: { parse: [] }, // loglardaki @everyone kimseyi etiketlemesin
      })
    }
  } catch (e) {
    console.error(`Log gönderilemedi (${kanalId}):`, e.message)
    if (e.code === 10003 || e.code === 50001) kuyruklar.delete(kanalId) // kanal silinmiş / erişim yok
  } finally {
    k.gonderiliyor = false
  }
}
setInterval(() => {
  for (const [kanalId, k] of kuyruklar) kanalaGonder(kanalId, k)
}, 2000)

// Oyun botlarının logları müşterinin odasına; "[satıcı]" satırları (tam hata
// dökümü, API faturası) sadece satıcının log kanalına
yonetici.on('log', (userId, line) => log(depo.bul(userId)?.kanalId, line))
yonetici.on('saticiLog', (userId, line) => adminLog(`(${depo.bul(userId)?.kullaniciAdi || userId}) ${line}`))

// ---------- BOT DÜŞERSE YENİDEN BAĞLAN ----------
const yenidenDeneme = new Map() // userId -> { sayi, zamanlayici }
const yenidenBaslat = new Set() // kapanınca hemen tekrar başlatılacaklar (ör. yapay zeka süresi bitti)
let kapaniyor = false

// Kayıtlı ayarlarla başlatır; yapay zeka o anki lisansa göre açılır/kapanır
function kayitliBaslat(l) {
  yonetici.baslat(l.userId, {
    ...l.son,
    yerelIzin: !!(l.son.yerelIzin && net.isIP(l.son.host)), // sadece satıcının yazdığı IP
    ai: depo.aiAktifMi(l),
  })
  panelGuncelle() // 🟢 ve "Çalışan bot" sayısı
}

// Yapay zeka hakkı açıldı/kapandıysa çalışan botu yeni hâliyle yeniden başlat
function aiDegistiyse(l, oncekiAi) {
  if (!l || oncekiAi === depo.aiAktifMi(l) || !yonetici.calisiyor(l.userId)) return false
  yenidenBaslat.add(l.userId)
  yonetici.durdur(l.userId)
  return true
}

function denemeIptal(userId) {
  clearTimeout(yenidenDeneme.get(userId)?.zamanlayici)
  yenidenDeneme.delete(userId)
}

// Beklenmedik kapanmada (sunucu kapandı, atıldı, internet gitti) 30 sn arayla
// en fazla 3 kez dener. Bot yeri doluysa ya da başlatılamazsa o da bir deneme sayılır.
function yenidenDene(userId) {
  const l = depo.bul(userId)
  if (kapaniyor || !l || !depo.aktifMi(l) || !l.calisiyordu || !l.son) return
  const d = yenidenDeneme.get(userId) || { sayi: 0, zamanlayici: null }
  if (d.sayi >= 3) {
    log(l.kanalId, 'Bot üst üste 3 kez bağlanamadı, otomatik bağlanmayı bıraktım. /baslat ile tekrar başlatabilirsin.')
    depo.guncelle(userId, { calisiyordu: false })
    yenidenDeneme.delete(userId)
    return
  }
  d.sayi++
  log(l.kanalId, `Bağlantı koptu, 30 sn sonra tekrar bağlanıyorum (${d.sayi}/3).`)
  clearTimeout(d.zamanlayici)
  d.zamanlayici = setTimeout(() => {
    const g = depo.bul(userId)
    if (kapaniyor || !g || !depo.aktifMi(g) || !g.calisiyordu || !g.son || yonetici.calisiyor(userId)) return
    try {
      kayitliBaslat(g)
    } catch (e) {
      log(g.kanalId, 'Tekrar bağlanamadım: ' + e.message)
      yenidenDene(userId) // ör. bot yerleri doluydu: biraz sonra yine dene
    }
  }, 30000)
  yenidenDeneme.set(userId, d)
}

yonetici.on('kapandi', (userId, { code, signal, elleDurdu, sure }) => {
  // Burada fırlayan bir hata bütün Discord botunu (ve bütün müşteri botlarını) düşürürdü
  try {
    panelGuncelle()
    const l = depo.bul(userId)
    log(l?.kanalId, `Bot kapandı (${signal ? 'sinyal: ' + signal : 'kod: ' + code}).`)
    if (yenidenBaslat.delete(userId) && !kapaniyor && l && depo.aktifMi(l) && l.son) {
      try {
        kayitliBaslat(l)
      } catch (e) {
        log(l.kanalId, 'Bot yeniden başlatılamadı: ' + e.message)
      }
      return
    }
    if (code === 3) {
      // kalıcı hata (yasak ya da olmayan adres): tekrar denemenin anlamı yok
      if (l) {
        depo.guncelle(userId, { calisiyordu: false })
        log(l.kanalId, 'Bu adrese bağlanılamıyor, otomatik bağlanma kapalı. Adresi kontrol edip /baslat yaz.')
      }
      return
    }
    if (elleDurdu) return
    const d = yenidenDeneme.get(userId)
    if (d && sure > 5 * 60000) d.sayi = 0 // uzun süre sorunsuz çalıştıysa sayaç baştan
    yenidenDene(userId)
  } catch (e) {
    console.error('kapandi işleyicisi:', e)
  }
})

function kapat() {
  kapaniyor = true
  yonetici.hepsiniDurdur() // calisiyordu bayrağı kalır: açılınca botlar geri gelir
}
process.on('exit', kapat)
for (const sinyal of ['SIGINT', 'SIGTERM']) {
  process.on(sinyal, () => {
    kapat()
    process.exit(0)
  })
}
// Tek bir Discord hatası (ör. süresi geçmiş komut) bütün botları düşürmesin
process.on('unhandledRejection', (e) => console.error('Beklenmeyen hata:', e?.message || e))
client.on(Events.Error, (e) => console.error('Discord hatası:', e.message))

// ---------- MÜŞTERİ ODALARI ----------
// Kanal silinmişse null. Discord'a o an ulaşılamıyorsa hata fırlatır: geçici
// bir hatada oda "silinmiş" sanılıp ikinci oda açılmasın ya da kayıt kaybolmasın.
async function kanalGetir(kanalId) {
  if (!kanalId) return null
  try {
    return await client.channels.fetch(kanalId)
  } catch (e) {
    if (e.code === 10003) return null // Unknown Channel
    throw e
  }
}

// Bot kategoriyi görebilmeli ve içinde kanal açabilmeli. Kategori herkese
// gizliyse ve botun izni yoksa (Yönetici değilse) oda açılamaz, kilitlenemez.
const BOT_KATEGORI_IZIN = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
]
async function botuKategoriyeEkle(k) {
  await k.permissionOverwrites
    .edit(
      client.user.id,
      { ViewChannel: true, ManageChannels: true, SendMessages: true, ReadMessageHistory: true },
      { type: OverwriteType.Member }
    )
    .catch((e) => adminLog(`⚠️ "${k.name}" kategorisine bot izni eklenemedi: ${e.message}`))
}

// Discord bir kategoride en fazla 50 kanala izin verir: dolunca yenisini aç
async function kategoriBul(guild) {
  if (KATEGORI_ID) {
    const k = await guild.channels.fetch(KATEGORI_ID).catch(() => null)
    if (k && k.type === ChannelType.GuildCategory && k.children.cache.size < 50) {
      await botuKategoriyeEkle(k)
      return k
    }
  }
  const hepsi = await guild.channels.fetch()
  const adaylar = [...hepsi.values()].filter(
    (c) => c && c.type === ChannelType.GuildCategory && c.name.startsWith('Yaren Odaları')
  )
  for (const k of adaylar) {
    if (k.children.cache.size < 50) {
      await botuKategoriyeEkle(k)
      return k
    }
  }
  return guild.channels.create({
    name: `Yaren Odaları${adaylar.length ? ' ' + (adaylar.length + 1) : ''}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, type: OverwriteType.Member, allow: BOT_KATEGORI_IZIN },
    ],
  })
}

const MUSTERI_IZIN = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseApplicationCommands,
]

function odaIzinleri(guild, userId, acik) {
  return [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: userId,
      type: OverwriteType.Member,
      allow: acik ? [...MUSTERI_IZIN, PermissionFlagsBits.SendMessages] : MUSTERI_IZIN,
      deny: acik ? [] : [PermissionFlagsBits.SendMessages],
    },
    {
      id: client.user.id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: ADMIN_ID,
      type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    ...(yetkiliRol
      ? [
          {
            id: yetkiliRol.id,
            type: OverwriteType.Role,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          },
        ]
      : []),
  ]
}

// yetkili_rol_id sonradan eklendiyse, rol eklenmeden önce açılan odalara da izin ver
async function yetkiliIzni(kanal) {
  if (!yetkiliRol || kanal.permissionOverwrites.cache?.has(yetkiliRol.id)) return
  await kanal.permissionOverwrites
    .edit(yetkiliRol.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { type: OverwriteType.Role })
    .catch((e) => adminLog(`⚠️ Yetkili rolüne oda izni verilemedi (#${kanal.name}): ${e.message}`))
}

// Süre dolunca müşteri odasını görür ama yazamaz (thread açıp da yazamaz);
// komutlar (yeni key) çalışır. null = sunucudaki varsayılan izin
function odaKilit(kanal, userId, kilitli) {
  const yazma = kilitli ? false : null
  return kanal.permissionOverwrites.edit(
    userId,
    {
      ViewChannel: true,
      ReadMessageHistory: true,
      UseApplicationCommands: true,
      SendMessages: !kilitli,
      SendMessagesInThreads: yazma,
      CreatePublicThreads: yazma,
      CreatePrivateThreads: yazma,
      AddReactions: yazma,
    },
    { type: OverwriteType.Member }
  )
}

const odaAdi = (ad) =>
  'yaren-' +
  (String(ad || 'musteri')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 20) || 'musteri')

function hosgeldin(l) {
  return [
    `Hoş geldin <@${l.userId}>! Bu oda sadece sana özel, botunu buradan yöneteceksin.`,
    `Lisans bitişi: ${bitisDiscord(l)} | Yapay zeka: **${depo.aiAktifMi(l) && ayarlar.apiKey ? 'açık' : 'kapalı'}**`,
    l.bitis !== null ? 'Süren bitince bu oda silinir. Yeni key girersen yeniden açılır, ayarların kaybolmaz.' : '',
    '',
    '**Başlamak için:**',
    '1. `/baslat host:sunucu.adresi` yaz, bot sunucuya girer.',
    '2. `/sahip ad:OyundakiAdın` yaz (örn. `/sahip ad:xdarkoum`). Bot oyunda sadece senin yazdıklarını yapar.',
    'Bir kere yazman yeter, sonraki seferlerde sadece `/baslat` yazabilirsin.',
    '',
    'Diğer komutlar: `/sahip` `/gorev` `/durum` `/sandik` `/soyle` `/durdur` `/bilgi`',
    'Oyun içinde: `!odun` `!tas` `!farm` `!topla` `!bosalt` `!gel` `!dur` `!durum` `!otonom`, ya da "Yaren ..." diye konuş.',
    '**Sandık:** oyunda sandığın dibinde dur ve `!sandik ekle` yaz. Bot envanteri yarı dolunca topladıklarını oraya bırakır, baltası kırılmak üzereyse oradan yenisini alır.',
  ].join('\n')
}

const odaBasligi = (l) =>
  `${l.kullaniciAdi} için Yaren odası | Lisans bitişi: ${l.bitis === null ? 'süresiz' : bitisYazi(l) + ' (TR saati)'}`

// Müşterinin odası yoksa açar, varsa kilidini açıp başlığındaki bitişi günceller
async function odaHazirla(guild, l) {
  let kanal = await kanalGetir(l.kanalId)
  if (kanal) {
    await odaKilit(kanal, l.userId, false)
    await yetkiliIzni(kanal)
    // Discord kanal başlığını 10 dakikada 2 kez değiştirtir; fazlasında discord.js
    // dakikalarca bekler. O yüzden sadece değiştiyse ve cevabı bekletmeden.
    const baslik = odaBasligi(l)
    if (kanal.topic !== baslik) kanal.setTopic?.(baslik).catch(() => {})
    return { kanal, yeni: false }
  }
  const parent = await kategoriBul(guild)
  kanal = await guild.channels.create({
    name: odaAdi(l.kullaniciAdi),
    type: ChannelType.GuildText,
    parent: parent?.id,
    topic: odaBasligi(l),
    permissionOverwrites: odaIzinleri(guild, l.userId, true),
  })
  depo.kanalAyarla(l.userId, kanal.id)
  await kanal.send({ content: hosgeldin(l), allowedMentions: { users: [l.userId] } })
  return { kanal, yeni: true }
}

// ---------- KEY KULLANMA ----------
const islemde = new Set() // aynı anda iki kere basılmasın
const yanlis = new Map() // userId -> { sayi, ilk }: key denemesi sınırı

// Keyi kontrol eder; doğruysa lisansı açar ve odayı hazırlar.
// Buton, /key-gir ve key kanalına yazılan mesaj hepsi bunu kullanır.
// Sonuç: { ok, metin, kanal }
async function keyIsle(user, guild, key) {
  const y = yanlis.get(user.id)
  if (y && Date.now() - y.ilk < 10 * 60000 && y.sayi >= 5) {
    return { ok: false, metin: 'Çok fazla yanlış key denedin, 10 dakika sonra tekrar dene.' }
  }
  if (islemde.has(user.id)) return { ok: false, metin: 'İşlemin sürüyor, biraz bekle.' }
  islemde.add(user.id)
  try {
    // Discord sunucusu en fazla 500 kanal alır: yeni oda gerekiyorsa ve yer
    // yoksa key yanmadan reddet
    const onceki = depo.bul(user.id)
    const odasiVar = !!(onceki?.kanalId && (await kanalGetir(onceki.kanalId).catch(() => true)))
    if (!odasiVar && (guild.channels.cache?.size ?? 0) >= 495) {
      adminLog('⚠️ Sunucuda kanal yeri kalmadı (500 sınırı), yeni müşteriye oda açılamıyor!')
      return { ok: false, metin: 'Şu an yeni oda açılamıyor, satıcıya haber ver. Keyin kullanılmadı.' }
    }
    const oncekiAi = depo.aiAktifMi(onceki)
    const r = depo.kullan(key, { userId: user.id, kullaniciAdi: user.username })
    if (!r.lisans) {
      if (r.tip === 'gecersiz') {
        const s = y && Date.now() - y.ilk < 10 * 60000 ? y : { sayi: 0, ilk: Date.now() }
        s.sayi++
        yanlis.set(user.id, s)
      }
      return { ok: false, metin: r.mesaj }
    }
    yanlis.delete(user.id)
    panelGuncelle()
    if (aiDegistiyse(r.lisans, oncekiAi)) log(r.lisans.kanalId, 'Yapay zeka hakkın değişti, bot yeniden başlatılıyor.')
    adminLog(`🔑 ${user.tag} (${user.id}) key kullandı: ${r.tip}. Bitiş: ${bitisYazi(r.lisans)}`)
    let kanal
    try {
      ;({ kanal } = await odaHazirla(guild, r.lisans))
    } catch (e) {
      adminLog(`⚠️ ${user.tag} için oda açılamadı: ${e.message}`)
      return { ok: true, metin: `${r.mesaj}\nAma odan açılamadı (${e.message}). Birazdan /odam yaz ya da satıcıya haber ver.` }
    }
    if (r.tip !== 'yeni') {
      await kanal
        .send({
          content: `<@${r.lisans.userId}> ${r.mesaj.split('.')[0]}. Yeni bitiş: ${bitisDiscord(r.lisans)}`,
          allowedMentions: { users: [r.lisans.userId] },
        })
        .catch(() => {})
    }
    return { ok: true, metin: `${r.mesaj.split('.')[0]}. Bitiş: ${bitisDiscord(r.lisans)}\nOdan: <#${kanal.id}>`, kanal }
  } finally {
    islemde.delete(user.id)
  }
}

// Açılışta, bot kapalıyken key kanalına yazılmış keyler önce sahiplerine işlenir.
// O bitene kadar buton/komutla key girenler bekler: kanalda görünen bir keyi
// başkası bot açılır açılmaz /key-gir ile kapamasın.
let birikmisBitti
const birikmisHazir = new Promise((r) => (birikmisBitti = r))

async function keyKullan(i, key) {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  if (i.guildId !== GUILD_ID) return i.editReply('Keyi satıcının Discord sunucusunda girmen lazım.')
  await birikmisHazir
  return i.editReply((await keyIsle(i.user, i.guild, key)).metin)
}

function keyModal() {
  return new ModalBuilder()
    .setCustomId('key_modal')
    .setTitle('Key Gir')
    .addLabelComponents((l) =>
      l
        .setLabel('Lisans keyin')
        .setDescription('Satıcıdan aldığın key (YAREN-...)')
        .setTextInputComponent((t) =>
          t
            .setCustomId('key')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(10)
            .setMaxLength(40)
            .setPlaceholder('YAREN-XXXX-XXXX-XXXX-XXXX')
        )
    )
}

// ---------- SLASH KOMUTLARI ----------
const S = ApplicationCommandOptionType
const SATICI = { default_member_permissions: '0' } // sadece yöneticiler görür; ayrıca ID/rol kontrolü var
// Süre: birim (zorunlu) + miktar. Discord'da zorunlu seçenekler önce gelmeli.
const SURE_BIRIM = {
  name: 'birim',
  description: 'Süre birimi',
  type: S.String,
  required: true,
  choices: [
    { name: 'saat', value: 'saat' },
    { name: 'gün', value: 'gun' },
    { name: 'hafta', value: 'hafta' },
    { name: 'ay (30 gün)', value: 'ay' },
    { name: 'süresiz', value: 'suresiz' },
  ],
}
const SURE_MIKTAR = {
  name: 'miktar',
  description: 'Kaç saat/gün/hafta/ay (süresizde boş bırak)',
  type: S.Integer,
  min_value: 1,
  max_value: 1000,
}
// Birim + miktarı milisaniyeye çevirir: { sure } ya da { hata }
function sureCoz(birim, miktar, ipucu = '') {
  if (birim === 'suresiz') return { sure: 0 }
  const ad = { saat: 'saat', gun: 'gün', hafta: 'hafta', ay: 'ay' }[birim]
  if (!ad) return { hata: 'Süre birimini seç.' }
  if (miktar === null || miktar === undefined || miktar === '') return { hata: `Kaç ${ad} olacağını da yaz${ipucu}.` }
  if (!Number.isInteger(miktar) || miktar < 1 || miktar > 1000) return { hata: 'Miktar 1 ile 1000 arasında bir sayı olmalı.' }
  const sure = miktar * { saat: SAAT, gun: GUN, hafta: 7 * GUN, ay: 30 * GUN }[birim]
  if (sure > 3650 * GUN) return { hata: 'En fazla 10 yıl verebilirsin (ya da süresiz).' }
  return { sure }
}
const sureOku = (i) => sureCoz(i.options.getString('birim'), i.options.getInteger('miktar'), ': `miktar` seçeneği')
const GOREV_SECENEK = [
  { name: 'farm (çiftçilik)', value: 'farm' },
  { name: 'odun', value: 'odun' },
  { name: 'taş', value: 'tas' },
  { name: 'topla (yerdeki eşyalar)', value: 'topla' },
  { name: 'otonom (kendi karar versin)', value: 'otonom' },
  { name: 'dur (görevi iptal et)', value: 'dur' },
  { name: 'gel', value: 'gel' },
  { name: 'bosalt (sandığa bırak)', value: 'bosalt' },
  { name: 'durum', value: 'durum' },
]

const COMMANDS = [
  // ---- müşteri ----
  {
    name: 'key-gir',
    description: 'Satın aldığın keyi gir, sana özel oda açılsın',
    options: [{ name: 'key', description: 'YAREN-XXXX-XXXX-XXXX-XXXX', type: S.String, required: true, max_length: 40 }],
  },
  { name: 'odam', description: 'Özel odanı gösterir (silindiyse yeniden açar)' },
  { name: 'bilgi', description: 'Lisansının bitişi, yapay zeka hakkın ve botunun durumu' },
  {
    name: 'baslat',
    description: 'Botunu bir Minecraft sunucusuna sokar',
    options: [
      { name: 'host', description: 'Sunucu adresi (örn. oyna.ornek.com). Boşsa son kullandığın', type: S.String },
      { name: 'sahip', description: 'Oyundaki adın (istersen sonra /sahip ile de verirsin)', type: S.String },
      { name: 'port', description: 'Port (varsayılan 25565)', type: S.Integer, min_value: 1, max_value: 65535 },
      { name: 'kullanici', description: 'Botun oyundaki adı', type: S.String },
      {
        name: 'hesap',
        description: 'Giriş türü',
        type: S.String,
        choices: [
          { name: 'offline (crack / LAN)', value: 'offline' },
          { name: 'microsoft (premium)', value: 'microsoft' },
        ],
      },
      { name: 'surum', description: 'Minecraft sürümü (boşsa otomatik, örn. 1.20.4)', type: S.String },
    ],
  },
  { name: 'durdur', description: 'Botunu sunucudan çıkarır' },
  { name: 'durum', description: 'Botunun oyundaki durumu' },
  {
    name: 'gorev',
    description: 'Botuna görev verir',
    options: [{ name: 'gorev', description: 'Ne yapsın?', type: S.String, required: true, choices: GOREV_SECENEK }],
  },
  {
    name: 'sandik',
    description: 'Botunun eşya bırakacağı sandıklar (oyunda sandığın dibinde durup "ekle" de diyebilirsin)',
    options: [
      {
        name: 'islem',
        description: 'Ne yapılsın?',
        type: S.String,
        required: true,
        choices: [
          { name: 'liste', value: 'liste' },
          { name: 'ekle (koordinatsız: oyunda dibinde durduğun sandık)', value: 'ekle' },
          { name: 'sil', value: 'sil' },
          { name: 'temizle (hepsini unut)', value: 'temizle' },
        ],
      },
      { name: 'x', description: 'Sandığın X koordinatı', type: S.Integer },
      { name: 'y', description: 'Sandığın Y koordinatı', type: S.Integer },
      { name: 'z', description: 'Sandığın Z koordinatı', type: S.Integer },
    ],
  },
  {
    name: 'sahip',
    description: 'Bot oyunda kimin yazdıklarını yapsın: senin Minecraft adın',
    options: [{ name: 'ad', description: 'Oyundaki adın (örn. xdarkoum). Boş bırakırsan şu anki sahibi gösterir', type: S.String, max_length: 16 }],
  },
  {
    name: 'soyle',
    description: 'Yaren ile konuş (yapay zeka): "biraz odun lazım" gibi',
    options: [{ name: 'metin', description: 'Ne diyorsun?', type: S.String, required: true, max_length: 500 }],
  },
  // ---- satıcı ----
  {
    name: 'key-olustur',
    description: 'Satış için key üretir (süre, key kullanıldığı an başlar)',
    ...SATICI,
    options: [
      SURE_BIRIM,
      SURE_MIKTAR,
      { name: 'adet', description: 'Kaç tane (varsayılan 1)', type: S.Integer, min_value: 1, max_value: 25 },
      { name: 'ai', description: 'Yapay zeka dahil mi (varsayılan evet)', type: S.Boolean },
    ],
  },
  {
    name: 'key-ver',
    description: 'Key üretip kişiye DM ile gönderir; keyi girdiği an odası açılır',
    ...SATICI,
    options: [
      { name: 'kullanici', description: 'Keyi alacak kişi', type: S.User, required: true },
      SURE_BIRIM,
      SURE_MIKTAR,
      { name: 'ai', description: 'Yapay zeka dahil mi (varsayılan evet)', type: S.Boolean },
    ],
  },
  { name: 'key-liste', description: 'Keylerin durumu', ...SATICI },
  {
    name: 'key-iptal',
    description: 'Henüz kullanılmamış bir keyi iptal eder',
    ...SATICI,
    options: [{ name: 'key', description: 'Tam key ya da YAREN-XXXX öneki', type: S.String, required: true }],
  },
  { name: 'lisanslar', description: 'Müşteriler ve botlarının durumu', ...SATICI },
  {
    name: 'lisans-uzat',
    description: 'Bir müşterinin süresini uzatır',
    ...SATICI,
    options: [{ name: 'kullanici', description: 'Müşteri', type: S.User, required: true }, SURE_BIRIM, SURE_MIKTAR],
  },
  {
    name: 'lisans-bitir',
    description: 'Müşterinin süresini hemen bitirir (botu durur, odası silinir; yeni key girerse devam eder)',
    ...SATICI,
    options: [{ name: 'kullanici', description: 'Müşteri', type: S.User, required: true }],
  },
  {
    name: 'lisans-iptal',
    description: 'Müşterinin lisansını iptal eder: botu durur, odası silinir, bir daha key giremez',
    ...SATICI,
    options: [{ name: 'kullanici', description: 'Müşteri', type: S.User, required: true }],
  },
  { name: 'panel-kur', description: 'Bu kanalı key kanalı yapar: müşteri keyini buraya yazar ya da butona basar', ...SATICI },
  { name: 'panel-kaldir', description: 'Bu kanal artık key kanalı olmaz (yazılan mesajlar silinmez)', ...SATICI },
  { name: 'yonetim-kur', description: 'Butonlu yönetim panelini kurar (key ver, süre uzat/bitir, canlı süre takibi)', ...SATICI },
]
const SATICI_KOMUTLARI = new Set(COMMANDS.filter((c) => c.default_member_permissions === '0').map((c) => c.name))
const ODA_KOMUTLARI = new Set(['baslat', 'sahip', 'durdur', 'durum', 'gorev', 'sandik', 'soyle'])

client.once(Events.ClientReady, async () => {
  console.log(`Discord botu hazır: ${client.user.tag}`)
  setTimeout(birikmisBitti, 60000) // aşağıda bir şey takılsa da en geç 1 dk sonra key girişi açılır
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    await guild.commands.set(COMMANDS)
    adminLog(`Bot açıldı. Müşteri: ${depo.ozetListe().lisanslar.length}, en fazla aynı anda ${ayarlar.maxBot} bot.`)
    if (YETKILI_ROL_ID) {
      yetkiliRol = await guild.roles?.fetch?.(YETKILI_ROL_ID).catch(() => null)
      if (!yetkiliRol) adminLog(`⚠️ yetkili_rol_id (${YETKILI_ROL_ID}) bu sunucuda bulunamadı, yetkili rolü kapalı.`)
      // rol sonradan eklendiyse mevcut odalar da yetkililere açılsın (arka planda)
      else
        (async () => {
          for (const l of depo.ozetListe().lisanslar) {
            const kanal = await kanalGetir(l.kanalId).catch(() => null)
            if (kanal) await yetkiliIzni(kanal)
          }
        })().catch(() => {})
    }
    // Eksik izin varsa key yanmadan önce satıcı bilsin
    const ben = guild.members?.me ?? (await guild.members?.fetchMe?.().catch(() => null))
    const eksikIzin = ben?.permissions.missing([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageMessages, // key kanalına yazılan keyleri silmek için
      PermissionFlagsBits.UseApplicationCommands,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
      PermissionFlagsBits.AddReactions,
    ])
    if (eksikIzin?.length) {
      const m = `⚠️ Botun Discord izinleri eksik: ${eksikIzin.join(', ')}. Müşteri odaları açılamayabilir!`
      adminLog(m)
      console.error(m)
    }
  } catch (e) {
    console.error(`Slash komutları kaydedilemedi (${e.message}). guild_id doğru mu, bot o sunucuda mı?`)
  }
  // içerik okunamasa da (Message Content Intent kapalı) kanalda kalan mesajlar silinir
  await kacanKeyMesajlari().catch((e) => console.error('Key kanalı:', e.message))
  birikmisBitti()
  await zamanKontrol().catch((e) => console.error('Süre kontrolü:', e.message))
  panelGuncelle()
  // Satıcı botu yeniden başlattıysa (VPS yeniden açıldı vb.) çalışan botları geri getir
  const geriGelecek = depo.ozetListe().lisanslar.filter((l) => depo.aktifMi(l) && l.calisiyordu && l.son)
  for (const [n, l] of geriGelecek.entries()) {
    setTimeout(() => {
      // beklerken iptal edilmiş, süresi dolmuş ya da /durdur denmiş olabilir
      const g = depo.bul(l.userId)
      if (kapaniyor || !g || !depo.aktifMi(g) || !g.calisiyordu || !g.son || yonetici.calisiyor(g.userId)) return
      try {
        kayitliBaslat(g)
        log(g.kanalId, 'Sistem yeniden başladı, botun tekrar bağlanıyor.')
      } catch (e) {
        log(g.kanalId, 'Botun tekrar başlatılamadı: ' + e.message)
      }
    }, n * 3000) // hepsi aynı anda bağlanmasın
  }
})

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isButton() && i.customId === 'key_gir') return await i.showModal(keyModal())
    if (i.isModalSubmit() && i.customId === 'key_modal') {
      return await keyKullan(i, i.fields.getTextInputValue('key'))
    }
    // yönetim paneli butonları / formları ("yp:", "ypm:", "ypo:")
    if ((i.isButton() || i.isModalSubmit()) && /^yp[mo]?:/.test(i.customId)) {
      if (i.guildId !== GUILD_ID) return
      if (!adminMi(i)) return await i.reply(gizli('Bu panel sadece satıcı ve yetkililer içindir.'))
      return await yonetimEtkilesim(i)
    }
    if (!i.isChatInputCommand()) return
    if (i.guildId !== GUILD_ID) return await i.reply(gizli('Bu bot sadece kendi sunucusunda çalışır.'))
    if (SATICI_KOMUTLARI.has(i.commandName)) {
      if (!adminMi(i)) return await i.reply(gizli('Bu komut sadece satıcı ve yetkililer içindir.'))
      return await saticiKomutu(i)
    }
    if (i.commandName === 'key-gir') return await keyKullan(i, i.options.getString('key'))
    if (i.commandName === 'odam') return await odam(i)
    if (i.commandName === 'bilgi') return await bilgi(i)
    if (ODA_KOMUTLARI.has(i.commandName)) {
      const l = await musteriOdasi(i)
      if (l) return await odaKomutu(i, l)
    }
  } catch (e) {
    console.error('Komut hatası:', e)
    const m = 'Bir hata oldu, tekrar dene.'
    try {
      if (i.deferred || i.replied) await i.editReply(m)
      else if (i.isRepliable()) await i.reply(gizli(m))
    } catch (_) {}
  }
})

// Oda komutları sadece müşterinin kendi odasında, sadece onun (ve satıcının) için
async function musteriOdasi(i) {
  const l = depo.kanaldanBul(i.channelId)
  if (!l) {
    const kendi = depo.bul(i.user.id)
    await i.reply(
      gizli(
        kendi?.kanalId
          ? `Bu komutu kendi odanda kullan: <#${kendi.kanalId}>`
          : 'Önce key girmen lazım: /key-gir ya da paneldeki "Key Gir" butonu.'
      )
    )
    return null
  }
  if (l.userId !== i.user.id && !adminMi(i)) {
    await i.reply(gizli('Bu oda senin değil.'))
    return null
  }
  if (!depo.aktifMi(l)) {
    await i.reply(
      gizli(
        l.durum === 'iptal'
          ? 'Lisansın satıcı tarafından iptal edildi, satıcıyla görüş.'
          : `Lisans süren doldu (${bitisYazi(l)}). Yeni key girersen botun tekrar açılır: /key-gir`
      )
    )
    return null
  }
  return l
}

const HOST_RE = /^[a-zA-Z0-9.\-]+$/
const USER_RE = /^[a-zA-Z0-9_]{3,16}$/

async function odaKomutu(i, l) {
  const uid = l.userId

  if (i.commandName === 'baslat') {
    await i.deferReply()
    if (yonetici.calisiyor(uid)) return i.editReply('Botun zaten çalışıyor. Önce /durdur yaz.')
    const son = l.son || {}
    const secilen = (ad) => (i.options.getString(ad) || '').trim()
    const host = secilen('host') || son.host || ''
    const owner = secilen('sahip') || son.owner || ''
    const port = i.options.getInteger('port') ?? (secilen('host') ? 25565 : son.port || 25565)
    const user = secilen('kullanici') || son.user || DEFAULT_BOT_NAME
    const auth = i.options.getString('hesap') || son.auth || 'offline'
    const version = secilen('surum') || (secilen('host') ? '' : son.version || '')

    if (!host) return i.editReply('İlk seferde sunucu adresini yaz: `/baslat host:oyna.sunucu.com`')
    if (!HOST_RE.test(host)) return i.editReply('Geçersiz sunucu adresi.')
    if (auth === 'offline' && !USER_RE.test(user)) {
      return i.editReply('Bot adı 3-16 karakter olmalı (harf, rakam, _).')
    }
    if (owner && !USER_RE.test(owner)) return i.editReply('Sahip adı geçerli bir Minecraft adı olmalı (3-16 karakter: harf, rakam, _).')
    if (version && !/^\d+\.\d+(\.\d+)?$/.test(version)) return i.editReply('Sürüm 1.20.4 gibi yazılmalı.')
    // Bekleyen otomatik bağlanma, DNS kontrolü sürerken eski ayarlarla başlamasın
    denemeIptal(uid)
    // Satıcı (destek/test için) yerel bir IP'ye bağlatabilir. Sadece IP olarak
    // yazılırsa: alan adı olsaydı müşteri DNS'ini sonradan iç ağa çevirip
    // otomatik bağlanmada bu izni kullanabilirdi.
    const yerelIzin = i.user.id === ADMIN_ID && net.isIP(host) !== 0 // sadece sen, yetkililer değil
    // Botlar senin makinende çalışır: müşteri senin yerel ağına bağlatamasın
    const engel = yerelIzin ? null : await hedefKontrol(host, port)
    if (engel) return i.editReply(engel)
    if (yonetici.calisiyor(uid)) return i.editReply('Botun zaten çalışıyor. Önce /durdur yaz.')
    // adres kontrolü birkaç saniye sürebilir; bu arada lisans dolmuş/iptal edilmiş olabilir
    if (!depo.aktifMi(depo.bul(uid))) return i.editReply('Lisans süren doldu, bot başlatılmadı. Yeni key: /key-gir')

    const ayar = { host, port, user, auth, version, owner, yerelIzin }
    try {
      yonetici.baslat(uid, { ...ayar, ai: depo.aiAktifMi(l) })
    } catch (e) {
      return i.editReply(e.message)
    }
    depo.guncelle(uid, { son: ayar, calisiyordu: true })
    panelGuncelle()
    adminLog(`▶️ ${l.kullaniciAdi} botu başlattı: ${host}:${port} (${user}, ${auth}). Çalışan: ${yonetici.sayi()}/${ayarlar.maxBot}`)
    log(l.kanalId, `Başlatılıyor: ${host}:${port} (${user}, ${auth}${version ? ', ' + version : ''}, sahip: ${owner || 'henüz yok'})`)
    return i.editReply(
      `Bot başlatılıyor: **${host}:${port}**. Loglar birazdan bu odaya düşecek.` +
        (auth === 'microsoft' ? '\nMicrosoft girişi için kod birazdan burada görünecek.' : '') +
        (owner
          ? `\nOyunda **${owner}** oyuncusunun yazdıklarını yapacak. Değiştirmek için: \`/sahip ad:YeniAd\``
          : '\nBot girince `/sahip ad:OyundakiAdın` yaz: bot oyunda sadece senin yazdıklarını yapar.')
    )
  }

  if (i.commandName === 'sahip') {
    const ad = (i.options.getString('ad') || '').trim()
    const simdiki = l.son?.owner || ''
    if (!ad) {
      return i.reply(
        simdiki
          ? `Bot oyunda **${simdiki}** oyuncusunun yazdıklarını yapıyor. Değiştirmek için: \`/sahip ad:YeniAd\``
          : 'Henüz sahip yok. `/sahip ad:OyundakiAdın` yaz (örn. `/sahip ad:xdarkoum`).'
      )
    }
    if (!USER_RE.test(ad)) return i.reply('Minecraft adı 3-16 karakter olmalı (harf, rakam, _).')
    depo.guncelle(uid, { son: { ...(l.son || {}), owner: ad } })
    const nasil = '\nOyunda: `!odun` `!tas` `!farm` `!topla` `!gel` `!dur` `!durum` `!yardim` ya da "Yaren ..." diye konuş.'
    if (!yonetici.calisiyor(uid)) {
      return i.reply(`Tamam, sahip: **${ad}**. \`/baslat\` ile bot girince oyunda sadece senin yazdıklarını yapacak.${nasil}`)
    }
    await i.deferReply()
    const r = await yonetici.istek(uid, 'sahip', { ad })
    if (r.kod !== 200) {
      return i.editReply(`Bota şu an ulaşamadım (${r.veri?.hata || r.kod}). Ad kaydedildi: bot yeniden başlayınca **${ad}** oyuncusunu dinler.`)
    }
    log(l.kanalId, `Sahip değişti: ${ad}`)
    return i.editReply(
      `Tamam! Bot artık oyunda sadece **${ad}** oyuncusunun yazdıklarını yapıyor.` +
        (r.veri.hazir && !r.veri.oyunda ? ' (Seni şu an sunucuda göremiyor; girdiğinde dinler.)' : '') +
        nasil
    )
  }

  if (i.commandName === 'durdur') {
    denemeIptal(uid)
    depo.guncelle(uid, { calisiyordu: false })
    if (!yonetici.durdur(uid)) return i.reply('Botun zaten çalışmıyor.')
    return i.reply('Bot durduruluyor.')
  }

  if (i.commandName === 'durum') {
    const info = yonetici.bilgi(uid)
    if (!info) return i.reply('Botun çalışmıyor. Başlatmak için /baslat yaz.')
    await i.deferReply() // bot takılırsa 2,5 sn bekleriz: Discord'un 3 sn sınırı aşılmasın
    const r = await yonetici.istek(uid, 'durum')
    const s = r.veri || {}
    let oyun
    if (r.kod !== 200) oyun = 'Oyundaki durumu alınamadı.'
    else if (s.hazir === false) oyun = 'Henüz oyuna girmedi.'
    else {
      oyun =
        `Görev: ${s.aktif_gorev || 'yok'}${s.otonom ? ' (otonom)' : ''}` +
        ` | Can: ${Math.round(s.can)}/20 | Açlık: ${s.aclik}/20 | Boş slot: ${s.bos_slot}` +
        ` | Konum: ${s.konum.join(', ')}` +
        `\nSahip: ${s.sahip ? `**${s.sahip}**${s.sahip_gorunuyor ? '' : ' (şu an yakında değil)'}` : 'yok, `/sahip ad:OyunAdın` yaz'}`
    }
    return i.editReply(`Çalışıyor: **${info.host}:${info.port}** (${info.user}, ${info.auth})\n${oyun}`)
  }

  if (i.commandName === 'gorev') {
    if (!yonetici.calisiyor(uid)) return i.reply('Botun çalışmıyor. Önce /baslat yaz.')
    const komut = i.options.getString('gorev')
    await i.deferReply()
    const r = await yonetici.istek(uid, 'komut', { komut })
    if (r.kod !== 200) return i.editReply('Bota ulaşamadım: ' + (r.veri?.hata || r.kod))
    return i.editReply(`**${komut}** → ${r.veri.cevap || 'gönderildi'}`)
  }

  if (i.commandName === 'sandik') {
    if (!yonetici.calisiyor(uid)) return i.reply('Botun çalışmıyor. Önce /baslat yaz (sandıklar sunucu başına kaydedilir).')
    const islem = i.options.getString('islem')
    const xyz = ['x', 'y', 'z'].map((k) => i.options.getInteger(k))
    const verilen = xyz.filter((v) => v !== null).length
    if (verilen !== 0 && verilen !== 3) return i.reply('Koordinat yazacaksan x, y ve z üçünü de yaz.')
    await i.deferReply()
    const r = await yonetici.istek(uid, 'komut', { komut: ['sandik', islem, ...(verilen ? xyz : [])].join(' ') })
    if (r.kod !== 200) return i.editReply('Bota ulaşamadım: ' + (r.veri?.hata || r.kod))
    return i.editReply(r.veri.cevap)
  }

  if (i.commandName === 'soyle') {
    if (!depo.aiAktifMi(l)) {
      return i.reply('Lisansında yapay zeka yok (ya da süresi doldu). `/gorev` ve oyundaki `!komutlar` çalışır.')
    }
    if (!ayarlar.apiKey) return i.reply('Yapay zeka şu an kapalı (satıcı anahtar eklememiş).')
    if (!yonetici.calisiyor(uid)) return i.reply('Botun çalışmıyor. Önce /baslat yaz.')
    await i.deferReply()
    const metin = i.options.getString('metin')
    const r = await yonetici.istek(uid, 'soyle', { metin }, 90000)
    if (r.kod !== 200) return i.editReply('Yaren cevap veremedi: ' + (r.veri?.hata || r.kod))
    const govde = `> ${metin}\n**Yaren:** ${r.veri.cevap}`
    return i.editReply({
      content: govde.length > 2000 ? govde.slice(0, 1997) + '…' : govde, // uzun cevap kaybolmasın
      allowedMentions: { parse: [] },
    })
  }
}

async function odam(i) {
  const l = depo.bul(i.user.id)
  if (!l) return i.reply(gizli('Henüz lisansın yok. Key girmek için /key-gir yaz.'))
  if (!depo.aktifMi(l)) {
    if (l.durum === 'iptal') return i.reply(gizli('Lisansın satıcı tarafından iptal edildi, satıcıyla görüş.'))
    return i.reply(gizli(`Lisans süren doldu. ${l.kanalId ? `Odan: <#${l.kanalId}>. ` : ''}Yeni key: /key-gir`))
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  if (islemde.has(i.user.id)) return i.editReply('İşlemin sürüyor, biraz bekle.')
  islemde.add(i.user.id)
  try {
    const { kanal, yeni } = await odaHazirla(i.guild, l)
    return i.editReply(`${yeni ? 'Odan yeniden açıldı' : 'Odan'}: <#${kanal.id}>`)
  } catch (e) {
    return i.editReply('Odan açılamadı: ' + e.message)
  } finally {
    islemde.delete(i.user.id)
  }
}

async function bilgi(i) {
  const l = depo.bul(i.user.id)
  if (!l) return i.reply(gizli('Henüz lisansın yok. Key girmek için /key-gir yaz.'))
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  const aiBitis = l.aiBitis === undefined ? l.bitis : l.aiBitis
  const satir = [
    `Lisans: **${depo.aktifMi(l) ? 'aktif' : l.durum === 'iptal' ? 'iptal' : 'süresi dolmuş'}**`,
    `Bitiş: ${bitisDiscord(l)}`,
    `Yapay zeka: **${depo.aiAktifMi(l) && ayarlar.apiKey ? 'açık' : 'kapalı'}**` +
      (depo.aiAktifMi(l) && aiBitis !== l.bitis && aiBitis ? ` (bitiş: ${zaman(aiBitis, 'R')})` : ''),
    `Bot: **${yonetici.calisiyor(l.userId) ? 'çalışıyor' : 'kapalı'}**`,
  ]
  if (yonetici.calisiyor(l.userId)) {
    const r = await yonetici.istek(l.userId, 'durum')
    const k = r.veri?.ai_kullanim
    if (k && k.limit) satir.push(`Bugünkü yapay zeka kullanımı: **${k.gun === new Date().toLocaleDateString('sv-SE') ? k.sayi : 0}/${k.limit}**`)
  }
  if (l.kanalId) satir.push(`Odan: <#${l.kanalId}>`)
  return i.editReply(satir.join('\n'))
}

// ---------- SATICI İŞLEMLERİ ----------
// Hem slash komutları hem yönetim paneli bunları kullanır; hepsi cevap metni döndürür.
const etiket = (u) => u?.tag || u?.username || u?.id
const durumYazi = (l) => (depo.aktifMi(l) ? 'aktif' : l.durum === 'iptal' ? 'iptal' : 'süresi dolmuş')

function keyOlusturIslem(yapan, sure, adet, ai) {
  const keyler = depo.olustur({ sure, adet, ai })
  adminLog(`🆕 ${etiket(yapan)}: ${adet} key üretti (${sureYazi(sure)}, AI ${ai ? 'var' : 'yok'}).`)
  panelGuncelle()
  return (
    `${adet} key (${sureYazi(sure)}, yapay zeka ${ai ? 'dahil' : 'yok'}). Süre, key girildiği an başlar:\n` +
    '```\n' + keyler.join('\n') + '\n```\n' +
    '⚠️ Keyler bir daha gösterilmez (sadece özeti saklanır), şimdi kopyala.'
  )
}

// Key üretip kişiye DM ile gönderir; DM'leri kapalıysa keyi satıcıya gösterir
async function keyVerIslem(yapan, u, sure, ai) {
  if (u.bot) return 'Botlara key verilmez.'
  if (depo.bul(u.id)?.durum === 'iptal') {
    return 'Bu kişinin lisansı iptal edilmiş; key giremez. Önce süre uzatarak iptali kaldır.'
  }
  const [key] = depo.olustur({ sure, ai, direkt: true, alici: u.id })
  const onek = `\`${key.slice(0, 10)}…\``
  const kanal = paneller.keyKanalId ? ` (<#${paneller.keyKanalId}>)` : ''
  const gitti = await dmGonder(
    u.id,
    [
      `Merhaba! Sana **${sureYazi(sure)}** Yaren lisans keyi tanımlandı${ai ? ' (yapay zeka dahil)' : ''}:`,
      '```\n' + key + '\n```',
      mesajOkunur
        ? `Sunucudaki key kanalına${kanal} bu keyi yaz ya da **Key Gir** butonuna bas.`
        : `Sunucudaki key kanalında${kanal} **Key Gir** butonuna bas ve bu keyi yapıştır (ya da \`/key-gir\` yaz).`,
      'Keyin doğruysa sana özel odan açılır ve süren o andan saymaya başlar.',
    ].join('\n')
  )
  adminLog(`🎁 ${etiket(yapan)} → ${etiket(u)}: ${sureYazi(sure)} key ${onek} ${gitti ? 'DM ile gönderildi' : 'üretildi (DM kapalı)'}.`)
  panelGuncelle()
  return gitti
    ? `<@${u.id}> kişisine **${sureYazi(sure)}** key (${onek}) DM ile gönderildi. Keyi girdiği an odası açılacak.\nVazgeçersen: Key İptal → ${key.slice(0, 10)}`
    : `<@${u.id}> kişisinin DM'leri kapalı, keyi sen ilet:\n\`\`\`\n${key}\n\`\`\`\n⚠️ Bir daha gösterilmez, şimdi kopyala.`
}

async function lisansUzatIslem(guild, yapan, u, sure) {
  if (!depo.bul(u.id)) return 'Bu kullanıcının lisansı yok. Ona key ver.'
  const oncekiAi = depo.aiAktifMi(depo.bul(u.id))
  const l = depo.uzat(u.id, sure)
  aiDegistiyse(l, oncekiAi)
  panelGuncelle()
  // süresi bitip odası silindiyse yeniden açılır. Müşteri o an key girip /odam
  // yazıyorsa oda onun işleminde açılır (aynı anda iki oda açılmasın)
  let kanal = null
  if (!islemde.has(u.id)) {
    islemde.add(u.id)
    try {
      ;({ kanal } = await odaHazirla(guild, l))
      await kanal.send({ content: `<@${u.id}> lisansın uzatıldı. Yeni bitiş: ${bitisDiscord(l)}`, allowedMentions: { users: [u.id] } })
    } catch (e) {
      adminLog(`⚠️ ${etiket(u)} odası açılamadı: ${e.message}`)
    } finally {
      islemde.delete(u.id)
    }
  }
  adminLog(`⏩ ${etiket(yapan)}: ${etiket(u)} lisansı ${sureYazi(sure)} uzatıldı. Bitiş: ${bitisYazi(l)}`)
  return `${etiket(u)} yeni bitiş: ${bitisDiscord(l)}${kanal ? `\nOdası: <#${kanal.id}>` : ''}`
}

// nasil: 'bitir' (süre biter, yeni key girerse devam eder) | 'iptal' (bir daha key giremez)
async function lisansKapatIslem(yapan, u, nasil) {
  const l = depo.bul(u.id)
  if (!l) return 'Bu kullanıcının lisansı yok.'
  if (nasil === 'bitir' && !depo.aktifMi(l)) {
    return `Bu kişinin lisansı zaten ${l.durum === 'iptal' ? 'iptal edilmiş' : 'bitmiş'}.`
  }
  // o an key giriyor / odası açılıyorsa araya girme (yarım kalmış durum olmasın)
  if (islemde.has(u.id)) return 'Bu kişinin bir işlemi sürüyor (key giriyor olabilir), birkaç saniye sonra tekrar dene.'
  islemde.add(u.id)
  try {
    return await lisansKapat(yapan, u, nasil)
  } finally {
    islemde.delete(u.id)
  }
}
async function lisansKapat(yapan, u, nasil) {
  denemeIptal(u.id)
  if (nasil === 'iptal') depo.iptalEt(u.id)
  else depo.bitir(u.id)
  yonetici.durdur(u.id)
  panelGuncelle()
  const iptal = nasil === 'iptal'
  const ne = iptal ? 'lisansın satıcı tarafından iptal edildi' : 'lisansının süresi satıcı tarafından bitirildi'
  const silindi = await odaSil(depo.bul(u.id), iptal ? 'Lisans iptal edildi' : 'Lisans satıcı tarafından bitirildi')
  if (!silindi) await odayaBildir(depo.bul(u.id), `<@${u.id}> ${ne}, botun durduruldu.`, true)
  await dmGonder(
    u.id,
    `Yaren ${ne}, botun durduruldu${silindi ? ' ve odan kapatıldı' : ''}.` + (iptal ? '' : ' Yeni key girersen odan ayarlarınla geri açılır.')
  )
  adminLog(`${iptal ? '⛔' : '⏹️'} ${etiket(yapan)}: ${etiket(u)} ${iptal ? 'lisansını iptal etti' : 'lisansının süresini bitirdi'}.`)
  return `${etiket(u)} ${iptal ? 'lisansı iptal edildi' : 'lisansının süresi bitirildi'}${silindi ? ', odası silindi' : ''}.`
}

function keyListeMetni() {
  const { sayi, keyler } = depo.ozetListe()
  const son = keyler.slice(-50).reverse()
  const satirlar = son.map(
    (k) =>
      `\`${k.onek}…\` ${sureYazi(keySuresi(k))}${k.ai ? '' : ' (AI yok)'}${k.direkt ? (k.alici ? ` (DM → <@${k.alici}>)` : ' (DM)') : ''} — ` +
      (k.durum === 'kullanildi' ? `kullanıldı: <@${k.kullanan}>` : k.durum === 'iptal' ? 'iptal' : '**boşta**')
  )
  return satirlar.length
    ? sigdir(`Boşta: **${sayi.bos}** | Kullanılmış: **${sayi.kullanildi}** | İptal: **${sayi.iptal}**\nSon keyler:`, satirlar)
    : 'Henüz key yok.'
}

function lisansListeMetni() {
  const { lisanslar } = depo.ozetListe()
  if (!lisanslar.length) return 'Henüz müşteri yok.'
  const sirali = [...lisanslar].sort((a, b) => depo.aktifMi(b) - depo.aktifMi(a))
  const satirlar = sirali.map(
    (l) =>
      `<@${l.userId}> — ${depo.aktifMi(l) ? 'aktif' : l.durum === 'iptal' ? 'iptal' : 'bitti'}, ` +
      `${l.bitis === null ? 'süresiz' : (depo.aktifMi(l) ? 'bitiş ' : 'bitti ') + zaman(l.bitis, 'R')}, bot ${yonetici.calisiyor(l.userId) ? '🟢' : '⚪'}` +
      (l.kanalId ? ` <#${l.kanalId}>` : '')
  )
  const aktif = lisanslar.filter((l) => depo.aktifMi(l)).length
  return sigdir(`Aktif: **${aktif}** / ${lisanslar.length} | Çalışan bot: **${yonetici.sayi()}/${ayarlar.maxBot}**`, satirlar)
}

// Tek bir müşterinin bütün bilgisi (panelde "Kişi Sorgula")
function kisiBilgiMetni(userId) {
  const l = depo.bul(userId)
  if (!l) return `<@${userId}> kişisinin lisansı yok.`
  const aiBitis = l.aiBitis === undefined ? l.bitis : l.aiBitis
  const aiAcik = depo.aiAktifMi(l)
  return [
    `<@${userId}> (${l.kullaniciAdi})`,
    `Lisans: **${durumYazi(l)}** | Bitiş: ${bitisDiscord(l)}`,
    `Yapay zeka: **${aiAcik ? 'açık' : 'kapalı'}**` + (aiAcik && aiBitis && aiBitis !== l.bitis ? ` (bitiş: ${zaman(aiBitis, 'R')})` : ''),
    `Bot: **${yonetici.calisiyor(userId) ? 'çalışıyor' : 'kapalı'}**` + (l.son ? ` (son sunucu: ${l.son.host}:${l.son.port})` : ''),
    `Oda: ${l.kanalId ? `<#${l.kanalId}>` : 'yok'}`,
    `Kullandığı keyler (${(l.keyler || []).length}): ${(l.keyler || []).length > 20 ? '… ' : ''}${(l.keyler || []).slice(-20).map((k) => `\`${k}…\``).join(', ') || '-'}`,
    `İlk key: ${zaman(l.olusturma)}`,
  ].join('\n')
}

// ---------- SATICI KOMUTLARI ----------
async function saticiKomutu(i) {
  const sessiz = { allowedMentions: { parse: [] } }
  if (i.commandName === 'key-olustur') {
    const s = sureOku(i)
    if (s.hata) return i.reply(gizli(s.hata))
    const adet = i.options.getInteger('adet') ?? 1
    const ai = i.options.getBoolean('ai') ?? true
    return i.reply(gizli(keyOlusturIslem(i.user, s.sure, adet, ai)))
  }

  if (i.commandName === 'key-ver') {
    const s = sureOku(i)
    if (s.hata) return i.reply(gizli(s.hata))
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    return i.editReply({ content: await keyVerIslem(i.user, i.options.getUser('kullanici'), s.sure, i.options.getBoolean('ai') ?? true), ...sessiz })
  }

  if (i.commandName === 'key-liste') return i.reply({ ...gizli(keyListeMetni()), ...sessiz })

  if (i.commandName === 'key-iptal') {
    const m = depo.keyIptal(i.options.getString('key'))
    panelGuncelle()
    return i.reply(gizli(m))
  }

  if (i.commandName === 'lisanslar') return i.reply({ ...gizli(lisansListeMetni()), ...sessiz })

  if (i.commandName === 'lisans-uzat') {
    const s = sureOku(i)
    if (s.hata) return i.reply(gizli(s.hata))
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    return i.editReply({ content: await lisansUzatIslem(i.guild, i.user, i.options.getUser('kullanici'), s.sure), ...sessiz })
  }

  if (i.commandName === 'lisans-iptal' || i.commandName === 'lisans-bitir') {
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    const nasil = i.commandName === 'lisans-iptal' ? 'iptal' : 'bitir'
    return i.editReply({ content: await lisansKapatIslem(i.user, i.options.getUser('kullanici'), nasil), ...sessiz })
  }

  if (i.commandName === 'panel-kur') return panelKur(i)
  if (i.commandName === 'panel-kaldir') {
    if (!keyKanaliMi(i.channelId)) return i.reply(gizli('Bu kanal zaten key kanalı değil.'))
    paneller.keyKanallari = paneller.keyKanallari.filter((id) => id !== i.channelId)
    if (paneller.keyKanalId === i.channelId) paneller.keyKanalId = paneller.keyKanallari.at(-1) ?? null
    panelKaydet()
    return i.reply(gizli('Bu kanal artık key kanalı değil: yazılanlar silinmez. Eski "Key Gir" panel mesajını kendin silebilirsin.'))
  }
  if (i.commandName === 'yonetim-kur') return yonetimKur(i)
}

// ---------- KEY KANALI (müşteri paneli) ----------
// /panel-kur yazılan kanal key kanalı olur: "Key Gir" butonu durur, müşteri
// keyini kanala mesaj olarak da yazabilir. Yazılan mesaj hemen silinir (key
// başkası tarafından görülmesin), cevap birkaç saniye sonra kendiliğinden kalkar.
const PANEL_DOSYA = path.join(VERI_DIR, 'paneller.json')
// { keyKanalId (en son kurulan), keyKanallari: [...], yonetimKanalId, yonetimMesajId }
let paneller = {}
try {
  paneller = JSON.parse(fs.readFileSync(PANEL_DOSYA, 'utf-8').replace(/^\uFEFF/, '')) || {}
} catch (e) {
  if (e.code !== 'ENOENT') {
    setImmediate(() =>
      adminLog(`⚠️ paneller.json okunamadı (${e.message}). Key kanalında /panel-kur, yönetim kanalında /yonetim-kur'u tekrar yaz.`)
    )
  }
}
// /panel-kur birden çok kanalda yazıldıysa hepsi key kanalıdır (eski panel metni de "buraya yaz" diyor)
paneller.keyKanallari = [...new Set([...(paneller.keyKanallari || []), paneller.keyKanalId].filter(Boolean))].filter(
  (id) => id !== LOG_CHANNEL_ID
)
const keyKanaliMi = (id) => paneller.keyKanallari.includes(id)
function panelKaydet() {
  try {
    fs.mkdirSync(VERI_DIR, { recursive: true })
    fs.writeFileSync(PANEL_DOSYA + '.tmp', JSON.stringify(paneller, null, 2), 'utf-8')
    fs.renameSync(PANEL_DOSYA + '.tmp', PANEL_DOSYA)
  } catch (e) {
    console.error('Panel ayarı kaydedilemedi:', e.message)
  }
}

// Kanal herkese açık mı: @everyone ya da yönetici/yetkili olmayan herhangi bir rol
// (ör. kayıtlı sunuculardaki "Üye" rolü) görebiliyorsa açık sayılır
function herkeseAcik(kanal, guild) {
  if (!kanal?.permissionsFor) return true
  const gorur = (r) => kanal.permissionsFor(r)?.has(PermissionFlagsBits.ViewChannel) !== false
  if (gorur(guild.roles.everyone)) return true
  const roller = guild.roles.cache ? [...guild.roles.cache.values()] : []
  return roller.some(
    (r) =>
      r.id !== guild.roles.everyone.id &&
      r.id !== yetkiliRol?.id &&
      !r.managed && // botların kendi rolleri
      !r.permissions?.has(PermissionFlagsBits.Administrator) &&
      gorur(r)
  )
}

async function panelKur(i) {
  if (i.channelId === LOG_CHANNEL_ID) return i.reply(gizli('Log kanalı key kanalı olamaz (oradaki mesajlar silinirdi). Müşterilerin göreceği ayrı bir kanalda yaz.'))
  const embed = new EmbedBuilder()
    .setTitle('Yaren — Minecraft Yardımcı Botu')
    .setColor(0x2ecc71)
    .setDescription(
      [
        'Oyunda senin için odun keser, taş kırar, tarla toplar. Türkçe konuşur, istersen kendi karar verir.',
        '',
        '**Keyini nasıl girerim?**',
        mesajOkunur
          ? '• Keyini **bu kanala yaz** (mesajın hemen silinir, kimse görmez) ya da aşağıdaki **Key Gir** butonuna bas.'
          : '• Aşağıdaki **Key Gir** butonuna bas ve keyini yaz.',
        '• Key doğruysa sana özel bir oda açılır (sadece sen ve satıcı görür), süren o an başlar.',
        '• Key yanlışsa ya da kullanılmışsa oda açılmaz, nedeni yazılır.',
        '',
        'Odanda `/baslat host:sunucu.adresi` yaz, bot girince `/sahip ad:OyunAdın` yaz: bot oyunda senin yazdıklarını yapar. Süren bitince odan kapanır; yeni key girersen ayarlarınla geri gelir.',
      ].join('\n')
    )
  const buton = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('key_gir').setLabel('Key Gir').setEmoji('🔑').setStyle(ButtonStyle.Success)
  )
  const ch = i.channel ?? (await client.channels.fetch(i.channelId).catch(() => null))
  try {
    await ch.send({ embeds: [embed], components: [buton] })
  } catch (e) {
    return i.reply(gizli(`Bu kanala yazamıyorum (${e.message}). Botun burada "Mesaj Gönder" ve "Bağlantı Yerleştir" izni olmalı.`))
  }
  paneller.keyKanalId = ch.id
  paneller.keyKanallari = [...new Set([...paneller.keyKanallari, ch.id])].slice(-10)
  panelKaydet()
  const notlar = ['Panel kuruldu, bu kanal artık key kanalı.']
  if (!mesajOkunur) {
    notlar.push(
      '⚠️ Message Content Intent kapalı: müşteriler şimdilik sadece **Key Gir** butonuyla girebilir. Keyi kanala yazarak girebilsinler diye Developer Portal > Bot > **Message Content Intent**i aç ve botu yeniden başlat.'
    )
  }
  const benim = client.user && ch.permissionsFor?.(client.user)
  if (benim && !benim.has(PermissionFlagsBits.ManageMessages)) {
    notlar.push('⚠️ Botun bu kanalda **Mesajları Yönet** izni yok: kanala yazılan keyleri silemez (herkes görür). İzni ver.')
  }
  return i.reply(gizli(notlar.join('\n')))
}

const silmeUyarisi = { verildi: false }
const sonYazma = new Map() // userId -> zaman: kanala art arda yazanlara her seferinde cevap verme
async function geciciCevap(kanal, userId, content, sn) {
  const m = await kanal.send({ content, allowedMentions: { users: [userId] } }).catch(() => null)
  if (m) setTimeout(() => m.delete().catch(() => {}), sn * 1000)
}

const KEY_RE = /YAREN[\s-]*(?:[A-Z0-9]{4}[\s-]*){4}/i

// gecmis: açılışta işlenen, bot kapalıyken yazılmış mesaj
async function keyMesaji(m, gecmis = false) {
  if (!keyKanaliMi(m.channelId)) return
  if (m.guildId !== GUILD_ID || m.author?.bot || m.system || m.webhookId) return
  const metin = (m.content || '').trim()
  const key = metin.match(KEY_RE)?.[0]
  // satıcı ve yetkililer kanala duyuru/açıklama yazabilir (key değilse dokunulmaz)
  if (!key && adminMi({ user: m.author, member: m.member })) return
  // Mesajı hemen sil (key kimse tarafından görülmesin) ama silinmesini bekleme:
  // key, silme sırası beklerken başkası kopyalayıp girmeden sahibine işlensin
  m.delete().catch(() => {
    if (silmeUyarisi.verildi) return
    silmeUyarisi.verildi = true
    adminLog('⚠️ Key kanalındaki mesajları silemiyorum: botun o kanalda "Mesajları Yönet" izni olmalı (yoksa yazılan keyleri herkes görür).')
  })
  if (!gecmis) await birikmisHazir
  if (key) {
    // keyler hiç atlanmaz; yanlış key denemesi sınırı ve işlem kilidi keyIsle'de
    const r = await keyIsle(m.author, m.guild, key)
    await geciciCevap(m.channel, m.author.id, `<@${m.author.id}> ${r.ok ? '✅' : '❌'} ${r.metin}`, r.ok ? 30 : 20)
    if (r.ok) await dmGonder(m.author.id, `Yaren: ${r.metin}`)
    return
  }
  // key olmayan mesajlara art arda cevap verme (kanal dolmasın, Discord sınırına takılmasın)
  const zamani = m.createdTimestamp || Date.now()
  const once = sonYazma.get(m.author.id)
  sonYazma.set(m.author.id, zamani)
  if (once && zamani - once < 3000) return
  if (!metin) {
    // Message Content Intent kapalıysa yazılanı göremeyiz
    return geciciCevap(m.channel, m.author.id, `<@${m.author.id}> keyini girmek için yukarıdaki **Key Gir** butonuna bas.`, 15)
  }
  return geciciCevap(
    m.channel,
    m.author.id,
    `<@${m.author.id}> bu kanala sadece keyini yaz (YAREN-XXXX-XXXX-XXXX-XXXX) ya da **Key Gir** butonuna bas.`,
    15
  )
}
client.on(Events.MessageCreate, (m) => keyMesaji(m).catch((e) => console.error('Key kanalı:', e)))

// Bot kapalıyken key kanalına yazılanlar (silinmemiş, cevapsız kalmış keyler)
async function kacanKeyMesajlari() {
  for (const id of paneller.keyKanallari) {
    try {
      const kanal = await kanalGetir(id)
      if (!kanal?.messages) continue
      const hepsi = [...(await kanal.messages.fetch({ limit: 50 })).values()]
      const benim = (m) => m.author?.id === client.user.id
      // kapanmadan silinemeyen kendi geçici cevaplarımız ("<@kişi> ..." ile başlar; panel kalır)
      for (const m of hepsi) {
        if (benim(m) && !m.embeds?.length && !m.components?.length && /^<@\d+> /.test(m.content || '')) m.delete().catch(() => {})
      }
      // sadece panel kurulduktan sonra yazılanlar: kanalın eski mesajlarına ve sabitlenmişlere dokunma.
      // Panel son 50 mesajda yoksa hepsi ondan sonra yazılmıştır.
      const sinir = Math.max(0, ...hepsi.filter((m) => benim(m) && m.components?.length).map((m) => m.createdTimestamp || 0))
      const mesajlar = hepsi
        .filter((m) => !m.author?.bot && !m.pinned && (m.createdTimestamp || 0) >= sinir)
        .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
      for (const m of mesajlar) await keyMesaji(m, true).catch((e) => console.error('Key kanalı:', e))
    } catch (e) {
      console.error(`Key kanalı okunamadı (${id}):`, e.message)
    }
  }
}
setInterval(() => {
  const once = Date.now() - 60000
  for (const [id, t] of sonYazma) if (t < once) sonYazma.delete(id)
}, 60000)

// ---------- YÖNETİM PANELİ ----------
// /yonetim-kur: satıcıya özel kanalda butonlu panel. Panel mesajı canlı bir
// tablo: bütün aktif lisanslar ve kalan süreleri (Discord kendisi geri sayar).
function yonetimEmbed() {
  const { sayi, lisanslar } = depo.ozetListe()
  const simdi = Date.now()
  const aktif = lisanslar.filter((l) => depo.aktifMi(l, simdi))
  const sirali = [...aktif].sort((a, b) => (a.bitis ?? Infinity) - (b.bitis ?? Infinity))
  const satirlar = sirali.map(
    (l) =>
      `${yonetici.calisiyor(l.userId) ? '🟢' : '⚪'} <@${l.userId}> — ` +
      (l.bitis === null ? 'süresiz' : `bitiş ${zaman(l.bitis, 'R')}`) +
      (l.kanalId ? ` <#${l.kanalId}>` : '')
  )
  const ust = [
    `Aktif lisans: **${aktif.length}** | Biten/iptal: **${lisanslar.length - aktif.length}** | Boşta key: **${sayi.bos}** | Çalışan bot: **${yonetici.sayi()}/${ayarlar.maxBot}**`,
    '',
    '**Süre takibi** (en önce biten üstte, 🟢 bot çalışıyor):',
  ].join('\n')
  return new EmbedBuilder()
    .setTitle('Yaren Yönetim Paneli')
    .setColor(0x3498db)
    .setDescription(satirlar.length ? sigdir(ust, satirlar, 3900) : ust + '\nHenüz aktif lisans yok.')
    .setFooter({ text: 'Süreler canlı sayılır. Butonları sadece satıcı ve yetkililer kullanabilir.' })
    .setTimestamp(simdi)
}

function yonetimButonlari() {
  const b = (id, ad, emoji, stil = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId('yp:' + id).setLabel(ad).setEmoji(emoji).setStyle(stil)
  return [
    new ActionRowBuilder().addComponents(
      b('ver', 'Key Ver', '🎁', ButtonStyle.Success),
      b('olustur', 'Key Oluştur', '🔑', ButtonStyle.Primary),
      b('uzat', 'Süre Uzat', '⏩', ButtonStyle.Primary),
      b('bitir', 'Lisans Bitir', '⛔', ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      b('sorgula', 'Kişi Sorgula', '🔍'),
      b('lisanslar', 'Lisanslar', '📋'),
      b('keyler', 'Keyler', '🗝️'),
      b('keyiptal', 'Key İptal', '🗑️'),
      b('yenile', 'Yenile', '🔄')
    ),
  ]
}

// Panel mesajını günceller. Çok sık değişiklikte en fazla 10 sn'de bir düzenler.
let panelZamanlayici = null
let panelSon = 0
function panelGuncelle() {
  if (!paneller.yonetimMesajId || panelZamanlayici) return
  const bekle = Math.max(0, panelSon + 10000 - Date.now())
  panelZamanlayici = setTimeout(async () => {
    panelZamanlayici = null
    panelSon = Date.now()
    if (!client.isReady()) return
    try {
      const kanal = await kanalGetir(paneller.yonetimKanalId)
      const mesaj = kanal && (await kanal.messages.fetch(paneller.yonetimMesajId).catch((e) => (e.code === 10008 ? null : Promise.reject(e))))
      if (!mesaj) {
        // panel ya da kanalı silinmiş
        paneller.yonetimMesajId = null
        panelKaydet()
        return
      }
      await mesaj.edit({ embeds: [yonetimEmbed()], components: yonetimButonlari(), allowedMentions: { parse: [] } })
    } catch (e) {
      console.error('Yönetim paneli güncellenemedi:', e.message)
    }
  }, bekle)
}
setInterval(panelGuncelle, 5 * 60000) // bot durumları (🟢/⚪) için

async function yonetimKur(i) {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  const guild = i.guild
  let kanal = i.channel ?? (await client.channels.fetch(i.channelId).catch(() => null))
  let yeniKanal = false
  let eskiKanal = false
  // daha önce açılan özel yönetim kanalı duruyorsa yenisini açma, onu kullan
  if (!kanal || herkeseAcik(kanal, guild)) {
    const onceki = await kanalGetir(paneller.yonetimKanalId).catch(() => null)
    if (onceki && !herkeseAcik(onceki, guild)) {
      kanal = onceki
      eskiKanal = true
    }
  }
  // Panelde müşteri listesi var: herkese açık kanala değil, sana özel kanala kur
  if (!kanal || herkeseAcik(kanal, guild)) {
    const izin = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    try {
      kanal = await guild.channels.create({
        name: 'yaren-yonetim',
        type: ChannelType.GuildText,
        topic: 'Yaren yönetim paneli: sadece satıcı ve yetkililer görür',
        permissionOverwrites: [
          { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          { id: client.user.id, type: OverwriteType.Member, allow: [...izin, PermissionFlagsBits.EmbedLinks] },
          { id: ADMIN_ID, type: OverwriteType.Member, allow: [...izin, PermissionFlagsBits.UseApplicationCommands] },
          ...(yetkiliRol ? [{ id: yetkiliRol.id, type: OverwriteType.Role, allow: [...izin, PermissionFlagsBits.UseApplicationCommands] }] : []),
        ],
      })
      yeniKanal = true
    } catch (e) {
      return i.editReply(`Yönetim kanalı açılamadı (${e.message}). Sadece senin görebildiğin bir kanalda tekrar /yonetim-kur yaz.`)
    }
  }
  // eski panel mesajını kaldır (butonları yine çalışırdı ama kafa karıştırmasın)
  if (paneller.yonetimMesajId) {
    const eski = await kanalGetir(paneller.yonetimKanalId).catch(() => null)
    await eski?.messages
      ?.fetch(paneller.yonetimMesajId)
      .then((m) => m.delete())
      .catch(() => {})
  }
  let mesaj
  try {
    mesaj = await kanal.send({ embeds: [yonetimEmbed()], components: yonetimButonlari(), allowedMentions: { parse: [] } })
  } catch (e) {
    return i.editReply(`Panel bu kanala yazılamadı (${e.message}). Botun "Mesaj Gönder" ve "Bağlantı Yerleştir" izni olmalı.`)
  }
  paneller.yonetimKanalId = kanal.id
  paneller.yonetimMesajId = mesaj.id
  panelKaydet()
  return i.editReply(
    `Yönetim paneli kuruldu: <#${kanal.id}>` +
      (yeniKanal
        ? '\nBu kanal herkese açık olduğu için panel sana (ve yetkililere) özel yeni bir kanala kuruldu.'
        : eskiKanal
          ? '\nBu kanal herkese açık olduğu için panel senin yönetim kanalına kuruldu.'
          : '')
  )
}

// ---- panel formları ----
const BIRIMLER = [
  { label: 'saat', value: 'saat' },
  { label: 'gün', value: 'gun', default: true },
  { label: 'hafta', value: 'hafta' },
  { label: 'ay (30 gün)', value: 'ay' },
  { label: 'süresiz', value: 'suresiz' },
]
const kisiSec = (l) =>
  l.setLabel('Kişi').setUserSelectMenuComponent((s) => s.setCustomId('kisi').setMinValues(1).setMaxValues(1))
const birimSec = (l) =>
  l.setLabel('Süre birimi').setStringSelectMenuComponent((s) => s.setCustomId('birim').addOptions(...BIRIMLER))
const miktarYaz = (l) =>
  l
    .setLabel('Kaç saat / gün / hafta / ay?')
    .setDescription('Süresiz seçtiysen boş bırak')
    .setTextInputComponent((t) => t.setCustomId('miktar').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder('30'))
const aiSec = (l) =>
  l
    .setLabel('Yapay zeka dahil mi?')
    .setStringSelectMenuComponent((s) =>
      s.setCustomId('ai').addOptions({ label: 'Evet', value: 'evet', default: true }, { label: 'Hayır', value: 'hayir' })
    )
const adetYaz = (l) =>
  l
    .setLabel('Kaç key? (1-25)')
    .setTextInputComponent((t) => t.setCustomId('adet').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2).setValue('1'))
const form = (id, baslik, ...parcalar) =>
  new ModalBuilder()
    .setCustomId('ypm:' + id)
    .setTitle(baslik)
    .addLabelComponents(...parcalar)

const FORMLAR = {
  ver: () => form('ver', 'Key Ver (DM ile gider)', kisiSec, birimSec, miktarYaz, aiSec),
  olustur: () => form('olustur', 'Key Oluştur', birimSec, miktarYaz, adetYaz, aiSec),
  uzat: () => form('uzat', 'Süre Uzat', kisiSec, birimSec, miktarYaz),
  bitir: () =>
    form('bitir', 'Lisans Bitir', kisiSec, (l) =>
      l.setLabel('Nasıl?').setStringSelectMenuComponent((s) =>
        s.setCustomId('nasil').addOptions(
          { label: 'Süresini şimdi bitir', description: 'Yeni key girerse devam edebilir', value: 'bitir', default: true },
          { label: 'İptal et (yasakla)', description: 'Bir daha key giremez', value: 'iptal' }
        )
      )
    ),
  sorgula: () => form('sorgula', 'Kişi Sorgula', kisiSec),
  keyiptal: () =>
    form('keyiptal', 'Key İptal', (l) =>
      l
        .setLabel('Key ya da öneki')
        .setDescription('Henüz kullanılmamış key: tam key ya da YAREN-XXXX')
        .setTextInputComponent((t) => t.setCustomId('key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40))
    ),
}

// Onay butonu bu sürümle eşleşmezse lisans arada değişmiş demektir
const lisansSurumu = (l) => (l ? `${l.durum}.${l.bitis ?? 's'}.${(l.keyler || []).length}` : 'yok')

// Formdaki sayı alanı: boşsa null, sayı değilse NaN (sureCoz reddeder)
const sayiAl = (v) => (String(v ?? '').trim() === '' ? null : /^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN)

async function yonetimEtkilesim(i) {
  const [tur, ne, ...ek] = i.customId.split(':')
  const sessiz = { allowedMentions: { parse: [] } }

  if (i.isButton() && tur === 'yp') {
    if (FORMLAR[ne]) return i.showModal(FORMLAR[ne]())
    if (ne === 'lisanslar') return i.reply({ ...gizli(lisansListeMetni()), ...sessiz })
    if (ne === 'keyler') return i.reply({ ...gizli(keyListeMetni()), ...sessiz })
    if (ne === 'yenile') return i.update({ embeds: [yonetimEmbed()], components: yonetimButonlari(), ...sessiz })
    if (ne === 'vazgec') return i.update({ content: 'Vazgeçildi.', components: [] })
    return
  }

  // "Emin misin?" onayı: ypo:bitir:<userId>:<bitir|iptal>:<lisans sürümü>
  if (i.isButton() && tur === 'ypo' && ne === 'bitir') {
    const [uid, nasil, surum] = ek
    // onay ekranı açıkken kişi yeni key girdiyse ya da başka biri bitirdiyse eski onayla işlem yapma
    if (lisansSurumu(depo.bul(uid)) !== surum) {
      return i.update({ content: 'Bu arada lisans değişti (yeni key, uzatma ya da bitirme). Panelden tekrar seç.', components: [] })
    }
    await i.deferUpdate()
    const u = await client.users.fetch(uid).catch(() => ({ id: uid }))
    return i.editReply({ content: await lisansKapatIslem(i.user, u, nasil === 'iptal' ? 'iptal' : 'bitir'), components: [], ...sessiz })
  }

  if (!i.isModalSubmit() || tur !== 'ypm') return
  const f = i.fields
  const kisi = () => f.getSelectedUsers('kisi')?.first() ?? null
  const sure = () => sureCoz(f.getStringSelectValues('birim')[0], sayiAl(f.getTextInputValue('miktar')))
  const ai = () => (f.getStringSelectValues('ai')[0] ?? 'evet') === 'evet'

  if (ne === 'olustur') {
    const s = sure()
    if (s.hata) return i.reply(gizli(s.hata))
    const adet = sayiAl(f.getTextInputValue('adet')) ?? 1
    if (!Number.isInteger(adet) || adet < 1 || adet > 25) return i.reply(gizli('Key sayısı 1 ile 25 arasında olmalı.'))
    return i.reply(gizli(keyOlusturIslem(i.user, s.sure, adet, ai())))
  }
  if (ne === 'keyiptal') {
    const m = depo.keyIptal(f.getTextInputValue('key'))
    panelGuncelle()
    return i.reply(gizli(m))
  }

  const u = kisi()
  if (!u) return i.reply(gizli('Bir kişi seç.'))
  if (ne === 'sorgula') return i.reply({ ...gizli(kisiBilgiMetni(u.id)), ...sessiz })
  if (ne === 'bitir') {
    const nasil = f.getStringSelectValues('nasil')[0] === 'iptal' ? 'iptal' : 'bitir'
    const l = depo.bul(u.id)
    if (!l) return i.reply(gizli('Bu kişinin lisansı yok.'))
    const ne2 = nasil === 'iptal' ? '**iptal etmek** (bir daha key giremez)' : '**süresini şimdi bitirmek** (yeni key girerse devam eder)'
    const surum = lisansSurumu(l)
    return i.reply({
      ...gizli(`<@${u.id}> lisansını ${ne2} istediğine emin misin? Botu durur, odası silinir.`),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`ypo:bitir:${u.id}:${nasil}:${surum}`).setLabel('Evet').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('yp:vazgec').setLabel('Vazgeç').setStyle(ButtonStyle.Secondary)
        ),
      ],
      ...sessiz,
    })
  }
  const s = sure()
  if (s.hata) return i.reply(gizli(s.hata))
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  if (ne === 'ver') return i.editReply({ content: await keyVerIslem(i.user, u, s.sure, ai()), ...sessiz })
  if (ne === 'uzat') return i.editReply({ content: await lisansUzatIslem(i.guild, i.user, u, s.sure), ...sessiz })
}

// ---------- SÜRE TAKİBİ ----------
// Müşterinin odasına mesaj atar; kilit verilirse odayı kilitler/açar.
// Hata fırlatmaz: bir müşterinin odasındaki sorun diğerlerini etkilemesin.
async function odayaBildir(l, content, kilit) {
  try {
    const kanal = await kanalGetir(l.kanalId)
    if (!kanal) return
    if (kilit !== undefined) {
      await odaKilit(kanal, l.userId, kilit).catch((e) =>
        adminLog(`⚠️ ${l.kullaniciAdi} odası ${kilit ? 'kilitlenemedi' : 'açılamadı'}: ${e.message}`)
      )
    }
    await kanal.send({ content, allowedMentions: { users: [l.userId] } })
  } catch (e) {
    console.error(`Odaya yazılamadı (${l.kullaniciAdi}):`, e.message)
  }
}

async function zamanKontrol() {
  const { dolan, yaklasan, sonSaat, aiDolan } = depo.zamanKontrol()
  if (dolan.length || aiDolan.length) panelGuncelle()
  for (const l of aiDolan) {
    adminLog(`🤖 ${l.kullaniciAdi} (${l.userId}) yapay zeka süresi doldu.`)
    if (yonetici.calisiyor(l.userId)) {
      yenidenBaslat.add(l.userId) // yapay zekasız olarak hemen geri gelir
      yonetici.durdur(l.userId)
    }
    await odayaBildir(
      l,
      `<@${l.userId}> yapay zeka süren doldu; botun yapay zekasız devam ediyor (\`!komutlar\` ve /gorev çalışır). Yapay zekalı key girersen tekrar açılır.`
    )
  }
  for (const l of dolan) {
    // önceki odalar silinirken bu kişi yeni key girmiş olabilir
    if (depo.aktifMi(depo.bul(l.userId))) continue
    denemeIptal(l.userId)
    yonetici.durdur(l.userId)
    adminLog(`⌛ ${l.kullaniciAdi} (${l.userId}) lisansı doldu.`)
    if (ODA_SILME_SAAT === 0) {
      const silindi = await odaSil(l, 'Lisans süresi doldu')
      if (depo.aktifMi(depo.bul(l.userId))) continue
      // silinemediyse (izin yok, Discord'a ulaşılamadı) en azından yazamasın
      if (!silindi) {
        await odayaBildir(l, `<@${l.userId}> lisans süren doldu, botun durduruldu. Yeni key girersen (/key-gir) kaldığın yerden devam edersin.`, true)
      }
      await dmGonder(
        l.userId,
        `Yaren lisans süren doldu, botun durduruldu${silindi ? ' ve odan kapatıldı' : ''}. Yeni key girersen (panelde Key Gir) odan ayarlarınla birlikte geri açılır.`
      )
    } else {
      await odayaBildir(
        l,
        `<@${l.userId}> lisans süren doldu, botun durduruldu. Bu oda ${ODA_SILME_SAAT} saat sonra silinecek. Yeni key girersen (/key-gir) kaldığın yerden devam edersin.`,
        true
      )
    }
  }
  const sonra = ODA_SILME_SAAT === 0 ? ' Süre bitince bu oda silinir.' : ''
  for (const l of yaklasan) {
    await odayaBildir(
      l,
      `<@${l.userId}> lisans süren ${zaman(l.bitis, 'R')} doluyor (${zaman(l.bitis)}).${sonra} Uzatmak için yeni key girebilirsin.`
    )
  }
  for (const l of sonSaat) {
    await odayaBildir(l, `<@${l.userId}> ⏰ lisans süren ${zaman(l.bitis, 'R')} bitiyor!${sonra}`)
  }
  // Güvenlik ağı: lisansı bitmiş/iptal edilmiş ama bir şekilde çalışan bot kalmasın
  for (const l of depo.ozetListe().lisanslar) {
    if (yonetici.calisiyor(l.userId) && !depo.aktifMi(l)) {
      denemeIptal(l.userId)
      yonetici.durdur(l.userId)
      adminLog(`⏹️ ${l.kullaniciAdi} lisansı kapalı olduğu halde çalışan botu durduruldu.`)
    }
  }
}
setInterval(() => zamanKontrol().catch((e) => console.error('Süre kontrolü:', e.message)), 60000)

// Müşterinin odasını siler. Lisans kaydı (ayarlar, sandıklar, deneyim) kalır;
// yeni key girerse odası yeniden açılır.
const silinemeyen = new Set() // her 10 dakikada aynı hatayla log kanalını doldurmasın
async function odaSil(l, neden) {
  if (!l?.kanalId) return false
  const kanalId = l.kanalId
  try {
    const kanal = await kanalGetir(kanalId) // geçici hatada fırlatır: kayıt silinmez
    // beklerken yeni key girilmiş ya da oda değişmiş olabilir
    const guncel = depo.bul(l.userId)
    if (!guncel || guncel.kanalId !== kanalId || depo.aktifMi(guncel)) return false
    if (kanal) await kanal.delete(neden)
    depo.kanalAyarla(l.userId, null)
    kuyruklar.delete(kanalId)
    silinemeyen.delete(kanalId)
    adminLog(`🗑️ ${l.kullaniciAdi} odası silindi (${neden}).`)
    return true
  } catch (e) {
    if (!silinemeyen.has(kanalId)) {
      silinemeyen.add(kanalId)
      adminLog(`⚠️ ${l.kullaniciAdi} odası silinemedi: ${e.message} (botun bu kanalı yönetme izni var mı?)`)
    }
    return false
  }
}

// Süresi biteli / iptal edileli oda_silme_saat kadar olan odaları sil. Hemen
// silmede (0) ilk denemede silinemeyenleri (Discord'a o an ulaşılamadı) toplar.
async function eskiOdalariSil() {
  const simdi = Date.now()
  for (const l of depo.ozetListe().lisanslar) {
    if (!l.kanalId || depo.aktifMi(l, simdi)) continue
    const bitti = l.durum === 'iptal' ? l.iptalZamani : l.bitis
    if (bitti && simdi - bitti < ODA_SILME_SAAT * SAAT) continue
    await odaSil(l, ODA_SILME_SAAT ? `Lisans ${ODA_SILME_SAAT} saattir kapalı` : 'Lisans kapalı')
  }
}
setInterval(() => eskiOdalariSil().catch((e) => console.error('Oda temizliği:', e.message)), 10 * 60000)

// Key kanalına yazılan keyi okuyabilmek için Message Content Intent lazım.
// Developer Portal'da kapalıyken istersek Discord bağlantıyı hiç kabul etmez,
// o yüzden önce açık mı diye bakılır; kapalıysa sadece buton çalışır.
async function girisYap() {
  try {
    client.rest.setToken(DISCORD_TOKEN.replace(/^(Bot|Bearer)\s*/i, ''))
    const uygulama = await client.rest.get(Routes.currentApplication())
    const bayrak = Number(uygulama?.flags || 0)
    mesajOkunur = !!(bayrak & (ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited))
  } catch (e) {
    console.error('Bot bilgisi alınamadı (token yanlış olabilir):', e.message)
  }
  if (mesajOkunur) {
    client.options.intents = new IntentsBitField(client.options.intents.bitfield | GatewayIntentBits.MessageContent).freeze()
  } else {
    console.log('Not: Message Content Intent kapalı; müşteriler keyi kanala yazarak değil, "Key Gir" butonuyla girer.')
  }
  await client.login(DISCORD_TOKEN)
}
girisYap().catch((e) => {
  console.error('Discord girişi başarısız (token yanlış olabilir):', e.message)
  process.exit(1)
})
