// botyonetici.js — her müşteri için ayrı bir gorevbot.js süreci
//
// Her bot kendi klasöründe çalışır (veri/musteriler/<discord id>/): deneyim
// defteri, yapay zeka kullanımı ve Microsoft girişi müşteriler arasında karışmaz.
// Discord botu, oyun botuyla IPC (process.send) üzerinden konuşur; port gerekmez.

const { fork } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { hedefKontrol, ozelAdres } = require('./ag')

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
    this.botlar = new Map() // userId -> { child, info, bekleyen, istekNo, elleDurdu, baslangic }
  }

  calisiyor(userId) {
    return this.botlar.has(userId)
  }

  sayi() {
    return this.botlar.size
  }

  bilgi(userId) {
    return this.botlar.get(userId)?.info || null
  }

  veriKlasoru(userId) {
    // Discord ID'si sadece rakamdır; başka bir şey klasör yolunu bozamasın
    return path.join(this.veriKoku, 'musteriler', String(userId).replace(/[^0-9]/g, '') || 'x')
  }

  // Sunucu giriş şifreleri (/giris): müşterinin klasöründe, sunucu adresi başına.
  // lisanslar.json'a ve yedeklere girmez, hiçbir loga yazılmaz.
  sifreDosyasi(userId) {
    return path.join(this.veriKlasoru(userId), 'sunucu_sifreleri.json')
  }

  sunucuSifresi(userId, host) {
    try {
      return JSON.parse(fs.readFileSync(this.sifreDosyasi(userId), 'utf-8'))[String(host || '').toLowerCase()] || ''
    } catch (_) {
      return ''
    }
  }

  sunucuSifresiKaydet(userId, host, sifre) {
    const dosya = this.sifreDosyasi(userId)
    let hepsi = {}
    try {
      hepsi = JSON.parse(fs.readFileSync(dosya, 'utf-8')) || {}
    } catch (_) {}
    const anahtar = String(host || '').toLowerCase()
    if (sifre) hepsi[anahtar] = sifre
    else delete hepsi[anahtar]
    fs.mkdirSync(path.dirname(dosya), { recursive: true })
    fs.writeFileSync(dosya + '.tmp', JSON.stringify(hepsi, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(dosya + '.tmp', dosya)
  }

  // ayar: { host, port, user, auth, version, owner, ai, yerelIzin, sohbet }
  baslat(userId, ayar) {
    if (this.botlar.has(userId)) throw new Error('Botun zaten çalışıyor. Önce /durdur yaz.')
    if (this.botlar.size >= this.maxBot) {
      throw new Error('Şu an bütün bot yerleri dolu, biraz sonra tekrar dene.')
    }
    const dir = this.veriKlasoru(userId)
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
      MC_GIRIS_SIFRE: this.sunucuSifresi(userId, ayar.host), // sunucu /login isterse
      MC_SOHBET: ayar.sohbet === false ? '0' : '1', // oyun sohbeti odaya aktarılsın mı
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
    this.botlar.set(userId, kayit)

    const temiz = (l) => {
      const t = l.replace(/\x1b\[[0-9;]*m/g, '')
      return t.length > MAX_SATIR ? t.slice(0, MAX_SATIR) + '…(kısaltıldı)' : t
    }
    const satir = (l) => {
      if (!l.trim()) return
      // "[satıcı]" ile başlayanlar (tam hata, API faturası vb.) müşteriye gitmez
      if (l.startsWith('[satıcı]')) this.emit('saticiLog', userId, temiz(l))
      else this.emit('log', userId, temiz(l))
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
    child.on('error', (e) => this.emit('log', userId, 'Bot başlatılamadı: ' + e.message))
    // 'close' her durumda gelir; süreç hiç başlayamadıysa 'exit' gelmez ve
    // bot "çalışıyor" görünüp yerini sonsuza kadar tutardı
    child.on('close', (code, signal) => {
      if (this.botlar.get(userId) === kayit) this.botlar.delete(userId)
      for (const bekleyen of kayit.bekleyen.values()) {
        bekleyen({ kod: 503, veri: { hata: 'bot kapandı' } })
      }
      kayit.bekleyen.clear()
      this.emit('kapandi', userId, {
        code,
        signal,
        elleDurdu: kayit.elleDurdu,
        sure: Date.now() - kayit.baslangic,
        info: kayit.info,
      })
    })
  }

  durdur(userId) {
    const k = this.botlar.get(userId)
    if (!k) return false
    k.elleDurdu = true
    k.child.kill()
    return true
  }

  hepsiniDurdur() {
    for (const userId of [...this.botlar.keys()]) this.durdur(userId)
  }

  // Oyun botuna istek: tip = komut | durum | soyle. Cevap: { kod, veri }
  istek(userId, tip, veri = {}, ms = 2500) {
    const k = this.botlar.get(userId)
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

module.exports = { BotYonetici, hedefKontrol, ozelAdres }
