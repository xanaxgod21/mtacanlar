// lisans.js — key üretme, key kullanma, lisans süresi
//
// Keyler dosyada açık hâliyle DURMAZ, sadece özeti (sha256) saklanır.
// Dosya çalınsa bile kullanılmamış keyler ele geçmez. Key bu yüzden sadece
// üretildiği an bir kere gösterilir.
//
// Bir kullanıcının tek lisansı olur. Lisansı varken yeni key girerse süresi
// uzar (yenileme). Süresi dolmuşsa yeni key lisansı tekrar açar.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SAAT = 60 * 60 * 1000
const GUN = 24 * SAAT

// Keyin süresi (ms, 0 = süresiz). Eski keylerde süre "gun" alanında durur.
const keySuresi = (k) => (k.sure !== undefined ? k.sure : (k.gun || 0) * GUN)
// Birbirine benzeyen harfler yok (0/O, 1/I/L): müşteri elle yazarken karıştırmasın
const ALFABE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const temizle = (key) => String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const ozet = (key) => crypto.createHash('sha256').update(temizle(key)).digest('hex')

function keyUret() {
  const parca = () =>
    Array.from({ length: 4 }, () => ALFABE[crypto.randomInt(ALFABE.length)]).join('')
  return `YAREN-${parca()}-${parca()}-${parca()}-${parca()}`
}

class LisansDeposu {
  constructor(dosya, log = () => {}) {
    this.dosya = dosya
    this.log = log
    this.veri = { keyler: [], lisanslar: {} }
    const oku = (f) => {
      try {
        return fs.readFileSync(f, 'utf-8')
      } catch (e) {
        if (e.code === 'ENOENT') return null // dosya yok
        // okunamayan dosyayı "ilk çalıştırma" sanıp üstüne boş liste yazmayalım
        throw new Error(`${path.basename(f)} okunamadı: ${e.message}`)
      }
    }
    const coz = (ham) => {
      const v = JSON.parse(ham.replace(/^\uFEFF/, ''))
      return {
        keyler: Array.isArray(v.keyler) ? v.keyler : [],
        lisanslar: v.lisanslar && typeof v.lisanslar === 'object' ? v.lisanslar : {},
      }
    }
    const ham = oku(dosya)
    if (ham === null && oku(dosya + '.tmp') === null) return // gerçekten ilk çalıştırma
    try {
      this.veri = coz(ham || '')
    } catch (e) {
      // Kayıt yarıda kaldıysa en yeni hâl .tmp dosyasındadır
      try {
        this.veri = coz(oku(dosya + '.tmp') || '')
        this.log(`[lisans] ${path.basename(dosya)} bozuktu, .tmp kopyasından okundu.`)
        return
      } catch (_) {}
      // Bozuk dosyanın üstüne yazıp bütün müşterileri kaybetmeyelim
      const yedek = `${dosya}.bozuk-${Date.now()}`
      try {
        if (ham !== null) fs.copyFileSync(dosya, yedek)
      } catch (_) {}
      throw new Error(`${path.basename(dosya)} bozuk ya da boş (${e.message}). Yedeği: ${path.basename(yedek)}`)
    }
  }

  // Hata fırlatmaz: kayıt olmasa da bellekteki değişiklik uygulanır (bot durur,
  // oda kilitlenir) ve bir sonraki kayıtta diske yazılır.
  kaydet() {
    const tmp = this.dosya + '.tmp'
    for (let deneme = 1; deneme <= 5; deneme++) {
      try {
        fs.mkdirSync(path.dirname(this.dosya), { recursive: true })
        fs.writeFileSync(tmp, JSON.stringify(this.veri, null, 2), 'utf-8')
        fs.renameSync(tmp, this.dosya) // yarıda kesilirse eski dosya sağlam kalır
        return true
      } catch (e) {
        // Windows'ta antivirüs/OneDrive dosyayı kısa süre kilitleyebilir
        if (deneme < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * deneme)
          continue
        }
        this.log(`[lisans] KAYDEDİLEMEDİ: ${e.message}. Disk dolu ya da dosya kilitli olabilir!`)
        return false
      }
    }
    return false
  }

  // ---------- Keyler ----------
  // sure: milisaniye (0 = süresiz); eski kullanım için gun de olur.
  // Açık keyleri döndürür (bir daha gösterilemez).
  olustur({ sure, gun, adet = 1, ai = true, direkt = false, simdi = Date.now() } = {}) {
    if (sure === undefined) sure = (gun ?? 30) * GUN
    const yeni = []
    for (let i = 0; i < adet; i++) {
      let key
      do key = keyUret()
      while (this.veri.keyler.some((k) => k.hash === ozet(key)))
      this.veri.keyler.push({
        hash: ozet(key),
        onek: key.slice(0, 10), // "YAREN-AB12": listede tanımak için
        sure,
        direkt, // satıcı /key-ver ile doğrudan verdi
        ai: !!ai,
        olusturma: simdi,
        durum: 'bos', // bos | kullanildi | iptal
        kullanan: null,
        kullanma: null,
      })
      yeni.push(key)
    }
    this.kaydet()
    return yeni
  }

  // Kullanılmamış keyi iptal eder (tam key ya da "YAREN-AB12" öneki)
  keyIptal(keyVeyaOnek) {
    const t = temizle(keyVeyaOnek)
    let k = this.veri.keyler.find((x) => x.hash === ozet(t))
    // Önekle iptal sadece öneki yazınca ("YAREN-AB12") ve sadece satılmamış keylerde:
    // yanlış yazılmış tam key başka (satılmış) bir keyi iptal etmesin
    if (!k && t.length === 9) {
      const uyan = this.veri.keyler.filter((x) => x.durum === 'bos' && temizle(x.onek) === t)
      if (uyan.length === 1) k = uyan[0]
    }
    if (!k) return 'Key bulunamadı (önek birden fazla keye uyuyorsa tam keyi yaz).'
    if (k.durum !== 'bos') return `Bu key zaten ${k.durum === 'iptal' ? 'iptal edilmiş' : 'kullanılmış'}.`
    k.durum = 'iptal'
    this.kaydet()
    return `${k.onek}… iptal edildi.`
  }

  // ---------- Lisanslar ----------
  aktifMi(l, simdi = Date.now()) {
    return !!l && l.durum === 'aktif' && (l.bitis === null || l.bitis > simdi)
  }

  // Yapay zekanın kendi süresi var: sadece yapay zekalı keyler onu uzatır.
  // (Yoksa bir kere AI'lı key alan, sonra ucuz AI'sız keylerle sonsuza kadar
  // senin paranla yapay zeka kullanırdı.)
  aiAktifMi(l, simdi = Date.now()) {
    if (!this.aktifMi(l, simdi) || !l.ai) return false
    const b = l.aiBitis === undefined ? l.bitis : l.aiBitis
    return b === null || b > simdi
  }

  bul(userId) {
    return this.veri.lisanslar[userId] || null
  }

  kanaldanBul(kanalId) {
    return Object.values(this.veri.lisanslar).find((l) => l.kanalId === kanalId) || null
  }

  // Keyi kullanır. Sonuç: { tip, lisans?, mesaj }
  //   tip: gecersiz | kullanilmis | iptal | yasakli | yeni | uzatildi | yeniden
  kullan(key, { userId, kullaniciAdi }, simdi = Date.now()) {
    const k = this.veri.keyler.find((x) => x.hash === ozet(key))
    if (!k) return { tip: 'gecersiz', mesaj: 'Bu key geçersiz. Doğru yazdığından emin ol.' }
    if (k.durum === 'iptal') return { tip: 'iptal', mesaj: 'Bu key iptal edilmiş.' }
    if (k.durum === 'kullanildi') {
      return {
        tip: 'kullanilmis',
        mesaj: k.kullanan === userId ? 'Bu keyi zaten kullandın.' : 'Bu key başkası tarafından kullanılmış.',
      }
    }
    const eski = this.bul(userId)
    if (eski && eski.durum === 'iptal') {
      return { tip: 'yasakli', mesaj: 'Lisansın satıcı tarafından iptal edilmiş, onunla görüş.' }
    }

    const sure = keySuresi(k)
    // Keyi hemen "kullanıldı" yap: iki kere hızlı basılırsa ikinci kez kullanılmasın
    k.durum = 'kullanildi'
    k.kullanan = userId
    k.kullanma = simdi

    let tip
    let l = eski
    if (!l) {
      tip = 'yeni'
      l = {
        userId,
        kullaniciAdi,
        kanalId: null,
        durum: 'aktif',
        bitis: sure > 0 ? simdi + sure : null,
        ai: k.ai,
        aiBitis: k.ai && sure > 0 ? simdi + sure : k.ai ? null : 0,
        aiBittiBildirildi: false,
        olusturma: simdi,
        keyler: [k.onek],
        son: null, // son /baslat ayarları
        calisiyordu: false, // bot kapanınca (yeniden başlatma) otomatik açılsın mı
        // "süren yarın / 1 saat sonra doluyor" (kısa denemelerde hemen uyarma)
        uyarildi: sure > 0 && sure <= GUN,
        saatUyarildi: sure > 0 && sure <= SAAT,
      }
      this.veri.lisanslar[userId] = l
    } else {
      tip = this.aktifMi(l, simdi) ? 'uzatildi' : 'yeniden'
      // yapay zeka durumu lisans süresi değişmeden önce okunur
      const aiAcik = this.aiAktifMi(l, simdi)
      const eskiAiBitis = l.aiBitis === undefined ? l.bitis : l.aiBitis
      if (sure === 0) l.bitis = null
      else if (l.bitis !== null || tip === 'yeniden') {
        const taban = tip === 'uzatildi' && l.bitis !== null ? l.bitis : simdi
        l.bitis = taban + sure
      }
      if (k.ai) {
        if (sure === 0) l.aiBitis = null
        else if (!aiAcik) l.aiBitis = simdi + sure
        else l.aiBitis = eskiAiBitis === null ? null : eskiAiBitis + sure
        l.ai = true
        l.aiBittiBildirildi = false
      }
      l.durum = 'aktif'
      l.kullaniciAdi = kullaniciAdi
      l.uyarildi = l.bitis !== null && l.bitis - simdi <= GUN
      l.saatUyarildi = l.bitis !== null && l.bitis - simdi <= SAAT
      l.keyler.push(k.onek)
    }
    this.kaydet()
    const ne = { yeni: 'Lisansın açıldı', uzatildi: 'Lisansın uzatıldı', yeniden: 'Lisansın yeniden açıldı' }[tip]
    return { tip, lisans: l, mesaj: `${ne}. Bitiş: ${bitisYazi(l)}.` }
  }

  kanalAyarla(userId, kanalId) {
    const l = this.bul(userId)
    if (!l) return
    l.kanalId = kanalId
    this.kaydet()
  }

  guncelle(userId, degisiklik) {
    const l = this.bul(userId)
    if (!l) return null
    Object.assign(l, degisiklik)
    this.kaydet()
    return l
  }

  // sure: milisaniye (0 = süresiz yap)
  uzat(userId, sure, simdi = Date.now()) {
    const l = this.bul(userId)
    if (!l) return null
    // önceki durumu değiştirmeden önce oku
    const aiAcik = this.aiAktifMi(l, simdi)
    const eskiAi = l.aiBitis === undefined ? l.bitis : l.aiBitis
    if (sure === 0) l.bitis = null
    else if (l.bitis !== null || !this.aktifMi(l, simdi)) {
      // süresiz lisans süresiz kalır; süreli olana (ya da kapanmış olana) süre eklenir
      l.bitis = Math.max(l.bitis ?? simdi, simdi) + sure
    }
    // Yapay zeka sadece şu an açıksa uzar (süresi bitmiş yapay zeka geri gelmez,
    // "süresiz yap" yapay zekayı süresiz yapmaz: parasını sen ödersin)
    if (l.ai && aiAcik && sure > 0 && eskiAi !== null) {
      l.aiBitis = Math.max(eskiAi, simdi) + sure
    } else if (l.aiBitis === undefined) {
      l.aiBitis = eskiAi // eski kayıt: yapay zeka lisansa bağlı kalmasın
    }
    l.durum = 'aktif'
    l.aiBittiBildirildi = !this.aiAktifMi(l, simdi) && l.aiBittiBildirildi
    l.uyarildi = l.bitis !== null && l.bitis - simdi <= GUN
    l.saatUyarildi = l.bitis !== null && l.bitis - simdi <= SAAT
    this.kaydet()
    return l
  }

  iptalEt(userId, simdi = Date.now()) {
    return this.guncelle(userId, { durum: 'iptal', calisiyordu: false, iptalZamani: simdi })
  }

  // Süresi yeni dolanlar (durumları "bitti" yapılır), yarın dolacaklar ve
  // lisansı sürerken yapay zeka süresi dolanlar
  zamanKontrol(simdi = Date.now()) {
    const dolan = []
    const yaklasan = [] // 1 günden az kaldı
    const sonSaat = [] // 1 saatten az kaldı
    const aiDolan = []
    for (const l of Object.values(this.veri.lisanslar)) {
      if (l.durum !== 'aktif') continue
      if (this.aktifMi(l, simdi) && l.ai && !this.aiAktifMi(l, simdi) && !l.aiBittiBildirildi) {
        l.aiBittiBildirildi = true
        aiDolan.push(l)
      }
      if (l.bitis === null) continue
      if (l.bitis <= simdi) {
        l.durum = 'bitti'
        l.calisiyordu = false
        dolan.push(l)
      } else if (!l.saatUyarildi && l.bitis - simdi < SAAT) {
        l.saatUyarildi = true
        l.uyarildi = true
        sonSaat.push(l)
      } else if (!l.uyarildi && l.bitis - simdi < GUN) {
        l.uyarildi = true
        yaklasan.push(l)
      }
    }
    if (dolan.length || yaklasan.length || sonSaat.length || aiDolan.length) this.kaydet()
    return { dolan, yaklasan, sonSaat, aiDolan }
  }

  ozetListe() {
    const sayi = { bos: 0, kullanildi: 0, iptal: 0 }
    for (const k of this.veri.keyler) sayi[k.durum] = (sayi[k.durum] || 0) + 1
    return { sayi, keyler: this.veri.keyler, lisanslar: Object.values(this.veri.lisanslar) }
  }
}

function bitisYazi(l) {
  if (!l || l.bitis === null) return 'süresiz'
  // VPS'ler genelde UTC saatindedir; müşteriler Türkiye saatini bekler
  return new Date(l.bitis).toLocaleString('tr-TR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Istanbul',
  })
}

// "3 gün", "12 saat", "2 hafta", "süresiz"
function sureYazi(ms) {
  if (!ms) return 'süresiz'
  const gun = ms / GUN
  if (gun >= 30 && gun % 30 === 0) return `${gun / 30} ay`
  if (gun >= 7 && gun % 7 === 0) return `${gun / 7} hafta`
  if (Number.isInteger(gun)) return `${gun} gün`
  const saat = Math.round(ms / SAAT)
  return saat >= 24 ? `${Math.floor(saat / 24)} gün ${saat % 24} saat` : `${saat} saat`
}

module.exports = { LisansDeposu, keyUret, temizle, ozet, bitisYazi, sureYazi, keySuresi, GUN, SAAT }
