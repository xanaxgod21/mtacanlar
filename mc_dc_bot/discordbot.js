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
// Kurulum: npm install, node discordbot.js. Token yoksa komut penceresinde
// sorar (yapıştırılır, ayarlar.json'a kaydedilir), botu sunucuya ekleme linkini
// verir. Sunucuda bir kanala /kur yazılınca bot log kanallarını, yetkili ve
// müşteri rollerini, key kanalını ve yönetim panelini kendisi açar, ayarları
// kaydeder. Message Content Intent kapalıysa açılışta kendisi açmayı dener.

console.log('Yaren açılıyor...')
// Paketler kurulmamışsa (npm install yarıda kalmış) anlaşılır söyle, baslat.bat beklesin (kod 5)
for (const paket of ['discord.js', 'mineflayer']) {
  try {
    require.resolve(paket)
  } catch (_) {
    console.error(`Gerekli paket (${paket}) kurulu değil. Bu klasördeki kur.bat'ı çalıştır (internet gerekir).`)
    process.exit(5)
  }
}

const fs = require('fs')
const net = require('net')
const { spawn, execFile, execFileSync } = require('child_process')
const zlib = require('zlib')
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
const { BotYonetici, hedefKontrol, sunucuyaUlasilir, baglantiHatasiMetni } = require('./botyonetici')

// ---------- AYARLAR ----------
// Hepsi ayarlar.json'dan (ya da aynı isimli ortam değişkenlerinden) okunur.
// Token'ı ASLA koda yazma: kodu paylaşınca token da gider.
// Token boşsa açılışta komut penceresinde sorulur; sunucu, kanal ve rol ID'lerini
// /kur doldurur (ikisi de ayarlar.json'a yazar). Bu yüzden değişebilirler (let).
let DISCORD_TOKEN = ayarlar.discordToken      // Developer Portal > Bot > Token
let GUILD_ID = ayarlar.guildId                // Discord sunucunun ID'si
let LOG_CHANNEL_ID = ayarlar.logKanalId       // satıcı logu: satışlar, başlatmalar, hatalar
let KEY_LOG_KANAL_ID = ayarlar.keyLogKanalId  // key geçmişi: kim üretti, kim kullandı (boşsa satıcı loguna)
let ADMIN_ID = ayarlar.discordSahipId         // satıcı (sen): key üretir, her odaya girer
let YETKILI_ROL_ID = ayarlar.yetkiliRolId     // bu roldekiler de key verip lisans yönetebilir
let MUSTERI_ROL_ID = ayarlar.musteriRolId     // key girene verilir, süre bitince alınır (boş = kapalı)
let AI_ANAHTAR = ayarlar.apiKey               // yapay zeka (Anthropic) anahtarı; /yapay-zeka ile değişir
const ODA_SILME_SAAT = ayarlar.odaSilmeSaat   // süre bitince oda kaç saat sonra silinsin (0 = hemen)
const KATEGORI_ID = ayarlar.musteriKategoriId // müşteri odaları bu kategoriye (boşsa bot açar)
const DEFAULT_BOT_NAME = 'GorevBot'
const VERI_DIR = path.join(__dirname, 'veri') // lisanslar ve müşteri klasörleri (git'e girmez)
// -----------------------------

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
  if (ADMIN_ID && i.user.id === ADMIN_ID) return true
  if (!YETKILI_ROL_ID) return false
  const roller = i.member?.roles
  return roller?.cache ? roller.cache.has(YETKILI_ROL_ID) : Array.isArray(roller) && roller.includes(YETKILI_ROL_ID)
}
let yetkiliRol = null // açılışta doğrulanır; yanlış ID oda açmayı bozmasın
let musteriRol = null // açılışta doğrulanır

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
    sohbet: !l.sohbetKapali,
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
    if (code === 3 || code === 4) {
      // kalıcı hata (yasak/olmayan adres ya da yanlış sunucu şifresi): tekrar denemenin anlamı yok,
      // yanlış şifreyle tekrar tekrar girmek sunucunun botu banlamasına yol açar
      if (l) {
        depo.guncelle(userId, { calisiyordu: false })
        log(
          l.kanalId,
          code === 4
            ? 'Sunucu şifreyi kabul etmedi, otomatik bağlanma kapalı. /giris sifre:DOĞRU_ŞİFRE yazıp /baslat yaz.'
            : 'Bu adrese bağlanılamıyor, otomatik bağlanma kapalı. Adresi kontrol edip /baslat yaz.'
        )
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
    ...(ADMIN_ID
      ? [
          {
            id: ADMIN_ID,
            type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          },
        ]
      : []),
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
    `Lisans bitişi: ${bitisDiscord(l)} | Yapay zeka: **${depo.aiAktifMi(l) && AI_ANAHTAR ? 'açık' : 'kapalı'}**`,
    l.bitis !== null ? 'Süren bitince bu oda silinir. Yeni key girersen yeniden açılır, ayarların kaybolmaz.' : '',
    '',
    '**Başlamak için:**',
    '1. `/baslat host:sunucu.adresi` yaz, bot sunucuya girer.',
    '2. `/sahip ad:OyundakiAdın` yaz (örn. `/sahip ad:xdarkoum`). Bot oyunda sadece senin yazdıklarını yapar.',
    '3. Sunucu girişte şifre istiyorsa (`/login`, `/register`): `/giris sifre:BotunŞifresi` yaz, bot her girişte kendisi yazar.',
    'Bir kere yazman yeter, sonraki seferlerde sadece `/baslat` yazabilirsin.',
    '',
    '**Bu odaya yazman yeter:** "odun kes", "maden kaz", "taş kır", "tarla", "gel", "dur", "durum". Bot yapar, cevabını buraya yazar.',
    '**Oyunda komut:** `/komut komut:warp xanaxgod` ya da odaya `/warp xanaxgod` yaz, bot oyunda `/warp xanaxgod` yazar.',
    'Oyun sohbeti bu odaya düşer (`/sohbet` ile kapatırsın), `/yaz` ile odadan oyuna yazarsın.',
    'Bot acıkınca yanındaki yemeği kendisi yer, boştayken AFK diye atılmasın diye arada hareket eder.',
    '',
    'Diğer komutlar: `/sahip` `/giris` `/sohbet` `/yaz` `/komut` `/gorev` `/durum` `/sandik` `/soyle` `/durdur` `/bilgi`',
    'Oyun içinde: `!odun` `!maden` `!tas` `!farm` `!topla` `!bosalt` `!gel` `!dur` `!durum` `!otonom`, ya da "Yaren ..." diye konuş' +
      (depo.aiAktifMi(l) && AI_ANAHTAR ? '.' : ' ("Yaren odun kes", "Yaren gel" gibi; yapay zeka kapalıyken basit cümleleri anlar).'),
    '**Sandık:** bot topladıklarını (bir yığın olunca ve iş bitince) görevin başladığı yere en yakın sandığa götürür. Kendi sandığını göstermek için oyunda dibinde dur ve `!sandik ekle` yaz: o zaman oraya bırakır, baltası/kazması kırılmak üzereyse oradan yenisini de alır.',
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
// kaynak: key logunda "nereden girildi" (Key Gir butonu, /key-gir, key kanalı)
async function keyIsle(user, guild, key, kaynak = '') {
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
    const oncekiBitis = onceki?.bitis ?? null // kullan() aynı nesneyi değiştirir: önce oku
    const r = depo.kullan(key, { userId: user.id, kullaniciAdi: user.username })
    if (!r.lisans) {
      // kendi kullandığı keyi tekrar girmek zararsız: sayılmaz, loglanmaz
      if (r.tip === 'kullanilmis' && r.kayit?.kullanan === user.id) return { ok: false, metin: r.mesaj }
      // yanlış key, başkasının kullandığı / iptal edilmiş key ve iptal edilen müşteri aynı
      // sınıra sayılır (10 dakikada 5): biri aynı keyi durmadan girip key logunu doldurmasın
      const s = y && Date.now() - y.ilk < 10 * 60000 ? y : { sayi: 0, ilk: Date.now() }
      s.sayi++
      yanlis.set(user.id, s)
      if (s.sayi === 5) {
        keyLog('supheli', '⚠️ Çok fazla yanlış key', [
          ['Deneyen', kim(user)],
          ['Ne oldu', '10 dakikada 5 yanlış/geçersiz key denedi, 10 dakika bekletiliyor'],
          ['Nereden', kaynak || '-'],
        ])
      }
      if (r.kayit) {
        // başkasının kullandığı / iptal edilmiş key ya da iptal edilen müşteri
        keyLog('supheli', '⚠️ Geçersiz key denemesi', [
          ['Deneyen', kim(user)],
          ['Key', onekYaz(r.kayit)],
          ['Neden', { kullanilmis: 'başkasının kullandığı key', iptal: 'iptal edilmiş key', yasakli: 'lisansı iptal edilmiş kişi' }[r.tip] || r.tip],
          ...(r.kayit.kullanan ? [['Keyi kullanan', `<@${r.kayit.kullanan}> (${zaman(r.kayit.kullanma)})`]] : []),
          ['Nereden', kaynak || '-'],
        ])
      }
      return { ok: false, metin: r.mesaj }
    }
    yanlis.delete(user.id)
    panelGuncelle()
    const k = r.kayit
    musteriRolu(user.id, true)
    keyLog('kullan', '🔑 Key kullanıldı', [
      ['Kullanan', kim(user)],
      ['Key', onekYaz(k)],
      ['Süre', `${sureYazi(keySuresi(k))}${k.ai ? '' : ' (AI yok)'}`],
      ['Ne oldu', { yeni: 'yeni lisans açıldı', uzatildi: 'süresi uzatıldı', yeniden: 'lisansı yeniden açıldı' }[r.tip]],
      ...(r.tip === 'yeniden' && oncekiBitis !== null ? [['Önceki bitiş', zaman(oncekiBitis)]] : []),
      ['Yeni bitiş', r.lisans.bitis === null ? 'süresiz' : zaman(r.lisans.bitis)],
      ['Nereden', kaynak || '-'],
      ['Üreten', k.olusturan ? `<@${k.olusturan}> (${k.olusturanAdi || k.olusturan})` : 'bilinmiyor'],
      ['Üretildiği an', zaman(k.olusturma)],
      ...(k.alici && k.alici !== user.id ? [['⚠️ Dikkat', `Bu key <@${k.alici}> kişisine verilmişti`, false]] : []),
    ])
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
let birikmisHazir
// Kapıyı kapatır: kanalda bekleyen keyler işlenene kadar (en fazla 1 dk) yeni girişler bekler.
// Açılışta ve sunucuya (yeniden) kurulunca kapanır.
function kapiyiKapat() {
  let bitti
  birikmisHazir = new Promise((r) => (bitti = r))
  birikmisBitti = bitti
  setTimeout(bitti, 60000) // bir şey takılsa da en geç 1 dk sonra key girişi açılır
}
kapiyiKapat()

async function keyKullan(i, key) {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  if (i.guildId !== GUILD_ID) return i.editReply('Keyi satıcının Discord sunucusunda girmen lazım.')
  await birikmisHazir
  const kaynak = i.isModalSubmit?.() ? 'Key Gir butonu' : '/key-gir komutu'
  return i.editReply((await keyIsle(i.user, i.guild, key, kaynak)).metin)
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

// ---------- YAPAY ZEKA AYARI (/yapay-zeka) ----------
// Yapay zeka Anthropic API anahtarıyla çalışır; parasını satıcı öder. Satıcı Discord'da
// /yapay-zeka yazar, butona basıp anahtarı yapıştırır: bot küçük bir istekle dener
// (anahtar, kredi ve model doğru mu), doğruysa ayarlar.json'a yazar ve çalışan
// müşteri botlarını yapay zekalı hâliyle yeniden başlatır. Anahtar yokken botlar
// "Yaren odun kes" gibi basit cümleleri yine anlar.
const AI_KONSOL = 'https://console.anthropic.com'

function yapayZekaDurumu() {
  const satir = [
    AI_ANAHTAR
      ? `🤖 Yapay zeka: **açık** (model: \`${ayarlar.aiModel}\`, müşteri başı günlük sınır: ${ayarlar.aiGunlukLimit || 'sınırsız'})`
      : '🤖 Yapay zeka: **kapalı** (anahtar yok). Botlar şimdilik "Yaren odun kes", "Yaren gel" gibi basit cümleleri anlıyor.',
    '',
    AI_ANAHTAR ? '**Anahtarı değiştirmek için:**' : '**Açmak için:**',
    `1. ${AI_KONSOL} adresinde hesap aç (Google hesabınla girebilirsin).`,
    '2. "Billing" kısmından kredi yükle (en az 5$). Yapay zeka parasını sen ödersin; müşteri başı günlük sınır faturanı korur.',
    '3. "API Keys" > "Create Key" > "Copy".',
    '4. Aşağıdaki **Anahtarı Gir** butonuna bas, yapıştır, Gönder. Bot dener, doğruysa kaydeder ve çalışan botlarda hemen açar.',
  ]
  const butonlar = [new ButtonBuilder().setCustomId('ai:anahtar').setLabel('Anahtarı Gir').setEmoji('🔑').setStyle(ButtonStyle.Primary)]
  if (AI_ANAHTAR) butonlar.push(new ButtonBuilder().setCustomId('ai:kapat').setLabel('Yapay Zekayı Kapat').setStyle(ButtonStyle.Danger))
  return { content: satir.join('\n'), components: [new ActionRowBuilder().addComponents(...butonlar)], flags: MessageFlags.Ephemeral }
}

function yapayZekaModal() {
  return new ModalBuilder()
    .setCustomId('ai:modal')
    .setTitle('Yapay Zeka Anahtarı')
    .addLabelComponents((l) =>
      l
        .setLabel('Anthropic API anahtarı')
        .setDescription('console.anthropic.com > API Keys > Create Key > Copy')
        .setTextInputComponent((t) =>
          t
            .setCustomId('anahtar')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(20)
            .setMaxLength(300)
            .setPlaceholder('sk-ant-api03-...')
        )
    )
}

// Anahtarı tek kelimelik (1 token) bir istekle dener: anahtar, kredi ve model birlikte
// doğrulanır. Maliyeti binde bir sentin altında.
async function aiAnahtarDene(anahtar) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anahtar, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ayarlar.aiModel, max_tokens: 1, messages: [{ role: 'user', content: 'merhaba' }] }),
      signal: AbortSignal.timeout(20000),
    })
    if (r.ok || r.status === 429) return { ok: true } // 429: anahtar geçerli, sadece o an yoğun
    const govde = await r.json().catch(() => ({}))
    const mesaj = String(govde?.error?.message || '')
    if (r.status === 401) return { hata: 'Anthropic bu anahtarı kabul etmedi (yanlış, eksik kopyalanmış ya da silinmiş). "Create Key" ile yenisini al.' }
    if (r.status === 403) return { hata: 'Bu anahtarın izni yok. Console\'da anahtarın bağlı olduğu çalışma alanına bak ya da yeni anahtar al.' }
    if (/credit|balance|billing/i.test(mesaj)) return { hata: `Anahtar doğru ama hesabında kredi yok. ${AI_KONSOL} > Billing kısmından kredi yükle, sonra tekrar dene.` }
    if (r.status === 404) return { hata: `Anahtar doğru ama ayarlardaki model (\`${ayarlar.aiModel}\`) bulunamadı. ayarlar.json'daki ai_model'i düzelt.` }
    return { hata: `Anthropic hata verdi (${r.status}${mesaj ? ': ' + mesaj.slice(0, 200) : ''}). Biraz sonra tekrar dene.` }
  } catch (e) {
    return { hata: `Anthropic'e ulaşılamadı (${e.message}). İnternetini kontrol edip tekrar dene.` }
  }
}

// Yeni anahtarı uygular: çalışan ve lisansında yapay zeka olan botlar yeniden başlar
function aiAnahtarUygula(anahtar) {
  AI_ANAHTAR = anahtar
  yonetici.apiKey = anahtar
  let n = 0
  for (const l of depo.ozetListe().lisanslar) {
    if (!yonetici.calisiyor(l.userId) || !depo.aiAktifMi(l)) continue
    yenidenBaslat.add(l.userId)
    yonetici.durdur(l.userId)
    log(l.kanalId, anahtar ? '🤖 Yapay zeka açıldı, botun yeniden bağlanıyor.' : '🤖 Yapay zeka kapatıldı, botun yeniden bağlanıyor.')
    n++
  }
  return n
}

async function yapayZekaEtkilesim(i) {
  if (i.isButton() && i.customId === 'ai:anahtar') return i.showModal(yapayZekaModal())
  if (i.isButton() && i.customId === 'ai:kapat') {
    try {
      ayarlar.kaydet({ anthropic_api_key: '' })
    } catch (e) {
      return i.reply(gizli(`Ayar kaydedilemedi: ${e.message}`))
    }
    const n = aiAnahtarUygula('')
    adminLog(`🤖 Yapay zeka kapatıldı (${i.user.tag}).`)
    return i.reply(gizli(`Yapay zeka kapatıldı.${n ? ` ${n} bot yeniden başlatılıyor.` : ''} Botlar basit cümleleri anlamaya devam eder.`))
  }
  if (i.isModalSubmit() && i.customId === 'ai:modal') {
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    const anahtar = i.fields.getTextInputValue('anahtar').trim().replace(/^["'`]+|["'`]+$/g, '')
    if (/\s/.test(anahtar) || anahtar.length < 20) return i.editReply('Bu bir API anahtarına benzemiyor. Console\'da "Create Key" > "Copy" ile alınanı yapıştır.')
    if (!anahtar.startsWith('sk-ant-')) return i.editReply('Anthropic anahtarı "sk-ant-" ile başlar. Doğru anahtarı kopyaladığından emin ol (Discord token\'ı değil).')
    const sonuc = await aiAnahtarDene(anahtar)
    if (!sonuc.ok) return i.editReply(`❌ ${sonuc.hata}`)
    const notlar = []
    try {
      ayarlar.kaydet({ anthropic_api_key: anahtar })
    } catch (e) {
      notlar.push(`⚠️ Anahtar dosyaya yazılamadı (${e.message}); bot kapanınca tekrar girmen gerekir.`)
    }
    if (ayarlar.envden('ANTHROPIC_API_KEY')) {
      notlar.push('⚠️ ANTHROPIC_API_KEY ortam değişkeni var: bot yeniden açılınca kaydedilen anahtar yerine o kullanılır. Onu sil ya da güncelle.')
    }
    const n = aiAnahtarUygula(anahtar)
    adminLog(`🤖 Yapay zeka açıldı (${i.user.tag}, anahtar ${anahtar.slice(0, 10)}…).`)
    return i.editReply(
      [
        '✅ Anahtar çalışıyor, kaydedildi. Yapay zeka **açık**.',
        n ? `${n} çalışan bot yapay zekalı olarak yeniden başlatılıyor.` : 'Bundan sonra başlatılan botlarda açık olacak.',
        'Müşteriler oyunda "Yaren ..." diye konuşabilir, `/soyle` ve `!otonom` çalışır. Yapay zekasız key verdiğin müşterilerde basit mod sürer.',
        ...notlar,
      ].join('\n')
    )
  }
}


// ---------- SLASH KOMUTLARI ----------
const S = ApplicationCommandOptionType
const SATICI = { default_member_permissions: '0' } // sadece yöneticiler görür; ayrıca ID/rol kontrolü var
// Bot henüz kurulmamışken sunucuda sadece bu komut durur (sunucu sahibi / yöneticiler görür)
const KUR_KOMUTU = {
  name: 'kur',
  description: 'Yaren\'i bu sunucuya kurar: log kanalları, roller, key kanalı ve yönetim paneli',
  ...SATICI,
}
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
  { name: 'maden (cevher kaz)', value: 'maden' },
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
    name: 'giris',
    description: 'Sunucu girişte şifre istiyorsa (/login, /register) bot bu şifreyle kendisi girer',
    options: [
      { name: 'sifre', description: 'Botun sunucudaki şifresi (boş: durumu gösterir, "sil": siler)', type: S.String, max_length: 64 },
    ],
  },
  {
    name: 'sohbet',
    description: 'Oyun sohbeti bu odaya aktarılsın mı',
    options: [
      {
        name: 'durum',
        description: 'Açık ya da kapalı',
        type: S.String,
        required: true,
        choices: [
          { name: 'açık', value: 'acik' },
          { name: 'kapalı', value: 'kapali' },
        ],
      },
    ],
  },
  {
    name: 'yaz',
    description: 'Bot oyunda bunu yazar (sohbet mesajı ya da /komut)',
    options: [{ name: 'mesaj', description: 'Ne yazsın?', type: S.String, required: true, max_length: 256 }],
  },
  {
    name: 'komut',
    description: 'Bot oyunda sunucu komutu yazar: "warp xanaxgod" yazarsan oyunda /warp xanaxgod',
    options: [
      { name: 'komut', description: 'Başında / olmadan: warp xanaxgod, spawn, home ev...', type: S.String, required: true, max_length: 255 },
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
    name: 'key-sorgu',
    description: 'Bir keyin geçmişi: kim üretti, kime verildi, kim ne zaman kullandı',
    ...SATICI,
    options: [{ name: 'key', description: 'Tam key ya da YAREN-XXXX öneki', type: S.String, required: true, max_length: 40 }],
  },
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
  { name: 'yedek', description: 'Müşteri ve key kayıtlarının yedeğini şimdi alır, sana gönderir', ...SATICI },
  { name: 'yapay-zeka', description: 'Yapay zekayı açar/kapatır: Anthropic API anahtarını gir (bot dener, kaydeder)', ...SATICI },
  KUR_KOMUTU,
]
const SATICI_KOMUTLARI = new Set(COMMANDS.filter((c) => c.default_member_permissions === '0').map((c) => c.name))
const ODA_KOMUTLARI = new Set(['baslat', 'sahip', 'giris', 'sohbet', 'yaz', 'komut', 'durdur', 'durum', 'gorev', 'sandik', 'soyle'])

// ---------- AÇILIŞ ----------
// Kurulum modu: ayarlarda sunucu yok ya da bot o sunucuda değil. Bot girdiği her
// sunucuya sadece /kur'u kaydeder; /kur yazılınca o sunucuya kurulur.
let kurulumModu = false
let sunucuBasladi = false // açılışta bir kez yapılanlar (kaçan keyler, botları geri getirme)
let uygulamaId = '' // davet linki için, token'dan öğrenilir

const davetLinki = (guildId) =>
  `https://discord.com/oauth2/authorize?client_id=${uygulamaId || client.user?.id}&scope=bot+applications.commands&permissions=8` +
  (guildId ? `&guild_id=${guildId}&disable_guild_select=true` : '')

client.once(Events.ClientReady, async () => {
  console.log(`Discord botu hazır: ${client.user.tag}`)
  if (GUILD_ID && client.guilds.cache.has(GUILD_ID)) await sunucuyuBaslat()
  else await kurulumModunaGec()
})

async function kurulumModunaGec() {
  kurulumModu = true
  const sunucular = [...client.guilds.cache.values()]
  for (const g of sunucular) {
    await g.commands.set([KUR_KOMUTU]).catch((e) => console.error(`/kur "${g.name}" sunucusuna kaydedilemedi: ${e.message}`))
  }
  console.log('')
  console.log('==================== YAREN KURULUMU ====================')
  if (GUILD_ID) console.log(`ayarlar.json'daki sunucuda (${GUILD_ID}) değilim: bot atılmış ya da ID yanlış.`)
  if (sunucular.length === 0) {
    console.log('1) Botu sunucuna ekle: bu linki aç, sunucunu seç, "Yetkilendir" de:')
  } else {
    console.log(`Bot şu sunucularda: ${sunucular.map((g) => g.name).join(', ')}`)
    console.log('1) Başka bir sunucuya eklemek istersen bu linki aç:')
  }
  console.log('   ' + davetLinki())
  console.log('2) O sunucuda herhangi bir kanala /kur yaz (sunucu sahibi ya da Yönetici).')
  console.log('   Bot log kanallarını, rolleri, key kanalını ve yönetim panelini kendisi açar.')
  console.log('========================================================')
  console.log('')
  if (sunucular.length === 0) tarayicidaAc(davetLinki())
}

// Windows'ta davet linkini tarayıcıda açar (VPS'te / pm2 altında sadece yazar)
function tarayicidaAc(url) {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return
  try {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref()
  } catch (_) {}
}

client.on(Events.GuildCreate, async (g) => {
  try {
    if (g.id === GUILD_ID) {
      // atılan bot aynı sunucuya geri eklendi: ayarlar duruyor, kaldığı yerden devam
      if (kurulumModu) {
        console.log(`Bot tekrar "${g.name}" sunucusunda, kaldığı yerden devam ediyor.`)
        kapiyiKapat() // yokken key kanalına yazılanlar önce sahiplerine
        kurulumModu = false
        await sunucuyuBaslat()
      }
      return
    }
    if (!kurulumModu) return
    await g.commands.set([KUR_KOMUTU])
    console.log(`Bot "${g.name}" sunucusuna eklendi. Şimdi orada herhangi bir kanala /kur yaz.`)
  } catch (e) {
    console.error(`Sunucuya eklenince hata (${g.name}): ${e.message}`)
  }
})
// Token sıfırlandı (4004) ya da Message Content Intent kapatıldı (4014): Discord bağlantıyı
// kalıcı keser, discord.js yeniden denemez. Çık: baslat.bat / pm2 yeniden açar, açılışta
// token sorulur ya da intent yeniden denetlenir.
client.on(Events.ShardDisconnect, (olay) => {
  const neden =
    olay?.code === 4004
      ? 'Token geçersiz oldu (Developer Portal\'da sıfırlanmış olabilir). Yeniden açılınca yenisi sorulacak.'
      : olay?.code === 4014
        ? 'Message Content Intent kapatılmış. Yeniden açılınca bot buna göre ayarlanır.'
        : `Discord bağlantıyı kalıcı kapattı (kod ${olay?.code}).`
  console.error('⚠️ ' + neden)
  process.exit(1)
})

client.on(Events.GuildDelete, (g) => {
  if (g.id !== GUILD_ID || kurulumModu) return
  console.error(`⚠️ Bot "${g.name || g.id}" sunucusundan çıkarıldı. Geri eklersen kaldığı yerden devam eder.`)
  kurulumModunaGec().catch((e) => console.error('Kurulum modu:', e.message))
})

// Kurulu sunucuyu hazırlar: komutlar, roller, izin kontrolü. İlk seferde ayrıca
// kaçan keyleri işler ve çalışan müşteri botlarını geri getirir.
async function sunucuyuBaslat() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    await guild.commands.set(COMMANDS)
    adminLog(`Bot açıldı. Müşteri: ${depo.ozetListe().lisanslar.length}, en fazla aynı anda ${ayarlar.maxBot} bot.`)
    if (!LOG_CHANNEL_ID) console.log('Not: log kanalı ayarlı değil. Sunucuda bir kanala /kur yazarsan bot açar.')
    if (!ADMIN_ID) console.log('Not: satıcı (discord_sahip_id) ayarlı değil. Sunucu sahibi bir kanala /kur yazsın.')
    if (!AI_ANAHTAR) adminLog('🤖 Yapay zeka kapalı (botlar basit cümleleri anlar). Açmak için Discord\'da /yapay-zeka yaz.')
    if (YETKILI_ROL_ID) {
      yetkiliRol = await guild.roles?.fetch?.(YETKILI_ROL_ID).catch(() => null)
      if (!yetkiliRol) adminLog(`⚠️ yetkili_rol_id (${YETKILI_ROL_ID}) bu sunucuda bulunamadı, yetkili rolü kapalı.`)
      // rol sonradan eklendiyse mevcut odalar da yetkililere açılsın (arka planda)
      else yetkiliOdalaraEkle().catch(() => {})
    }
    if (MUSTERI_ROL_ID) {
      musteriRol = await guild.roles?.fetch?.(MUSTERI_ROL_ID).catch(() => null)
      if (!musteriRol) adminLog(`⚠️ musteri_rol_id (${MUSTERI_ROL_ID}) bu sunucuda bulunamadı, müşteri rolü kapalı.`)
      else rolleriEsitle().catch((e) => console.error('Müşteri rolleri eşitlenemedi:', e.message))
    }
    // Key log kanalı: yoksa satıcı loguna düşer; herkese açıksa uyar
    if (KEY_LOG_KANAL_ID) {
      const kl = await kanalGetir(KEY_LOG_KANAL_ID).catch(() => null)
      if (!kl) adminLog(`⚠️ key_log_kanal_id (${KEY_LOG_KANAL_ID}) bulunamadı, key logları bu kanala düşecek.`)
      else if (herkeseAcik(kl, guild, [LOG_ROL_ID].filter(Boolean))) adminLog('⚠️ Key log kanalını herkes görebiliyor (müşteri adları ve key önekleri orada). Kanalı sadece sana ve yetkililere aç.')
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
  // Bot kapalıyken (ya da sunucudan atılmışken) key kanalına yazılanlar: keyler sahiplerine
  // işlenir, mesajlar silinir. İçerik okunamasa da (Message Content Intent kapalı) silinir.
  await kacanKeyMesajlari().catch((e) => console.error('Key kanalı:', e.message))
  birikmisBitti()
  if (sunucuBasladi) return
  sunucuBasladi = true
  await zamanKontrol().catch((e) => console.error('Süre kontrolü:', e.message))
  panelGuncelle()
  setTimeout(() => gunlukYedek().catch(() => {}), 60000) // son yedek 1 günden eskiyse
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
}

// Yetkili rolü sonradan eklendiyse mevcut müşteri odaları da o role açılsın
async function yetkiliOdalaraEkle() {
  for (const l of depo.ozetListe().lisanslar) {
    const kanal = await kanalGetir(l.kanalId).catch(() => null)
    if (kanal) await yetkiliIzni(kanal)
  }
}

// ---------- /kur: TEK KOMUTLA KURULUM ----------
// "Yaren Yönetim" kategorisinde log, key log ve yönetim paneli kanallarını, "Yaren
// Log" (log kanallarını görür, key veremez) ve "Yaren Müşteri" rollerini, herkese
// açık key kanalını açar; log rolünü /kur yazana verir, ID'leri ayarlar.json'a
// yazar. Tekrar yazılırsa var olanları kullanır, silinmiş olanları yeniden açar.
// Key verme yetkisi rolle dağıtılmaz (Rolleri Yönet izni olan biri kendine verip key
// basamasın): satıcı ve elle ayarlanan yetkili_rol_id'dekiler.
const KUR_AD = {
  kategori: 'Yaren Yönetim',
  log: 'yaren-log',
  keyLog: 'yaren-key-log',
  yonetim: 'yaren-yonetim',
  keyKanali: 'key-gir',
  logRol: 'Yaren Log',
  musteri: 'Yaren Müşteri',
}
const BOT_OZEL_IZIN = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ManageMessages,
]
const SATICI_KANAL_IZIN = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseApplicationCommands,
]
const LOG_ROL_IZIN = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
const izinNesnesi = (liste) => Object.fromEntries(liste.map((f) => [Object.keys(PermissionFlagsBits).find((k) => PermissionFlagsBits[k] === f), true]))
let kuruluyor = false
let LOG_ROL_ID = ayarlar.logRolId

// Kişi sunucuda mı (sunucudan çıkmışsa false; Discord'a ulaşılamazsa hata)
async function uyeMi(guild, userId) {
  if (!userId) return false
  try {
    await guild.members.fetch({ user: userId, force: true })
    return true
  } catch (e) {
    if (e.code === 10007 || e.code === 10013) return false // Unknown Member / Unknown User
    throw e
  }
}

async function kurKomutu(i) {
  const guild = i.guild ?? (await client.guilds.fetch(i.guildId).catch(() => null))
  if (!guild) return i.reply(gizli('/kur bir sunucu kanalında yazılmalı.'))
  const kurulu = !kurulumModu && !!GUILD_ID
  if (kurulu && guild.id !== GUILD_ID) return i.reply(gizli('Yaren başka bir sunucuya kurulu; bir bot tek sunucuda çalışır.'))
  if (kuruluyor) return i.reply(gizli('Kurulum zaten sürüyor, birkaç saniye bekle.'))
  kuruluyor = true
  try {
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    const sahibi = i.user.id === guild.ownerId
    const yoneticiMi = !!i.memberPermissions?.has(PermissionFlagsBits.Administrator)
    let izin
    let red
    if (kurulu) {
      // Kurulu sunucuda sadece satıcı; satıcı sunucudan çıkmışsa (ya da hiç yoksa) sunucu sahibi devralır
      izin = (ADMIN_ID && i.user.id === ADMIN_ID) || (sahibi && !(await uyeMi(guild, ADMIN_ID)))
      red = 'Kurulumu sadece satıcı (ilk /kur yazan kişi) değiştirebilir.'
    } else if (ADMIN_ID) {
      // Daha önce kurulmuş bot (atılmış ya da taşınıyor): başka bir sunucunun sahibi/yöneticisi
      // /kur yazıp satıcının müşterilerini, keylerini ele geçiremesin
      izin = i.user.id === ADMIN_ID
      red = "Bu bot daha önce kuruldu: /kur'u sadece satıcısı yazabilir. (Satıcı sensen ve bu hesap değilse ayarlar.json'da discord_sahip_id'yi düzelt.)"
    } else if (GUILD_ID && guild.id !== GUILD_ID && depo.ozetListe().lisanslar.length) {
      izin = false
      red = "Bu botun başka bir sunucuda müşterileri var. Taşımak için ayarlar.json'a discord_sahip_id olarak kendi ID'ni yaz, botu yeniden aç."
    } else {
      izin = sahibi || yoneticiMi // ilk kurulum
      red = "/kur'u sadece sunucu sahibi ya da Yönetici yetkisi olan biri yazabilir."
    }
    if (!izin) return i.editReply(red)
    return await kurulumYap(i, guild)
  } catch (e) {
    console.error('/kur hatası:', e)
    return i.editReply(`Kurulum yarıda kaldı: ${e.message}\nTekrar /kur yaz; açılanlar tekrar açılmaz, eksikler tamamlanır.`).catch(() => {})
  } finally {
    kuruluyor = false
  }
}

async function rolBulYaDaAc(guild, id, ad) {
  let rol = id ? await guild.roles.fetch(id).catch(() => null) : null
  if (!rol) rol = [...(guild.roles.cache?.values?.() || [])].find((r) => r.name === ad && !r.managed) || null
  if (rol) return { rol, yeni: false }
  return { rol: await guild.roles.create({ name: ad, permissions: [], mentionable: false, reason: 'Yaren /kur' }), yeni: true }
}

// id'deki kanal bu sunucuda duruyorsa o, yoksa aynı adlı kanal, o da yoksa yenisi
async function kanalBulYaDaAc(guild, hepsi, id, ad, ozellik) {
  let k = id ? await kanalGetir(id).catch(() => null) : null
  if (k && k.guildId && k.guildId !== guild.id) k = null
  if (!k) k = hepsi.find((c) => c && c.type === ozellik.type && c.name === ad && (!ozellik.parent || c.parentId === ozellik.parent)) || null
  if (k) return { kanal: k, yeni: false }
  return { kanal: await guild.channels.create({ name: ad, reason: 'Yaren /kur', ...ozellik }), yeni: true }
}

// Var olan (kullanılan) özel kanala da bot, satıcı ve verilen roller erişsin
async function ozelKanalIzinleri(kanal, saticiId, roller) {
  await kanal.permissionOverwrites.edit(client.user.id, izinNesnesi(BOT_OZEL_IZIN), { type: OverwriteType.Member })
  await kanal.permissionOverwrites.edit(saticiId, izinNesnesi(SATICI_KANAL_IZIN), { type: OverwriteType.Member })
  for (const [rolId, izinler] of roller) await kanal.permissionOverwrites.edit(rolId, izinNesnesi(izinler), { type: OverwriteType.Role })
}

// Kanalda botun koyduğu "Key Gir" paneli duruyor mu (tekrar /kur'da ikincisi atılmasın)
async function keyPaneliVarMi(kanal) {
  const mesajlar = await kanal.messages.fetch({ limit: 50 }).catch(() => null)
  if (!mesajlar) return false
  return [...mesajlar.values()].some(
    (m) =>
      m.author?.id === client.user.id &&
      (m.components || []).some((r) => (r.components || []).some((c) => (c.customId ?? c.data?.custom_id) === 'key_gir'))
  )
}

// Satıcı değişti (sunucu sahibi devraldı): eskisi log kanallarını, paneli ve
// müşteri odalarını artık görmesin, yenisi görsün
async function saticiDegisti(eski, yeni, ozelKanallar) {
  const neden = 'Yaren /kur: satıcı değişti'
  for (const k of ozelKanallar) await k?.permissionOverwrites?.delete(eski, neden).catch(() => {})
  for (const l of depo.ozetListe().lisanslar) {
    const oda = await kanalGetir(l.kanalId).catch(() => null)
    if (!oda) continue
    if (l.userId !== eski) await oda.permissionOverwrites.delete(eski, neden).catch(() => {}) // kendi odasıysa kalsın
    await oda.permissionOverwrites
      .edit(yeni, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { type: OverwriteType.Member })
      .catch((e) => adminLog(`⚠️ Yeni satıcıya oda izni verilemedi (#${oda.name}): ${e.message}`))
  }
}

async function kurulumYap(i, guild) {
  const notlar = []
  const ben = guild.members?.me ?? (await guild.members.fetchMe())
  // Discord, botun kendinde olmayan bir izni kanal izinlerinde verip kısmasına izin vermez:
  // aşağıda verilen/kısılan her izin burada olmalı
  const eksik = ben.permissions.missing([
    ...new Set([
      ...BOT_OZEL_IZIN,
      ...SATICI_KANAL_IZIN,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.CreatePrivateThreads,
    ]),
  ])
  if (eksik.length) {
    return i.editReply(
      `Botun bu sunucuda izni eksik: ${eksik.join(', ')}.\n` +
        `Botu bu linkle Yönetici olarak yeniden ekle (sunucudan atmana gerek yok), sonra tekrar /kur yaz:\n${davetLinki(guild.id)}`
    )
  }
  const ayniSunucu = GUILD_ID === guild.id // değilse eski ID'ler başka sunucunun, kullanılmaz
  const eskiSatici = ayniSunucu ? ADMIN_ID : ''
  const satici = i.user.id

  // Roller
  await guild.roles.fetch().catch(() => null) // adla bulabilmek için hepsini al
  const logRol = await rolBulYaDaAc(guild, ayniSunucu ? LOG_ROL_ID : '', KUR_AD.logRol)
  const musteri = await rolBulYaDaAc(guild, ayniSunucu ? MUSTERI_ROL_ID : '', KUR_AD.musteri)
  const botUst = ben.roles?.highest?.position ?? Infinity
  for (const { rol } of [logRol, musteri]) {
    if (rol.position >= botUst) {
      notlar.push(`⚠️ "${rol.name}" rolü botun rolünden yukarıda, bot bu rolü veremez. Sunucu Ayarları > Roller'de Yaren rolünü onun üstüne sürükle.`)
    }
  }
  // elle ayarlanmış yetkili rolü (key verebilen ekip) bu sunucudaysa log ve paneli de görür
  const yetkili = ayniSunucu && YETKILI_ROL_ID ? await guild.roles.fetch(YETKILI_ROL_ID).catch(() => null) : null

  // Sadece satıcının (ve verilen rollerin) gördüğü kanallar
  const ozel = (roller) => [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, type: OverwriteType.Member, allow: BOT_OZEL_IZIN },
    { id: satici, type: OverwriteType.Member, allow: SATICI_KANAL_IZIN },
    ...roller.map(([id, izinler]) => ({ id, type: OverwriteType.Role, allow: izinler })),
  ]
  const logRolleri = [[logRol.rol.id, LOG_ROL_IZIN], ...(yetkili ? [[yetkili.id, SATICI_KANAL_IZIN]] : [])]
  const panelRolleri = yetkili ? [[yetkili.id, SATICI_KANAL_IZIN]] : []
  const hepsi = () => guild.channels.fetch().then((c) => [...c.values()])
  const kategori = await kanalBulYaDaAc(guild, await hepsi(), '', KUR_AD.kategori, {
    type: ChannelType.GuildCategory,
    permissionOverwrites: ozel(logRolleri),
  })
  if (!kategori.yeni) await ozelKanalIzinleri(kategori.kanal, satici, logRolleri)
  const ozelKanal = async (id, ad, konu, roller) => {
    const r = await kanalBulYaDaAc(guild, await hepsi(), ayniSunucu ? id : '', ad, {
      type: ChannelType.GuildText,
      parent: kategori.kanal.id,
      topic: konu,
      permissionOverwrites: ozel(roller),
    })
    if (!r.yeni) await ozelKanalIzinleri(r.kanal, satici, roller)
    return r
  }
  const logK = await ozelKanal(LOG_CHANNEL_ID, KUR_AD.log, 'Yaren: satışlar, botların açılıp kapanması, hatalar', logRolleri)
  const keyLogK = await ozelKanal(KEY_LOG_KANAL_ID, KUR_AD.keyLog, 'Yaren: kim hangi keyi ne zaman üretti, verdi, kullandı', logRolleri)
  const yonetimK = await ozelKanal(paneller.yonetimKanalId, KUR_AD.yonetim, 'Yaren yönetim paneli: key ver, süre uzat/bitir', panelRolleri)

  // Bot başka sunucudan taşınıyorsa eski sunucunun odaları ve key kanalları artık
  // açılamaz (Missing Access): müşteriler yeni sunucuda yeni oda alsın (ayarları kalır)
  if (!ayniSunucu) {
    const buradakiler = new Set((await hepsi()).map((c) => c.id))
    for (const l of depo.ozetListe().lisanslar) {
      if (l.kanalId && !buradakiler.has(l.kanalId)) {
        kuyruklar.delete(l.kanalId)
        depo.kanalAyarla(l.userId, null)
      }
    }
    paneller.keyKanallari = paneller.keyKanallari.filter((id) => buradakiler.has(id))
    if (!buradakiler.has(paneller.yonetimKanalId)) paneller.yonetimMesajId = null
  }

  // Müşterilerin key yazdığı kanal (herkese açık; konu açılmasın diye thread kapalı)
  let keyK = null
  for (const id of [...paneller.keyKanallari].reverse()) {
    const k = await kanalGetir(id).catch(() => null)
    if (k && (!k.guildId || k.guildId === guild.id)) {
      keyK = { kanal: k, yeni: false }
      break
    }
  }
  if (!keyK) {
    keyK = await kanalBulYaDaAc(guild, await hepsi(), '', KUR_AD.keyKanali, {
      type: ChannelType.GuildText,
      topic: 'Yaren keyini buraya yaz ya da Key Gir butonuna bas. Mesajın hemen silinir, kimse görmez.',
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          type: OverwriteType.Role,
          deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
        },
        {
          id: client.user.id,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageMessages,
          ],
        },
      ],
    })
  }

  // Yeni ayarlar: önce bellekte (panel butonları hemen çalışsın), sonra dosyaya.
  // İlk kurulumda (ya da taşımada) kapı kapanır: kanalda bekleyen keyler önce
  // sahiplerine işlenir, sonra butonla girenler sıraya girer.
  const ilkKurulum = kurulumModu || !ayniSunucu
  if (ilkKurulum) kapiyiKapat()
  GUILD_ID = guild.id
  ADMIN_ID = satici
  LOG_CHANNEL_ID = logK.kanal.id
  KEY_LOG_KANAL_ID = keyLogK.kanal.id
  LOG_ROL_ID = logRol.rol.id
  MUSTERI_ROL_ID = musteri.rol.id
  musteriRol = musteri.rol
  try {
    ayarlar.kaydet({
      guild_id: GUILD_ID,
      discord_sahip_id: ADMIN_ID,
      log_kanal_id: LOG_CHANNEL_ID,
      key_log_kanal_id: KEY_LOG_KANAL_ID,
      log_rol_id: LOG_ROL_ID,
      musteri_rol_id: MUSTERI_ROL_ID,
    })
  } catch (e) {
    notlar.push(`⚠️ Ayarlar dosyaya yazılamadı (${e.message}). Bot şimdilik çalışır; yeniden açılınca tekrar /kur yaz.`)
  }
  // Ortam değişkeni varsa bir sonraki açılışta dosyadaki değerin yerine o kullanılır
  const envdekiler = [
    ['GUILD_ID', 'guild_id'],
    ['DISCORD_OWNER_ID', 'discord_sahip_id'],
    ['LOG_CHANNEL_ID', 'log_kanal_id'],
    ['KEY_LOG_CHANNEL_ID', 'key_log_kanal_id'],
    ['LOG_ROL_ID', 'log_rol_id'],
    ['MUSTERI_ROL_ID', 'musteri_rol_id'],
  ].filter(([env]) => ayarlar.envden(env))
  if (envdekiler.length) {
    notlar.push(`⚠️ Şu ayarlar ortam değişkeninden geliyor, bot yeniden açılınca kaydedilen değerin yerine onlar kullanılır: ${envdekiler.map(([e]) => e).join(', ')}. Onları sil ya da güncelle.`)
  }
  if (eskiSatici && eskiSatici !== satici) {
    saticiDegisti(eskiSatici, satici, [kategori.kanal, logK.kanal, keyLogK.kanal, yonetimK.kanal]).catch((e) => console.error('Satıcı değişimi:', e.message))
  }

  // Log rolü /kur yazana
  try {
    const uye = await guild.members.fetch({ user: satici, force: true })
    if (!uye.roles.cache.has(logRol.rol.id)) await uye.roles.add(logRol.rol, 'Yaren /kur')
  } catch (e) {
    notlar.push(`⚠️ "${logRol.rol.name}" rolü sana verilemedi (${e.message}).`)
  }

  // Paneller
  paneller.keyKanallari = [...new Set([...paneller.keyKanallari, keyK.kanal.id])]
    .filter((id) => id !== LOG_CHANNEL_ID && id !== KEY_LOG_KANAL_ID)
    .slice(-10)
  paneller.keyKanalId = keyK.kanal.id
  panelKaydet()
  if (!(await keyPaneliVarMi(keyK.kanal))) {
    await keyK.kanal.send(keyPaneliMesaji()).catch((e) => notlar.push(`⚠️ Key kanalına panel konamadı (${e.message}).`))
  }
  const eskiPanel =
    paneller.yonetimKanalId === yonetimK.kanal.id && paneller.yonetimMesajId
      ? await yonetimK.kanal.messages.fetch(paneller.yonetimMesajId).catch(() => null)
      : null
  if (eskiPanel) panelGuncelle()
  else await yonetimPaneliGonder(yonetimK.kanal).catch((e) => notlar.push(`⚠️ Yönetim paneli konamadı (${e.message}).`))

  if (ilkKurulum) {
    kurulumModu = false
    // /kur'u diğer sunuculardan kaldır, bu sunucuya bütün komutları kaydet
    for (const g of client.guilds.cache.values()) {
      if (g.id !== guild.id) await g.commands.set([]).catch(() => {})
    }
    await sunucuyuBaslat()
  } else {
    rolleriEsitle().catch((e) => console.error('Müşteri rolleri eşitlenemedi:', e.message))
  }
  adminLog(`✅ Yaren kuruldu (/kur: ${i.user.tag}).`)
  console.log(`Yaren "${guild.name}" sunucusuna kuruldu. Satıcı: ${i.user.tag}`)

  const isaret = (r) => (r.yeni ? ' (yeni)' : '')
  const satirlar = [
    '✅ **Yaren kuruldu!** Ayarlar kaydedildi, dosyalara bir şey yazmana gerek yok.',
    '',
    `📋 Log: <#${logK.kanal.id}>${isaret(logK)}`,
    `🔑 Key logu: <#${keyLogK.kanal.id}>${isaret(keyLogK)}`,
    `🛠️ Yönetim paneli: <#${yonetimK.kanal.id}>${isaret(yonetimK)} (key ver, süre uzat/bitir; sadece sen görürsün)`,
    `🎫 Key kanalı: <#${keyK.kanal.id}>${isaret(keyK)} (müşteriler keyini buraya yazar)`,
    `📜 <@&${logRol.rol.id}>${isaret(logRol)} rolü sana verildi. Bu rolü verdiğin kişi log kanallarını görür; key veremez, paneli görmez.`,
    `🧑 <@&${musteri.rol.id}>${isaret(musteri)} rolü key girenlere otomatik verilir, süresi bitince alınır.`,
    AI_ANAHTAR ? '🤖 Yapay zeka: açık.' : '🤖 Yapay zeka kapalı: açmak için `/yapay-zeka` yaz (anahtarsız da botlar basit cümleleri anlar).',
  ]
  if (!mesajOkunur) {
    satirlar.push(
      '',
      '⚠️ Message Content Intent kapalı: müşteriler şimdilik sadece **Key Gir** butonuyla girebilir. Developer Portal > Bot > **Message Content Intent**i açıp botu yeniden başlatırsan keyi kanala yazarak da girerler.'
    )
  }
  if (notlar.length) satirlar.push('', ...notlar)
  return i.editReply({ content: satirlar.join('\n'), allowedMentions: { parse: [] } })
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'kur') return await kurKomutu(i)
    if (kurulumModu) {
      if (i.isRepliable()) await i.reply(gizli('Yaren henüz kurulmadı: sunucu sahibi bir kanala /kur yazsın.'))
      return
    }
    if (i.isButton() && i.customId === 'key_gir') return await i.showModal(keyModal())
    if (i.isModalSubmit() && i.customId === 'key_modal') {
      return await keyKullan(i, i.fields.getTextInputValue('key'))
    }
    // yapay zeka anahtarı (sadece satıcı: faturası ona gelir)
    if ((i.isButton() || i.isModalSubmit()) && /^ai:/.test(i.customId)) {
      if (i.guildId !== GUILD_ID) return
      if (i.user.id !== ADMIN_ID) return await i.reply(gizli('Yapay zeka ayarını sadece satıcı değiştirebilir.'))
      return await yapayZekaEtkilesim(i)
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
    // "oyna.sunucu.com:25566", "http://1.2.3.4:25565/" gibi yazılanları da anla
    const hamHost = secilen('host')
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/\/.*$/, '')
    const hostPort = hamHost.match(/^(.+):(\d{1,5})$/)
    const host = (hostPort ? hostPort[1] : hamHost) || son.host || ''
    let owner = secilen('sahip') || son.owner || ''
    const port = i.options.getInteger('port') ?? (hostPort ? Number(hostPort[2]) : hamHost ? 25565 : son.port || 25565)
    if (!(port >= 1 && port <= 65535)) return i.editReply('Port 1-65535 arası bir sayı olmalı.')
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
    // Sunucu cevap vermiyorsa botu boşuna başlatıp 3 kez denemesin: hemen nedenini söyle
    await i.editReply(`Sunucu yoklanıyor: **${host}:${port}**...`).catch(() => {})
    const ulasim = await sunucuyaUlasilir(host, port)
    if (!ulasim.ok) return i.editReply(baglantiHatasiMetni(ulasim.kod, `${ulasim.host}:${ulasim.port}`, ulasim.bedrock))
    if (yonetici.calisiyor(uid)) return i.editReply('Botun zaten çalışıyor. Önce /durdur yaz.')
    // adres kontrolü birkaç saniye sürebilir; bu arada lisans dolmuş/iptal edilmiş olabilir
    if (!depo.aktifMi(depo.bul(uid))) return i.editReply('Lisans süren doldu, bot başlatılmadı. Yeni key: /key-gir')
    // adres kontrolü sürerken /sahip ile ad verilmiş olabilir: eski adla ezme
    if (!secilen('sahip')) owner = depo.bul(uid).son?.owner || ''

    const ayar = { host, port, user, auth, version, owner, yerelIzin }
    try {
      yonetici.baslat(uid, { ...ayar, ai: depo.aiAktifMi(l), sohbet: !depo.bul(uid)?.sohbetKapali })
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
    const nasil = '\nOyunda: `!odun` `!maden` `!tas` `!farm` `!topla` `!gel` `!dur` `!durum` `!yardim` ya da "Yaren ..." diye konuş. Bu odaya "odun kes" gibi yazman da yeter.'
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

  if (i.commandName === 'giris') {
    const sifre = (i.options.getString('sifre') || '').trim()
    const host = l.son?.host
    if (!host) return i.reply(gizli('Önce `/baslat host:sunucu.adresi` ile sunucunu yaz, şifre o sunucu için kaydedilir.'))
    const port = l.son?.port || 25565
    const adres = port === 25565 ? host : `${host}:${port}`
    const kayitli = !!yonetici.sunucuSifresi(uid, host, port)
    if (!sifre) {
      return i.reply(
        gizli(
          kayitli
            ? `**${adres}** için kayıtlı şifre var. Bot sunucu isteyince \`/login\` (ilk seferde \`/register\`) yazar. Değiştirmek için \`/giris sifre:YeniŞifre\`, silmek için \`/giris sifre:sil\`.`
            : `**${adres}** için kayıtlı şifre yok. Sunucu girişte şifre istiyorsa \`/giris sifre:BotunŞifresi\` yaz.`
        )
      )
    }
    const sil = sifre.toLowerCase() === 'sil'
    if (!sil && !/^[^\s]{3,64}$/.test(sifre)) return i.reply(gizli('Şifre 3-64 karakter olmalı ve boşluk içermemeli.'))
    yonetici.sunucuSifresiKaydet(uid, host, port, sil ? '' : sifre)
    // çalışan bot aynı sunucudaysa hemen uygula
    let ek = ''
    const b = yonetici.bilgi(uid)
    if (yonetici.calisiyor(uid) && b?.host === host && Number(b?.port) === Number(port)) {
      const r = await yonetici.istek(uid, 'giris', { sifre: sil ? '' : sifre })
      if (r.kod === 200 && !sil) ek = r.veri.cevap === 'deneniyor' ? ' Bot şimdi giriş yapmayı deniyor.' : ''
    }
    return i.reply(
      gizli(sil ? `**${adres}** için şifre silindi.` : `Şifre kaydedildi (**${adres}**). Bot sunucu isteyince kendisi giriş yapar.${ek} Şifre hiçbir yerde gösterilmez.`)
    )
  }

  if (i.commandName === 'sohbet') {
    const acik = i.options.getString('durum') === 'acik'
    depo.guncelle(uid, { sohbetKapali: !acik })
    if (yonetici.calisiyor(uid)) await yonetici.istek(uid, 'sohbet', { acik })
    return i.reply(acik ? 'Oyun sohbeti bu odaya aktarılacak.' : 'Oyun sohbeti artık bu odaya aktarılmayacak.')
  }

  if (i.commandName === 'yaz') {
    if (!yonetici.calisiyor(uid)) return i.reply(gizli('Botun çalışmıyor. Önce /baslat yaz.'))
    const mesaj = i.options.getString('mesaj')
    const r = await yonetici.istek(uid, 'yaz', { metin: mesaj })
    if (r.kod !== 200) return i.reply(gizli('Yazılamadı: ' + (r.veri?.hata || r.kod)))
    // giriş komutunda şifre olabilir: odaya gösterme
    // komutlarda şifre/kod olabilir (/login, /giris, /kayit, /cp, /2fa...): sadece yazana görünsün
    if (mesaj.trim().startsWith('/')) return i.reply(gizli('Komut oyunda yazıldı.'))
    return i.reply({ content: `Oyunda yazıldı: ${mesaj}`, allowedMentions: { parse: [] } })
  }

  if (i.commandName === 'komut') {
    if (!yonetici.calisiyor(uid)) return i.reply(gizli('Botun çalışmıyor. Önce /baslat yaz.'))
    const r = await oyundaCalistir(uid, i.options.getString('komut'))
    if (r.hata) return i.reply(gizli(r.hata))
    if (r.sifreli) return i.reply(gizli('Komut oyunda yazıldı (şifre içerebileceği için burada gösterilmiyor).'))
    return i.reply({ content: `🎮 Oyunda yazıldı: ${kodYaz(r.komut)}${l.sohbetKapali ? SOHBET_KAPALI_NOTU : ''}`, allowedMentions: { parse: [] } })
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
    // yapay zeka yoksa (lisansta yok ya da satıcı anahtar eklememiş) bot basit cümleleri yine anlar
    const basitMod = !depo.aiAktifMi(l) || !AI_ANAHTAR
    if (!yonetici.calisiyor(uid)) return i.reply('Botun çalışmıyor. Önce /baslat yaz.')
    await i.deferReply()
    const metin = i.options.getString('metin')
    const r = await yonetici.istek(uid, 'soyle', { metin }, 90000)
    if (r.kod !== 200) return i.editReply('Yaren cevap veremedi: ' + (r.veri?.hata || r.kod))
    const govde =
      `> ${metin}\n**Yaren:** ${r.veri.cevap}` +
      (basitMod ? '\n_(Basit mod: yapay zeka kapalı, "odun kes", "gel", "dur" gibi istekleri anlarım.)_' : '')
    return i.editReply({
      content: govde.length > 2000 ? govde.slice(0, 1997) + '…' : govde, // uzun cevap kaybolmasın
      allowedMentions: { parse: [] },
    })
  }
}

// ---------- OYUNDA KOMUT (/komut ve odaya "/" ile yazılanlar) ----------
// Şifre olabilecek komutlar (/login, /register, /cp...) odada gösterilmez.
const SIFRELI_KOMUT = /^\/(login|l|log|giris|register|reg|kayit|changepassword|changepass|cp|sifre|password|pass|2fa|totp|unregister)\b/
const SOHBET_KAPALI_NOTU = '\n_(Oyun sohbeti bu odaya aktarılmıyor; sunucunun cevabını görmek için `/sohbet durum:açık`.)_'
const kodYaz = (t) => '`' + String(t).replace(/`/g, "'") + '`'
const sadeKomut = (t) =>
  String(t)
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
// { komut, sifreli } ya da { hata }
async function oyundaCalistir(uid, metin) {
  const k = String(metin || '').replace(/\s+/g, ' ').trim().replace(/^\/+\s*/, '')
  if (!k) return { hata: 'Komutu yaz: örn. `/komut komut:warp xanaxgod` (oyunda /warp xanaxgod yazar).' }
  const komut = '/' + k
  if (komut.length > 256) return { hata: 'Komut çok uzun (en fazla 256 karakter).' }
  const r = await yonetici.istek(uid, 'yaz', { metin: komut })
  if (r.kod !== 200) return { hata: 'Oyunda yazılamadı: ' + (r.veri?.hata || r.kod) }
  return { komut, sifreli: SIFRELI_KOMUT.test(sadeKomut(komut)) }
}

// ---------- ODAYA YAZILANLAR ----------
// Müşteri odasına düz yazı yazarak da botunu yönetir (sadece odanın sahibi; satıcının
// ya da başkasının yazdığına karışılmaz):
//   "odun kes", "maden kaz", "gel", "dur"  -> Yaren anlar (yapay zeka ya da basit mod)
//   "/warp xanaxgod"                        -> oyunda komut olarak yazılır (/komut gibi)
//   "!maden", "!sandik ekle"                -> oyun içi komut
// Mesajlar sırayla işlenir; cevap mesaja yanıt olarak yazılır.
const odaSirasi = new Map() // userId -> { is: Promise, bekleyen }
const icerikUyarildi = new Map() // userId -> zaman: yazılanı okuyamıyoruz uyarısı
async function odaMesaji(m) {
  if (kurulumModu || m.guildId !== GUILD_ID || m.author?.bot || m.system || m.webhookId) return
  const l = depo.kanaldanBul(m.channelId)
  if (!l || l.userId !== m.author.id || !depo.aktifMi(l)) return
  const benim = new RegExp(`<@!?${client.user.id}>`, 'g')
  // başkasını etiketlediyse (ör. satıcıya yazıyor) bota söylenmiş sayma
  if (m.mentions?.everyone || m.mentions?.roles?.size || [...(m.mentions?.users?.keys() || [])].some((id) => id !== client.user.id)) return
  const metin = String(m.content || '').replace(benim, ' ').trim()
  if (!metin) {
    // Message Content Intent kapalıysa yazılanı göremeyiz: arada bir söyle
    if (!mesajOkunur && !m.attachments?.size && Date.now() - (icerikUyarildi.get(l.userId) || 0) > 10 * 60000) {
      icerikUyarildi.set(l.userId, Date.now())
      await m.channel
        .send({
          content:
            `<@${l.userId}> yazdıklarını okuyamıyorum (satıcının Developer Portal'da "Message Content Intent"i açması lazım). ` +
            'Şimdilik `/gorev`, `/soyle` ve `/komut` kullan.',
          allowedMentions: { users: [l.userId] },
        })
        .catch(() => {})
    }
    return
  }
  let sira = odaSirasi.get(l.userId)
  if (!sira) odaSirasi.set(l.userId, (sira = { is: Promise.resolve(), bekleyen: 0 }))
  if (sira.bekleyen >= 3) return m.react('⏳').catch(() => {}) // art arda çok yazdı
  sira.bekleyen++
  sira.is = sira.is
    .then(() => odaMesajiIsle(m, l.userId, metin))
    .catch((e) => console.error('Oda mesajı:', e))
    .finally(() => {
      sira.bekleyen--
      if (!sira.bekleyen && odaSirasi.get(l.userId) === sira) odaSirasi.delete(l.userId)
    })
}
client.on(Events.MessageCreate, (m) => odaMesaji(m).catch((e) => console.error('Oda mesajı:', e)))

async function odaMesajiIsle(m, uid, metin) {
  const yaz = (content, yanit = true) => {
    const govde = { content: content.length > 2000 ? content.slice(0, 1997) + '…' : content, allowedMentions: { parse: [] } }
    const gonder = () => m.channel.send(govde).catch(() => {})
    return yanit ? m.reply({ ...govde, allowedMentions: { parse: [], repliedUser: false } }).catch(gonder) : gonder()
  }
  const l = depo.bul(uid)
  if (!l || !depo.aktifMi(l)) return
  if (!yonetici.calisiyor(uid)) return yaz('Botun çalışmıyor. Önce `/baslat` yaz.')

  // "/warp xanaxgod": oyunda komut
  if (metin.startsWith('/')) {
    const r = await oyundaCalistir(uid, metin)
    if (r.hata) return yaz(r.hata)
    if (r.sifreli) {
      // şifre odada kalmasın
      await m.delete().catch(() => {})
      return yaz('Komut oyunda yazıldı. Şifre içerebileceği için mesajını sildim.', false)
    }
    return yaz(`🎮 Oyunda yazıldı: ${kodYaz(r.komut)}${l.sohbetKapali ? SOHBET_KAPALI_NOTU : ''}`)
  }

  // "!maden", "!sandik ekle": oyun içi komut
  if (metin.startsWith('!')) {
    const r = await yonetici.istek(uid, 'komut', { komut: metin.slice(1) })
    if (r.kod === 400) return yaz('Bu komutu bilmiyorum. Şunlar var: `!odun` `!maden` `!tas` `!farm` `!topla` `!bosalt` `!sandik` `!gel` `!dur` `!durum` `!otonom`')
    if (r.kod !== 200) return yaz('Bota ulaşamadım: ' + (r.veri?.hata || r.kod))
    return yaz(`**Yaren:** ${r.veri.cevap}`)
  }

  // düz yazı: Yaren anlar (yapay zeka yoksa "odun kes", "maden kaz" gibi basit cümleler)
  if (depo.aiAktifMi(l) && AI_ANAHTAR) m.channel.sendTyping?.().catch(() => {})
  const r = await yonetici.istek(uid, 'soyle', { metin: metin.slice(0, 500) }, 90000)
  if (r.kod !== 200) return yaz('Yaren cevap veremedi: ' + (r.veri?.hata || r.kod))
  return yaz(`**Yaren:** ${r.veri.cevap}`)
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
    `Yapay zeka: **${depo.aiAktifMi(l) && AI_ANAHTAR ? 'açık' : 'kapalı'}**` +
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

// ---------- MÜŞTERİ ROLÜ ----------
// musteri_rol_id: key girene verilir, süresi bitince / iptal edilince alınır.
// Bot rolü bu rolün üstünde olmalı ve "Rolleri Yönet" izni olmalı.
const rolHatasi = { verildi: false }
async function musteriRolu(userId, ver) {
  if (!musteriRol) return
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    // önbellek eski olabilir (rol başka yerden değişmiş): sunucudan güncelini al
    const uye = await guild.members.fetch({ user: userId, force: true }).catch((e) => (e.code === 10007 ? null : Promise.reject(e))) // sunucudan çıkmış
    if (!uye) return
    const var_ = uye.roles.cache.has(musteriRol.id)
    if (ver && !var_) await uye.roles.add(musteriRol, 'Yaren lisansı aktif')
    if (!ver && var_) await uye.roles.remove(musteriRol, 'Yaren lisansı bitti')
  } catch (e) {
    if (!rolHatasi.verildi) {
      rolHatasi.verildi = true
      adminLog(`⚠️ Müşteri rolü verilemedi/alınamadı: ${e.message}. Botun rolü müşteri rolünün üstünde olmalı ve "Rolleri Yönet" izni olmalı.`)
    }
  }
}
// Açılışta: aktif müşterilerde rol olsun, süresi bitenlerde olmasın (bot kapalıyken değişenler)
async function rolleriEsitle() {
  for (const l of depo.ozetListe().lisanslar) {
    await musteriRolu(l.userId, depo.aktifMi(l))
  }
}

// ---------- YEDEK ----------
// lisanslar.json (bütün müşteriler ve keyler), paneller.json ve key_log.txt
// her gün veri/yedekler klasörüne kopyalanır (son 14 gün) ve sana DM ile gelir.
// Sunucu şifreleri ve Microsoft girişleri yedeğe girmez.
const YEDEK_DIR = path.join(VERI_DIR, 'yedekler')
const YEDEK_DOSYALAR = ['lisanslar.json', 'paneller.json', 'key_log.txt']
function yedekAl() {
  const gun = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }) // 2026-10-07
  const saat = new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }).replace(':', '')
  const klasor = path.join(YEDEK_DIR, `${gun}_${saat}`)
  fs.mkdirSync(klasor, { recursive: true })
  const ekler = []
  for (const ad of YEDEK_DOSYALAR) {
    const kaynak = path.join(VERI_DIR, ad)
    if (!fs.existsSync(kaynak)) continue
    const veri = fs.readFileSync(kaynak)
    fs.writeFileSync(path.join(klasor, ad), veri)
    // Discord ek sınırı: büyük dosya sıkıştırılarak gider
    ekler.push(veri.length > 7 * 1024 * 1024 ? { attachment: zlib.gzipSync(veri), name: `${gun}_${ad}.gz` } : { attachment: veri, name: `${gun}_${ad}` })
  }
  // eski yedekleri temizle (son 14 kalsın)
  const eskiler = fs.readdirSync(YEDEK_DIR).filter((a) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(a)).sort()
  for (const a of eskiler.slice(0, Math.max(0, eskiler.length - 14))) fs.rmSync(path.join(YEDEK_DIR, a), { recursive: true, force: true })
  fs.writeFileSync(path.join(YEDEK_DIR, 'son_yedek.txt'), String(Date.now()))
  const { lisanslar, keyler } = depo.ozetListe()
  return { ekler, bilgi: `${gun} ${saat.slice(0, 2)}:${saat.slice(2)}, ${lisanslar.length} müşteri, ${keyler.length} key` }
}
function sonYedek() {
  try {
    return Number(fs.readFileSync(path.join(YEDEK_DIR, 'son_yedek.txt'), 'utf-8')) || 0
  } catch (_) {
    return 0
  }
}
async function gunlukYedek() {
  if (!ayarlar.gunlukYedek || !ADMIN_ID || !client.isReady() || Date.now() - sonYedek() < 24 * SAAT) return
  try {
    const { ekler, bilgi } = yedekAl()
    const gitti = await client.users
      .fetch(ADMIN_ID)
      .then((u) => u.send({ content: `🗄️ Günlük Yaren yedeği (${bilgi}). Bilgisayar bozulursa bu dosyaları yeni kurulumda \`veri/\` klasörüne koyman yeterli.`, files: ekler }))
      .then(
        () => true,
        () => false
      )
    if (!gitti) adminLog('⚠️ Günlük yedek DM ile gönderilemedi (DM\'lerin kapalı olabilir). Yedek bilgisayarında veri/yedekler klasöründe.')
  } catch (e) {
    adminLog('⚠️ Günlük yedek alınamadı: ' + e.message)
  }
}
setInterval(() => gunlukYedek().catch(() => {}), SAAT)

// ---------- KEY LOGU ----------
// Key ve lisans olayları (kim, hangi key, ne zaman) ayrı kanala embed olarak düşer
// (key_log_kanal_id; boşsa satıcı log kanalına) ve veri/key_log.txt'ye yazılır.
// Keyin tamamı asla yazılmaz, sadece öneki (YAREN-AB12…): logu gören biri keyi
// kullanamasın. Tam key sadece üretildiği an satıcıya gösterilir.
const KEY_LOG_DOSYA = path.join(VERI_DIR, 'key_log.txt')
const KEY_LOG_RENK = { uret: 0x3498db, ver: 0x9b59b6, kullan: 0x2ecc71, iptal: 0xe67e22, supheli: 0xe74c3c, lisans: 0x95a5a6 }
const kim = (u) => `<@${u.id}> (${etiket(u)})`
const onekYaz = (k) => `\`${k.onek}…\``
let keyLogSira = Promise.resolve()
function keyLog(tur, baslik, alanlar) {
  const simdi = Date.now()
  try {
    fs.mkdirSync(VERI_DIR, { recursive: true })
    const duz = (v) =>
      String(v)
        .replace(/<t:(\d+):\w>/g, (_, sn) => new Date(sn * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }))
        .replace(/<@!?(\d+)>/g, '$1')
        .replace(/[`\n]/g, ' ')
    const satir = alanlar.map(([ad, deger]) => `${ad}: ${duz(deger)}`).join(' | ')
    const an = new Date(simdi).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })
    fs.appendFileSync(KEY_LOG_DOSYA, `[${an}] ${baslik} | ${satir}\n`, 'utf-8')
  } catch (e) {
    console.error('key_log.txt yazılamadı:', e.message)
  }
  const embed = new EmbedBuilder()
    .setTitle(baslik)
    .setColor(KEY_LOG_RENK[tur] ?? 0x95a5a6)
    .addFields(
      ...alanlar.map(([name, value, inline = true]) => ({ name, value: String(value || '-').slice(0, 1024), inline })),
      { name: 'Zaman', value: `${zaman(simdi)} (${zaman(simdi, 'R')})`, inline: false }
    )
  // sırayla gönder (aynı anda çok olay olunca sıra karışmasın, Discord sınırına takılmasın)
  keyLogSira = keyLogSira.then(async () => {
    if (!client.isReady()) await new Promise((r) => client.once(Events.ClientReady, r)) // giriş bitmeden olanlar kaybolmasın
    for (const id of [KEY_LOG_KANAL_ID, LOG_CHANNEL_ID].filter(Boolean)) {
      try {
        const kanal = await client.channels.fetch(id)
        await kanal.send({ embeds: [embed], allowedMentions: { parse: [] } })
        return
      } catch (e) {
        console.error(`Key logu gönderilemedi (${id}):`, e.message) // key log kanalı yoksa satıcı loguna dene
      }
    }
  })
}

// ---------- SATICI İŞLEMLERİ ----------
// Hem slash komutları hem yönetim paneli bunları kullanır; hepsi cevap metni döndürür.
const etiket = (u) => u?.tag || u?.username || u?.id
const durumYazi = (l) => (depo.aktifMi(l) ? 'aktif' : l.durum === 'iptal' ? 'iptal' : 'süresi dolmuş')

function keyOlusturIslem(yapan, sure, adet, ai) {
  const keyler = depo.olustur({ sure, adet, ai, olusturan: yapan.id, olusturanAdi: etiket(yapan) })
  keyLog('uret', `🆕 ${adet} key üretildi`, [
    ['Üreten', kim(yapan)],
    ['Süre', sureYazi(sure)],
    ['Yapay zeka', ai ? 'dahil' : 'yok'],
    ['Keyler', keyler.map((k) => `\`${k.slice(0, 10)}…\``).join('\n'), false],
  ])
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
  const [key] = depo.olustur({ sure, ai, direkt: true, alici: u.id, olusturan: yapan.id, olusturanAdi: etiket(yapan) })
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
  const kayit = depo.keyBul(key)[0]
  if (kayit) {
    kayit.dmGitti = gitti // key geçmişinde "DM ile" mi "satıcı iletti" mi doğru görünsün
    depo.kaydet()
  }
  adminLog(`🎁 ${etiket(yapan)} → ${etiket(u)}: ${sureYazi(sure)} key ${onek} ${gitti ? 'DM ile gönderildi' : 'üretildi (DM kapalı)'}.`)
  keyLog('ver', '🎁 Key verildi', [
    ['Veren', kim(yapan)],
    ['Alan', kim(u)],
    ['Key', onek],
    ['Süre', sureYazi(sure)],
    ['Yapay zeka', ai ? 'dahil' : 'yok'],
    ['DM', gitti ? 'gönderildi' : "kapalı, key satıcıya gösterildi"],
  ])
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
  musteriRolu(u.id, true)
  keyLog('lisans', '⏩ Lisans uzatıldı', [
    ['Yapan', kim(yapan)],
    ['Müşteri', kim(u)],
    ['Eklenen', sureYazi(sure)],
    ['Yeni bitiş', l.bitis === null ? 'süresiz' : zaman(l.bitis)],
  ])
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
  const odasiVardi = !!depo.bul(u.id)?.kanalId
  const silindi = await odaSil(depo.bul(u.id), iptal ? 'Lisans iptal edildi' : 'Lisans satıcı tarafından bitirildi')
  if (!silindi) await odayaBildir(depo.bul(u.id), `<@${u.id}> ${ne}, botun durduruldu.`, true)
  await dmGonder(
    u.id,
    `Yaren ${ne}, botun durduruldu${silindi ? ' ve odan kapatıldı' : ''}.` + (iptal ? '' : ' Yeni key girersen odan ayarlarınla geri açılır.')
  )
  adminLog(`${iptal ? '⛔' : '⏹️'} ${etiket(yapan)}: ${etiket(u)} ${iptal ? 'lisansını iptal etti' : 'lisansının süresini bitirdi'}.`)
  musteriRolu(u.id, false)
  keyLog(iptal ? 'iptal' : 'lisans', iptal ? '⛔ Lisans iptal edildi' : '⏹️ Lisans bitirildi', [
    ['Yapan', kim(yapan)],
    ['Müşteri', kim(u)],
    ['Oda', silindi ? 'silindi' : odasiVardi ? 'kilitlendi' : 'yok'],
    ...(iptal ? [['Not', 'bir daha key giremez (kaldırmak için süre uzat)', false]] : []),
  ])
  return `${etiket(u)} ${iptal ? 'lisansı iptal edildi' : 'lisansının süresi bitirildi'}${silindi ? ', odası silindi' : ''}.`
}

function keyIptalIslem(yapan, keyVeyaOnek) {
  const r = depo.keyIptalEt(keyVeyaOnek, { yapan: yapan.id, yapanAdi: etiket(yapan) })
  if (r.ok) {
    panelGuncelle()
    keyLog('iptal', '🗑️ Key iptal edildi', [
      ['İptal eden', kim(yapan)],
      ['Key', onekYaz(r.kayit)],
      ['Süre', sureYazi(keySuresi(r.kayit))],
      ['Üreten', r.kayit.olusturan ? `<@${r.kayit.olusturan}>` : 'bilinmiyor'],
      ...(r.kayit.alici ? [['Verilmişti', `<@${r.kayit.alici}>`]] : []),
    ])
  }
  return r.mesaj
}

// Bir keyin bütün geçmişi (/key-sorgu, panelde "Key Sorgula")
function keySorguMetni(keyVeyaOnek) {
  const bulunan = depo.keyBul(keyVeyaOnek)
  if (!bulunan.length) return 'Bu keyi bulamadım. Tam keyi ya da YAREN-XXXX önekini yaz.'
  const durum = { bos: 'boşta (kullanılmadı)', kullanildi: 'kullanıldı', iptal: 'iptal edildi' }
  const kayitlar = bulunan.slice(-10).map((k) =>
    [
      `**${onekYaz(k)}** — ${sureYazi(keySuresi(k))}${k.ai ? '' : ' (AI yok)'} — **${durum[k.durum] || k.durum}**`,
      `Üreten: ${k.olusturan ? `<@${k.olusturan}> (${k.olusturanAdi || k.olusturan})` : 'bilinmiyor'} — ${zaman(k.olusturma)}`,
      k.alici
        ? `Verildiği kişi: <@${k.alici}>${k.dmGitti === true ? ' (DM ile)' : k.dmGitti === false ? ' (DM kapalıydı, satıcı iletti)' : ''}`
        : null,
      k.kullanan ? `Kullanan: <@${k.kullanan}> — ${zaman(k.kullanma)}` : null,
      k.durum === 'iptal' ? `İptal eden: ${k.iptalEden ? `<@${k.iptalEden}>` : 'bilinmiyor'}${k.iptalZamani ? ` — ${zaman(k.iptalZamani)}` : ''}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  )
  return sigdir(bulunan.length > 1 ? `Bu öneke uyan ${bulunan.length} key var:` : 'Key geçmişi:', kayitlar.map((x) => x + '\n'))
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
    `Bot: **${yonetici.calisiyor(userId) ? 'çalışıyor' : 'kapalı'}**` + (l.son?.host ? ` (son sunucu: ${l.son.host}:${l.son.port})` : ''),
    `Oyundaki sahip: ${l.son?.owner ? `**${l.son.owner}**` : 'yok'}`,
    `Oda: ${l.kanalId ? `<#${l.kanalId}>` : 'yok'}`,
    `Kullandığı keyler (${(l.keyler || []).length}): ${(l.keyler || []).length > 20 ? '… ' : ''}${(l.keyler || []).slice(-20).map((k) => `\`${k}…\``).join(', ') || '-'}`,
    `İlk key: ${zaman(l.olusturma)}`,
  ].join('\n')
}

// ---------- SATICI KOMUTLARI ----------
async function saticiKomutu(i) {
  const sessiz = { allowedMentions: { parse: [] } }
  if (i.commandName === 'yapay-zeka') {
    if (i.user.id !== ADMIN_ID) return i.reply(gizli('Yapay zeka ayarını sadece satıcı değiştirebilir (faturası ona gelir).'))
    return i.reply(yapayZekaDurumu())
  }
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

  if (i.commandName === 'key-iptal') return i.reply(gizli(keyIptalIslem(i.user, i.options.getString('key'))))
  if (i.commandName === 'key-sorgu') return i.reply({ ...gizli(keySorguMetni(i.options.getString('key'))), ...sessiz })

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
  if (i.commandName === 'yedek') {
    await i.deferReply({ flags: MessageFlags.Ephemeral })
    try {
      const { ekler, bilgi } = yedekAl()
      return i.editReply({ content: `🗄️ Yedek alındı (${bilgi}). Dosyalar ekte; ayrıca bilgisayarında \`veri/yedekler\` klasöründe.`, files: ekler })
    } catch (e) {
      return i.editReply('Yedek alınamadı: ' + e.message)
    }
  }
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
// key_log_kanal_id yanlışlıkla key kanalı yazıldıysa key kanalını kapatma (müşteriler oraya
// key yazıyor, kapatılırsa keyler herkese açık kalır): key logu satıcı loguna düşsün
if (KEY_LOG_KANAL_ID && paneller.keyKanallari.includes(KEY_LOG_KANAL_ID)) {
  const uyari = `⚠️ key_log_kanal_id (${KEY_LOG_KANAL_ID}) müşterilerin key yazdığı key kanalı, key log kanalı olamaz. Key logları satıcı log kanalına gidiyor. ayarlar.json'da key_log_kanal_id'yi sadece senin gördüğün ayrı bir kanal yap.`
  console.error(uyari)
  setImmediate(() => adminLog(uyari))
  KEY_LOG_KANAL_ID = ''
}
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
function herkeseAcik(kanal, guild, haric = []) {
  if (!kanal?.permissionsFor) return true
  const gorur = (r) => kanal.permissionsFor(r)?.has(PermissionFlagsBits.ViewChannel) !== false
  if (gorur(guild.roles.everyone)) return true
  const roller = guild.roles.cache ? [...guild.roles.cache.values()] : []
  return roller.some(
    (r) =>
      r.id !== guild.roles.everyone.id &&
      r.id !== yetkiliRol?.id &&
      !haric.includes(r.id) &&
      !r.managed && // botların kendi rolleri
      !r.permissions?.has(PermissionFlagsBits.Administrator) &&
      gorur(r)
  )
}

// Key kanalındaki "Key Gir" paneli (/panel-kur ve /kur koyar)
function keyPaneliMesaji() {
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
  return { embeds: [embed], components: [buton] }
}

async function panelKur(i) {
  if (i.channelId === LOG_CHANNEL_ID || i.channelId === KEY_LOG_KANAL_ID) {
    return i.reply(gizli('Log kanalı key kanalı olamaz (oradaki mesajlar silinirdi). Müşterilerin göreceği ayrı bir kanalda yaz.'))
  }
  const ch = i.channel ?? (await client.channels.fetch(i.channelId).catch(() => null))
  try {
    await ch.send(keyPaneliMesaji())
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
    const r = await keyIsle(m.author, m.guild, key, gecmis ? 'key kanalı (bot kapalıyken yazılmış)' : 'key kanalı')
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
      b('bitir', 'Lisans Bitir', '⛔', ButtonStyle.Danger),
      b('keysorgu', 'Key Sorgula', '🔎')
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

// Yönetim panelini kanala koyar, eskisini kaldırır (butonları yine çalışırdı ama kafa karıştırmasın)
async function yonetimPaneliGonder(kanal) {
  if (paneller.yonetimMesajId) {
    const eski = await kanalGetir(paneller.yonetimKanalId).catch(() => null)
    await eski?.messages
      ?.fetch(paneller.yonetimMesajId)
      .then((m) => m.delete())
      .catch(() => {})
  }
  const mesaj = await kanal.send({ embeds: [yonetimEmbed()], components: yonetimButonlari(), allowedMentions: { parse: [] } })
  paneller.yonetimKanalId = kanal.id
  paneller.yonetimMesajId = mesaj.id
  panelKaydet()
}

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
          ...(ADMIN_ID ? [{ id: ADMIN_ID, type: OverwriteType.Member, allow: [...izin, PermissionFlagsBits.UseApplicationCommands] }] : []),
          ...(yetkiliRol ? [{ id: yetkiliRol.id, type: OverwriteType.Role, allow: [...izin, PermissionFlagsBits.UseApplicationCommands] }] : []),
        ],
      })
      yeniKanal = true
    } catch (e) {
      return i.editReply(`Yönetim kanalı açılamadı (${e.message}). Sadece senin görebildiğin bir kanalda tekrar /yonetim-kur yaz.`)
    }
  }
  try {
    await yonetimPaneliGonder(kanal)
  } catch (e) {
    return i.editReply(`Panel bu kanala yazılamadı (${e.message}). Botun "Mesaj Gönder" ve "Bağlantı Yerleştir" izni olmalı.`)
  }
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
  keysorgu: () =>
    form('keysorgu', 'Key Sorgula', (l) =>
      l
        .setLabel('Key ya da öneki')
        .setDescription('Kim üretti, kime verildi, kim ne zaman kullandı')
        .setTextInputComponent((t) => t.setCustomId('key').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40))
    ),
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
  if (ne === 'keyiptal') return i.reply(gizli(keyIptalIslem(i.user, f.getTextInputValue('key'))))
  if (ne === 'keysorgu') return i.reply({ ...gizli(keySorguMetni(f.getTextInputValue('key'))), ...sessiz })

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
    musteriRolu(l.userId, false)
    keyLog('lisans', '⌛ Lisans süresi doldu', [
      ['Müşteri', `<@${l.userId}> (${l.kullaniciAdi})`],
      ['Kullandığı keyler', (l.keyler || []).slice(-5).map((k) => `\`${k}…\``).join(', ') || '-'],
      ['Bitiş', zaman(l.bitis)], // bot kapalıyken dolduysa "Zaman" fark edildiği an olur
    ])
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

// ---------- GİRİŞ (token) ----------
// Token yoksa ya da Discord kabul etmiyorsa sorulur (aşağıda TOKEN ALMA), Discord'a
// sorularak denenir, ayarlar.json'a kaydedilir.
const tokenTemizle = (t) =>
  String(t || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(Bot|Bearer)\s+/i, '')
    .trim()

// ---------- TOKEN ALMA ----------
// Token üç yoldan hangisi önce gelirse oradan alınır:
//  1) Pano izlenir: Developer Portal'da "Copy"ye basılınca token kendiliğinden alınır
//     (yapıştırmak gerekmez; sadece token'a benzeyen kısa metinlere bakılır).
//  2) Konsola yapıştırılır ya da yazılır: her karakter yerine * görünür. Boş Enter panoyu
//     bir kez daha okur, eski konsoldaki Ctrl+V (^V) panoyu yapıştırır.
//  3) Klasöre token.txt konursa okunur ve silinir.
// Ctrl+C bot'u kapatır (takılı kalmaz).
const TOKEN_BICIMI = /^[\w-]+\.[\w-]+\.[\w-]+$/
const PANO_TOKEN_BICIMI = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/ // panodan kendiliğinden almak için daha sıkı

// Konsoldan satır okur; geri dönen fonksiyon okumayı yarıda keser
function konsoldanOku(metin, bitince) {
  const girdi = process.stdin
  process.stdout.write(metin)
  let deger = ''
  let acik = true
  const ekle = (s) => {
    deger += s
    process.stdout.write('*'.repeat([...s].length))
  }
  const kapat = () => {
    if (!acik) return
    acik = false
    girdi.removeListener('data', veri)
    if (girdi.isTTY) girdi.setRawMode(false)
    girdi.pause()
    process.stdout.write('\n')
  }
  const veri = (parca) => {
    // ok tuşları, yapıştırma işaretleri (ESC [ ...) gibi diziler atılır
    const temiz = String(parca).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '')
    for (const ch of temiz) {
      if (ch === '\r' || ch === '\n') {
        kapat()
        return bitince(deger)
      }
      if (ch === '\u0003' || (ch === '\u0004' && !deger)) {
        kapat()
        process.exit(0)
      }
      if (ch === '\u0016') {
        ekle(panoyuOku())
        continue
      }
      if (ch === '\u007f' || ch === '\b') {
        if (deger) {
          deger = [...deger].slice(0, -1).join('')
          process.stdout.write('\b \b')
        }
        continue
      }
      if (ch >= ' ') ekle(ch)
    }
  }
  if (girdi.isTTY) girdi.setRawMode(true)
  girdi.setEncoding('utf8')
  girdi.on('data', veri)
  girdi.resume()
  return kapat
}

// Panodaki (kopyalanan) metin; okunamazsa ''
function panoyuOku() {
  const calistir = (komut, argumanlar) => {
    try {
      return execFileSync(komut, argumanlar, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
    } catch (_) {
      return ''
    }
  }
  if (process.platform === 'win32') return calistir('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Get-Clipboard -Raw'])
  if (process.platform === 'darwin') return calistir('pbpaste', [])
  return calistir('xclip', ['-o', '-selection', 'clipboard']) || calistir('wl-paste', ['-n'])
}

// Panoyu izler, kısa metin değiştikçe bildirir. Geri dönen fonksiyon izlemeyi durdurur.
// Windows'ta tek bir PowerShell sürekli çalışır (her saniye yeni işlem açılmasın).
const PANO_IZLE_PS = [
  '$son = $null',
  'while ($true) {',
  '  try { $c = Get-Clipboard -Raw } catch { $c = $null }',
  '  if ($c -and $c.Length -lt 300 -and $c -ne $son) {',
  '    $son = $c',
  '    [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c)))',
  '    [Console]::Out.Flush()',
  '  }',
  '  Start-Sleep -Milliseconds 700',
  '}',
].join('\n')
function panoIzle(degisince) {
  if (process.platform === 'win32') {
    let cocuk
    try {
      cocuk = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PANO_IZLE_PS, 'utf16le').toString('base64')],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
    } catch (_) {
      return () => {}
    }
    cocuk.on('error', () => {})
    let tampon = ''
    cocuk.stdout.on('data', (d) => {
      tampon += d
      let n
      while ((n = tampon.indexOf('\n')) >= 0) {
        const satir = tampon.slice(0, n).trim()
        tampon = tampon.slice(n + 1)
        if (satir) degisince(Buffer.from(satir, 'base64').toString('utf8'))
      }
    })
    const oldur = () => {
      try {
        cocuk.kill()
      } catch (_) {}
    }
    process.once('exit', oldur) // bot kapanırsa PowerShell arkada kalmasın
    return () => {
      process.removeListener('exit', oldur)
      oldur()
    }
  }
  let son = null
  let calisiyor = false
  const zamanlayici = setInterval(() => {
    if (calisiyor) return
    calisiyor = true
    const komut = process.platform === 'darwin' ? ['pbpaste', []] : ['xclip', ['-o', '-selection', 'clipboard']]
    execFile(komut[0], komut[1], { encoding: 'utf8', timeout: 3000 }, (hata, cikti) => {
      calisiyor = false
      if (hata || !cikti || cikti.length >= 300 || cikti === son) return
      son = cikti
      degisince(cikti)
    })
  }, 1000)
  return () => clearInterval(zamanlayici)
}

// Son çare: klasöre token.txt koyup içine token yapıştırılırsa okunur ve dosya silinir
// (uzantılar gizliyken "token.txt" adı verilince dosya token.txt.txt olur, o da okunur)
function tokenDosyasiOku() {
  for (const ad of ['token.txt', 'token.txt.txt']) {
    const dosya = path.join(__dirname, ad)
    try {
      const t = fs.readFileSync(dosya, 'utf-8').replace(/^\uFEFF/, '')
      fs.rmSync(dosya, { force: true }) // token düz dosyada kalmasın
      if (t.trim()) return t
    } catch (_) {}
  }
  return ''
}

// Bir token gelene kadar bekler (pano, konsol, token.txt). denenenler: geçersiz çıkmış
// tokenlar, panoda dururken tekrar tekrar denenmesin.
function tokenBekle(denenenler) {
  return new Promise((coz) => {
    let bitti = false
    const durdurulacaklar = []
    const bitir = (ham, kaynak) => {
      if (bitti) return
      bitti = true
      for (const d of durdurulacaklar) d()
      coz({ ham, kaynak })
    }
    durdurulacaklar.push(
      panoIzle((metin) => {
        const t = tokenTemizle(metin)
        if (PANO_TOKEN_BICIMI.test(t) && !denenenler.has(t)) bitir(t, 'pano')
      })
    )
    const dosyaSayaci = setInterval(() => {
      const t = tokenDosyasiOku()
      if (t) bitir(t, 'dosya')
    }, 1000)
    durdurulacaklar.push(() => clearInterval(dosyaSayaci))
    // boş Enter: panoya bakar; o da boşsa ne yapılacağını söyleyip yeniden sorar
    const sor = () =>
      durdurulacaklar.push(
        konsoldanOku('Token: ', (deger) => {
          if (deger.trim()) return bitir(deger, 'konsol')
          const pano = panoyuOku()
          if (pano.trim()) return bitir(pano, 'pano')
          console.log("(Boş: Developer Portal'da \"Copy\"ye bas, bot kendisi alır; ya da token'ı buraya yapıştırıp Enter'a bas.)")
          if (!bitti) sor()
        })
      )
    if (process.stdin.isTTY) sor()
  })
}

// Token'la uygulama bilgisini al: { uygulama } ya da { yanlis: true } / { hata }
async function tokenDene(token) {
  client.rest.setToken(token)
  try {
    return { uygulama: await client.rest.get(Routes.currentApplication()) }
  } catch (e) {
    if (e.status === 401) return { yanlis: true }
    return { hata: e.message }
  }
}

async function tokenSor(neden) {
  const dosyadan = tokenDosyasiOku()
  if (!process.stdin.isTTY && !dosyadan) {
    console.error(`${neden} Botu bir kere komut penceresinde (node discordbot.js) aç, token'ı yapıştır; ya da bu klasöre token.txt koyup içine token'ı yaz.`)
    process.exit(1)
  }
  const portal = 'https://discord.com/developers/applications'
  console.log('')
  console.log('==================== YAREN İLK AYAR ====================')
  console.log(neden)
  console.log(`Discord Developer Portal tarayıcıda açılıyor (açılmazsa: ${portal})`)
  console.log(' 1) "New Application" > ad ver (ör. Yaren) > Create')
  console.log(' 2) Soldan "Bot" > "Reset Token" > "Yes, do it!" > "Copy"')
  console.log(' 3) Bu kadar: "Copy"ye basınca bot token\'ı kendisi alır,')
  console.log('    yapıştırmana gerek yok. (İstersen buraya yapıştırıp Enter\'a da basabilirsin.)')
  console.log(' Token botun şifresidir: kimseye gösterme.')
  console.log('========================================================')
  if (!dosyadan) tarayicidaAc(portal)
  const denenenler = new Set()
  let ilk = dosyadan ? { ham: dosyadan, kaynak: 'dosya' } : null
  for (;;) {
    const { ham, kaynak } = ilk || (await tokenBekle(denenenler))
    ilk = null
    const token = tokenTemizle(ham)
    if (!token) continue
    denenenler.add(token)
    const nereden = { pano: 'kopyaladığın token alındı', dosya: 'token.txt okundu (dosya silindi)', konsol: 'yazdığın token alındı' }[kaynak] || 'token alındı'
    console.log(`Token: ${token.slice(0, 6)}… (gizlendi) — ${nereden}, deneniyor...`)
    let sorun = ''
    if (!TOKEN_BICIMI.test(token)) {
      sorun = 'Bu bir bot token\'ına benzemiyor (noktayla ayrılmış 3 parça olmalı). Bot sayfasındaki "Reset Token" ile alınanı kopyala.'
    } else {
      const r = await tokenDene(token)
      if (r.yanlis) sorun = 'Discord bu token\'ı kabul etmedi. "Reset Token" > "Copy" ile yenisini al.'
      else if (r.hata) sorun = `Discord'a ulaşılamadı (${r.hata}). İnternetini kontrol edip token'ı tekrar kopyala.`
      else {
        try {
          ayarlar.kaydet({ discord_token: token })
          console.log('Token kaydedildi (ayarlar.json). Bir daha sorulmayacak.')
        } catch (e) {
          console.log(`Token dosyaya yazılamadı (${e.message}); bot bu sefer çalışır, bir dahaki açılışta tekrar sorar.`)
        }
        return { token, uygulama: r.uygulama }
      }
    }
    console.log(sorun)
    if (!process.stdin.isTTY) process.exit(1) // token.txt yanlıştı, soracak konsol yok
  }
}

// Key kanalına yazılan keyi okuyabilmek için Message Content Intent lazım.
// Developer Portal'da kapalıyken istersek Discord bağlantıyı hiç kabul etmez,
// o yüzden önce açık mı diye bakılır. Kapalıysa Discord'un izin verdiği şekilde
// (100'den az sunucudaki botlar) kendisi açmayı dener; olmazsa sadece buton çalışır.
const MESAJ_BAYRAK = ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited
const SINIRLI_BAYRAK =
  ApplicationFlags.GatewayPresenceLimited | ApplicationFlags.GatewayGuildMembersLimited | ApplicationFlags.GatewayMessageContentLimited
async function mesajIzniAc(uygulama) {
  const bayrak = Number(uygulama?.flags || 0)
  if (bayrak & MESAJ_BAYRAK) return true
  // Önce bütün bayraklarla, olmazsa sadece değiştirilebilenlerle
  for (const flags of [bayrak | ApplicationFlags.GatewayMessageContentLimited, (bayrak & SINIRLI_BAYRAK) | ApplicationFlags.GatewayMessageContentLimited]) {
    try {
      const yeni = await client.rest.patch(Routes.currentApplication(), { body: { flags } })
      if (Number(yeni?.flags || 0) & MESAJ_BAYRAK) {
        console.log('Message Content Intent açıldı: müşteriler keyi kanala yazarak da girebilir.')
        return true
      }
    } catch (_) {}
  }
  return false
}

// 5: kullanıcının düzeltmesi gereken bir şey var; baslat.bat yeniden denemeden bekler
const DUZELT = 5

async function girisYap() {
  if (ayarlar.bozuk) {
    console.error(`ayarlar.json bozuk, okunamadı: ${ayarlar.bozuk}`)
    console.error('Not Defteri ile aç, fazla/eksik virgül ya da tırnağı düzelt ve kaydet. Düzeltemezsen dosyayı sil:')
    console.error("bot token'ı yeniden sorar, sunucunda /kur'u tekrar yazarsın (müşteriler veri/ klasöründe, kaybolmaz).")
    process.exit(DUZELT)
  }
  let uygulama = null
  if (!DISCORD_TOKEN) {
    ;({ token: DISCORD_TOKEN, uygulama } = await tokenSor('Discord bot token\'ı henüz girilmemiş.'))
  } else {
    DISCORD_TOKEN = tokenTemizle(DISCORD_TOKEN)
    const r = await tokenDene(DISCORD_TOKEN)
    if (r.yanlis && ayarlar.envden('DISCORD_TOKEN')) {
      console.error("DISCORD_TOKEN ortam değişkenindeki token geçersiz: onu güncelle ya da sil (o varken ayarlar.json'daki token kullanılmaz).")
      process.exit(DUZELT)
    }
    if (r.yanlis) ({ token: DISCORD_TOKEN, uygulama } = await tokenSor('Kayıtlı token artık geçersiz (sıfırlanmış olabilir).'))
    else if (r.hata) console.error('Bot bilgisi alınamadı:', r.hata)
    else uygulama = r.uygulama
  }
  if (uygulama) {
    uygulamaId = uygulama.id || ''
    mesajOkunur = await mesajIzniAc(uygulama)
  }
  if (mesajOkunur) {
    client.options.intents = new IntentsBitField(client.options.intents.bitfield | GatewayIntentBits.MessageContent).freeze()
  } else {
    console.log('Not: Message Content Intent kapalı; müşteriler keyi kanala yazarak değil, "Key Gir" butonuyla girer.')
    console.log('     Açmak için: Developer Portal > Bot > Message Content Intent > Save, sonra botu yeniden başlat.')
  }
  await client.login(DISCORD_TOKEN)
}
girisYap().catch((e) => {
  console.error('Discord girişi başarısız (token yanlış olabilir):', e.message)
  process.exit(1)
})
