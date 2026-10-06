// Discord kontrol botu
// - Log kanalına NPC'nin (gorevbot.js) yaptıklarını yazar
// - Kontrol kanalındaki slash komutlarıyla botu başlatır/durdurur
//
// Kurulum: npm install discord.js
// Çalıştırma: node discordbot.js
// (gorevbot.js'i ayrıca ELLE çalıştırma, bu bot onu kendisi başlatır.)
//
// Komutlar (sadece kontrol kanalında ve sadece sen):
//   /baslat host:... port:... [kullanici] [hesap] [surum] [sahip]
//   /durdur
//   /durum
//   /gorev gorev:farm|odun|tas|dur|gel|durum

const { spawn } = require('child_process')
const path = require('path')
const {
  Client,
  Events,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  MessageFlags,
} = require('discord.js')

// ---------- AYARLAR ----------
const DISCORD_TOKEN = 'BURAYA_TOKEN'            // Developer Portal > Bot > Token
const GUILD_ID = '1062443427964399687'                         // Discord sunucunun ID'si
const LOG_CHANNEL_ID = '1556774227191922848'               // NPC loglarının düşeceği kanal
const CONTROL_CHANNEL_ID = '1556774274453209108'       // komutları yazacağın kanal
const DISCORD_OWNER_ID = '561571565527891985' // sadece bu kişi komut kullanabilir
const MC_OWNER = 'Lyraiv'        // oyunda !komut yazabilecek Minecraft adın
const DEFAULT_BOT_NAME = 'GorevBot'
// -----------------------------

const BOT_SCRIPT = path.join(__dirname, 'gorevbot.js')
const client = new Client({ intents: [GatewayIntentBits.Guilds] })

let child = null
let info = null

// ---------- LOG KUYRUĞU (rate limit olmasın diye 2 sn'de bir toplu gönder) ----------
let queue = []

function log(line) {
  const time = new Date().toLocaleTimeString('tr-TR')
  queue.push(`[${time}] ${line}`)
}

const clean = (l) => l.replace(/\x1b\[[0-9;]*m/g, '')

async function flush() {
  if (queue.length === 0) return
  const text = queue.splice(0, queue.length).join('\n').replace(/```/g, "'''")
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID)
    for (let i = 0; i < text.length; i += 1900) {
      await ch.send('```\n' + text.slice(i, i + 1900) + '\n```')
    }
  } catch (e) {
    console.error('Log gönderilemedi:', e.message)
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
  me.on('exit', (code) => {
    log(`Bot kapandı (kod: ${code})`)
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
process.on('SIGINT', () => {
  stopBot()
  process.exit(0)
})

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
  { name: 'durum', description: 'Botun çalışıp çalışmadığını gösterir' },
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
  const guild = await client.guilds.fetch(GUILD_ID)
  await guild.commands.set(COMMANDS)
  log('Discord kontrol botu açıldı. Komutlar: /baslat /durdur /durum /gorev')
})

const HOST_RE = /^[a-zA-Z0-9.\-]+$/
const USER_RE = /^[a-zA-Z0-9_]{3,16}$/

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return

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
    return i.reply(
      child
        ? `Çalışıyor: **${info.host}:${info.port}** (kullanıcı: ${info.user}, giriş: ${info.auth})`
        : 'Çalışmıyor.'
    )
  }

  if (i.commandName === 'gorev') {
    if (!child) return i.reply('Bot çalışmıyor. Önce /baslat yaz.')
    const komut = i.options.getString('gorev')
    try {
      const r = await fetch('http://127.0.0.1:3030/komut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ komut }),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return i.reply(`Görev gönderildi: **${komut}**`)
    } catch (e) {
      return i.reply('Bota ulaşamadım: ' + e.message)
    }
  }
})

client.login(DISCORD_TOKEN)
