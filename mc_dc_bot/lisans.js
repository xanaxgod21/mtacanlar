// lisans.js — key üretme, key kullanma, lisans süresi
//
// Keyler dosyada açık hâliyle DURMAZ, sadece özeti (sha256) saklanır.
// Dosya çalınsa bile kullanılmamış keyler ele geçmez. Key bu yüzden sadece
// üretildiği an bir kere gösterilir.
//
// Bir kullanıcının tek lisansı olur. Lisansı varken yeni key girerse süresi
// uzar (yenileme). Süresi dolmuşsa yeni key lisansı tekrar açar.
//
// Paketler: key "tam" (her iş) ya da sadece odun / maden / farm olabilir ve 1-3
// bot hakkı verir. Her paketin ve her ek bot yerinin kendi bitişi vardır (yapay
// zeka gibi): ucuz bir "sadece odun" keyi, pahalı tam paketin süresini uzatmaz.
// Lisansın bitişi, paketlerden en geç bitenidir.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SAAT = 60 * 60 * 1000
const GUN = 24 * SAAT

// Keyin süresi (ms, 0 = süresiz). Eski keylerde süre "gun" alanında durur.
const keySuresi = (k) => (k.sure !== undefined ? k.sure : (k.gun || 0) * GUN)
// Birbirine benzeyen harfler yok (0/O, 1/I/L): müşteri elle yazarken karıştırmasın
const ALFABE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// Paketler (gorevbot.js'deki PAKET_GOREVLERI ile aynı adlar)
const PAKETLER = {
  tam: 'Tam paket',
  odun: 'Sadece odun',
  maden: 'Sadece maden',
  farm: 'Sadece farm (tarla, balık, XP)',
}
const MAX_BOT = 3
const paketAdi = (p) => PAKETLER[p] || PAKETLER.tam
// "tam, 2 bot" gibi
const paketYazi = (paketler, botSayisi = 1) =>
  (paketler.includes('tam') || !paketler.length ? PAKETLER.tam : paketler.map(paketAdi).join(' + ')) +
  (botSayisi > 1 ? `, ${botSayisi} bot` : '')
const keyPaketi = (k) => (PAKETLER[k?.paket] ? k.paket : 'tam')
const keyBotSayisi = (k) => Math.min(MAX_BOT, Math.max(1, Number(k?.botSayisi) || 1))
// bitiş (ms | null = süresiz) şu an açık mı
const acikMi = (b, simdi) => b === null || (typeof b === 'number' && b > simdi)

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
      let kurtarildi = false
      try {
        this.veri = coz(oku(dosya + '.tmp') || '')
        kurtarildi = true
      } catch (_) {}
      if (kurtarildi) {
        // log hatası (ör. kaydedici henüz hazır değil) kurtarılan veriyi kaybettirmesin
        try {
          this.log(`[lisans] ${path.basename(dosya)} bozuktu, .tmp kopyasından okundu.`)
        } catch (_) {}
        return
      }
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
  // olusturan: keyi üreten satıcı/yetkili (id ve adı, key geçmişi için)
  // paket: tam | odun | maden | farm, botSayisi: 1-3
  olustur({ sure, gun, adet = 1, ai = true, paket = 'tam', botSayisi = 1, direkt = false, alici = null, olusturan = null, olusturanAdi = null, simdi = Date.now() } = {}) {
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
        alici, // kime verildi (Key Ver), iptal etmek gerekirse bulunsun
        ai: !!ai,
        paket: keyPaketi({ paket }),
        botSayisi: keyBotSayisi({ botSayisi }),
        olusturan,
        olusturanAdi,
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

  // Kullanılmamış keyi iptal eder (tam key ya da "YAREN-AB12" öneki).
  // Sonuç: { ok, mesaj, kayit }
  keyIptalEt(keyVeyaOnek, { yapan = null, yapanAdi = null, simdi = Date.now() } = {}) {
    const t = temizle(keyVeyaOnek)
    let k = this.veri.keyler.find((x) => x.hash === ozet(t))
    // Önekle iptal sadece öneki yazınca ("YAREN-AB12") ve sadece satılmamış keylerde:
    // yanlış yazılmış tam key başka (satılmış) bir keyi iptal etmesin
    if (!k && t.length === 9) {
      const uyan = this.veri.keyler.filter((x) => x.durum === 'bos' && temizle(x.onek) === t)
      if (uyan.length === 1) k = uyan[0]
    }
    if (!k) return { ok: false, mesaj: 'Key bulunamadı (önek birden fazla keye uyuyorsa tam keyi yaz).' }
    if (k.durum !== 'bos') {
      return { ok: false, kayit: k, mesaj: `Bu key zaten ${k.durum === 'iptal' ? 'iptal edilmiş' : 'kullanılmış'}.` }
    }
    k.durum = 'iptal'
    k.iptalEden = yapan
    k.iptalEdenAdi = yapanAdi
    k.iptalZamani = simdi
    this.kaydet()
    return { ok: true, kayit: k, mesaj: `${k.onek}… iptal edildi.` }
  }

  keyIptal(keyVeyaOnek) {
    return this.keyIptalEt(keyVeyaOnek).mesaj
  }

  // Key geçmişi için: tam keyle tek kayıt, "YAREN-AB12" önekiyle uyan bütün kayıtlar
  keyBul(keyVeyaOnek) {
    const t = temizle(keyVeyaOnek)
    const tam = this.veri.keyler.find((x) => x.hash === ozet(t))
    if (tam) return [tam]
    if (t.length !== 9) return []
    return this.veri.keyler.filter((x) => temizle(x.onek) === t)
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

  // Şu an açık paketler: ['tam'] ya da ['odun', 'maden']. Eski lisanslar tam pakettir.
  paketleri(l, simdi = Date.now()) {
    if (!this.aktifMi(l, simdi)) return []
    if (!l.paketBitis) return ['tam']
    const acik = Object.keys(PAKETLER).filter((p) => acikMi(l.paketBitis[p], simdi))
    return acik.includes('tam') ? ['tam'] : acik
  }

  // Aynı anda kaç bot çalıştırabilir (lisans kapalıysa 0)
  botSayisi(l, simdi = Date.now()) {
    if (!this.aktifMi(l, simdi)) return 0
    const ek = Object.values(l.botBitis || {}).filter((b) => acikMi(b, simdi)).length
    return Math.min(MAX_BOT, 1 + ek)
  }

  paketYazi(l, simdi = Date.now()) {
    if (!l) return '-'
    if (!this.aktifMi(l, simdi)) return paketYazi(l.paketBitis ? Object.keys(l.paketBitis) : ['tam'], 1)
    return paketYazi(this.paketleri(l, simdi), this.botSayisi(l, simdi))
  }

  // paket/bot sayısı değişti mi anlamak için
  paketImzasi(l, simdi = Date.now()) {
    return `${this.paketleri(l, simdi).join(',')}|${this.botSayisi(l, simdi)}`
  }

  // Lisansın bitişi: en geç biten paket
  _bitisHesapla(l) {
    const hepsi = Object.values(l.paketBitis)
    if (!hepsi.length) return
    l.bitis = hepsi.some((b) => b === null) ? null : Math.max(...hepsi)
  }

  // Eski kayıt (paketsiz): tam paket, lisansla aynı süre
  _paketHazirla(l) {
    if (!l.paketBitis) l.paketBitis = { tam: l.bitis }
    if (!l.botBitis) l.botBitis = {}
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
    if (k.durum === 'iptal') return { tip: 'iptal', kayit: k, mesaj: 'Bu key iptal edilmiş.' }
    if (k.durum === 'kullanildi') {
      return {
        tip: 'kullanilmis',
        kayit: k,
        mesaj: k.kullanan === userId ? 'Bu keyi zaten kullandın.' : 'Bu key başkası tarafından kullanılmış.',
      }
    }
    const eski = this.bul(userId)
    if (eski && eski.durum === 'iptal') {
      return { tip: 'yasakli', kayit: k, mesaj: 'Lisansın satıcı tarafından iptal edilmiş, onunla görüş.' }
    }

    const sure = keySuresi(k)
    const paket = keyPaketi(k)
    const botSayisi = keyBotSayisi(k)
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
        paketBitis: { [paket]: sure > 0 ? simdi + sure : null },
        botBitis: Object.fromEntries(Array.from({ length: botSayisi - 1 }, (_, i) => [i + 2, sure > 0 ? simdi + sure : null])),
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
      // Keyin paketi ve bot yerleri kendi sürelerinden uzar; kapanmış olanlar şimdiden başlar.
      // Lisans kapalıyken kalmış "süresiz" kayıt (eski iptal/bitti) süresiz açılmasın.
      this._paketHazirla(l)
      const ekle = (b) => (sure === 0 ? null : b === null && tip === 'uzatildi' ? null : Math.max(typeof b === 'number' ? b : 0, simdi) + sure)
      l.paketBitis[paket] = ekle(l.paketBitis[paket])
      for (let n = 2; n <= botSayisi; n++) l.botBitis[n] = ekle(l.botBitis[n])
      if (tip === 'yeniden') {
        // eski paketlerden süresi kalmış görünen (süresiz) olanlar kapanmış sayılır
        for (const p of Object.keys(l.paketBitis)) if (p !== paket && l.paketBitis[p] === null) l.paketBitis[p] = simdi
        for (const n of Object.keys(l.botBitis)) if (Number(n) > botSayisi && l.botBitis[n] === null) l.botBitis[n] = simdi
      }
      this._bitisHesapla(l)
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
    l.paketImza = this.paketImzasi(l, simdi)
    this.kaydet()
    const ne = { yeni: 'Lisansın açıldı', uzatildi: 'Lisansın uzatıldı', yeniden: 'Lisansın yeniden açıldı' }[tip]
    return { tip, lisans: l, kayit: k, mesaj: `${ne}. Bitiş: ${bitisYazi(l)}.` }
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
    const lisansAcik = this.aktifMi(l, simdi)
    if (l.paketBitis) {
      // Lisans bittiği an açık olan paketler ve bot yerleri uzar (sonradan kapanmış
      // ucuz paket geri gelmez); süresiz olan süresiz kalır.
      this._paketHazirla(l)
      const son = lisansAcik ? simdi : Math.min(l.bitis ?? simdi, simdi)
      const sayilir = (b) => b === null || (typeof b === 'number' && b >= son)
      const uzat = (b) => (sure === 0 || (b === null && lisansAcik) ? null : Math.max(b ?? simdi, simdi) + sure)
      let paketler = Object.keys(l.paketBitis).filter((p) => sayilir(l.paketBitis[p]))
      if (!paketler.length) paketler = Object.keys(l.paketBitis)
      for (const p of paketler) l.paketBitis[p] = uzat(l.paketBitis[p])
      for (const n of Object.keys(l.botBitis)) if (sayilir(l.botBitis[n])) l.botBitis[n] = uzat(l.botBitis[n])
      this._bitisHesapla(l)
    } else if (sure === 0) l.bitis = null
    else if (l.bitis !== null || !lisansAcik) {
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
    l.paketImza = this.paketImzasi(l, simdi)
    this.kaydet()
    return l
  }

  iptalEt(userId, simdi = Date.now()) {
    return this.guncelle(userId, { durum: 'iptal', calisiyordu: false, iptalZamani: simdi })
  }

  // Süreyi şimdi bitirir. İptalden farkı: kişi yeni key girip devam edebilir.
  bitir(userId, simdi = Date.now()) {
    const l = this.bul(userId)
    if (!l) return null
    l.durum = 'bitti'
    l.bitis = simdi
    l.calisiyordu = false
    // süresiz yapay zeka da biter; yeni AI'sız keyle geri gelmesin
    const ai = l.aiBitis === undefined ? null : l.aiBitis
    if (ai === null || ai > simdi) l.aiBitis = simdi
    // paketler ve bot yerleri de biter (yeni keyle süresiz geri gelmesin)
    for (const tablo of [l.paketBitis, l.botBitis]) {
      if (!tablo) continue
      for (const [ad, b] of Object.entries(tablo)) if (b === null || b > simdi) tablo[ad] = simdi
    }
    this.kaydet()
    return l
  }

  // Süresi yeni dolanlar (durumları "bitti" yapılır), yarın dolacaklar ve
  // lisansı sürerken yapay zeka süresi dolanlar
  zamanKontrol(simdi = Date.now()) {
    const dolan = []
    const yaklasan = [] // 1 günden az kaldı
    const sonSaat = [] // 1 saatten az kaldı
    const aiDolan = []
    const paketDegisen = [] // lisans sürerken bir paketi ya da ek bot yeri bitti
    let degisti = false
    for (const l of Object.values(this.veri.lisanslar)) {
      if (l.durum !== 'aktif') continue
      if (this.aktifMi(l, simdi) && l.ai && !this.aiAktifMi(l, simdi) && !l.aiBittiBildirildi) {
        l.aiBittiBildirildi = true
        aiDolan.push(l)
      }
      if (this.aktifMi(l, simdi)) {
        const imza = this.paketImzasi(l, simdi)
        if (l.paketImza !== imza) {
          if (l.paketImza !== undefined) paketDegisen.push(l)
          l.paketImza = imza
          degisti = true
        }
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
    if (degisti || dolan.length || yaklasan.length || sonSaat.length || aiDolan.length) this.kaydet()
    return { dolan, yaklasan, sonSaat, aiDolan, paketDegisen }
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

module.exports = {
  LisansDeposu,
  keyUret,
  temizle,
  ozet,
  bitisYazi,
  sureYazi,
  keySuresi,
  keyPaketi,
  keyBotSayisi,
  paketYazi,
  paketAdi,
  PAKETLER,
  MAX_BOT,
  GUN,
  SAAT,
}
