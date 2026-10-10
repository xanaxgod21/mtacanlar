// botyonetici.js — her müşteri için ayrı bir gorevbot.js süreci
//
// Her bot kendi klasöründe çalışır (veri/musteriler/<discord id>/): deneyim
// defteri, yapay zeka kullanımı ve Microsoft girişi müşteriler arasında karışmaz.
// Discord botu, oyun botuyla IPC (process.send) üzerinden konuşur; port gerekmez.
//
// Bir lisansla birden çok bot: 1. botun kimliği müşterinin Discord ID'si,
// diğerleri "ID~2", "ID~3". Ek botların klasörü 1. botunkinin içinde (bot2, bot3).

const { fork } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { hedefKontrol, ozelAdres, sunucuyaUlasilir, baglantiHatasiMetni } = require('./ag')

const BOT_BELLEK_MB = 384 // bir müşteri botu en fazla bu kadar bellek kullanır
const MAX_SATIR = 500 // tek log satırı (sunucunun dev atılma mesajı odayı boğmasın)

class BotYonetici extends EventEmitter {
  constructor({ script, veriKoku, maxBot = 20, apiKey = '', aiGunlukLimit = 0 }) {
    super()
    this.script = script
    this.veriKoku = veriKoku
    this.maxBot = maxBot
    this.apiKey = apiKey
    this.aiGunlukLimit = aiGunlukLimit
    this.botlar = new Map() // botId -> { child, info, bekleyen, istekNo, elleDurdu, baslangic }
  }

  // "123~2" -> { uid: '123', n: 2 }
  static coz(botId) {
    const [uid, n] = String(botId).split('~')
    return { uid, n: Math.max(1, parseInt(n, 10) || 1) }
  }

  static kimlik(uid, n = 1) {
    return n > 1 ? `${uid}~${n}` : String(uid)
  }

  // Müşterinin çalışan botları (botId listesi, 1. bot önce)
  kullaniciBotlari(uid) {
    return [...this.botlar.keys()]
      .filter((id) => BotYonetici.coz(id).uid === String(uid))
      .sort((a, b) => BotYonetici.coz(a).n - BotYonetici.coz(b).n)
  }

  kullaniciCalisiyor(uid) {
    return this.kullaniciBotlari(uid).length > 0
  }

  // Müşterinin bütün botlarını durdurur, kaç tane durduğunu döndürür
  kullaniciyiDurdur(uid) {
    let n = 0
    for (const id of this.kullaniciBotlari(uid)) if (this.durdur(id)) n++
    return n
  }

  calisiyor(botId) {
    return this.botlar.has(botId)
  }

  sayi() {
    return this.botlar.size
  }

  bilgi(botId) {
    return this.botlar.get(botId)?.info || null
  }

  veriKlasoru(botId) {
    // Discord ID'si sadece rakamdır; başka bir şey klasör yolunu bozamasın
    const { uid, n } = BotYonetici.coz(botId)
    const kok = path.join(this.veriKoku, 'musteriler', uid.replace(/[^0-9]/g, '') || 'x')
    return n > 1 ? path.join(kok, `bot${n}`) : kok
  }

  // Sunucu giriş şifreleri (/giris): müşterinin klasöründe, sunucu adresi başına.
  // lisanslar.json'a ve yedeklere girmez, hiçbir loga yazılmaz.
  sifreDosyasi(botId) {
    return path.join(this.veriKlasoru(botId), 'sunucu_sifreleri.json')
  }

  // anahtar sunucu:port: aynı IP'deki başka bir sunucuya bu şifre gitmesin
  sifreAnahtari(host, port) {
    return `${String(host || '').toLowerCase()}:${Number(port) || 25565}`
  }

  sunucuSifresi(botId, host, port) {
    try {
      return JSON.parse(fs.readFileSync(this.sifreDosyasi(botId), 'utf-8'))[this.sifreAnahtari(host, port)] || ''
    } catch (_) {
      return ''
    }
  }

  sunucuSifresiKaydet(botId, host, port, sifre) {
    const dosya = this.sifreDosyasi(botId)
    let hepsi = {}
    try {
      hepsi = JSON.parse(fs.readFileSync(dosya, 'utf-8')) || {}
    } catch (_) {}
    const anahtar = this.sifreAnahtari(host, port)
    if (sifre) hepsi[anahtar] = sifre
    else delete hepsi[anahtar]
    fs.mkdirSync(path.dirname(dosya), { recursive: true })
    fs.writeFileSync(dosya + '.tmp', JSON.stringify(hepsi, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(dosya + '.tmp', dosya)
  }

  // ayar: { host, port, user, auth, version, owner, ai, yerelIzin, sohbet, paket }
  baslat(botId, ayar) {
    if (this.botlar.has(botId)) throw new Error('Botun zaten çalışıyor. Önce /durdur yaz.')
    if (this.botlar.size >= this.maxBot) {
      throw new Error('Şu an bütün bot yerleri dolu, biraz sonra tekrar dene.')
    }
    const dir = this.veriKlasoru(botId)
    fs.mkdirSync(dir, { recursive: true })
    const aiAcik = !!(ayar.ai && this.apiKey)
    const env = {
      ...process.env,
      MC_HOST: ayar.host,
      MC_PORT: String(ayar.port),
      MC_BOT_NAME: ayar.user,
      MC_AUTH: ayar.auth,
      MC_VERSION: ayar.version || '',
      MC_OWNER: ayar.owner || '',
      MC_YONETILEN: '1', // sahip boşsa bot kimseyi dinlemesin (satıcının mc_sahip adına düşmesin)
      MC_GIRIS_SIFRE: this.sunucuSifresi(botId, ayar.host, ayar.port), // sunucu /login isterse
      MC_SOHBET: ayar.sohbet === false ? '0' : '1', // oyun sohbeti odaya aktarılsın mı
      MC_PAKET: ayar.paket || 'tam', // lisansın paketi: hangi işleri yapabilir
      MC_VERI_DIR: dir,
      KOMUT_PORT: '0', // HTTP yok, IPC var: 50 bot aynı portu kapmaya çalışmasın
      AI_KAPALI: aiAcik ? '0' : '1',
      ANTHROPIC_API_KEY: aiAcik ? this.apiKey : '',
      AI_GUNLUK_LIMIT: String(this.aiGunlukLimit),
      // Yerel/özel ağ adreslerine bağlanma yasağı (sadece satıcı açabilir)
      MC_HEDEF_KONTROL: ayar.yerelIzin ? '0' : '1',
    }
    delete env.DISCORD_TOKEN // oyun botunun Discord token'ına ihtiyacı yok

    const child = fork(this.script, [], {
      cwd: path.dirname(this.script),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Bellek sınırı: tek bir müşterinin botu bütün makineyi yiyip diğer
      // botları (ve Discord botunu) düşürmesin. Aşarsa sadece o bot kapanır.
      execArgv: [...process.execArgv, `--max-old-space-size=${BOT_BELLEK_MB}`],
    })
    const kayit = {
      child,
      info: { host: ayar.host, port: ayar.port, user: ayar.user, auth: ayar.auth, version: ayar.version },
      bekleyen: new Map(),
      istekNo: 0,
      elleDurdu: false,
      baslangic: Date.now(),
    }
    this.botlar.set(botId, kayit)

    const temiz = (l) => {
      const t = l.replace(/\x1b\[[0-9;]*m/g, '')
      return t.length > MAX_SATIR ? t.slice(0, MAX_SATIR) + '…(kısaltıldı)' : t
    }
    const satir = (l) => {
      if (!l.trim()) return
      // "[satıcı]" ile başlayanlar (tam hata, API faturası vb.) müşteriye gitmez
      if (l.startsWith('[satıcı]')) this.emit('saticiLog', botId, temiz(l))
      else this.emit('log', botId, temiz(l))
    }
    for (const akis of [child.stdout, child.stderr]) {
      let buf = ''
      akis.setEncoding('utf8') // parça sınırında ş/ğ/ı gibi harfler bozulmasın
      akis.on('data', (d) => {
        buf += d
        const parcalar = buf.split(/\r?\n/)
        buf = parcalar.pop()
        if (buf.length > 20000) buf = buf.slice(0, MAX_SATIR) // satır sonu gelmeyen dev çıktı
        for (const l of parcalar) satir(l)
      })
    }
    child.on('message', (m) => {
      const bekleyen = m && kayit.bekleyen.get(m.id)
      if (!bekleyen) return
      kayit.bekleyen.delete(m.id)
      bekleyen(m)
    })
    child.on('error', (e) => this.emit('log', botId, 'Bot başlatılamadı: ' + e.message))
    // 'close' her durumda gelir; süreç hiç başlayamadıysa 'exit' gelmez ve
    // bot "çalışıyor" görünüp yerini sonsuza kadar tutardı
    child.on('close', (code, signal) => {
      if (this.botlar.get(botId) === kayit) this.botlar.delete(botId)
      for (const bekleyen of kayit.bekleyen.values()) {
        bekleyen({ kod: 503, veri: { hata: 'bot kapandı' } })
      }
      kayit.bekleyen.clear()
      this.emit('kapandi', botId, {
        code,
        signal,
        elleDurdu: kayit.elleDurdu,
        sure: Date.now() - kayit.baslangic,
        info: kayit.info,
      })
    })
  }

  durdur(botId) {
    const k = this.botlar.get(botId)
    if (!k) return false
    k.elleDurdu = true
    k.child.kill()
    return true
  }

  hepsiniDurdur() {
    for (const botId of [...this.botlar.keys()]) this.durdur(botId)
  }

  // Oyun botuna istek: tip = komut | durum | soyle. Cevap: { kod, veri }
  istek(botId, tip, veri = {}, ms = 2500) {
    const k = this.botlar.get(botId)
    if (!k) return Promise.resolve({ kod: 503, veri: { hata: 'bot çalışmıyor' } })
    const id = ++k.istekNo
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        k.bekleyen.delete(id)
        resolve({ kod: 504, veri: { hata: 'bot cevap vermedi' } })
      }, ms)
      k.bekleyen.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      try {
        k.child.send({ ...veri, id, tip })
      } catch (e) {
        clearTimeout(t)
        k.bekleyen.delete(id)
        resolve({ kod: 503, veri: { hata: e.message } })
      }
    })
  }
}

module.exports = { BotYonetici, hedefKontrol, ozelAdres, sunucuyaUlasilir, baglantiHatasiMetni }
