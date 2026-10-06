// Discord kontrol botu
// - Log kanalına NPC'nin (gorevbot.js) yaptıklarını yazar
// - Kontrol kanalındaki slash komutlarıyla botu başlatır/durdurur
//
// Kurulum: npm install
// Ayar: ayarlar.ornek.json dosyasını ayarlar.json adıyla kopyala, token'ı yaz.
// Çalıştırma: node discordbot.js
// (gorevbot.js'i ayrıca ELLE çalıştırma, bu bot onu kendisi başlatır.)
//
// Komutlar (sadece kontrol kanalında ve sadece sen):
//   /baslat host:... port:... [kullanici] [hesap] [surum] [sahip]
//   /durdur
//   /durum
//   /gorev gorev:farm|odun|tas|topla|otonom|dur|gel|durum

const { spawn } = require('child_process')
const path = require('path')
const {
  Client,
  Events,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  MessageFlags,
} = require('discord.js')
const ayarlar = require('./ayarlar')

// ---------- AYARLAR ----------
// Hepsi ayarlar.json'dan (ya da aynı isimli ortam değişkenlerinden) okunur.
// Token'ı ASLA koda yazma: kodu paylaşınca token da gider.
const DISCORD_TOKEN = ayarlar.discordToken           // Developer Portal > Bot > Token
const GUILD_ID = ayarlar.guildId                     // Discord sunucunun ID'si
const LOG_CHANNEL_ID = ayarlar.logKanalId            // NPC loglarının düşeceği kanal
const CONTROL_CHANNEL_ID = ayarlar.kontrolKanalId    // komutları yazacağın kanal
const DISCORD_OWNER_ID = ayarlar.discordSahipId      // sadece bu kişi komut kullanabilir
const MC_OWNER = ayarlar.mcSahip                     // oyunda !komut yazabilecek Minecraft adın
const DEFAULT_BOT_NAME = 'GorevBot'
const KOMUT_URL = 'http://127.0.0.1:3030'            // gorevbot.js'in yerel sunucusu
// -----------------------------

const eksik = Object.entries({
  discord_token: DISCORD_TOKEN,
  guild_id: GUILD_ID,
  log_kanal_id: LOG_CHANNEL_ID,
  kontrol_kanal_id: CONTROL_CHANNEL_ID,
  discord_sahip_id: DISCORD_OWNER_ID,
})
  .filter(([, v]) => !v)
  .map(([k]) => k)
if (eksik.length > 0) {
  console.error(`ayarlar.json içinde eksik: ${eksik.join(', ')}`)
  console.error('ayarlar.ornek.json dosyasını ayarlar.json adıyla kopyalayıp doldur.')
  process.exit(1)
}

const BOT_SCRIPT = path.join(__dirname, 'gorevbot.js')
const client = new Client({ intents: [GatewayIntentBits.Guilds] })

let child = null
let info = null

// ---------- LOG KUYRUĞU (rate limit olmasın diye 2 sn'de bir toplu gönder) ----------
const MAX_KUYRUK = 300 // Discord'a ulaşılamazsa bellek şişmesin
let queue = []
let atlanan = 0
let flushing = false

function log(line) {
  const time = new Date().toLocaleTimeString('tr-TR')
  queue.push(`[${time}] ${line}`)
  if (queue.length > MAX_KUYRUK) {
    atlanan += queue.length - MAX_KUYRUK
    queue.splice(0, queue.length - MAX_KUYRUK)
  }
}

const clean = (l) => l.replace(/\x1b\[[0-9;]*m/g, '')

async function flush() {
  // önceki gönderim bitmeden yenisi başlarsa satırlar karışık sırayla düşer
  if (flushing || queue.length === 0 || !client.isReady()) return
  flushing = true
  const lines = queue.splice(0, queue.length)
  if (atlanan > 0) {
    lines.unshift(`(${atlanan} log satırı sığmadığı için atlandı)`)
    atlanan = 0
  }
  const text = lines.join('\n').replace(/```/g, "'''")
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID)
    for (let i = 0; i < text.length; i += 1900) {
      await ch.send({
        content: '```\n' + text.slice(i, i + 1900) + '\n```',
        allowedMentions: { parse: [] }, // loglardaki @everyone kimseyi etiketlemesin
      })
    }
  } catch (e) {
    console.error('Log gönderilemedi:', e.message)
  } finally {
    flushing = false
  }
}
setInterval(flush, 2000)

// ---------- BOT SÜRECİ ----------
function startBot({ host, port, user, auth, version, owner }) {
  const me = spawn(process.execPath, [BOT_SCRIPT], {
    cwd: __dirname,
    env: {
      ...process.env,
      MC_HOST: host,
      MC_PORT: String(port),
      MC_BOT_NAME: user,
      MC_AUTH: auth,
      MC_VERSION: version || '',
      MC_OWNER: owner,
    },
  })
  child = me
  info = { host, port, user, auth, version }

  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const parts = buf.split(/\r?\n/)
      buf = parts.pop()
      parts.forEach((l) => l.trim() && log(clean(l)))
    })
  }
  pipe(me.stdout)
  pipe(me.stderr)

  me.on('error', (e) => log('Bot başlatılamadı: ' + e.message))
  me.on('exit', (code, signal) => {
    log(`Bot kapandı (${signal ? 'sinyal: ' + signal : 'kod: ' + code})`)
    if (child === me) {
      child = null
      info = null
    }
  })
}

function stopBot() {
  if (child) child.kill()
}

process.on('exit', stopBot)
for (const sinyal of ['SIGINT', 'SIGTERM']) {
  process.on(sinyal, () => {
    stopBot()
    process.exit(0)
  })
}
// Tek bir Discord hatası (ör. süresi geçmiş komut) bütün botu ve NPC'yi düşürmesin
process.on('unhandledRejection', (e) => console.error('Beklenmeyen hata:', e?.message || e))
client.on(Events.Error, (e) => console.error('Discord hatası:', e.message))

// gorevbot.js'in yerel sunucusuna istek atar, JSON cevabı döndürür
async function botaSor(yol, govde) {
  const r = await fetch(KOMUT_URL + yol, {
    method: govde ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: govde ? JSON.stringify(govde) : undefined,
    signal: AbortSignal.timeout(2500), // Discord 3 sn içinde cevap ister
  })
  const veri = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(veri.hata || 'HTTP ' + r.status)
  return veri
}

// ---------- SLASH KOMUTLARI ----------
const COMMANDS = [
  {
    name: 'baslat',
    description: 'Botu bir Minecraft sunucusuna sokar',
    options: [
      { name: 'host', description: 'Sunucu adresi (örn. oyna.ornek.com)', type: ApplicationCommandOptionType.String, required: true },
      { name: 'port', description: 'Port (varsayılan 25565)', type: ApplicationCommandOptionType.Integer, min_value: 1, max_value: 65535 },
      { name: 'kullanici', description: 'Botun oyundaki adı', type: ApplicationCommandOptionType.String },
      {
        name: 'hesap',
        description: 'Giriş türü',
        type: ApplicationCommandOptionType.String,
        choices: [
          { name: 'offline (crack / LAN)', value: 'offline' },
          { name: 'microsoft (premium)', value: 'microsoft' },
        ],
      },
      { name: 'surum', description: 'Minecraft sürümü (boşsa otomatik, örn. 1.20.4)', type: ApplicationCommandOptionType.String },
      { name: 'sahip', description: 'Oyunda bot komutlarını yazabilecek kişinin adı', type: ApplicationCommandOptionType.String },
    ],
  },
  { name: 'durdur', description: 'Botu sunucudan çıkarır ve kapatır' },
  { name: 'durum', description: 'Botun çalışıp çalışmadığını ve oyundaki durumunu gösterir' },
  {
    name: 'gorev',
    description: 'Çalışan bota görev verir',
    options: [
      {
        name: 'gorev',
        description: 'Ne yapsın?',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'farm (çiftçilik)', value: 'farm' },
          { name: 'odun', value: 'odun' },
          { name: 'taş', value: 'tas' },
          { name: 'topla (yerdeki eşyalar)', value: 'topla' },
          { name: 'otonom (kendi karar versin)', value: 'otonom' },
          { name: 'dur (görevi iptal et)', value: 'dur' },
          { name: 'gel', value: 'gel' },
          { name: 'durum', value: 'durum' },
        ],
      },
    ],
  },
]

client.once(Events.ClientReady, async () => {
  console.log(`Discord botu hazır: ${client.user.tag}`)
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    await guild.commands.set(COMMANDS)
    log('Discord kontrol botu açıldı. Komutlar: /baslat /durdur /durum /gorev')
  } catch (e) {
    console.error(
      `Slash komutları kaydedilemedi (${e.message}). guild_id doğru mu, bot o sunucuda mı?`
    )
  }
})

const HOST_RE = /^[a-zA-Z0-9.\-]+$/
const USER_RE = /^[a-zA-Z0-9_]{3,16}$/

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return
  try {
    await komutuIsle(i)
  } catch (e) {
    console.error('Komut hatası:', e.message)
  }
})

async function komutuIsle(i) {
  if (i.user.id !== DISCORD_OWNER_ID || i.channelId !== CONTROL_CHANNEL_ID) {
    return i.reply({
      content: 'Bu komutu burada kullanamazsın.',
      flags: MessageFlags.Ephemeral,
    })
  }

  if (i.commandName === 'baslat') {
    if (child) {
      return i.reply(`Bot zaten çalışıyor (${info.host}:${info.port}). Önce /durdur yaz.`)
    }
    const host = i.options.getString('host').trim()
    const port = i.options.getInteger('port') ?? 25565
    const user = (i.options.getString('kullanici') || DEFAULT_BOT_NAME).trim()
    const auth = i.options.getString('hesap') || 'offline'
    const version = (i.options.getString('surum') || '').trim()
    const owner = (i.options.getString('sahip') || MC_OWNER).trim()

    if (!HOST_RE.test(host)) return i.reply('Geçersiz sunucu adresi.')
    if (auth === 'offline' && !USER_RE.test(user)) {
      return i.reply('Kullanıcı adı 3-16 karakter olmalı (harf, rakam, _).')
    }
    if (!USER_RE.test(owner)) return i.reply('Sahip adı geçerli bir Minecraft adı olmalı.')
    if (version && !/^\d+\.\d+(\.\d+)?$/.test(version)) {
      return i.reply('Sürüm 1.20.4 gibi yazılmalı.')
    }

    startBot({ host, port, user, auth, version, owner })
    log(`Başlatılıyor: ${host}:${port} (${user}, ${auth}${version ? ', ' + version : ''})`)
    return i.reply(`Bot başlatılıyor: **${host}:${port}**. Detaylar log kanalında.`)
  }

  if (i.commandName === 'durdur') {
    if (!child) return i.reply('Bot zaten çalışmıyor.')
    stopBot()
    return i.reply('Bot durduruluyor.')
  }

  if (i.commandName === 'durum') {
    if (!child) return i.reply('Çalışmıyor.')
    let oyun = ''
    try {
      const s = await botaSor('/durum')
      if (s.hazir === false) oyun = '\nHenüz oyuna girmedi.'
      else {
        oyun =
          `\nGörev: ${s.aktif_gorev || 'yok'}${s.otonom ? ' (otonom)' : ''}` +
          ` | Can: ${Math.round(s.can)}/20 | Açlık: ${s.aclik}/20 | Boş slot: ${s.bos_slot}` +
          ` | Konum: ${s.konum.join(', ')}`
      }
    } catch (_) {
      oyun = '\nOyundaki durumu alınamadı.'
    }
    return i.reply(
      `Çalışıyor: **${info.host}:${info.port}** (kullanıcı: ${info.user}, giriş: ${info.auth})${oyun}`
    )
  }

  if (i.commandName === 'gorev') {
    if (!child) return i.reply('Bot çalışmıyor. Önce /baslat yaz.')
    const komut = i.options.getString('gorev')
    try {
      const { cevap } = await botaSor('/komut', { komut })
      return i.reply(`**${komut}** → ${cevap || 'gönderildi'}`)
    } catch (e) {
      return i.reply('Bota ulaşamadım: ' + e.message)
    }
  }
}

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Discord girişi başarısız (token yanlış olabilir):', e.message)
  process.exit(1)
})
