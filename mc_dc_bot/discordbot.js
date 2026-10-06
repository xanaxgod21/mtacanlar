// Discord kontrol botu (satış sürümü)
//
// Nasıl çalışır:
//  1. Sen (satıcı) /key-olustur ile key üretip müşteriye verirsin.
//  2. Müşteri panelde "Key Gir" butonuna basar (ya da /key-gir yazar).
//  3. Bot ona özel bir oda açar: odayı sadece o, sen ve bot görür.
//  4. Müşteri kendi odasında /baslat /durdur /durum /gorev /soyle /bilgi
//     kullanır. Botunun bütün logları o odaya düşer.
//  5. Süre dolunca botu durur, odası kilitlenir. Yeni key girerse süresi uzar.
//
// Kurulum: npm install, ayarlar.ornek.json -> ayarlar.json, node discordbot.js
// Botu sunucuna davet ederken şu izinleri ver (en kolayı Yönetici): Kanalları
// Gör, Mesaj Gönder, Mesaj Geçmişini Oku, Bağlantı Yerleştir, Kanalları Yönet,
// Rolleri Yönet. Ardından bir kanalda /panel-kur yaz.

const net = require('net')
const path = require('path')
const {
  Client,
  Events,
  GatewayIntentBits,
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
const { LisansDeposu, bitisYazi, GUN } = require('./lisans')
const { BotYonetici, hedefKontrol } = require('./botyonetici')

// ---------- AYARLAR ----------
// Hepsi ayarlar.json'dan (ya da aynı isimli ortam değişkenlerinden) okunur.
// Token'ı ASLA koda yazma: kodu paylaşınca token da gider.
const DISCORD_TOKEN = ayarlar.discordToken    // Developer Portal > Bot > Token
const GUILD_ID = ayarlar.guildId              // Discord sunucunun ID'si
const LOG_CHANNEL_ID = ayarlar.logKanalId     // satıcı logu: satışlar, başlatmalar, hatalar
const ADMIN_ID = ayarlar.discordSahipId       // satıcı (sen): key üretir, her odaya girer
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
  depo = new LisansDeposu(path.join(VERI_DIR, 'lisanslar.json'), (m) => adminLog(m))
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
const client = new Client({ intents: [GatewayIntentBits.Guilds] })
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
const adminMi = (userId) => userId === ADMIN_ID

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
  ]
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
    `Lisans bitişi: **${bitisYazi(l)}** | Yapay zeka: **${depo.aiAktifMi(l) && ayarlar.apiKey ? 'açık' : 'kapalı'}**`,
    '',
    '**Başlamak için:** `/baslat host:sunucu.adresi sahip:OyundakiAdın`',
    '`sahip`: botun oyunda sadece senin komutlarını dinlemesi için senin Minecraft adın.',
    'Bir kere yazman yeter, sonraki seferlerde sadece `/baslat` yazabilirsin.',
    '',
    'Diğer komutlar: `/gorev` `/durum` `/sandik` `/soyle` `/durdur` `/bilgi`',
    'Oyun içinde: `!odun` `!tas` `!farm` `!topla` `!bosalt` `!gel` `!dur` `!durum` `!otonom`, ya da "Yaren ..." diye konuş.',
    '**Sandık:** oyunda sandığın dibinde dur ve `!sandik ekle` yaz. Bot envanteri yarı dolunca topladıklarını oraya bırakır, baltası kırılmak üzereyse oradan yenisini alır.',
  ].join('\n')
}

// Müşterinin odası yoksa açar, varsa kilidini açar
async function odaHazirla(guild, l) {
  let kanal = await kanalGetir(l.kanalId)
  if (kanal) {
    await odaKilit(kanal, l.userId, false)
    return { kanal, yeni: false }
  }
  const parent = await kategoriBul(guild)
  kanal = await guild.channels.create({
    name: odaAdi(l.kullaniciAdi),
    type: ChannelType.GuildText,
    parent: parent?.id,
    topic: `${l.kullaniciAdi} için Yaren kontrol odası`,
    permissionOverwrites: odaIzinleri(guild, l.userId, true),
  })
  depo.kanalAyarla(l.userId, kanal.id)
  await kanal.send({ content: hosgeldin(l), allowedMentions: { users: [l.userId] } })
  return { kanal, yeni: true }
}

// ---------- KEY KULLANMA ----------
const islemde = new Set() // aynı anda iki kere basılmasın
const yanlis = new Map() // userId -> { sayi, ilk }: key denemesi sınırı

async function keyKullan(i, key) {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  if (i.guildId !== GUILD_ID) return i.editReply('Keyi satıcının Discord sunucusunda girmen lazım.')
  const y = yanlis.get(i.user.id)
  if (y && Date.now() - y.ilk < 10 * 60000 && y.sayi >= 5) {
    return i.editReply('Çok fazla yanlış key denedin, 10 dakika sonra tekrar dene.')
  }
  if (islemde.has(i.user.id)) return i.editReply('İşlemin sürüyor, biraz bekle.')
  islemde.add(i.user.id)
  try {
    // Discord sunucusu en fazla 500 kanal alır: yeni oda gerekiyorsa ve yer
    // yoksa key yanmadan reddet
    const onceki = depo.bul(i.user.id)
    const odasiVar = !!(onceki?.kanalId && (await kanalGetir(onceki.kanalId).catch(() => true)))
    if (!odasiVar && (i.guild.channels.cache?.size ?? 0) >= 495) {
      adminLog('⚠️ Sunucuda kanal yeri kalmadı (500 sınırı), yeni müşteriye oda açılamıyor!')
      return i.editReply('Şu an yeni oda açılamıyor, satıcıya haber ver. Keyin kullanılmadı.')
    }
    const oncekiAi = depo.aiAktifMi(onceki)
    const r = depo.kullan(key, { userId: i.user.id, kullaniciAdi: i.user.username })
    if (!r.lisans) {
      if (r.tip === 'gecersiz') {
        const s = y && Date.now() - y.ilk < 10 * 60000 ? y : { sayi: 0, ilk: Date.now() }
        s.sayi++
        yanlis.set(i.user.id, s)
      }
      return i.editReply(r.mesaj)
    }
    yanlis.delete(i.user.id)
    if (aiDegistiyse(r.lisans, oncekiAi)) log(r.lisans.kanalId, 'Yapay zeka hakkın değişti, bot yeniden başlatılıyor.')
    adminLog(`🔑 ${i.user.tag} (${i.user.id}) key kullandı: ${r.tip}. Bitiş: ${bitisYazi(r.lisans)}`)
    let kanal
    try {
      ;({ kanal } = await odaHazirla(i.guild, r.lisans))
    } catch (e) {
      adminLog(`⚠️ ${i.user.tag} için oda açılamadı: ${e.message}`)
      return i.editReply(`${r.mesaj}\nAma odan açılamadı (${e.message}). Birazdan /odam yaz ya da satıcıya haber ver.`)
    }
    if (r.tip !== 'yeni') {
      await kanal
        .send({ content: `<@${r.lisans.userId}> ${r.mesaj}`, allowedMentions: { users: [r.lisans.userId] } })
        .catch(() => {})
    }
    return i.editReply(`${r.mesaj}\nOdan: <#${kanal.id}>`)
  } finally {
    islemde.delete(i.user.id)
  }
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
const SATICI = { default_member_permissions: '0' } // sadece yöneticiler görür; ayrıca ID kontrolü var
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
      { name: 'sahip', description: 'Oyundaki adın: bot sadece senin komutlarını dinler', type: S.String },
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
    name: 'soyle',
    description: 'Yaren ile konuş (yapay zeka): "biraz odun lazım" gibi',
    options: [{ name: 'metin', description: 'Ne diyorsun?', type: S.String, required: true, max_length: 500 }],
  },
  // ---- satıcı ----
  {
    name: 'key-olustur',
    description: 'Satış için key üretir',
    ...SATICI,
    options: [
      { name: 'gun', description: 'Kaç günlük (0 = süresiz)', type: S.Integer, required: true, min_value: 0, max_value: 3650 },
      { name: 'adet', description: 'Kaç tane (varsayılan 1)', type: S.Integer, min_value: 1, max_value: 25 },
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
    options: [
      { name: 'kullanici', description: 'Müşteri', type: S.User, required: true },
      { name: 'gun', description: 'Kaç gün (0 = süresiz yap)', type: S.Integer, required: true, min_value: 0, max_value: 3650 },
    ],
  },
  {
    name: 'lisans-iptal',
    description: 'Bir müşterinin lisansını iptal eder (botu durur, odası kilitlenir)',
    ...SATICI,
    options: [{ name: 'kullanici', description: 'Müşteri', type: S.User, required: true }],
  },
  { name: 'panel-kur', description: 'Bu kanala "Key Gir" butonlu satış panelini koyar', ...SATICI },
]
const SATICI_KOMUTLARI = new Set(COMMANDS.filter((c) => c.default_member_permissions === '0').map((c) => c.name))
const ODA_KOMUTLARI = new Set(['baslat', 'durdur', 'durum', 'gorev', 'sandik', 'soyle'])

client.once(Events.ClientReady, async () => {
  console.log(`Discord botu hazır: ${client.user.tag}`)
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    await guild.commands.set(COMMANDS)
    adminLog(`Bot açıldı. Müşteri: ${depo.ozetListe().lisanslar.length}, en fazla aynı anda ${ayarlar.maxBot} bot.`)
    // Eksik izin varsa key yanmadan önce satıcı bilsin
    const ben = guild.members?.me ?? (await guild.members?.fetchMe?.().catch(() => null))
    const eksikIzin = ben?.permissions.missing([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
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
  await zamanKontrol()
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
    if (!i.isChatInputCommand()) return
    if (i.guildId !== GUILD_ID) return await i.reply(gizli('Bu bot sadece kendi sunucusunda çalışır.'))
    if (SATICI_KOMUTLARI.has(i.commandName)) {
      if (!adminMi(i.user.id)) return await i.reply(gizli('Bu komut sadece satıcı içindir.'))
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
  if (l.userId !== i.user.id && !adminMi(i.user.id)) {
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

    if (!host) return i.editReply('İlk seferde sunucu adresini yaz: `/baslat host:oyna.sunucu.com sahip:OyunAdın`')
    if (!owner) {
      return i.editReply('Oyundaki adını da yaz: `/baslat sahip:OyunAdın` (bot oyunda sadece senin komutlarını dinler)')
    }
    if (!HOST_RE.test(host)) return i.editReply('Geçersiz sunucu adresi.')
    if (auth === 'offline' && !USER_RE.test(user)) {
      return i.editReply('Bot adı 3-16 karakter olmalı (harf, rakam, _).')
    }
    if (!USER_RE.test(owner)) return i.editReply('Sahip adı geçerli bir Minecraft adı olmalı.')
    if (version && !/^\d+\.\d+(\.\d+)?$/.test(version)) return i.editReply('Sürüm 1.20.4 gibi yazılmalı.')
    // Bekleyen otomatik bağlanma, DNS kontrolü sürerken eski ayarlarla başlamasın
    denemeIptal(uid)
    // Satıcı (destek/test için) yerel bir IP'ye bağlatabilir. Sadece IP olarak
    // yazılırsa: alan adı olsaydı müşteri DNS'ini sonradan iç ağa çevirip
    // otomatik bağlanmada bu izni kullanabilirdi.
    const yerelIzin = adminMi(i.user.id) && net.isIP(host) !== 0
    // Botlar senin makinende çalışır: müşteri senin yerel ağına bağlatamasın
    const engel = yerelIzin ? null : await hedefKontrol(host, port)
    if (engel) return i.editReply(engel)
    if (yonetici.calisiyor(uid)) return i.editReply('Botun zaten çalışıyor. Önce /durdur yaz.')

    const ayar = { host, port, user, auth, version, owner, yerelIzin }
    try {
      yonetici.baslat(uid, { ...ayar, ai: depo.aiAktifMi(l) })
    } catch (e) {
      return i.editReply(e.message)
    }
    depo.guncelle(uid, { son: ayar, calisiyordu: true })
    adminLog(`▶️ ${l.kullaniciAdi} botu başlattı: ${host}:${port} (${user}, ${auth}). Çalışan: ${yonetici.sayi()}/${ayarlar.maxBot}`)
    log(l.kanalId, `Başlatılıyor: ${host}:${port} (${user}, ${auth}${version ? ', ' + version : ''}, sahip: ${owner})`)
    return i.editReply(
      `Bot başlatılıyor: **${host}:${port}**. Loglar birazdan bu odaya düşecek.` +
        (auth === 'microsoft' ? '\nMicrosoft girişi için kod birazdan burada görünecek.' : '')
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
        ` | Konum: ${s.konum.join(', ')}`
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
    `Bitiş: **${bitisYazi(l)}**${l.bitis ? ` (${Math.max(0, Math.ceil((l.bitis - Date.now()) / GUN))} gün kaldı)` : ''}`,
    `Yapay zeka: **${depo.aiAktifMi(l) && ayarlar.apiKey ? 'açık' : 'kapalı'}**` +
      (depo.aiAktifMi(l) && aiBitis !== l.bitis ? ` (bitiş: ${bitisYazi({ bitis: aiBitis })})` : ''),
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

// ---------- SATICI KOMUTLARI ----------
async function saticiKomutu(i) {
  if (i.commandName === 'key-olustur') {
    const gun = i.options.getInteger('gun')
    const adet = i.options.getInteger('adet') ?? 1
    const ai = i.options.getBoolean('ai') ?? true
    const keyler = depo.olustur({ gun, adet, ai })
    adminLog(`🆕 ${adet} key üretildi (${gun ? gun + ' gün' : 'süresiz'}, AI ${ai ? 'var' : 'yok'}).`)
    return i.reply(
      gizli(
        `${adet} key (${gun ? gun + ' günlük' : 'süresiz'}, yapay zeka ${ai ? 'dahil' : 'yok'}):\n` +
          '```\n' + keyler.join('\n') + '\n```\n' +
          '⚠️ Keyler bir daha gösterilmez (sadece özeti saklanır), şimdi kopyala.'
      )
    )
  }

  if (i.commandName === 'key-liste') {
    const { sayi, keyler } = depo.ozetListe()
    const son = keyler.slice(-50).reverse()
    const satirlar = son.map(
      (k) =>
        `\`${k.onek}…\` ${k.gun ? k.gun + 'g' : 'süresiz'}${k.ai ? '' : ' (AI yok)'} — ` +
        (k.durum === 'kullanildi' ? `kullanıldı: <@${k.kullanan}>` : k.durum === 'iptal' ? 'iptal' : '**boşta**')
    )
    return i.reply({
      ...gizli(
        satirlar.length
          ? sigdir(`Boşta: **${sayi.bos}** | Kullanılmış: **${sayi.kullanildi}** | İptal: **${sayi.iptal}**\nSon keyler:`, satirlar)
          : 'Henüz key yok.'
      ),
      allowedMentions: { parse: [] },
    })
  }

  if (i.commandName === 'key-iptal') {
    return i.reply(gizli(depo.keyIptal(i.options.getString('key'))))
  }

  if (i.commandName === 'lisanslar') {
    const { lisanslar } = depo.ozetListe()
    if (!lisanslar.length) return i.reply(gizli('Henüz müşteri yok.'))
    const sirali = [...lisanslar].sort((a, b) => depo.aktifMi(b) - depo.aktifMi(a))
    const satirlar = sirali.map(
      (l) =>
        `<@${l.userId}> — ${depo.aktifMi(l) ? 'aktif' : l.durum === 'iptal' ? 'iptal' : 'bitti'}, ` +
        `bitiş ${bitisYazi(l)}, bot ${yonetici.calisiyor(l.userId) ? '🟢' : '⚪'}` +
        (l.kanalId ? ` <#${l.kanalId}>` : '')
    )
    const aktif = lisanslar.filter((l) => depo.aktifMi(l)).length
    return i.reply({
      ...gizli(sigdir(`Aktif: **${aktif}** / ${lisanslar.length} | Çalışan bot: **${yonetici.sayi()}/${ayarlar.maxBot}**`, satirlar)),
      allowedMentions: { parse: [] },
    })
  }

  if (i.commandName === 'lisans-uzat') {
    const u = i.options.getUser('kullanici')
    const gun = i.options.getInteger('gun')
    if (!depo.bul(u.id)) return i.reply(gizli('Bu kullanıcının lisansı yok. Ona key üret.'))
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    const oncekiAi = depo.aiAktifMi(depo.bul(u.id))
    const l = depo.uzat(u.id, gun)
    aiDegistiyse(l, oncekiAi)
    await odayaBildir(l, `<@${u.id}> lisansın uzatıldı. Yeni bitiş: **${bitisYazi(l)}**`, false)
    adminLog(`⏩ ${u.tag} lisansı uzatıldı: ${bitisYazi(l)}`)
    return i.editReply(`${u.tag} yeni bitiş: ${bitisYazi(l)}`)
  }

  if (i.commandName === 'lisans-iptal') {
    const u = i.options.getUser('kullanici')
    if (!depo.bul(u.id)) return i.reply(gizli('Bu kullanıcının lisansı yok.'))
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    denemeIptal(u.id)
    depo.iptalEt(u.id)
    yonetici.durdur(u.id)
    await odayaBildir(depo.bul(u.id), 'Lisans satıcı tarafından iptal edildi, bot durduruldu.', true)
    adminLog(`⛔ ${u.tag} lisansı iptal edildi.`)
    return i.editReply(`${u.tag} lisansı iptal edildi.`)
  }

  if (i.commandName === 'panel-kur') {
    const embed = new EmbedBuilder()
      .setTitle('Yaren — Minecraft Yardımcı Botu')
      .setColor(0x2ecc71)
      .setDescription(
        [
          'Oyunda senin için odun keser, taş kırar, tarla toplar. Türkçe konuşur, istersen kendi karar verir.',
          '',
          '**Nasıl başlarım?**',
          '1. Aşağıdaki **Key Gir** butonuna bas ve keyini yaz.',
          '2. Sana özel bir oda açılacak (sadece sen ve satıcı görür).',
          '3. Odanda `/baslat host:sunucu.adresi sahip:OyunAdın` yaz.',
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
    return i.reply(gizli('Panel kuruldu.'))
  }
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
  const { dolan, yaklasan, aiDolan } = depo.zamanKontrol()
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
    denemeIptal(l.userId)
    yonetici.durdur(l.userId)
    adminLog(`⌛ ${l.kullaniciAdi} (${l.userId}) lisansı doldu.`)
    await odayaBildir(
      l,
      `<@${l.userId}> lisans süren doldu, botun durduruldu. Yeni key girersen (/key-gir) kaldığın yerden devam edersin.`,
      true
    )
  }
  for (const l of yaklasan) {
    await odayaBildir(
      l,
      `<@${l.userId}> lisans süren **${bitisYazi(l)}** tarihinde doluyor. Uzatmak için yeni key al ve /key-gir yaz.`
    )
  }
}
setInterval(() => zamanKontrol().catch((e) => console.error('Süre kontrolü:', e.message)), 60000)

// Süresi dolalı / iptal edileli 14 gün olan odaları sil (500 kanal sınırı dolmasın).
// Lisans kaydı kalır; müşteri yeni key girerse odası yeniden açılır.
const ODA_SILME_GUN = 14
async function eskiOdalariSil() {
  const simdi = Date.now()
  for (const l of depo.ozetListe().lisanslar) {
    if (!l.kanalId || depo.aktifMi(l, simdi)) continue
    const bitti = l.durum === 'iptal' ? l.iptalZamani : l.bitis
    if (!bitti || simdi - bitti < ODA_SILME_GUN * GUN) continue
    try {
      const kanal = await kanalGetir(l.kanalId) // geçici hatada fırlatır: kayıt silinmez
      if (kanal) await kanal.delete('Lisans 14 gündür kapalı')
      depo.kanalAyarla(l.userId, null)
      adminLog(`🗑️ ${l.kullaniciAdi} odası silindi (lisans ${ODA_SILME_GUN} gündür kapalı).`)
    } catch (e) {
      console.error('Oda silinemedi:', e.message)
    }
  }
}
setInterval(() => eskiOdalariSil().catch((e) => console.error('Oda temizliği:', e.message)), 60 * 60000)

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Discord girişi başarısız (token yanlış olabilir):', e.message)
  process.exit(1)
})
