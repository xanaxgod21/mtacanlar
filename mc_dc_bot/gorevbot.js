// Mineflayer çok görevli bot: çiftçilik, odun kırma, taş kırma, maden kazma
// Kurulum: npm install
// Çalıştırma: node discordbot.js (bu dosyayı o başlatır) ya da elle: node gorevbot.js
//
// Oyun içi komutlar (sadece sahip yazabilir, fısıltıyla da olur; sahip Discord'da
// /sahip ile verilir, büyük/küçük harf fark etmez):
//   !farm   -> olgun ürünleri toplar ve yeniden eker
//   !odun   -> yakındaki ağaçları keser
//   !tas    -> taş kırar (kazma gerekir)
//   !maden  -> cevher kazar: kömür, demir, bakır, altın, elmas... (kazma gerekir)
//   !maden elmas|demir|altin... -> o cevherin derinliğine merdivenle iner, orada kazar
//   !balik  -> yakındaki suda balık tutar (olta yoksa ipten yapar)
//   !xp     -> durduğu yerde yaklaşan yaratıkları keser (yaratık çiftliği)
//   !koru   -> sahibini takip eder, ona saldıranla savaşır (!koruma ac|kapat: kendini koruma)
//   !yap kazma|balta|kilic|kurek|capa|olta -> en değerli malzemeden yapar (ham demiri eritir)
//   !envanter -> üstündekileri söyler
//   !topla  -> yerdeki eşyaları toplar
//   !bosalt -> topladıklarını sandığa bırakır (sandık gösterilmediyse en yakındakine)
//   !sandik ekle|sil|liste|temizle -> sandık göster (dibinde dur ya da x y z yaz)
//   !otonom -> yapay zeka kendi karar verip görev seçer
//   !gel    -> sana gelir
//   !dur    -> mevcut görevi ve otonom modu durdurur
//   !durum  -> ne yaptığını, canını, açlığını söyler
//   Yaren <cümle> -> yapay zekayla serbest konuşma ("Yaren biraz odun lazım")
//
// Kendiliğinden yaptıkları: sunucu şifre isterse /login - /register yazar
// (şifre Discord'dan /giris ile verilir), acıkınca yemek yer, boştayken AFK
// diye atılmasın diye arada hareket eder, oyun sohbetini müşterinin odasına aktarır,
// yaklaşan düşman yaratıklarla savaşır (savas.js), aleti kırılınca yenisini yapar
// (zanaat.js), ölünce doğup eşyalarını toplamaya döner ve işine devam eder.

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const ayarlar = require('./ayarlar')
const { guvenliBaglanti, baglantiHatasiMetni } = require('./ag')
const kurSavas = require('./savas')
const kurZanaat = require('./zanaat')

let createBrain
try {
  createBrain = require('./beyin')
} catch (e) {
  console.log('[ai] beyin.js bulunamadı, yapay zeka kapalı:', e.message)
  createBrain = () => ({
    enabled: false,
    ask: async () => 'Yapay zeka kapalı.',
    decide: async () => '',
    reflect: async () => '',
    recordEvent() {},
    dersler: () => [],
    kullanim: () => null,
  })
}

// ---------- AYARLAR ----------
// discordbot.js bu değerleri ortam değişkeniyle verir (her müşteriye ayrı).
// Elle çalıştırırsan sağdaki varsayılanlar kullanılır.
// Sahip: bot oyunda sadece onun yazdıklarını yapar. Discord'dan /sahip ile sonradan
// verilir ya da değiştirilir. Discord botu başlattıysa (MC_YONETILEN) sahip yoksa
// kimseyi dinlemez; elle çalıştırınca ayarlar.json'daki mc_sahip kullanılır.
let OWNER = process.env.MC_YONETILEN === '1' ? String(process.env.MC_OWNER || '').trim() : ayarlar.mcSahip
const SAHIP_RE = /^[A-Za-z0-9_]{3,16}$/
const sahipMi = (ad) => !!OWNER && String(ad || '').toLowerCase() === OWNER.toLowerCase()
const SAHIPSIZ = 'Henüz sahibim yok: Discord odana /sahip ad:OyunAdın yaz.'
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const BOT_NAME = process.env.MC_BOT_NAME || 'GorevBot'
const AUTH = process.env.MC_AUTH || 'offline' // 'offline' veya 'microsoft'
const VERSION = process.env.MC_VERSION || ''  // boşsa otomatik algılanır
const SEARCH_RADIUS = 48
// Deneyim defteri, yapay zeka kullanımı ve Microsoft girişi burada durur.
// discordbot.js her müşteriye kendi klasörünü verir.
const VERI_DIR = process.env.MC_VERI_DIR || __dirname
// ses.py için yerel komut sunucusu. discordbot.js botla IPC üzerinden
// konuştuğu için onu 0 (kapalı) verir; çok bot aynı portu kapmaya çalışmasın.
const KOMUT_PORT = parseInt(process.env.KOMUT_PORT ?? '3030', 10) || 0

// Yapay zeka anahtarı: ortam değişkeni, ayarlar.json ya da anahtar.txt.
// Hiçbiri yoksa yapay zeka kapalı kalır, bot eskisi gibi çalışır.
// AI_KAPALI=1 ise (yapay zekasız lisans) dosyada anahtar olsa bile kapalı.
const API_KEY = process.env.AI_KAPALI === '1' ? '' : ayarlar.apiKey
const AI_MODEL = ayarlar.aiModel
const AI_GUNLUK_LIMIT = parseInt(process.env.AI_GUNLUK_LIMIT || '0', 10) || 0 // 0 = sınırsız
// -----------------------------

const YARDIM =
  'Komutlar: !odun !maden (!maden elmas) !tas !farm !balik !xp !koru !yap kazma !topla !bosalt !sandik !envanter !gel !dur !durum !otonom (ya da "Yaren odun kes" gibi konuş)'

const botSecenek = {
  host: HOST,
  port: PORT,
  logErrors: false, // mineflayer hatayı ham yığınıyla basmasın; aşağıda anlaşılır yazılır
  username: BOT_NAME,
  auth: AUTH,
  ...(VERSION ? { version: VERSION } : {}),
  // Microsoft girişi varsayılan olarak herkes için ortak bir klasörde, kullanıcı
  // adına göre saklanır. Ayrı klasör olmazsa aynı adı yazan başka bir müşteri
  // senin hesabınla girebilir.
  profilesFolder: path.join(VERI_DIR, 'giris'),
  onMsaCode: (d) =>
    console.log(
      `[giriş] Microsoft hesabıyla giriş: ${d.verification_uri} adresini aç ve şu kodu yaz: ${d.user_code}`
    ),
}
// Satış sürümünde müşteri botları sadece internetteki sunuculara bağlanır.
// Kontrol soket açılırken yapılır: yeniden bağlanmada da, alan adı sonradan
// iç ağa çevrilse de geçerli.
if (process.env.MC_HEDEF_KONTROL === '1') {
  botSecenek.connect = guvenliBaglanti(botSecenek, (neden, kalici) => {
    console.log(`[hata] Bu adrese bağlanamam: ${neden}.`)
    process.exit(kalici ? 3 : 1) // 3 = kalıcı hata: discordbot.js tekrar denemesin
  })
}
const bot = mineflayer.createBot(botSecenek)
bot.loadPlugin(pathfinder)

// Giriş bekçisi: Microsoft kodu girilmezse, hesap Minecraft'a sahip değilse ya
// da sunucu girişi hiç bitirmezse 'end' olayı gelmez ve süreç sonsuza kadar
// bekleyip bir bot yerini tutardı. Belli sürede oyuna giremezse kapan.
const GIRIS_SURESI = AUTH === 'microsoft' ? 17 * 60000 : 2 * 60000
setTimeout(() => {
  if (hazir) return
  console.log('[hata] Oyuna giremedim (giriş zaman aşımı), kapanıyorum.')
  process.exit(1)
}, GIRIS_SURESI).unref()

let hazir = false       // oyuna girip doğunca true olur
let taskId = 0          // her yeni görevde artar, eski görev bunu görünce durur
let currentTask = null  // 'farm' | 'odun' | 'tas' | 'maden' | 'topla' | 'bosalt' | null
let gorev = null        // çalışan görevin bilgisi: { id, bitis, not, zamanlayici }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = (p) => `${p.x},${p.y},${p.z}`

// ---------- KENDİNİ KORUMA (savas.js) ----------
// Düşman yaratık yaklaşınca savaşır, tehlikeliden kaçar. Savaş sürerken görevler
// bekler: yürüme ve kazma aşağıda sarmalanır, savaş kestiyse bitince yeniden denenir.
let KORUMA = process.env.MC_KORUMA !== '0'
const savas = kurSavas(bot, {
  goals,
  log: (m) => console.log(m),
  iyiSilah: () => iyiAlet('sword') || iyiAlet('axe'),
  yemekYe: () => yemekGerekirse(),
  istatistik: (tur, ad) => istatistikEkle(tur, ad),
  acik: () => (KORUMA || currentTask === 'koru' || currentTask === 'xp') && hazir,
  yerinde: () => currentTask === 'xp',
  korunan: () => (currentTask === 'koru' ? sahipOyuncu()?.entity || null : null),
})

// ---------- ALET YAPMA (zanaat.js) ----------
const zanaat = kurZanaat(bot, {
  goals,
  log: (m) => console.log(m),
  kaz: (b) => kaz(b),
  topla: () => collectDrops(taskId, 5, 6),
  aletTuru: (i) => aletTuru(i),
  istatistik: (tur, ad) => istatistikEkle(tur, ad),
})

// Yürüme savaşta kesilirse savaş bitince aynı hedefe yeniden gider (görev değişmediyse)
function savasaDayanikli() {
  const asilGoto = bot.pathfinder.goto.bind(bot.pathfinder)
  bot.pathfinder.goto = async (goal) => {
    const tid = taskId
    for (;;) {
      await savas.bekle()
      if (taskId !== tid) throw new Error('görev değişti')
      const s = savas.seq()
      try {
        return await asilGoto(goal)
      } catch (e) {
        if (savas.seq() === s || !(bot.health > 0)) throw e
      }
    }
  }
}

let ilkDogus = true
bot.on('spawn', () => {
  if (ilkDogus) return
  // ölüp yeniden doğdu
  if (olum) setTimeout(() => olumdenDon().catch((e) => console.log('[olum] hata:', e.message)), 2500)
})
bot.once('spawn', () => {
  ilkDogus = false
  normalMovements = new Movements(bot)
  woodMovements = new Movements(bot)
  woodMovements.canDig = false // odun toplarken yaprakları kırmasın
  savasaDayanikli()
  hazir = true
  restoreMovements()
  console.log(`[olay] Sunucuya girdi: ${HOST}:${PORT} (${BOT_NAME})`)
  if (!OWNER) {
    console.log('[sahip] Henüz sahibim yok, kimsenin yazdığını yapmıyorum. Discord odana /sahip ad:OyunAdın yaz.')
  } else {
    console.log(`[sahip] Oyunda sadece ${OWNER} oyuncusunun yazdıklarını yapıyorum.`)
  }
  if (girisBekleyen) girisKomutu(girisBekleyen)
  say(`Hazırım! ${YARDIM}`)
})

function say(msg) {
  const metin = String(msg || '').replace(/\s+/g, ' ').trim()
  if (!metin) return
  console.log('[bot]', metin)
  if (!hazir) return
  const parts = metin.match(/.{1,200}/g) || [] // sohbet sınırı: parça parça gönder
  for (const p of parts) {
    // "/" ile başlayan mesaj sunucuda komut olarak çalışır. Yapay zekanın
    // cevabı yanlışlıkla (ya da kandırılıp) botun yetkisiyle komut çalıştırmasın.
    const temiz = p.replace(/^[\s/]+/, '')
    if (!temiz) continue
    try {
      bot.chat(temiz)
    } catch (_) {}
  }
}

// ---------- KOMUTLAR ----------
// Oyundaki sahip (adını farklı büyük/küçük harfle yazmış olabilir)
function sahipOyuncu() {
  if (!OWNER || !bot.players) return null // sunucuya bağlanana kadar oyuncu listesi yok
  const ad = Object.keys(bot.players).find(sahipMi)
  return ad ? bot.players[ad] : null
}

// mineflayer gönderenin adını mesaj metninden tahminle çıkarır ("[Rütbe] Ad » mesaj"
// gibi satırlarda baştaki birkaç karakteri atlar). Biri "/me xdarkoum: !odun" ya da
// "]xdarkoum: !odun" yazıp sahip gibi görünmesin: mesajı gönderenin UUID'si (varsa)
// sahibinki olmalı ve satırda sahibin adından önce başka bir oyuncunun adı geçmemeli.
let sonGonderen = null
bot.on('message', (_m, _poz, gonderen) => {
  sonGonderen = gonderen || null
})
const uuidTemiz = (u) => String(u || '').replace(/-/g, '').toLowerCase()
const adKonumu = (satir, ad) =>
  satir.search(new RegExp(`(?<![A-Za-z0-9_])${ad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i'))
function gercekSahipSatiri(satir) {
  const uuid = uuidTemiz(sahipOyuncu()?.uuid)
  const gonderen = uuidTemiz(sonGonderen)
  if (uuid && gonderen && !/^0+$/.test(gonderen) && gonderen !== uuid) return false
  const yer = adKonumu(satir, OWNER)
  if (yer < 0) return false
  return !Object.keys(bot.players || {}).some((ad) => {
    if (sahipMi(ad)) return false
    const y = adKonumu(satir, ad)
    return y >= 0 && y < yer
  })
}

async function onOwnerMessage(username, message, _translate, satir) {
  if (!sahipMi(username) || !gercekSahipSatiri(String(satir ?? ''))) return
  const text = String(message).trim()
  if (text.startsWith('!')) return handleCommand(text.toLowerCase())
  const m = text.match(/^yaren[\s,:!]*(.*)$/i)
  if (m) {
    const metin = m[1] || 'merhaba'
    console.log('[duydum]', metin)
    say(brain.enabled ? await brain.ask(metin) : anahtarsizCevap(metin))
  }
}

// Yapay zeka kapalıyken (anahtar yok ya da lisansta yapay zeka yok) "Yaren ..." cümleleri
// ve Discord odasına yazılanlar: sık istekler komuta çevrilir, gerisine ne anlayabildiği
// söylenir. Para harcamaz. İş isteği = iş adı + yapma fiili ("odun kes", "maden kaz").
// "kesme", "kesmeyi bırak" gibi olumsuz biçimler durdurmadır; "kazma" alettir.
const GOREV_NIYETLERI = [
  ['!balik', /\bbalik/],
  ['!xp', /\b(xp|tecrube|yaratik|mob|canavar)/],
  ['!odun', /\b(odun|agac|kutuk|tahta|kereste)/],
  ['!maden', /\b(maden|cevher|demir|komur|elmas|altin|bakir|zumrut|lapis|kizil ?tas|redstone)/],
  ['!tas', /\b(tas|kaya|cobble)/],
  ['!farm', /\b(tarla|farm|ekin|bugday|hasat|havuc|patates|pancar)/],
  ['!topla', /\b(topla(?![dt][iu][gk])|yerdeki)/], // "topladıklarını" değil
]
const FIIL_RE = /\b(kes|kas|kaz|kir|topla|hasat|cikar|bic|getir|bul|tut)(?!m[ae])/ // "kesme", "kazma(yı)" değil
// her zaman durdurma: "kesmeyi bırak", "kazmayı kes", "odun kesme", "kazma artık"
const KESIN_DUR_RE = /\w+m[ae]yi (birak|kes|durdur)|\b(kes|kas|kir|topla)m[ae]\b|\bkazma (artik|yeter)|\bkazma$/
// iş isteğinden önce geçerse: "dur", "durur musun" ("odun kes, bitince dur" ise iş yapılır)
const DUR_RE = /\b(dur|durun|durur|dursana|durdur\w*|bekle\w*|yeter|iptal|vazgec\w*)\b/
const GEL_RE = /\b(gel(?!me)|yanima|buraya|beni takip)/
const DURUM_RE = /\b(durum|ne yapiyorsun|neredesin|nasilsin|ne var)/
const SANDIGA_RE = /\b(sandi[gk]|bosalt|depola|gotur)|\besya\w* (birak|koy)/
const SANDIK_KOMUTLARI = [
  [/\bsandi(k|gi|gimi|klari)\s+(ekle|kaydet|goster)/, '!sandik ekle'], // "sandığa ekle" değil
  [/\bsandi(k|gi|gimi|klari|klarimi)\s+(sil|kaldir|unut)/, '!sandik sil'],
  [/\bsandi(k|klari|klarimi)\s+temizle/, '!sandik temizle'],
  [/\bsandik(lar)?(in|im|larim)?\s+(liste|neler)|\bsandik listesi/, '!sandik liste'],
]
// koruma, alet yapma, envanter: işlerden önce bakılır
const ALET_KELIME = { kazma: 'kazma', balta: 'balta', kilic: 'kilic', kurek: 'kurek', capa: 'capa', olta: 'olta' }
const OZEL_NIYETLER = [
  [/\bkoruma\w* (kapat|kapa|iptal)|\bsavasma\b/, '!koruma kapat'],
  [/\bkoruma\w* ac/, '!koruma ac'],
  [/\b(beni koru|koru beni|korumam ol|bana koruma|beni savun)/, '!koru'],
  // "envanterini boşalt", "envanter dolunca odun kes" değil
  [/^(?!.*\b(bosalt|depola|sandi[gk]|koy|birak|gotur)|.*envanter\w* dol).*\b(envanter|uzerinde ne var|cantanda ne var|neyin var)/, '!envanter'],
]
const MADEN_KELIME = [
  ['elmas', /\b(elmas|derin)/], ['kiziltas', /\b(kizil ?tas|redstone)/], ['altin', /\baltin/], ['zumrut', /\bzumrut/],
  ['lapis', /\blapis/], ['demir', /\bdemir/], ['bakir', /\bbakir/], ['komur', /\bkomur/],
]
function niyetBul(t) {
  // "elmasları sandığa koyma": bırakma isteği değil
  if (/\b(koy|birak|gotur|tasi|bosalt|depola)m[ae]\b/.test(t)) return 'birakma'
  if (KESIN_DUR_RE.test(t)) return '!dur'
  for (const [re, cmd] of SANDIK_KOMUTLARI) if (re.test(t)) return cmd
  for (const [re, cmd] of OZEL_NIYETLER) if (re.test(t)) return cmd
  // "kazma yap", "bana kılıç yap", "olta üret"
  const alet = t.match(/\b(kazma|balta|kilic|kurek|capa|olta)\w*\s+(yap|uret|olustur)|\b(yap|uret)\w*\s+(kazma|balta|kilic|kurek|capa|olta)/)
  if (alet) return `!yap ${ALET_KELIME[alet[1] || alet[4]]}`
  if (/\bsandi[gk]\w*tan\b/.test(t)) return 'sandiktan' // "sandıktan al": yapamaz
  // "götürdün mü", "sandık nerede": soru, iş değil
  if (/\b(nerede|nerde)\b|\w+[dt][iu]n? m[iu]\b/.test(t)) return '!durum'
  const sandiga = SANDIGA_RE.test(t)
  let metin = t.replace(/\b(demir|elmas|altin|tas|tahta|odun|bakir|netherit)\w* kazma\w*/g, ' ') // alet adı
  // "topladıklarını / kestiğin odunları sandığa koy": yapılmış iş; "sandığa taşı": taşımak
  if (sandiga) metin = metin.replace(/\btasi\w*/g, ' ').replace(/\b\w+[dt][iu][gk]\w*/g, ' ')
  let gorev = null
  let yer = Infinity
  for (const [cmd, re] of GOREV_NIYETLERI) {
    const i = metin.search(re)
    if (i >= 0 && i < yer) [gorev, yer] = [cmd, i]
  }
  if (!gorev && /\bkaz(?!m[ae])/.test(metin)) [gorev, yer] = ['!maden', metin.search(/\bkaz/)] // sadece "kaz"
  const fiil = FIIL_RE.test(metin)
  const is = gorev && fiil // açık iş isteği
  const ilk = (re) => {
    const i = t.search(re)
    return i < 0 ? Infinity : i
  }
  // sandık / eşya geçmeyen "bırak": "işi bırak", "bırak artık"
  const birakDur = !/\b(sandi[gk]|esya|depo)/.test(t) ? ilk(/\bbirak/) : Infinity
  const durum = /\b(bosalt|depola|sandi[gk]|koy|birak|gotur)|envanter\w* dol/.test(t) ? Infinity : ilk(DURUM_RE)
  const digerleri = [
    [Math.min(ilk(DUR_RE), birakDur), '!dur'],
    [durum, '!durum'],
    [ilk(GEL_RE), '!gel'],
  ].sort((a, b) => a[0] - b[0])
  // iş önce söylendiyse ("odun kes 64 tane yeter", "maden kaz dolunca dur") iş yapılır
  if (digerleri[0][0] < Infinity && !(is && yer < digerleri[0][0])) return digerleri[0][1]
  // "odun kes, sandığa götür": görev topladığını zaten sandığa götürür.
  // "odunları sandığa koy" (kesme yok): elindekileri bırakır.
  if (sandiga && !is) return '!bosalt'
  if (gorev === '!maden') {
    // "elmas kaz": o cevherin derinliğine iner
    const hedef = MADEN_KELIME.find(([, re]) => re.test(metin))
    return hedef ? `!maden ${hedef[0]}` : gorev
  }
  if (gorev) return gorev
  if (/\b(yardim|komut|ne yapabilirsin|neler yapabilirsin)/.test(t)) return '!yardim'
  return null
}
function anahtarsizCevap(metin) {
  const t = sade(metin)
  if (/\botonom|kendi kendine|kendin karar/.test(t)) return 'Kendi kendime karar vermem için yapay zeka lazım (satıcı açabilir). Bana ne yapacağımı söyle: odun kes, maden kaz, tarla, gel...'
  const cmd = niyetBul(t)
  if (cmd === 'birakma') return 'Tamam, sandığa bırakmıyorum.'
  if (cmd === 'sandiktan') return 'Sandıktan eşya almayı bilmiyorum, sadece sandığa bırakırım. (Kırılmak üzere olan aletimin yenisini gösterdiğin sandıktan kendim alırım.)'
  if (cmd) return komut(cmd) || 'Tamam.'
  if (/\b(selam|merhaba|sa\b|hey|naber)/.test(t)) return 'Merhaba! Ne yapayım? Odun keserim, maden kazarım, taş kırarım, tarla toplarım, yanına gelirim.'
  return 'Bunu anlamadım. Şunları anlarım: odun kes, maden kaz, taş kır, tarla, eşya topla, sandığa bırak, gel, dur, durum. (Satıcı yapay zekayı açarsa her şeyi konuşabiliriz.)'
}
bot.on('chat', onOwnerMessage)
bot.on('whisper', onOwnerMessage) // /msg GorevBot !odun da çalışsın

const KOMUTLAR = [
  '!farm', '!odun', '!tas', '!maden', '!topla', '!bosalt', '!sandik', '!otonom', '!dur', '!durum', '!gel', '!yardim',
  '!koru', '!koruma', '!balik', '!xp', '!yap', '!envanter',
]

// ---------- PAKET ----------
// Satıcı ucuz paket sattıysa (sadece odun, sadece maden...) diğer işler kapalıdır.
// MC_PAKET: "tam" ya da "odun,maden" gibi. Gel, dur, koru, sandık, alet yapma her pakette var.
const PAKET_GOREVLERI = { odun: ['odun'], maden: ['maden', 'tas'], farm: ['farm', 'balik', 'xp'] }
const PAKET_ADLARI = { tam: 'Tam', odun: 'Odun', maden: 'Maden', farm: 'Farm (tarla, balık, XP)' }
const PAKET = String(process.env.MC_PAKET || 'tam').split(',').map((p) => p.trim()).filter((p) => PAKET_ADLARI[p])
const tamPaket = !PAKET.length || PAKET.includes('tam')
const PAKETLI = new Set(Object.values(PAKET_GOREVLERI).flat())
function paketEngeli(gorevAdi) {
  if (tamPaket || !PAKETLI.has(gorevAdi)) return null
  if (PAKET.some((p) => PAKET_GOREVLERI[p].includes(gorevAdi))) return null
  return `Bu iş paketinde yok (paketin: ${PAKET.map((p) => PAKET_ADLARI[p]).join(' + ')}). Satıcıdan paket yükseltmesi isteyebilirsin.`
}
const ALET_ADLARI = { kazma: 'pickaxe', balta: 'axe', kilic: 'sword', kurek: 'shovel', capa: 'hoe', olta: 'fishing_rod' }

// Komutu çalıştırır, cevabı oyunda söyler ve geri döndürür (Discord ve ses.py
// cevabı HTTP'den alır). Bilinmeyen komutta null döner, hiçbir şey söylemez.
function handleCommand(cmd) {
  const cevap = komut(cmd)
  if (cevap) say(cevap)
  return cevap
}

function komut(cmd) {
  const [ad, ...arg] = cmd.split(/\s+/) // "!sandik ekle 10 64 -5"
  if (!KOMUTLAR.includes(ad)) return null
  console.log('[komut]', cmd)
  if (!hazir) return 'Henüz oyuna girmedim, biraz bekle.'
  if (!['!durum', '!otonom', '!yardim', '!sandik'].includes(ad)) otonomRun = 0
  switch (ad) {
    case '!farm':
    case '!odun':
    case '!tas':
    case '!topla':
    case '!bosalt':
    case '!balik':
    case '!xp':
    case '!koru': {
      const gorevAdi = ad.slice(1)
      const engel = paketEngeli(gorevAdi) || baslamaEngeli(gorevAdi)
      if (engel) return engel
      const metin = startTask(gorevAdi, GOREVLER[gorevAdi], 0, ad)
      if (gorevAdi === 'koru') return 'Yanındayım, sana saldıranla savaşırım. (Bırakmak için: dur)'
      if (gorevAdi === 'xp') return `${metin} Burada durup yaklaşan yaratıkları keserim (yaratık çiftliği için).`
      return metin
    }
    case '!maden': {
      const engel = paketEngeli('maden') || baslamaEngeli('maden')
      if (engel) return engel
      const hedef = MADEN_HEDEFLERI[arg[0]] ? arg[0] : null
      const metin = startTask('maden', (id) => madenTask(id, { hedef }), 0, hedef ? `!maden ${hedef}` : '!maden')
      return hedef && MADEN_HEDEFLERI[hedef].y.some((y) => y !== null) ? `${metin} ${hedef} için aşağı iniyorum.` : metin
    }
    case '!yap': {
      const tur = ALET_ADLARI[arg[0] || 'kazma']
      if (!tur) return 'Şunları yapabilirim: !yap kazma | balta | kilic | kurek | capa | olta'
      return startTask('yap', (id) => yapTask(id, tur), 0, cmd)
    }
    case '!koruma': {
      if (arg[0] === 'kapat') KORUMA = false
      else if (arg[0] === 'ac') KORUMA = true
      return KORUMA
        ? 'Koruma açık: yaklaşan düşman yaratıklarla savaşır, tehlikeliden kaçarım. (Kapatmak: !koruma kapat)'
        : 'Koruma kapalı: yaratıklarla savaşmam (beni koru dersen yine korurum). (Açmak: !koruma ac)'
    }
    case '!envanter':
      return envanterOzeti()
    case '!sandik':
      return sandikKomutu(arg)
    case '!otonom':
      return setAuto(true)
    case '!dur': {
      // durdurunca topladıklarını götürmez: söyle ki "sandığa koy" diyebilsin
      const yanimda = currentTask && TOPLAMA_GOREVLERI.has(currentTask) ? toplananAdet() : 0
      stopTask()
      return yanimda ? `Durdum. Topladıklarım yanımda (${yanimda} eşya); "sandığa koy" dersen götürürüm.` : 'Durdum.'
    }
    case '!durum':
      return durumMetni()
    case '!gel':
      stopTask()
      return comeToOwner()
    case '!yardim':
      return YARDIM
  }
  return null
}

function comeToOwner() {
  if (!OWNER) return SAHIPSIZ
  const p = sahipOyuncu()?.entity
  if (!p) return 'Seni göremiyorum, yakın değilsin.'
  const myId = taskId
  bot.pathfinder
    .goto(new goals.GoalNear(p.position.x, p.position.y, p.position.z, 2))
    .catch(() => {
      // yolu yeni bir görev kestiyse "ulaşamadım" deme
      if (taskId === myId) say('Sana ulaşamadım.')
    })
  return 'Geliyorum.'
}

function durumMetni() {
  const s = snapshot()
  const ne = s.aktif_gorev
    ? `Görev: ${s.aktif_gorev}${s.kalan_dakika != null ? ` (${s.kalan_dakika} dk kaldı)` : ''}`
    : 'Boştayım'
  return `${ne}. Can ${Math.round(s.can)}/20, açlık ${s.aclik}/20, boş slot ${s.bos_slot}${
    s.otonom ? ', otonom açık' : ''
  }.`
}

// ---------- YAPAY ZEKA BAĞLANTISI ----------
// Kırılan blok sayaçları (görev özeti için). mineflayer'ın 'diggingCompleted'
// olayı bloğun kırıldıktan sonraki hâlini (yani 'air') verdiği ve bot ölünce
// o olayın dinleyicilerini sildiği için sayımı kaz() içinde kendimiz yapıyoruz.
const counters = {}

// Savaş kazmayı keserse savaş bitince aynı bloğu yeniden kazar (görev değişmediyse)
async function kaz(block) {
  const ad = block.name
  const tid = taskId
  for (;;) {
    await savas.bekle()
    if (taskId !== tid) throw new Error('görev değişti')
    const b = bot.blockAt(block.position)
    if (!b || b.boundingBox === 'empty' || b.name !== ad) return // bu arada kırılmış / değişmiş
    const s = savas.seq()
    try {
      // sunucu cevap vermezse (blok uzakta, eklenti engelledi) sonsuza kadar beklemesin
      const sure = (typeof bot.digTime === 'function' ? bot.digTime(b) : 5000) + 8000
      await sureli(bot.dig(b), sure, 'kazma cevapsız kaldı')
      break
    } catch (e) {
      if (/cevapsız/.test(e.message)) {
        try {
          bot.stopDigging()
        } catch (_) {}
      }
      if (savas.seq() === s || !(bot.health > 0)) throw e
    }
  }
  // Korumalı alanda (spawn, arsa) sunucu kırmayı geri alır: blok yerinde kalır.
  // Kırıldı sayma, çağıran bu bloğu atlasın.
  await sleep(150)
  const sonra = bot.blockAt(block.position)
  // çakıl/kum kırılınca üstündeki düşüp yerine geçer: o koruma sayılmaz
  if (sonra && sonra.name === ad && sonra.boundingBox !== 'empty' && !/gravel|sand$|concrete_powder/.test(ad)) {
    korumaliSayac++
    if (korumaliSayac >= 3) uyar('korumali', 'Burada kazmama izin yok (korumalı alan / arsa olabilir). Beni başka bir yere götür.', 10 * 60000)
    throw new Error('blok kırılmadı (korumalı alan olabilir)')
  }
  korumaliSayac = 0
  counters[ad] = (counters[ad] || 0) + 1
  istatistikEkle('kirilan', ad)
}
let korumaliSayac = 0

let lastResult = ''  // son görevin özeti
let otonomRun = 0    // 0 = kapalı, değilse çalışan döngünün numarası
let otonomSeq = 0

// Yapay zekanın "durum_bak" ile gördüğü bilgiler
function snapshot() {
  if (!hazir || !bot.entity) return { hazir: false }
  const envanter = {}
  for (const it of bot.inventory.items()) {
    envanter[it.name] = (envanter[it.name] || 0) + it.count
  }
  const p = bot.entity.position
  return {
    aktif_gorev: currentTask,
    kalan_dakika:
      gorev && gorev.bitis
        ? Math.max(0, Math.round((gorev.bitis - Date.now()) / 6000) / 10)
        : null,
    otonom: otonomRun !== 0,
    konum: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
    can: bot.health,
    aclik: bot.food,
    gunduz: bot.time ? bot.time.isDay : null,
    bos_slot: bot.inventory.emptySlotCount(),
    envanter,
    son_gorev_sonucu: lastResult || null,
    sandik_sayisi: sandiklar().length,
    sahip: OWNER || null,
    sahip_gorunuyor: !!sahipOyuncu()?.entity,
    ai_kullanim: brain.enabled ? brain.kullanim() : null,
  }
}

const GOREVLER = {
  farm: (id) => farmTask(id),
  odun: (id) => woodTask(id),
  tas: (id) => stoneTask(id),
  maden: (id) => madenTask(id),
  topla: (id) => collectDrops(id, 16, 30),
  bosalt: (id) => bosaltTask(id),
  koru: (id) => korumaTask(id),
  balik: (id) => balikTask(id),
  xp: (id) => xpTask(id),
}
// Topladığını sandığa götüren görevler (envanter dolunca, bir yığın toplayınca ve
// görev kendiliğinden bitince)
const TOPLAMA_GOREVLERI = new Set(['farm', 'odun', 'tas', 'maden', 'balik', 'xp'])

async function bosaltTask(id) {
  const hedef = birakmaHedefi()
  if (!hedef.liste.length) {
    return gorevNotu(id, 'Yakında sandık göremiyorum. Beni bir sandığın yanına getir ya da sandığın dibinde dur ve !sandik ekle yaz.')
  }
  // en yakın sandığa alet bırakılmaz: sadece aletler fazlaysa "bırakacak bir şey yok"
  if (!birakmaPlani(bot.inventory.items(), hedef.oto ? envanterSayim() : null).length) return gorevNotu(id, 'Sandığa bırakacak bir şeyim yok.')
  // açıkça istendi: en yakın sandığa da (sadece bu görevde toplananları değil) fazlaların hepsi
  const r = await sandikZiyareti(id, { don: false, hepsi: true })
  if (!r.ulasilan) gorevNotu(id, hedef.oto ? 'Yakındaki sandıklara ulaşamadım ya da açamadım.' : 'Sandıklara ulaşamadım.')
}

const hasPickaxe = () => bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))

// Görev hiç başlamadan anlamsızsa nedenini döndürür
function baslamaEngeli(ad) {
  // gösterilen sandık varsa oradan kazma alabilir / oraya boşaltabilir
  const sandikVar = sandiklar().length > 0
  if ((ad === 'tas' || ad === 'maden') && !hasPickaxe() && !sandikVar && !zanaat.yapilabilir('pickaxe')) {
    return `Kazmam yok, ${ad === 'tas' ? 'taş kıramam' : 'maden kazamam'}. Envanterime ya da sandığa bir kazma koy.`
  }
  const toplar = ['farm', 'odun', 'tas', 'maden', 'topla', 'balik'].includes(ad)
  if (toplar && bot.inventory.emptySlotCount() === 0 && !sandikVar && !otoSandiklar(bot.entity.position).length) {
    return 'Envanterim dolu ve yakında sandık yok. Boşaltmam için bir sandık göster: !sandik ekle'
  }
  return null
}

// Yapay zekanın başlattığı (istenirse süre sınırlı) görev
function startTimed(ad, dakika, otonom, hedef) {
  if (!hazir) return 'Henüz oyuna girmedim.'
  if (!GOREVLER[ad]) return `Bilmediğim görev: ${ad}`
  const engel = paketEngeli(ad) || baslamaEngeli(ad)
  if (engel) return engel
  if (!otonom) otonomRun = 0 // kullanıcı bir şey isteyince otonom biter
  let mins = Math.max(0, Math.round(Number(dakika) || 0))
  if (otonom) mins = Math.min(mins || 5, 8) // otonomda süresiz ya da çok uzun görev olmasın
  const madenHedefi = ad === 'maden' && MADEN_HEDEFLERI[hedef] ? hedef : null
  const fn = madenHedefi ? (id) => madenTask(id, { hedef: madenHedefi }) : GOREVLER[ad]
  const text = startTask(ad, fn, mins, madenHedefi ? `!maden ${madenHedefi}` : `!${ad}`)
  say(text)
  return text
}

function setAuto(on) {
  if (!on) {
    otonomRun = 0
    return 'Otonom mod kapalı.'
  }
  if (!brain.enabled) return 'Otonom mod için yapay zeka anahtarı gerekli.'
  if (!hazir) return 'Henüz oyuna girmedim.'
  if (otonomRun) return 'Zaten otonom çalışıyorum.'
  otonomRun = ++otonomSeq
  otonomLoop(otonomRun)
  return 'Otonom moda geçtim, kendi başıma karar vereceğim.'
}

// Kendi kendine karar ver -> görevi yap -> sonucu değerlendir -> tekrar
async function otonomLoop(run) {
  console.log('[otonom] başladı')
  let bos = 0
  while (otonomRun === run) {
    try {
      const text = await brain.decide(lastResult)
      if (text) console.log('[yaren]', text)
      if (otonomRun !== run) break
      if (!currentTask) {
        bos++
        if (bos >= 4) {
          say('Ne yapacağıma karar veremedim, otonom modu kapatıyorum.')
          otonomRun = 0
          break
        }
        await sleep(20000)
        continue
      }
      bos = 0
      while (otonomRun === run && currentTask) await sleep(2000)
      await sleep(5000)
    } catch (e) {
      console.log('[hata] otonom döngü:', e.message || e)
      await sleep(10000)
    }
  }
  console.log('[otonom] bitti')
}

const brain = createBrain({
  apiKey: API_KEY,
  model: AI_MODEL,
  owner: () => OWNER,
  dataFile: path.join(VERI_DIR, 'deneyim.json'),
  gunlukLimit: AI_GUNLUK_LIMIT,
  kullanimDosyasi: path.join(VERI_DIR, 'ai_kullanim.json'),
  log: (...a) => console.log(...a),
  getState: snapshot,
  actions: {
    start: (gorev, dakika, otonom, hedef) => startTimed(gorev, dakika, otonom, hedef),
    yap: (alet) => {
      if (!hazir) return 'Henüz oyuna girmedim.'
      const tur = ALET_ADLARI[alet]
      if (!tur) return 'Bilmediğim alet.'
      otonomRun = 0
      const text = startTask('yap', (id) => yapTask(id, tur), 0, `!yap ${alet}`)
      say(text)
      return text
    },
    stop: () => {
      otonomRun = 0
      stopTask()
      return 'Görevi durdurdum.'
    },
    come: () => {
      if (!hazir) return 'Henüz oyuna girmedim.'
      otonomRun = 0
      stopTask()
      return comeToOwner()
    },
    auto: (on) => setAuto(on),
  },
})
console.log('[ai]', brain.enabled ? `açık (${AI_MODEL})` : 'kapalı (anahtar yok)')

// Görev bitince: özet çıkar, deneyim defterine yaz, başarısızsa ders çıkar
function onTaskEnd({ name, natural, hata, startedAt, before, not }) {
  const dk = Math.round((Date.now() - startedAt) / 6000) / 10
  const ozet =
    Object.entries(counters)
      .map(([k, v]) => [k, v - (before[k] || 0)])
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, d]) => `${k}×${d}`)
      .join(', ') || 'hiçbir şey kırılmadı'
  let neden
  if (not) neden = not // görevin kendi söylediği neden (envanter doldu, öldü, süre doldu...)
  else if (!natural) neden = 'durduruldu' // durdurunca yarım kalan kazma hatası sayılmasın
  else if (hata) neden = `hata: ${hata.message || hata}`
  else neden = 'bitti'

  const olay = { gorev: name, sebep: neden, ozet, dakika: dk }
  lastResult = `${name} (${dk} dk): ${ozet}; sebep: ${neden}`
  console.log(`[sonuç] ${lastResult}`)
  brain.recordEvent(olay)

  const kotu = /bulamadım|envanter|kalmadı|kazma|hata|öldü/i.test(neden)
  if (kotu && name !== 'topla') {
    brain
      .reflect(olay)
      .then((t) => t && say(t))
      .catch(() => {})
  }
}

// ---------- DIŞARIDAN KOMUT (Discord ve ses.py) ----------
// Aynı istekler iki yoldan gelir:
//   discordbot.js -> IPC (process.send), her müşterinin botu ayrı süreç
//   ses.py        -> yerel HTTP sunucusu (sadece KOMUT_PORT verildiyse)
//     POST /komut {"komut": "farm"}        -> sabit komut, cevap: {"cevap": "..."}
//     POST /soyle {"metin": "odun lazım"}  -> yapay zekaya serbest cümle
//     GET  /durum                          -> botun durumu (JSON)
//     GET  /envanter, /istatistik          -> üstündekiler, bugünkü / dünkü sayılar
async function istekIsle(tip, veri) {
  if (tip === 'durum') return { kod: 200, veri: snapshot() }
  if (tip === 'envanter') {
    if (!hazir || !bot.entity) return { kod: 409, veri: { hata: 'henüz oyuna girmedim' } }
    return { kod: 200, veri: envanterBilgisi() }
  }
  if (tip === 'istatistik') {
    gunKontrol()
    return { kod: 200, veri: istatistik }
  }
  if (tip === 'komut') {
    const cevap = handleCommand('!' + String(veri.komut || '').toLowerCase().trim())
    if (cevap === null) return { kod: 400, veri: { hata: 'bilinmeyen komut' } }
    return { kod: 200, veri: { cevap } }
  }
  if (tip === 'sahip') {
    const ad = String(veri.ad || '').trim()
    if (ad && !SAHIP_RE.test(ad)) return { kod: 400, veri: { hata: 'geçersiz Minecraft adı' } }
    OWNER = ad
    console.log(ad ? `[sahip] Artık oyunda sadece ${ad} oyuncusunun yazdıklarını yapıyorum.` : '[sahip] Sahip kaldırıldı, kimseyi dinlemiyorum.')
    if (ad && hazir) say(`${ad}, artık senin komutlarını dinliyorum. !yardim yazarsan neler yapabildiğimi söylerim.`)
    return { kod: 200, veri: { cevap: ad, oyunda: !!sahipOyuncu(), hazir } }
  }
  if (tip === 'giris') {
    const sifre = String(veri.sifre || '')
    if (sifre && !SIFRE_RE.test(sifre)) return { kod: 400, veri: { hata: 'geçersiz şifre' } }
    GIRIS_SIFRE = sifre
    girisHatali = false
    girisDeneme = 0
    girisPenceresi = Date.now() + 90000
    if (!sifre) {
      console.log('[giris] Sunucu şifresi silindi.')
      return { kod: 200, veri: { cevap: 'silindi' } }
    }
    console.log('[giris] Sunucu şifresi kaydedildi.')
    // oyundaysa ve henüz giriş yapılmadıysa hemen dene (sunucu kayıt isterse kayıt olur)
    if (hazir && !girisYapildi) girisKomutu(girisBekleyen || 'giris')
    return { kod: 200, veri: { cevap: girisYapildi ? 'zaten giriş yapılmış' : hazir ? 'deneniyor' : 'girince kullanılacak' } }
  }
  if (tip === 'sohbet') {
    SOHBET = !!veri.acik
    console.log(SOHBET ? '[sohbet] Oyun sohbeti bu odaya aktarılıyor.' : '[sohbet] Oyun sohbeti aktarımı kapatıldı.')
    return { kod: 200, veri: { cevap: SOHBET ? 'acik' : 'kapali' } }
  }
  if (tip === 'yaz') {
    if (!hazir) return { kod: 409, veri: { hata: 'henüz oyuna girmedim' } }
    const metin = String(veri.metin || '').replace(/\s+/g, ' ').trim().slice(0, 256)
    if (!metin) return { kod: 400, veri: { hata: 'boş mesaj' } }
    if (Date.now() - sonYazma < 1500) return { kod: 429, veri: { hata: 'çok hızlı, biraz bekle' } }
    sonYazma = Date.now()
    try {
      bot.chat(metin)
    } catch (e) {
      return { kod: 500, veri: { hata: e.message } }
    }
    // giriş komutlarında şifre olur: loga yazma
    // komutlarda şifre/kod olabilir (/login, /giris, /cp, /2fa...): sadece komutun adı yazılır
    console.log(metin.startsWith('/') ? `[yaz] ${metin.split(' ')[0]} (komut gönderildi)` : `[yaz] ${gizle(metin)}`)
    return { kod: 200, veri: { cevap: 'gönderildi' } }
  }
  if (tip === 'soyle') {
    const metin = String(veri.metin || '').trim().slice(0, 500)
    console.log('[duydum]', metin)
    const cevap = brain.enabled ? await brain.ask(metin || 'merhaba') : anahtarsizCevap(metin || 'merhaba')
    console.log('[yaren]', cevap)
    return { kod: 200, veri: { cevap } }
  }
  return { kod: 404, veri: { hata: 'yok' } }
}

if (process.send) {
  process.on('message', async (m) => {
    if (!m || typeof m !== 'object') return
    let sonuc
    try {
      sonuc = await istekIsle(m.tip, m)
    } catch (e) {
      sonuc = { kod: 500, veri: { hata: e.message } }
    }
    try {
      process.send({ id: m.id, ...sonuc })
    } catch (_) {}
  })
  // Discord botu kapandıysa (ya da çöktüyse) sahipsiz bot oyunda kalmasın
  process.on('disconnect', () => process.exit(0))
}

const http = require('http')
const server = http.createServer((req, res) => {
  const cevapVer = (kod, veri) => {
    res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(veri))
  }
  if (req.method === 'GET' && ['/durum', '/envanter', '/istatistik'].includes(req.url)) {
    return istekIsle(req.url.slice(1)).then((s) => cevapVer(s.kod, s.veri))
  }
  if (req.method !== 'POST' || (req.url !== '/komut' && req.url !== '/soyle')) {
    return cevapVer(404, { hata: 'yok' })
  }
  // Tarayıcıda açık bir site de 127.0.0.1'e istek atabilir. JSON başlığı zorunlu
  // olunca tarayıcı önce izin sorar (CORS), izin çıkmaz ve istek hiç gelmez.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return cevapVer(415, { hata: 'Content-Type: application/json olmalı' })
  }
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 10000) req.destroy() // anlamsız büyük istek
  })
  req.on('end', async () => {
    let json
    try {
      json = JSON.parse(body)
    } catch (_) {
      return cevapVer(400, { hata: 'bozuk JSON' })
    }
    const s = await istekIsle(req.url.slice(1), json || {})
    cevapVer(s.kod, s.veri)
  })
})
server.on('error', (e) =>
  console.log(
    `[hata] Komut sunucusu açılamadı (port ${KOMUT_PORT}): ${e.message}. Başka bir gorevbot açık olabilir.`
  )
)
if (KOMUT_PORT) {
  server.listen(KOMUT_PORT, '127.0.0.1', () =>
    console.log(`Ses komut sunucusu: 127.0.0.1:${KOMUT_PORT}`)
  )
}

// ---------- GÖREV YÖNETİMİ ----------
// Görev döngüsü devam etsin mi? Durdurulunca ya da süresi dolunca false olur.
// Süre dolunca görev elindeki işi bitirip toparlanır (iskele, fidan); temizlik
// adımları "id === taskId" ile çalışmaya devam eder.
function calisiyor(id) {
  if (id !== taskId) return false
  return !(gorev && gorev.id === id && gorev.bitis && Date.now() >= gorev.bitis)
}

// Görev kendi bitiş nedenini söyler (deneyim defteri ve yapay zeka bunu görür)
function gorevNotu(id, msg) {
  if (gorev && gorev.id === id) gorev.not = msg
  say(msg)
}

function startTask(name, fn, dakika = 0, komutMetni = null) {
  stopTask()
  const id = ++taskId
  // komut: ölüp doğunca aynı işe (aynı ayarla, ör. "!maden elmas") dönmek için
  const g = { id, bitis: dakika > 0 ? Date.now() + dakika * 60000 : 0, not: '', zamanlayici: null, komut: komutMetni || '!' + name }
  gorev = g
  currentTask = name
  // topladıklarını sayabilmek ve en yakın sandığı bulabilmek için başlangıç
  gorevMerkezi = bot.entity ? bot.entity.position.clone() : null
  gorevBasiEnvanter = envanterSayim()
  olmayanSandik.clear()
  bilinenOtoSandiklar = gorevMerkezi && !sandiklar().length ? yakindakiSandiklar(gorevMerkezi) : []
  restoreMovements() // önceki görevin hareket ayarı (ör. kazmayan) taşınmasın
  if (g.bitis) {
    // Süre dolunca görev elindeki ağacı bitirip toparlanır ve kendisi durur.
    // 2 dakika içinde duramazsa (takıldıysa) zorla durdur.
    g.zamanlayici = setTimeout(() => {
      if (taskId !== id) return
      g.not = g.not || 'süre doldu'
      stopTask()
    }, dakika * 60000 + 120000)
  }
  const startedAt = Date.now()
  const before = { ...counters }
  let hata = null
  Promise.resolve()
    .then(() => fn(id))
    .then(() => teslimEt(id, name))
    .catch((e) => {
      hata = e
      // Müşteri odasına sadece mesaj gitsin; tam hata (sunucudaki dosya yollarıyla) satıcıya
      console.log('[hata] Görev hatası:', e.message || e)
      console.error('[satıcı] Görev hatası:', e && e.stack)
    })
    .finally(() => {
      clearTimeout(g.zamanlayici)
      const natural = id === taskId
      if (natural) {
        if (!g.not && g.bitis && Date.now() >= g.bitis) g.not = 'süre doldu'
        currentTask = null
        gorev = null
        restoreMovements()
        say(`${name} görevi bitti.`)
      }
      onTaskEnd({ name, natural, hata, startedAt, before, not: g.not })
    })
  return `${name} görevi başladı${dakika ? ` (${dakika} dk)` : ''}.${sandikNotu(name)}`
}

function stopTask() {
  if (currentTask) console.log(`[görev] ${currentTask} durduruldu`)
  taskId++ // eski görev döngüsü id uyuşmazlığı görüp çıkar
  currentTask = null
  gorev = null
  if (!hazir) return
  bot.pathfinder.setGoal(null)
  bot.stopDigging() // yarım kalan kazmayı da bırak
  restoreMovements()
}

// ---------- ALETLER ----------
const MATERIALS = ['netherite', 'diamond', 'iron', 'copper', 'stone', 'golden', 'wooden']
const ALET_TURLERI = ['axe', 'pickaxe', 'shovel', 'hoe', 'sword']
const ALET_ADI = { axe: 'balta', pickaxe: 'kazma', shovel: 'kürek', hoe: 'çapa', sword: 'kılıç' }
const ALET_ESIK = 10 // kalan dayanıklılık bunun altındaysa alet "kırılmak üzere"

const aletTuru = (item) => ALET_TURLERI.find((k) => item.name.endsWith('_' + k)) || null
const kalanDayaniklilik = (item) =>
  item.maxDurability ? item.maxDurability - (item.durabilityUsed || 0) : Infinity
const kirilmakUzere = (item) => kalanDayaniklilik(item) < ALET_ESIK
function buyuluMu(item) {
  try {
    return (item.enchants || []).length > 0
  } catch (_) {
    return false
  }
}

// İyi malzeme önce; aynı malzemede dayanıklılığı çok olan önce. Listede
// olmayan (ör. modlu) aletler en sona.
function aletSirasi(a, b) {
  const rank = (item) => {
    const r = MATERIALS.findIndex((m) => item.name.startsWith(m + '_'))
    return r === -1 ? MATERIALS.length : r
  }
  return rank(a) - rank(b) || kalanDayaniklilik(b) - kalanDayaniklilik(a)
}

// İstenen türde, kırılmak üzere olmayan en iyi alet
function iyiAlet(kind, items = bot.inventory.items()) {
  return items.filter((i) => aletTuru(i) === kind && !kirilmakUzere(i)).sort(aletSirasi)[0] || null
}

// Aynı uyarıyı sohbete dakikada bir yağdırmasın
const uyarilar = new Map()
function uyar(anahtar, mesaj, ms = 10 * 60000) {
  const t = uyarilar.get(anahtar)
  if (t && Date.now() - t < ms) return
  uyarilar.set(anahtar, Date.now())
  say(mesaj)
}

const sandiktaYok = new Map() // alet türü -> sandıklarda en son bulunamadığı zaman

// Aleti eline alır. Elindeki kırılmak üzereyse envanterdeki sağlamına geçer,
// envanterde yoksa belirlenen sandıklardan alır. Hiç yoksa elle devam eder.
// Döner: true = alet elde, false = elle (aletsiz)
const ALET_YAPILIR = new Set(['pickaxe', 'axe'])
const yapilamadi = new Map() // alet türü -> son yapılamadığı zaman (her blokta denemesin)

async function equipTool(kind, { sandiktan = true } = {}) {
  await yemekGerekirse() // görevin arasında, aleti almadan önce
  const ad = ALET_ADI[kind] || kind
  let alet = iyiAlet(kind)
  if (
    !alet &&
    sandiktan &&
    sandiklar().length &&
    Date.now() - (sandiktaYok.get(kind) || 0) > 5 * 60000
  ) {
    console.log(`[alet] sağlam ${ad} yok, sandıklara bakıyorum`)
    await sandikZiyareti(taskId, { alet: kind })
    alet = iyiAlet(kind)
    if (!alet) sandiktaYok.set(kind, Date.now())
  }
  // hâlâ yoksa üstündeki en değerli malzemeden kendisi yapar (ham demiri eritip de)
  if (!alet && sandiktan && ALET_YAPILIR.has(kind) && Date.now() - (yapilamadi.get(kind) || 0) > 5 * 60000) {
    console.log(`[alet] sağlam ${ad} yok, kendim yapmayı deniyorum`)
    const r = await zanaat.aletYap(kind)
    alet = iyiAlet(kind)
    if (r.ok && alet) say(`Kendime yeni ${ad} yaptım (${alet.name}).`)
    else {
      yapilamadi.set(kind, Date.now())
      console.log(`[alet] ${ad} yapamadım: ${r.neden || 'bilinmiyor'}`)
    }
  }
  if (!alet) {
    const hepsi = bot.inventory.items().filter((i) => aletTuru(i) === kind).sort(aletSirasi)
    // yedek yok: kırılmak üzere olanı kullan; büyülüyse kırılıp gitmesin diye kullanma
    alet = hepsi.find((i) => !buyuluMu(i)) || null
    if (alet) {
      uyar(`alet-${kind}`, `Elimdeki ${ad} kırılmak üzere ve sağlam ${ad} bulamadım. Envanterime ya da sandığa yeni ${ad} koy.`)
    } else if (hepsi.length) {
      uyar(`alet-${kind}`, `Büyülü ${ad} kırılmak üzere, kırılmasın diye kullanmıyorum. Yeni ${ad} ver.`)
    }
  }
  if (!alet) {
    await eliBosalt()
    return false
  }
  if (bot.heldItem?.slot !== alet.slot) await bot.equip(alet, 'hand')
  return true
}

// "Elle" kırmak için elde alet olmasın (ör. yaprakta balta boşuna aşınmasın).
// bot.unequip('hand') envanterde boş yer yoksa elindekini YERE ATAR; onun
// yerine boş ya da aletsiz bir hotbar yuvasına geçeriz, hiçbir şey atılmaz.
async function eliBosalt() {
  await yemekGerekirse()
  const el = bot.heldItem
  if (!el || !el.maxDurability) return // zaten aletsiz
  const hotbar = bot.inventory.slots.slice(36, 45)
  let i = hotbar.findIndex((it) => !it)
  if (i === -1) i = hotbar.findIndex((it) => it && !it.maxDurability)
  if (i !== -1) return bot.setQuickBarSlot(i)
  const aletsiz = bot.inventory.items().find((it) => !it.maxDurability)
  if (aletsiz) await bot.equip(aletsiz, 'hand')
}

// ---------- SANDIKLAR ----------
// Sahibin gösterdiği sandıklar (sunucu başına ayrı): !sandik ekle / sil / liste / temizle.
// Envanter yarı dolunca topladıklarını buraya bırakır; sağlam alet de buradan alır.
const SANDIK_DOSYA = path.join(VERI_DIR, 'sandiklar.json')
const SUNUCU = `${HOST}:${PORT}`
const SANDIK_TURLERI = new Set(['chest', 'trapped_chest', 'barrel'])
const MAX_SANDIK = 10
const ENVANTER_YUVA = 36
const YARI_DOLU = Math.ceil(ENVANTER_YUVA * 0.5) // bu kadar yuva dolunca sandığa boşalt
const konumYaz = (p) => `${p.x} ${p.y} ${p.z}`

let sandikKaydi = {}
try {
  const k = JSON.parse(fs.readFileSync(SANDIK_DOSYA, 'utf-8'))
  if (k && typeof k === 'object' && !Array.isArray(k)) sandikKaydi = k
} catch (_) {} // dosya yoksa sandık yok

const sandiklar = () =>
  (Array.isArray(sandikKaydi[SUNUCU]) ? sandikKaydi[SUNUCU] : []).map((p) => new Vec3(p.x, p.y, p.z))

function sandiklariKaydet(liste) {
  sandikKaydi[SUNUCU] = liste.map((p) => ({ x: p.x, y: p.y, z: p.z }))
  try {
    fs.writeFileSync(SANDIK_DOSYA, JSON.stringify(sandikKaydi, null, 2), 'utf-8')
  } catch (e) {
    console.log('[hata] sandıklar kaydedilemedi:', e.message)
  }
  sandiktaYok.clear() // yeni sandıkta alet olabilir
}

// Sahibin dibindeki (5 blok) sandık; liste verilirse sadece onlardan seçer
function sahibeEnYakinSandik(liste = null) {
  const sahip = sahipOyuncu()?.entity
  if (!sahip) return null
  const adaylar =
    liste || bot.findBlocks({ matching: (b) => SANDIK_TURLERI.has(b.name), maxDistance: 32, count: 64 })
  return (
    adaylar
      .filter((p) => p.distanceTo(sahip.position) <= 5)
      .sort((a, b) => a.distanceTo(sahip.position) - b.distanceTo(sahip.position))[0] || null
  )
}

function sandikKomutu([islem = 'liste', ...sayilar]) {
  const liste = sandiklar()
  const koordinat = () => {
    if (sayilar.length === 0) return null
    const [x, y, z] = sayilar.map(Number)
    if (sayilar.length !== 3 || ![x, y, z].every(Number.isInteger)) return 'hata'
    return new Vec3(x, y, z)
  }
  if (islem === 'liste') {
    return liste.length
      ? `Sandıklarım (${liste.length}): ${liste.map(konumYaz).join(', ')}`
      : 'Hiç sandık göstermedin. Sandığın dibinde dur ve !sandik ekle yaz.'
  }
  if (islem === 'temizle') {
    sandiklariKaydet([])
    return 'Bütün sandıkları unuttum.'
  }
  if (islem === 'ekle') {
    let p = koordinat()
    if (p === 'hata') return 'Koordinatı şöyle yaz: !sandik ekle x y z'
    if (!p) {
      if (!OWNER) return SAHIPSIZ + ' Ya da sandığın koordinatını yaz.'
      p = sahibeEnYakinSandik()
      if (!p) return 'Yanında sandık göremiyorum. Sandığın dibinde dur ya da !sandik ekle x y z yaz.'
    } else {
      const b = bot.blockAt(p)
      if (b && !SANDIK_TURLERI.has(b.name)) return `${konumYaz(p)} konumunda sandık yok (${b.name}).`
    }
    // çift sandığın diğer yarısı da aynı sandık sayılır
    if (liste.some((q) => q.distanceTo(p) < 1.5)) return `${konumYaz(p)} zaten listemde.`
    if (liste.length >= MAX_SANDIK) return `En fazla ${MAX_SANDIK} sandık gösterebilirsin.`
    sandiklariKaydet([...liste, p])
    return `Sandık eklendi: ${konumYaz(p)}. Topladıklarımı buraya bırakacağım.`
  }
  if (islem === 'sil') {
    let p = koordinat()
    if (p === 'hata') return 'Koordinatı şöyle yaz: !sandik sil x y z'
    if (!p && !OWNER) return SAHIPSIZ + ' Ya da sandığın koordinatını yaz.'
    if (!p) p = sahibeEnYakinSandik(liste)
    const kalan = p ? liste.filter((q) => q.distanceTo(p) >= 1.5) : liste
    if (kalan.length === liste.length) return 'Silinecek sandığı bulamadım (dibinde dur ya da koordinat yaz).'
    sandiklariKaydet(kalan)
    return `Sandık silindi: ${konumYaz(p)}.`
  }
  return 'Kullanım: !sandik ekle | sil | liste | temizle (istersen sonuna x y z)'
}

// Sandığa bırakılmayıp yanında kalanlar (işine lazım olanlar), türü başına adet
const TOHUMLAR = new Set(['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato', 'nether_wart'])
function tutulacak(ad) {
  if (ad.endsWith('_sapling') || ad === 'mangrove_propagule') return 16 // yeniden dikmek için
  if (TOHUMLAR.has(ad)) return 32 // tarlayı yeniden ekmek için
  if (SCAFFOLD.has(ad)) return 32 // yüksek kütüklere çıkmak için iskele
  if (bot.registry.foodsByName?.[ad]) return 16
  return 0
}

// Neyi bırakacağız: her türün fazlası. Aletlerden sağlam en iyi ikisi kalır;
// kırılmak üzere olanlar (sağlamı varsa) tamir edilsin diye sandığa gider.
// Alet olmayan dayanıklı eşyalara (zırh, yay, olta...) dokunulmaz.
// sinir (ad -> adet) verilirse her türden en fazla o kadar bırakılır ve aletler hiç
// bırakılmaz (en yakın sandığa sadece toplananlar gider).
function birakmaPlani(items, sinir = null) {
  const plan = []
  const yigin = new Map() // ad -> { type, toplam }
  const aletler = new Map() // tür -> [item]
  for (const it of items) {
    const tur = aletTuru(it)
    if (tur) aletler.set(tur, [...(aletler.get(tur) || []), it])
    else if (!it.maxDurability) {
      const y = yigin.get(it.name) || { ad: it.name, type: it.type, toplam: 0 }
      y.toplam += it.count
      yigin.set(it.name, y)
    }
  }
  for (const y of yigin.values()) {
    let fazla = y.toplam - tutulacak(y.ad)
    if (sinir) fazla = Math.min(fazla, sinir.get(y.ad) || 0)
    if (fazla > 0) plan.push({ ad: y.ad, type: y.type, adet: fazla })
  }
  if (sinir) return plan
  for (const liste of aletler.values()) {
    const saglam = liste.filter((i) => !kirilmakUzere(i)).sort(aletSirasi)
    for (const i of saglam.slice(2)) plan.push({ ad: i.name, slot: i.slot, adet: 1 })
    if (saglam.length) for (const i of liste.filter(kirilmakUzere)) plan.push({ ad: i.name, slot: i.slot, adet: 1 })
  }
  return plan
}

// Belli bir yuvadaki eşyayı (ör. tam o balta) taşır: tıkla al, boş yuvaya bırak
async function slotTasi(pencere, kaynak, bas, son) {
  const hedef = pencere.firstEmptySlotRange(bas, son)
  if (hedef === null) throw new Error('hedef dolu')
  await bot.clickWindow(kaynak, 0, 0)
  await bot.clickWindow(hedef, 0, 0)
}

async function sandigaBirak(pencere, sinir = null) {
  let birakilan = 0
  for (const p of birakmaPlani(pencere.items(), sinir)) {
    try {
      if (p.slot != null) await slotTasi(pencere, p.slot, 0, pencere.inventoryStart)
      else await pencere.deposit(p.type, null, p.adet)
      birakilan += p.adet
      istatistikEkle('birakilan', p.ad, p.adet)
    } catch (e) {
      if (/full|dolu/i.test(e.message)) return { birakilan, dolu: true }
      console.log(`[sandık] ${p.ad} bırakılamadı: ${e.message}`)
    }
  }
  return { birakilan, dolu: false }
}

function sureli(soz, ms, mesaj) {
  let t
  return Promise.race([
    soz,
    new Promise((_, reddet) => (t = setTimeout(() => reddet(new Error(mesaj)), ms))),
  ]).finally(() => clearTimeout(t))
}

let sandikta = false // aynı anda iki sandık ziyareti olmasın

// Sandıklara (yakından uzağa) gider: fazlaları bırakır, istenirse sağlam alet alır,
// sonra işin olduğu yere döner. Sandık gösterilmediyse en yakın sandığa sadece bu
// görevde topladıklarını bırakır (hepsi: !bosalt ile açıkça istenince fazlaların hepsi).
// Alet sadece gösterilen sandıklardan alınır.
async function sandikZiyareti(id, { alet = null, don = true, hepsi = false } = {}) {
  const sonuc = { birakilan: 0, alindi: false, ulasilan: 0, dolu: 0, yer: null }
  if (sandikta || !hazir) return sonuc
  sandikta = true
  const donus = bot.entity.position.clone()
  const hedef = alet ? { liste: sandiklar().sort(yakindanUzaga), oto: false } : birakmaHedefi()
  // en yakın sandığa aletler hiç gitmez; !bosalt ile istenmediyse sadece bu görevde toplananlar
  const sinir = () => (hedef.oto ? (hepsi ? envanterSayim() : toplananlar()) : null)
  const olmadi = (pos) => hedef.oto && olmayanSandik.add(key(pos)) // en yakındaki olmadı: sıradakini dene
  // başkasının evindeki sandığa giderken duvar kırmasın, blok koymasın
  if (hedef.oto) bot.pathfinder.setMovements(cleanMovements())
  try {
    for (const pos of hedef.liste) {
      if (id !== taskId) break
      const aletLazim = alet && !iyiAlet(alet)
      if (!aletLazim && birakmaPlani(bot.inventory.items(), sinir()).length === 0) break
      try {
        await gotoTimeout(new goals.GoalGetToBlock(pos.x, pos.y, pos.z), 60000)
      } catch (_) {
        console.log(`[sandık] ${konumYaz(pos)} sandığına gidemedim`)
        olmadi(pos)
        continue
      }
      if (id !== taskId) break
      const blok = bot.blockAt(pos)
      if (!blok || !SANDIK_TURLERI.has(blok.name)) {
        console.log(`[sandık] ${konumYaz(pos)} konumunda sandık yok`)
        olmadi(pos)
        continue
      }
      let pencere
      try {
        pencere = await sureli(bot.openContainer(blok), 8000, 'sandık açılmadı')
      } catch (e) {
        console.log(`[sandık] ${konumYaz(pos)} açılamadı: ${e.message}`)
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        olmadi(pos)
        continue
      }
      sonuc.ulasilan++
      try {
        const b = await sandigaBirak(pencere, sinir())
        sonuc.birakilan += b.birakilan
        if (b.birakilan) sonuc.yer = pos
        if (b.dolu) {
          sonuc.dolu++
          olmadi(pos)
          console.log(`[sandık] ${konumYaz(pos)} doldu`)
        }
        if (aletLazim) {
          const bulunan = iyiAlet(alet, pencere.containerItems())
          if (bulunan) {
            await slotTasi(pencere, bulunan.slot, pencere.inventoryStart, pencere.inventoryEnd)
            sonuc.alindi = true
            console.log(`[alet] sandıktan ${bulunan.name} aldım (${kalanDayaniklilik(bulunan)} dayanıklılık)`)
            // sağlamı geldi: kırılmak üzere olan eskisi tamir için hemen buraya kalsın
            sonuc.birakilan += (await sandigaBirak(pencere)).birakilan
          }
        }
      } catch (e) {
        console.log(`[sandık] hata: ${e.message}`)
      } finally {
        try {
          pencere.close()
        } catch (_) {}
      }
    }
  } finally {
    sandikta = false
  }
  if (sonuc.birakilan) {
    // koordinat oyun sohbetine yazılmaz (herkes görür), sadece müşterinin odasına gider
    if (hedef.oto) console.log(`[sandık] En yakın sandık: ${konumYaz(sonuc.yer)}`)
    say(`Sandığa ${sonuc.birakilan} eşya bıraktım.`)
  }
  if (sonuc.dolu && sonuc.dolu === sonuc.ulasilan) {
    uyar('sandik-dolu', hedef.oto ? 'Yakındaki sandık doldu. Boş bir sandık göster: dibinde dur, !sandik ekle.' : 'Sandıklarım doldu, yeni sandık göster (!sandik ekle).')
  }
  tabanGuncelle()
  // işin olduğu yere dön (en yakın sandıktan dönerken de duvar kırmasın)
  try {
    if (don && id === taskId && bot.entity.position.distanceTo(donus) > 3) {
      await gotoTimeout(new goals.GoalNear(donus.x, donus.y, donus.z, 2), 60000).catch(() => {})
    }
  } finally {
    if (hedef.oto) restoreMovements()
  }
  return sonuc
}

let bosaltmaEsigi = YARI_DOLU
const doluYuva = () => ENVANTER_YUVA - bot.inventory.emptySlotCount()

let teslimBekle = 0 // sandığa bırakamadıysa bir süre tekrar denemesin

// Bir yığın topladıysa ya da envanter yarı dolduysa sandığa götürür (görev döngülerinin başında).
// En yakın (gösterilmemiş) sandığa sadece topladıklarını götürdüğü için orada yarı dolu
// envanter sayılmaz: yarısı kendi eşyasıysa birkaç fidan için yürümesin.
async function gerekirseBosalt(id) {
  if (gorev && gorev.id === id && gorev.uzakTeslim) return // derin madende her yığında yukarı çıkmasın (dolunca / bitince götürür)
  const yariDolu = doluYuva() >= bosaltmaEsigi
  const yigin = toplananAdet() >= TESLIM_ADET && Date.now() >= teslimBekle
  if (!yariDolu && !yigin) return
  const hedef = birakmaHedefi()
  if (!hedef.liste.length) {
    if (yariDolu) {
      uyar(
        'sandik-yok',
        'Envanterim yarı doldu ve yakında sandık yok. Sandık gösterirsen (dibinde dur, !sandik ekle) topladıklarımı oraya götürürüm, yoksa dolunca dururum.',
        30 * 60000
      )
    }
    return
  }
  if (!hedef.oto || yigin) {
    const r = await sandikZiyareti(id)
    if (!r.birakilan) teslimBekle = Date.now() + 3 * 60000 // ulaşamadı / doldu: her turda yürümesin
  }
  // yanımda kalması gerekenler yüzünden hâlâ yarıdan fazlaysa her turda sandığa gitmesin
  bosaltmaEsigi = Math.max(YARI_DOLU, doluYuva() + 6)
}

// Envanter tamamen doluysa sandığa boşaltmayı dener. Yer açılmazsa nedeni döner.
async function yerAc(id) {
  if (bot.inventory.emptySlotCount() > 0) return null
  const hedef = birakmaHedefi()
  if (!hedef.liste.length) return 'Envanterim doldu ve yakında sandık yok, duruyorum. (Sandık gösterirsen oraya boşaltırım: !sandik ekle)'
  await sandikZiyareti(id)
  if (bot.inventory.emptySlotCount() > 0) return null
  return hedef.oto ? 'Envanterim doldu, yakındaki sandıklara da bırakamadım; duruyorum.' : 'Envanterim de sandıklarım da doldu, duruyorum.'
}

// Görev kendiliğinden bitince (süre doldu, yakında kalmadı) topladıklarını sandığa
// götürür. Durdurulunca (!dur, yeni görev) götürmez.
async function teslimEt(id, ad) {
  if (id !== taskId || !hazir || !TOPLAMA_GOREVLERI.has(ad)) return
  if (toplananAdet() === 0 || !birakmaHedefi().liste.length) return
  console.log('[sandık] Görev bitti, topladıklarımı sandığa götürüyorum.')
  await sandikZiyareti(id, { don: false })
}

// ---------- EN YAKIN SANDIK ----------
// Sandık gösterilmediyse topladıklarını görevin başladığı yere en yakın sandığa götürür.
// Bu sandık kaydedilmez: başka yerde verilen görevde oradaki en yakın sandık kullanılır.
// Oraya sadece o görevde topladıklarını bırakır (yanında getirdiklerine ve aletlerine
// dokunmaz) ve oradan alet almaz: başkasının sandığı olabilir.
const OTO_SANDIK_MESAFE = 32
const TESLIM_ADET = 64 // bu kadar topladıysa (bir yığın) sandığa götürür
let gorevMerkezi = null // görevin başladığı yer
let gorevBasiEnvanter = new Map() // görev başındaki eşyalar (ad -> adet); toplananlar bunun üstü
let bilinenOtoSandiklar = [] // görev başında görülen yakın sandıklar (uzaklaşınca da hatırlansın)
const olmayanSandik = new Set() // bu görevde ulaşılamayan, açılmayan ya da dolan sandıklar
const yakindanUzaga = (a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)

function envanterSayim() {
  const m = new Map()
  for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) || 0) + it.count)
  return m
}
// Eşya azaldıysa (sandığa bıraktı, yedi, iskele koydu) taban da iner: sonra
// toplananlar yine sayılsın
function tabanGuncelle() {
  const simdi = envanterSayim()
  for (const [ad, n] of gorevBasiEnvanter) if ((simdi.get(ad) || 0) < n) gorevBasiEnvanter.set(ad, simdi.get(ad) || 0)
  return simdi
}
// Bu görevde toplananlar: ad -> adet
function toplananlar() {
  const m = new Map()
  for (const [ad, n] of tabanGuncelle()) {
    const fark = n - (gorevBasiEnvanter.get(ad) || 0)
    if (fark > 0) m.set(ad, fark)
  }
  return m
}
const toplananAdet = () => birakmaPlani(bot.inventory.items(), toplananlar()).reduce((t, p) => t + p.adet, 0)

const OTO_SANDIK_TURLERI = ['chest', 'barrel'] // tuzaklı sandık (redstone tetikler) hariç
function yakindakiSandiklar(merkez) {
  const idler = OTO_SANDIK_TURLERI.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
  return bot.findBlocks({ matching: idler, maxDistance: OTO_SANDIK_MESAFE, count: 32, point: merkez })
}
// Görevin başladığı yere en yakın sandıklar (olmadığı görülenler hariç)
function otoSandiklar(merkez = gorevMerkezi || bot.entity.position) {
  const hepsi = new Map()
  for (const p of [...bilinenOtoSandiklar, ...yakindakiSandiklar(merkez), ...yakindakiSandiklar(bot.entity.position)]) {
    hepsi.set(key(p), p)
  }
  // bot uzaklaşınca başladığı yerin parçaları yüklü olmayabilir: etrafına da bakılır ama
  // sadece başladığı yere 32 blok içindekiler (uzaktaki köy / başkasının evi değil)
  return [...hepsi.values()]
    .filter((p) => !olmayanSandik.has(key(p)) && p.distanceTo(merkez) <= OTO_SANDIK_MESAFE + 1)
    .sort((a, b) => a.distanceTo(merkez) - b.distanceTo(merkez))
    .slice(0, 6)
}
// Topladıklarını nereye bırakacak: gösterilen sandıklar, hiç yoksa en yakın sandık
function birakmaHedefi() {
  const kayitli = sandiklar()
  if (kayitli.length) return { liste: kayitli.sort(yakindanUzaga), oto: false }
  return { liste: otoSandiklar(), oto: true }
}
// Görev başlarken söylenecek: topladıkları nereye gidecek
function sandikNotu(ad) {
  if (!TOPLAMA_GOREVLERI.has(ad)) return ''
  if (sandiklar().length) return ' Topladıklarımı sandığa götüreceğim.'
  const p = otoSandiklar()[0]
  if (!p) return ' Yakında sandık yok, topladıklarım yanımda kalacak.'
  console.log(`[sandık] En yakın sandık: ${konumYaz(p)}`) // koordinat oyun sohbetine yazılmaz
  return ' Topladıklarımı en yakın sandığa götüreceğim.'
}

// ---------- YERDEKİ EŞYALARI TOPLA ----------
async function collectDrops(id, range = 8, maxItems = 12) {
  const ignore = new Set()
  // görev durdurulunca toplamayı bırak (yoksa !gel'in yolunu ele geçirir)
  for (let i = 0; i < maxItems && id === taskId; i++) {
    const drops = Object.values(bot.entities)
      .filter(
        (e) =>
          (e.name === 'item' || e.displayName === 'Item') &&
          !ignore.has(e.id) &&
          e.position.distanceTo(bot.entity.position) < range
      )
      .sort(
        (a, b) =>
          a.position.distanceTo(bot.entity.position) -
          b.position.distanceTo(bot.entity.position)
      )
    if (drops.length === 0) return
    const d = drops[0]
    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.5)
      )
    } catch (_) {
      ignore.add(d.id) // ulaşılamayanı bir daha deneme
    }
    await sleep(200)
    if (bot.entities[d.id]) ignore.add(d.id) // hâlâ yerdeyse (alınamadı) atla
  }
}

// ---------- GENEL BLOK KIRMA GÖREVİ ----------
async function gatherTask(id, { matchFn, toolKind, aletYok, label, maxCount = 200, afterDig }) {
  const skipped = new Set() // ulaşılamayan blokları tekrar deneme
  let count = 0

  while (calisiyor(id) && count < maxCount) {
    const dolu = await yerAc(id)
    if (dolu) return gorevNotu(id, dolu)
    await gerekirseBosalt(id)

    const ayak = bot.entity.position.floored()
    const positions = bot
      .findBlocks({
        matching: matchFn,
        maxDistance: SEARCH_RADIUS,
        count: 20,
      })
      // tam ayağının altındakini kazmaz: altı boşluk / mağara olabilir, düşer
      .filter((p) => !skipped.has(key(p)) && !(p.x === ayak.x && p.z === ayak.z && p.y < ayak.y))

    if (positions.length === 0) {
      gorevNotu(id, `Yakında ${label} kalmadı.`)
      return
    }

    // en yakın olanı seç
    positions.sort(
      (a, b) =>
        a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
    )
    const pos = positions[0]

    try {
      await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3))
      if (id !== taskId) return
      if (toolKind && !(await equipTool(toolKind))) {
        // alet kırıldı: elle kırmak hem çok yavaş hem de taşta hiçbir şey düşürmez
        gorevNotu(id, aletYok || `Elimde ${toolKind} kalmadı, duruyorum.`)
        return
      }
      const block = bot.blockAt(pos)
      if (!block || !matchFn(block)) continue
      if (!bot.canDigBlock(block)) {
        skipped.add(key(pos))
        continue
      }
      await kaz(block)
      count++
      if (count % 5 === 0) console.log(`[${label}] ${count} blok kırıldı (son: ${block.name})`)
      await collectDrops(id)
      if (afterDig) await afterDig()
    } catch (e) {
      skipped.add(key(pos))
    }
  }
}

// ---------- ODUN ----------
// Pathfinder yükselirken yere blok (toprak vb.) koyar. Bunları takip edip
// işimiz bitince geri kırıyoruz.
const SCAFFOLD = new Set(['dirt', 'cobblestone', 'netherrack'])
const placed = new Map() // "x,y,z" -> Vec3
let normalMovements = null
let woodMovements = null   // odun görevinde kullanılır: yoldaki yaprakları kırmaz
const CLEAN_LEAVES = true // ağaç bitince yapraklarını elle kırar (false: dokunmaz, kendileri dökülür)

// Hangi görev çalışıyorsa onun hareket ayarına dön
function restoreMovements() {
  if (!normalMovements) return // henüz doğmadı
  bot.pathfinder.setMovements(currentTask === 'odun' ? woodMovements : normalMovements)
}

const isLog = (b) => b.name.endsWith('_log')
const isLeaves = (b) => b.name.endsWith('_leaves')

// Odun görevi sırasında, botun yakınında boşluğa konan iskele bloklarını kaydet
bot.on('blockUpdate', (oldBlock, newBlock) => {
  if (currentTask !== 'odun' || !oldBlock || !newBlock) return
  if (!SCAFFOLD.has(newBlock.name)) return
  if (oldBlock.boundingBox !== 'empty') return
  if (newBlock.position.distanceTo(bot.entity.position) > 6) return
  placed.set(key(newBlock.position), newBlock.position.clone())
})

// Temizlik sırasında blok koymayan / kırmayan hareket ayarı
function cleanMovements() {
  const m = new Movements(bot)
  m.scafoldingBlocks = []
  m.canDig = false
  return m
}

// Kulenin tepesindeyse ayağının altındaki blokları kırarak iner
async function cleanBelow(id) {
  let n = 0
  for (let i = 0; i < 40 && id === taskId; i++) {
    const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
    if (!below || !placed.has(key(below.position)) || !SCAFFOLD.has(below.name)) break
    try {
      await equipTool('shovel', { sandiktan: false }) // kürek yoksa elle
      await kaz(below)
    } catch (_) {
      break
    }
    placed.delete(key(below.position))
    n++
    await sleep(400) // bir blok düşmesini bekle
  }
  if (n > 0) console.log(`[temizlik] kuleden inerken ${n} blok kırıldı`)
}

// Yerde kalan iskele blokları
async function cleanLeftovers(id) {
  if (placed.size === 0) return
  let n = 0
  bot.pathfinder.setMovements(cleanMovements())
  try {
    for (const pos of [...placed.values()]) {
      if (id !== taskId) break
      placed.delete(key(pos))
      const b = bot.blockAt(pos)
      if (!b || !SCAFFOLD.has(b.name)) continue
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3))
        if (bot.canDigBlock(b)) {
          await equipTool('shovel', { sandiktan: false })
          await kaz(b)
          n++
        }
      } catch (_) {}
    }
  } finally {
    restoreMovements()
  }
  if (n > 0) console.log(`[temizlik] ${n} iskele bloğu toplandı`)
  await collectDrops(id)
}

// Kesilen ağacın yapraklarını ELLE kırar (balta yaprakta boşuna aşınmasın).
// Fidan, elma, çubuk düşer ve toplanır. Sadece bu ağacın doğal yaprakları:
// oyuncunun koyduğu yapraklara (çit, süs) ve yandaki ağaçlara dokunmaz.
// Uzanamadığı yüksek yapraklar kendiliğinden dökülür.
async function cleanLeaves(id, kutukler) {
  if (!kutukler || !kutukler.length) return
  const yakin = (p) => kutukler.some((k) => k.distanceTo(p) <= 4.5)
  const dogalYaprak = (b) => isLeaves(b) && String(b.getProperties().persistent) !== 'true'
  const skipped = new Set()
  const sonZaman = Date.now() + 60000 // bir ağacın yapraklarına en fazla 1 dakika
  let n = 0
  bot.pathfinder.setMovements(cleanMovements())
  try {
    while (id === taskId && n < 60 && Date.now() < sonZaman) {
      const leaves = bot
        .findBlocks({ matching: dogalYaprak, maxDistance: 12, count: 150 })
        .filter((p) => !skipped.has(key(p)) && yakin(p))
      if (leaves.length === 0) break
      leaves.sort(
        (a, b) =>
          a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
      )
      const pos = leaves[0]
      try {
        // uzanabiliyorsa yürümeden kır
        if (!bot.canDigBlock(bot.blockAt(pos))) {
          await gotoTimeout(new goals.GoalNear(pos.x, pos.y, pos.z, 3), 10000)
        }
        const b = bot.blockAt(pos)
        if (b && dogalYaprak(b) && bot.canDigBlock(b)) {
          await eliBosalt()
          await kaz(b)
          n++
        } else {
          skipped.add(key(pos))
        }
      } catch (_) {
        skipped.add(key(pos))
      }
    }
  } finally {
    restoreMovements()
  }
  if (n > 0) console.log(`[temizlik] ${n} yaprak elle kırıldı`)
  await collectDrops(id, 12, 30) // fidan, elma, çubuk
}

// Ağaç bitince temizle
async function treeCleanup(id, kutukler) {
  await cleanBelow(id)
  if (CLEAN_LEAVES) await cleanLeaves(id, kutukler)
  await collectDrops(id, 14, 12) // kütük, fidan, elma, çubuk
  await plantSaplings(id)
}

// ---------- İNSAN GİBİ AĞAÇ ARAMA ----------
const VIEW_RANGE = 28 // en fazla bu kadar uzaktaki ağacı "görür"
const LEASH = 120     // başladığı yerden bu kadar uzaklaşınca geri döner
const SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt'])
const plantSpots = new Map() // kesilen ağacın dip noktaları (fidan dikilecek yerler)
let heading = 0              // gezinme yönü (radyan)

const isTreeLog = (b) => isLog(b) && !b.name.startsWith('stripped_')

// Göz hizasından bloğun ortasına giden ışın önce o bloğa mı çarpıyor (önü açık mı).
// mineflayer'ın canSeeBlock'u ışını bloğun köşesine kadar uzatır: +x/+z yönündeki
// bloklarda ışın yüzeye ulaşmadan biter ve açıktaki ağaç "görünmüyor" sayılırdı.
function gorunuyor(b) {
  const goz = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const yon = b.position.offset(0.5, 0.5, 0.5).minus(goz)
  const uzunluk = yon.norm() // normalize() vektörü yerinde değiştirir: önce uzunluk
  const carpan = bot.world.raycast(goz, yon.normalize(), uzunluk + 1)
  return !!carpan && carpan.position.equals(b.position)
}

// Sadece göz hizasından doğrudan görebildiği (önünde engel olmayan) kütükleri bulur.
// Toprağın/duvarın arkasındakini görmez.
function findVisibleLog(skipped, structures) {
  const positions = bot
    .findBlocks({ matching: isTreeLog, maxDistance: VIEW_RANGE, count: 80 })
    .filter(
      (p) => !skipped.has(key(p)) && !(structures && structures.has(key(p)))
    )
  positions.sort(
    (a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
  )
  for (const pos of positions) {
    const b = bot.blockAt(pos)
    if (!b) continue
    // çok yakındakini (6 blok) her zaman görür, uzaktakini sadece önü açıksa
    const near = pos.distanceTo(bot.entity.position) < 6
    if (!near && !gorunuyor(b)) continue
    return b
  }
  return null
}

// Takılırsa vazgeçsin diye süreli yürüme (savaşta geçen süre sayılmaz)
function gotoTimeout(goal, ms) {
  return new Promise((resolve, reject) => {
    let gecen = 0
    const t = setInterval(() => {
      if (savas.savasta()) return
      gecen += 250
      if (gecen < ms) return
      clearInterval(t)
      bot.pathfinder.setGoal(null)
      reject(new Error('zaman aşımı'))
    }, 250)
    bot.pathfinder.goto(goal).then(
      () => {
        clearInterval(t)
        resolve()
      },
      (e) => {
        clearInterval(t)
        reject(e)
      }
    )
  })
}

// Gezdiği bölgeleri hatırlar (16x16'lık hücreler), az gezilen tarafa yürür
const CELL = 16
const visited = new Map() // "cx,cz" -> ziyaret puanı
let lastCellKey = null

function markVisited() {
  const p = bot.entity.position
  const cx = Math.floor(p.x / CELL)
  const cz = Math.floor(p.z / CELL)
  const ck = `${cx},${cz}`
  if (ck === lastCellKey) return // aynı hücrede durdukça puan artmasın
  lastCellKey = ck
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const k = `${cx + dx},${cz + dz}`
      visited.set(k, (visited.get(k) || 0) + (dx === 0 && dz === 0 ? 1 : 0.3))
    }
  }
}

async function explore(id, home) {
  if (id !== taskId) return // durdurulduysa yürümeye başlama
  const p = bot.entity.position
  const dist = 20
  let best = null
  for (let k = -3; k <= 4; k++) {
    const h = heading + (k * Math.PI) / 4
    const tx = p.x + Math.cos(h) * dist
    const tz = p.z + Math.sin(h) * dist
    const cx = Math.floor(tx / CELL)
    const cz = Math.floor(tz / CELL)
    let score = visited.get(`${cx},${cz}`) || 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      score += 0.5 * (visited.get(`${cx + dx},${cz + dz}`) || 0)
    }
    score += Math.abs(k) * 0.15 // düz gitmeyi biraz tercih et
    score += Math.random() * 0.3
    if (Math.hypot(tx - home.x, tz - home.z) > LEASH) score += 100
    if (!best || score < best.score) best = { score, h, tx, tz, cx, cz }
  }
  heading = best.h
  bot.pathfinder.setMovements(cleanMovements()) // yürürken blok koymasın/kazmasın
  try {
    await gotoTimeout(new goals.GoalNearXZ(best.tx, best.tz, 3), 20000)
  } catch (_) {
    // ulaşılamadı: o hücreyi kötü işaretle, yön değiştir
    const k = `${best.cx},${best.cz}`
    visited.set(k, (visited.get(k) || 0) + 3)
    heading += Math.PI / 2
  } finally {
    if (id === taskId) restoreMovements()
  }
}

async function cutLog(id, block, skipped) {
  try {
    const bp = block.position
    await bot.pathfinder.goto(new goals.GoalNear(bp.x, bp.y, bp.z, 3))
    if (id !== taskId) return false
    await equipTool('axe')
    const b = bot.blockAt(bp)
    if (!b || !isTreeLog(b)) return false
    if (!bot.canDigBlock(b)) {
      skipped.add(key(bp))
      return false
    }
    const below = bot.blockAt(bp.offset(0, -1, 0))
    if (below && SOIL.has(below.name)) {
      plantSpots.set(key(bp), { pos: bp.clone(), log: b.name })
    }
    await kaz(b)
    return true
  } catch (_) {
    skipped.add(key(block.position))
    return false
  }
}

// Tek fidanla büyümeyen ağaçlar (2x2 dikmek gerekir), tek başına dikme
const IKILI_FIDAN = new Set(['dark_oak_sapling', 'pale_oak_sapling'])

// Kesilen ağaca uygun fidanı seç (yoksa herhangi bir fidan)
function pickSapling(logName) {
  const species = logName.replace('_log', '')
  const exact = species === 'mangrove' ? 'mangrove_propagule' : `${species}_sapling`
  const items = bot.inventory.items()
  return (
    items.find((i) => i.name === exact && !IKILI_FIDAN.has(i.name)) ||
    items.find(
      (i) =>
        (i.name.endsWith('_sapling') || i.name === 'mangrove_propagule') &&
        !IKILI_FIDAN.has(i.name)
    )
  )
}

// Kesilen ağaçların dibine fidan dik
async function plantSaplings(id) {
  if (plantSpots.size === 0) return
  bot.pathfinder.setMovements(cleanMovements())
  let n = 0
  try {
    for (const [k, spot] of [...plantSpots]) {
      if (id !== taskId) return
      const sapling = pickSapling(spot.log)
      if (!sapling) return // fidan yok, yerler kalsın, sonra tekrar denenir
      plantSpots.delete(k)
      const here = bot.blockAt(spot.pos)
      const below = bot.blockAt(spot.pos.offset(0, -1, 0))
      if (!here || here.name !== 'air' || !below || !SOIL.has(below.name)) continue
      try {
        await bot.pathfinder.goto(new goals.GoalNear(spot.pos.x, spot.pos.y, spot.pos.z, 3))
        // tam üstünde duruyorsa biraz uzaklaş
        if (bot.entity.position.distanceTo(spot.pos.offset(0.5, 0, 0.5)) < 1.6) {
          await bot.pathfinder.goto(
            new goals.GoalNear(spot.pos.x + 2, spot.pos.y, spot.pos.z, 1)
          )
        }
        await bot.equip(sapling, 'hand')
        await bot.placeBlock(below, new Vec3(0, 1, 0))
        n++
      } catch (_) {}
    }
  } finally {
    if (id === taskId) restoreMovements()
    if (n > 0) console.log(`[fidan] ${n} fidan dikildi`)
  }
}

// Bir kütükten başlayıp birbirine değen tüm kütükleri (= bir ağaç) bulur
function collectTree(startPos, cap = 250) {
  const seen = new Set([key(startPos)])
  const queue = [startPos]
  const logs = []
  while (queue.length > 0) {
    const p = queue.shift()
    logs.push(p)
    if (logs.length >= cap) return { logs, capped: true }
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          const q = p.offset(dx, dy, dz)
          const k = key(q)
          if (seen.has(k)) continue
          seen.add(k)
          const b = bot.blockAt(q)
          if (b && isTreeLog(b)) queue.push(q)
        }
      }
    }
  }
  return { logs, capped: false }
}

// Gerçek ağaç mı, yoksa oyuncunun kütükten yaptığı bir şey mi (ev, çit direği)?
// Doğal yaprakların "persistent" özelliği false olur; oyuncunun koyduğu yaprak
// true olur, evin kütüklerinde ise hiç yaprak yoktur. Yaprağı dökülmüş küçük
// kütükler (yarım kalmış ağaç) toprağa basıyorsa yine kesilir.
function agacMi(logs) {
  for (const p of logs) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz))
          if (b && isLeaves(b) && String(b.getProperties().persistent) !== 'true') return true
        }
      }
    }
  }
  return logs.length <= 4 && logs.some((p) => SOIL.has(bot.blockAt(p.offset(0, -1, 0))?.name))
}

// Ağacın bütün kütüklerini aşağıdan yukarı keser, kaç tane kestiğini döndürür
async function cutTree(id, logs, skipped) {
  const order = [...logs].sort(
    (a, b) =>
      a.y - b.y ||
      a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
  )
  let cut = 0
  for (const pos of order) {
    if (id !== taskId) break
    const b = bot.blockAt(pos)
    if (!b || !isTreeLog(b)) continue
    if (await cutLog(id, b, skipped)) cut++
  }
  return cut
}

async function woodTask(id) {
  restoreMovements()
  placed.clear()
  plantSpots.clear()
  // önceki aramalarda gezilen yerleri hatırla (zamanla azalır: ağaçlar yeniden büyür)
  for (const [k, v] of visited) visited.set(k, v * 0.5)
  lastCellKey = null
  const home = bot.entity.position.clone()
  const skipped = new Set()    // bu bölgede ulaşılamayan kütükler
  const structures = new Set() // ağaç olmayan kütükler (ev, yapı), dokunma
  heading = Math.random() * Math.PI * 2
  let count = 0
  let misses = 0
  let errors = 0

  try {
    const first = findVisibleLog(skipped, structures)
    console.log(
      `[odun] başladı. Görünen ağaç: ${first ? 'var' : 'yok'}, boş slot: ${bot.inventory.emptySlotCount()}`
    )
  } catch (e) {
    console.log(`[hata] başlangıç kontrolü: ${e.message || e}`)
  }

  while (calisiyor(id)) {
    try {
      const dolu = await yerAc(id)
      if (dolu) {
        gorevNotu(id, dolu)
        break
      }
      await gerekirseBosalt(id)
      if (!calisiyor(id)) break

      markVisited()
      await collectDrops(id, 14, 12) // düşen fidan, elma, çubuk vb. otomatik topla
      if (!calisiyor(id)) break

      const target = findVisibleLog(skipped, structures)
      if (!target) {
        misses++
        if (misses === 1 || misses % 5 === 0) {
          console.log(`[odun] ağaç göremiyorum, yürüyorum (${misses}. deneme)`)
        }
        if (misses > 30) {
          gorevNotu(id, 'Etrafta ağaç bulamadım, duruyorum.')
          break
        }
        await explore(id, home)
        skipped.clear()
        continue
      }
      misses = 0

      const tree = collectTree(target.position)
      if (tree.capped) {
        // yüzlerce bitişik kütük: büyük ihtimalle ağaç değil, bir yapı
        tree.logs.forEach((p) => structures.add(key(p)))
        console.log('[odun] çok büyük kütük yığını gördüm, yapı sanıp atladım')
        continue
      }
      if (!agacMi(tree.logs)) {
        tree.logs.forEach((p) => structures.add(key(p)))
        console.log(
          `[odun] yapraksız kütük kümesi (${tree.logs.length} kütük), ev/yapı olabilir, dokunmadım`
        )
        continue
      }

      const cut = await cutTree(id, tree.logs, skipped)
      if (cut > 0) {
        count += cut
        console.log(`[odun] ağaç kesildi (${cut} kütük, toplam ${count})`)
        await collectDrops(id)
        await treeCleanup(id, tree.logs)
      } else {
        console.log(
          `[odun] ağaca ulaşamadım (${tree.logs.length} kütük, hiçbiri kesilemedi). Bota blok (dirt) verirsen yükselip ulaşabilir.`
        )
        tree.logs.forEach((p) => skipped.add(key(p))) // hiçbirini kesemedi, atla
      }
      errors = 0
    } catch (e) {
      errors++
      console.log(`[hata] odun döngüsü: ${e.message || e}`)
      if (errors >= 5) {
        gorevNotu(id, 'Üst üste hata aldım, duruyorum.')
        break
      }
      await sleep(1000)
    }
  }

  // Süre dolunca da buraya gelinir: iskeleyi topla, fidanları dik
  if (id === taskId) {
    try {
      await cleanBelow(id)
      await cleanLeftovers(id)
      await collectDrops(id, 14, 12)
      await plantSaplings(id)
    } catch (e) {
      console.log(`[hata] son temizlik: ${e.message || e}`)
    }
  }
}

// ---------- TAŞ ----------
async function stoneTask(id) {
  if (!(await equipTool('pickaxe'))) {
    gorevNotu(id, 'Kazma yok! Envanterime bir kazma ver.')
    return
  }
  return gatherTask(id, {
    // Sadece doğal taş. Cobblestone çoğu zaman oyuncunun yapısıdır (ev, duvar);
    // taşı kırınca zaten cobblestone düşer.
    matchFn: (b) => b.name === 'stone',
    toolKind: 'pickaxe',
    aletYok: 'Kazmam kırıldı, bana yeni bir kazma ver.',
    label: 'taş',
  })
}

// ---------- MADEN ----------
// Cevher kazar: kömür, demir, bakır, altın, kızıltaş, lapis, elmas, zümrüt (derin
// kayadakiler ve Nether cevherleri dahil). Önce açıkta (mağara duvarında) olanlar,
// sonra yakındakiler. Kazmasının yetmediğini (taş kazmayla elmas gibi) kazmaz, lavın
// dibindekine dokunmaz. Yakında cevher kalmazsa ayak ve baş hizasında düz bir tünel
// açarak ilerler (aşağı kuyu kazmaz); tünelde çıkan cevherleri kazar.
// tünel açarken kazdığı doğal bloklar (yapı blokları değil)
const MADEN_TASI = new Set([
  'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'netherrack', 'basalt', 'smooth_basalt',
  'blackstone', 'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'gravel', 'sand', 'red_sand',
  'sandstone', 'red_sandstone', 'clay', 'soul_sand', 'soul_soil',
])
const YONLER = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const YATAY = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
const MADEN_DIKEY = 16 // en fazla bu kadar aşağıdaki/yukarıdaki cevhere gider
const TUNEL_SINIRI = 64 // cevher bulamadan bu kadar ilerlerse bırakır
const cevherMi = (b) => !!b && (b.name.endsWith('_ore') || b.name === 'ancient_debris')
const komsular = (pos) => YONLER.map((d) => bot.blockAt(pos.plus(d)))
const lavYakin = (pos) => komsular(pos).some((b) => b && b.name === 'lava')
const acikta = (pos) => komsular(pos).some((b) => b && b.boundingBox === 'empty')
let cevherIdleri = null
let tunelYonu = 0

// Elindeki en iyi kazma bu bloğu kazabilir mi (kazamazsa hiçbir şey düşmez)
function kazmaYeter(b) {
  if (!b.harvestTools) return true
  const kazma = iyiAlet('pickaxe') || bot.inventory.items().find((i) => aletTuru(i) === 'pickaxe')
  return !!kazma && !!b.harvestTools[kazma.type]
}

function cevherBul(skipped, enFazla = null) {
  if (!cevherIdleri) {
    cevherIdleri = Object.values(bot.registry.blocksByName).filter((b) => cevherMi(b)).map((b) => b.id)
  }
  const ben = bot.entity.position
  const ayak = ben.floored()
  let yetmeyen = 0
  const adaylar = []
  for (const p of bot.findBlocks({ matching: cevherIdleri, maxDistance: SEARCH_RADIUS, count: 64 })) {
    if (skipped.has(key(p)) || Math.abs(p.y - ayak.y) > MADEN_DIKEY) continue
    if (enFazla !== null && p.distanceTo(ben) > enFazla) continue // inerken sadece yanındakiler
    if (p.x === ayak.x && p.z === ayak.z && p.y < ayak.y) continue // tam ayağının altı: düşer
    const b = bot.blockAt(p)
    if (!b || lavYakin(p)) continue
    if (!kazmaYeter(b)) {
      yetmeyen++
      continue
    }
    adaylar.push({ p, puan: p.distanceTo(ben) + (acikta(p) ? 0 : 6) })
  }
  adaylar.sort((a, b) => a.puan - b.puan)
  return { pos: adaylar[0]?.p || null, yetmeyen }
}

// Önündeki blokları güvenliyse kazar: lav/su/boşluk ya da kazmadığı blok varsa 'kapali'
const kazilabilirMi = (b) => b.boundingBox === 'empty' || MADEN_TASI.has(b.name) || (cevherMi(b) && kazmaYeter(b))
const tehlikeli = (b) => !b || b.name === 'lava' || b.name === 'water' || lavYakin(b.position)
async function yolAc(id, bloklar) {
  for (const b of bloklar) {
    if (b.boundingBox === 'empty') continue
    if (!(await equipTool('pickaxe'))) return 'kazma'
    if (id !== taskId) return 'ok'
    const guncel = bot.blockAt(b.position) // üstten çakıl düşmüş olabilir
    if (!guncel || guncel.boundingBox === 'empty') continue
    if (!kazmaYeter(guncel) || (!MADEN_TASI.has(guncel.name) && !cevherMi(guncel))) return 'kapali'
    await kaz(guncel)
  }
  return null
}

// Cevher yokken: bakılan yöne bir adım tünel (ayak + baş hizası). Önü kapalıysa
// (lav, su, boşluk, yapı) başka yöne döner. Döner: 'ok' | 'kazma' | 'kapali'
async function tunelAdimi(id) {
  for (let deneme = 0; deneme < 4; deneme++) {
    if (id !== taskId) return 'ok'
    const ayak = bot.entity.position.floored()
    const ileri = ayak.plus(YATAY[tunelYonu])
    const zemin = bot.blockAt(ileri.offset(0, -1, 0))
    const bloklar = [bot.blockAt(ileri), bot.blockAt(ileri.offset(0, 1, 0))]
    const kapali = !zemin || zemin.boundingBox !== 'block' || bloklar.some(tehlikeli) || !bloklar.every(kazilabilirMi)
    if (kapali) {
      tunelYonu = (tunelYonu + 1) % 4
      continue
    }
    const r = await yolAc(id, bloklar)
    if (r) return r
    await gotoTimeout(new goals.GoalBlock(ileri.x, ileri.y, ileri.z), 15000)
    return 'ok'
  }
  return 'kapali'
}

// Derin maden: bakılan yöne bir basamak aşağı (merdiven). Önündeki 3 blok kazılır,
// basamağın altı sağlam olmalı (boşluğa, lava, suya inmez). Döner: 'ok' | 'kazma' | 'kapali'
async function inisAdimi(id) {
  for (let deneme = 0; deneme < 4; deneme++) {
    if (id !== taskId) return 'ok'
    const ayak = bot.entity.position.floored()
    const ileri = ayak.plus(YATAY[tunelYonu])
    const bloklar = [ileri.offset(0, 1, 0), ileri, ileri.offset(0, -1, 0)].map((p) => bot.blockAt(p))
    const zemin = bot.blockAt(ileri.offset(0, -2, 0))
    const kapali =
      !zemin || zemin.boundingBox !== 'block' || tehlikeli(zemin) || bloklar.some(tehlikeli) || !bloklar.every(kazilabilirMi)
    if (kapali) {
      tunelYonu = (tunelYonu + 1) % 4
      continue
    }
    const r = await yolAc(id, bloklar)
    if (r) return r
    await gotoTimeout(new goals.GoalBlock(ileri.x, ileri.y - 1, ileri.z), 15000)
    return 'ok'
  }
  return 'kapali'
}

// "elmas kaz" gibi: hangi derinlikte aranır. [1.18+ dünyalar (-64'ten başlar), eski dünyalar]
const MADEN_HEDEFLERI = {
  elmas: { y: [-54, 12], demirLazim: true },
  kiziltas: { y: [-54, 12], demirLazim: true },
  altin: { y: [-16, 20], demirLazim: true },
  zumrut: { y: [null, null], demirLazim: true },
  lapis: { y: [0, 16] },
  demir: { y: [16, 30] },
  bakir: { y: [48, null] },
  komur: { y: [null, null] },
}
const KATMAN = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']
const kazmaKatmani = () => {
  const k = iyiAlet('pickaxe') || bot.inventory.items().find((i) => aletTuru(i) === 'pickaxe')
  return k ? KATMAN.findIndex((m) => k.name.startsWith(m + '_')) : 99
}

async function demirKazmaYap() {
  console.log('[maden] Demir kazma yapacak malzemem var, yapıyorum.')
  const r = await zanaat.aletYap('pickaxe', { sadece: 'iron' })
  if (r.ok) say('Kendime demir kazma yaptım.')
  return r.ok
}

async function madenTask(id, secenek = {}) {
  if (!(await equipTool('pickaxe'))) return gorevNotu(id, 'Kazmam yok! Envanterime bir kazma ver.')
  const hedefBilgi = MADEN_HEDEFLERI[secenek.hedef] || null
  const yeniDunya = (bot.game?.minY ?? 0) < 0
  const hedefY = hedefBilgi ? hedefBilgi.y[yeniDunya ? 0 : 1] : null
  let iniyor = hedefY !== null && bot.entity.position.y > hedefY + 1
  if (gorev && gorev.id === id && iniyor) gorev.uzakTeslim = true // derinden her yığında yukarı çıkmasın
  if (hedefBilgi?.demirLazim && kazmaKatmani() > KATMAN.indexOf('iron')) {
    if (zanaat.yukseltilebilir('pickaxe')) await demirKazmaYap()
    else say(`${secenek.hedef} için en az demir kazma lazım. Yolda demir bulursam eritip kendime yaparım.`)
  }
  if (iniyor) console.log(`[maden] ${secenek.hedef} için y=${hedefY} seviyesine merdivenle iniyorum (şu an y=${Math.floor(bot.entity.position.y)}).`)
  const skipped = new Set()
  tunelYonu = Math.floor(Math.random() * 4)
  let count = 0
  let tunel = 0 // son cevherden beri tünelde atılan adım
  let hatalar = 0
  let sonYukseltme = Date.now()
  let sonInisY = null
  const tunelSiniri = hedefY !== null ? TUNEL_SINIRI * 3 : TUNEL_SINIRI
  while (calisiyor(id)) {
    let hedef = null
    try {
      const dolu = await yerAc(id)
      if (dolu) return gorevNotu(id, dolu)
      await gerekirseBosalt(id)
      if (!calisiyor(id)) break
      // ham demiri biriktiyse kazmasını demire yükselt (elmasa dokunmaz)
      if (Date.now() - sonYukseltme > 20000) {
        sonYukseltme = Date.now()
        if (kazmaKatmani() > KATMAN.indexOf('iron') && zanaat.yukseltilebilir('pickaxe')) await demirKazmaYap()
      }

      const { pos, yetmeyen } = cevherBul(skipped, iniyor ? 5 : null)
      hedef = pos
      if (yetmeyen) uyar('kazma-yetmez', 'Yakında kazmamın yetmediği cevherler var (elmas, altın için en az demir kazma lazım).', 30 * 60000)
      if (!pos && iniyor) {
        if (bot.entity.position.y <= hedefY + 1) {
          iniyor = false
          console.log(`[maden] y=${Math.floor(bot.entity.position.y)} seviyesine indim, ${secenek.hedef} arıyorum.`)
          continue
        }
        const r = await inisAdimi(id)
        const y = Math.floor(bot.entity.position.y)
        if (y % 10 === 0 && y !== sonInisY) console.log(`[maden] İniyorum: y=${(sonInisY = y)}`)
        if (r === 'kazma') return gorevNotu(id, 'Kazmam kırıldı, bana yeni bir kazma ver.')
        if (r === 'kapali') {
          iniyor = false
          console.log(`[maden] Daha aşağı inemiyorum (önüm lav, su ya da boşluk), y=${Math.floor(bot.entity.position.y)} seviyesinde arıyorum.`)
        }
        hatalar = 0
        continue
      }
      if (!pos) {
        if (tunel >= tunelSiniri) return gorevNotu(id, 'Yakında maden kalmadı. Beni bir mağaraya ya da madene götür.')
        if (tunel === 0) console.log('[maden] Görünen cevher yok, tünel kazarak arıyorum.')
        const r = await tunelAdimi(id)
        if (r === 'kazma') return gorevNotu(id, 'Kazmam kırıldı, bana yeni bir kazma ver.')
        if (r === 'kapali') return gorevNotu(id, 'Tünelde ilerleyemiyorum (önüm lav, su, boşluk ya da kazmadığım bloklar). Beni başka bir yere götür.')
        tunel++
        hatalar = 0
        continue
      }

      // açıktakine bakabileceği yere, kapalıdakine (taşın içinde) dibine kazarak gider
      const hedefGoal = acikta(pos) ? new goals.GoalLookAtBlock(pos, bot.world) : new goals.GoalGetToBlock(pos.x, pos.y, pos.z)
      try {
        await gotoTimeout(hedefGoal, 60000)
      } catch (e) {
        if (id !== taskId) return
        console.log(`[maden] cevhere ulaşamadım: ${e.message || e}`)
        skipped.add(key(pos)) // ulaşılamayanı atla; üst üste hata sayılmaz
        continue
      }
      if (id !== taskId) return
      if (!(await equipTool('pickaxe'))) return gorevNotu(id, 'Kazmam kırıldı, bana yeni bir kazma ver.')
      const block = bot.blockAt(pos)
      if (!cevherMi(block)) continue // yaklaşınca taş çıktı (sunucu cevherleri gizliyor)
      if (!bot.canDigBlock(block) || lavYakin(pos)) {
        skipped.add(key(pos))
        continue
      }
      await kaz(block)
      count++
      tunel = 0
      hatalar = 0
      if (count % 5 === 0) console.log(`[maden] ${count} cevher kazıldı (son: ${block.name})`)
      await collectDrops(id)
    } catch (e) {
      if (id !== taskId) return
      hatalar++
      console.log(`[maden] ${hedef ? 'kazamadım' : 'tünel'}: ${e.message || e}`)
      if (hatalar >= 8) return gorevNotu(id, 'Üst üste hata aldım, duruyorum.')
      if (hedef) skipped.add(key(hedef)) // ulaşılamayanı bir daha deneme
      else tunelYonu = (tunelYonu + 1) % 4
      await sleep(500)
    }
  }
}

// ---------- BENİ KORU ----------
// Sahibini takip eder; sahibine ya da kendisine saldıran yaratıklarla savaşır
// (savaşı savas.js yapar, bu görev sadece sahibin yanında kalır).
async function korumaTask(id) {
  if (!OWNER) return gorevNotu(id, SAHIPSIZ)
  let goremedi = 0
  while (calisiyor(id)) {
    if (savas.savasta()) {
      await savas.bekle()
      continue
    }
    const p = sahipOyuncu()?.entity
    if (!p) {
      if (goremedi++ % 30 === 0) say('Seni göremiyorum, yanıma gelince korurum.')
      await sleep(2000)
      continue
    }
    goremedi = 0
    const g = bot.pathfinder.goal
    if (!(g instanceof goals.GoalFollow) || g.entity !== p) bot.pathfinder.setGoal(new goals.GoalFollow(p, 2), true)
    await yemekGerekirse()
    await sleep(500)
  }
  if (id === taskId) bot.pathfinder.setGoal(null)
}

// ---------- XP (YARATIK ÇİFTLİĞİ) ----------
// Başladığı yerde durur, yaklaşan yaratıkları keser (savas.js yerinde modunda),
// düşenleri toplar ve yerine döner. Çiftlikteki domuz adam, enderman da kesilir.
async function xpTask(id) {
  const yer = bot.entity.position.floored()
  if (!iyiAlet('sword') && !iyiAlet('axe')) say('Kılıcım yok, elle vuruyorum (yavaş). Bana kılıç ver.')
  while (calisiyor(id)) {
    await savas.bekle()
    await yemekGerekirse()
    const dolu = await yerAc(id)
    if (dolu) return gorevNotu(id, dolu)
    await gerekirseBosalt(id)
    await collectDrops(id, 3, 6)
    if (id !== taskId) return
    if (bot.entity.position.distanceTo(yer.offset(0.5, 0, 0.5)) > 1.2) {
      await gotoTimeout(new goals.GoalBlock(yer.x, yer.y, yer.z), 15000).catch(() => {})
    }
    await sleep(1000)
  }
}

// ---------- BALIK ----------
// Yakındaki suya olta atar, tuttuklarını sayar (sandığa da götürür). Oltası yoksa
// ip ve çubuktan yapar.
async function balikTask(id) {
  const oltaBul = () => bot.inventory.items().find((i) => i.name === 'fishing_rod')
  if (!oltaBul()) {
    const r = await zanaat.aletYap('fishing_rod')
    if (!oltaBul()) return gorevNotu(id, `Oltam yok${r.neden ? ` (${r.neden})` : ''}. Bana bir olta ver.`)
  }
  const suId = bot.registry.blocksByName.water?.id
  const su = bot
    .findBlocks({ matching: suId, maxDistance: 20, count: 80 })
    .map((p) => bot.blockAt(p))
    .filter((b) => b && bot.blockAt(b.position.offset(0, 1, 0))?.boundingBox === 'empty')
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (!su) return gorevNotu(id, 'Yakında su göremiyorum. Beni suyun kenarına götür.')
  if (su.position.distanceTo(bot.entity.position) > 6) {
    await gotoTimeout(new goals.GoalNear(su.position.x, su.position.y + 1, su.position.z, 4), 30000).catch(() => {})
  }
  let tutulan = 0
  let hata = 0
  while (calisiyor(id)) {
    const dolu = await yerAc(id)
    if (dolu) return gorevNotu(id, dolu)
    await gerekirseBosalt(id)
    await yemekGerekirse()
    await savas.bekle()
    if (id !== taskId) return
    const olta = oltaBul()
    if (!olta) return gorevNotu(id, 'Oltam kırıldı. Bana yeni olta ver (ya da ip getir, yaparım).')
    try {
      if (bot.heldItem?.slot !== olta.slot) await bot.equip(olta, 'hand')
      await bot.lookAt(su.position.offset(0.5, 1, 0.5), true)
      const once = envanterSayim()
      await sureli(bot.fish(), 45000, 'balık tutulamadı')
      hata = 0
      await sleep(600) // tutulan eşya envantere gelsin
      for (const [ad, n] of envanterSayim()) {
        const fark = n - (once.get(ad) || 0)
        if (fark > 0) istatistikEkle('balik', ad, fark)
      }
      tutulan++
      if (tutulan % 10 === 0) console.log(`[balik] ${tutulan} kez tuttum.`)
    } catch (e) {
      if (id !== taskId) return
      try {
        bot.activateItem() // oltayı geri çek
      } catch (_) {}
      if (savas.savasta()) continue
      if (++hata >= 5) return gorevNotu(id, 'Balık tutamıyorum (olta suya düşmüyor olabilir). Beni suyun kenarına götür.')
      await sleep(1500)
    }
  }
}

// ---------- ALET YAP (!yap kazma) ----------
async function yapTask(id, tur) {
  const r = await zanaat.aletYap(tur)
  if (id !== taskId) return
  gorevNotu(id, r.ok ? `Yaptım: ${r.ad}.` : `Yapamadım: ${r.neden}.`)
}

// ---------- ENVANTER ----------
const ZIRH_YUVALARI = [5, 6, 7, 8] // kask, göğüs, pantolon, bot
function envanterBilgisi() {
  const esya = (it) =>
    it && {
      ad: it.name,
      gorunen: it.displayName || it.name,
      adet: it.count,
      dayanik: it.maxDurability ? { kalan: kalanDayaniklilik(it), en: it.maxDurability } : null,
    }
  const items = bot.inventory.items()
  return {
    esyalar: items.map(esya),
    el: esya(bot.heldItem),
    zirh: ZIRH_YUVALARI.map((s) => esya(bot.inventory.slots[s])).filter(Boolean),
    bos_slot: bot.inventory.emptySlotCount(),
  }
}
function envanterOzeti() {
  const say2 = envanterSayim()
  if (!say2.size) return 'Envanterim boş.'
  const liste = [...say2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([ad, n]) => `${ad}×${n}`)
  return `Envanterim: ${liste.join(', ')}${say2.size > 8 ? ` (+${say2.size - 8} çeşit)` : ''}. Boş slot ${bot.inventory.emptySlotCount()}.`
}

// ---------- GÜNLÜK İSTATİSTİK ----------
// Bugün ne kırdı, sandığa ne bıraktı, kaç yaratık kesti, kaç kez öldü... Discord gün
// sonunda odaya özet atar (/rapor ile istendiği an). Türkiye gününe göre sıfırlanır.
const ISTATISTIK_DOSYA = path.join(VERI_DIR, 'istatistik.json')
const trGun = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' })
const bosIstatistik = (gun) => ({ gun, kirilan: {}, birakilan: {}, yaratik: {}, balik: {}, yapilan: {}, olum: 0 })
let istatistik = { bugun: bosIstatistik(trGun()), dun: null }
try {
  const k = JSON.parse(fs.readFileSync(ISTATISTIK_DOSYA, 'utf-8'))
  if (k && k.bugun && k.bugun.gun) istatistik = { bugun: k.bugun, dun: k.dun || null }
} catch (_) {}
let istatistikKirli = false
function gunKontrol() {
  const gun = trGun()
  if (istatistik.bugun.gun === gun) return
  istatistik = { bugun: bosIstatistik(gun), dun: istatistik.bugun }
  istatistikKirli = true
}
function istatistikEkle(tur, ad, n = 1) {
  gunKontrol()
  const g = istatistik.bugun
  if (tur === 'olum') g.olum = (g.olum || 0) + n
  else {
    g[tur] = g[tur] || {}
    g[tur][ad] = (g[tur][ad] || 0) + n
  }
  istatistikKirli = true
}
function istatistikKaydet() {
  if (!istatistikKirli) return
  istatistikKirli = false
  try {
    fs.writeFileSync(ISTATISTIK_DOSYA, JSON.stringify(istatistik), 'utf-8')
  } catch (_) {}
}
setInterval(istatistikKaydet, 30000).unref()
process.on('exit', istatistikKaydet)

// ---------- ÖLÜM ----------
// Ölünce odaya haber verir ([olum] satırı: Discord sahibini etiketler). Doğunca ölüm
// yerine dönüp eşyalarını toplar (yakınsa ve eşyalar kaybolmadan), sonra yaptığı işe
// devam eder. Kısa sürede 3 kez ölürse işi bırakır.
let olum = null // { pos, boyut, zaman, komut }
const olumZamanlari = []
let sonOlumMesaji = { metin: '', zaman: 0 }
bot.on('messagestr', (m) => {
  const t = String(m)
  if (t.includes(BOT_NAME) && !t.trim().startsWith('<')) sonOlumMesaji = { metin: t.slice(0, 200), zaman: Date.now() }
})

function devamEt(komutMetni) {
  setTimeout(() => {
    if (currentTask || !hazir) return
    console.log(`[olum] İşime dönüyorum: ${komutMetni}`)
    handleCommand(komutMetni)
  }, 1500)
}

async function esyaTopla(id, o) {
  say('Öldüm, eşyalarımı toplamaya gidiyorum.')
  const toplam = () => bot.inventory.items().reduce((t, i) => t + i.count, 0)
  const once = toplam()
  try {
    await gotoTimeout(new goals.GoalNear(o.pos.x, o.pos.y, o.pos.z, 2), 120000)
  } catch (e) {
    if (id !== taskId) return
    gorevNotu(id, 'Öldüğüm yere ulaşamadım, eşyalarımı alamadım.')
    if (o.komut) devamEt(o.komut) // eşyalar gitse de işine devam etsin
    return
  }
  for (let i = 0; i < 3 && id === taskId; i++) {
    await collectDrops(id, 10, 40)
    await sleep(500)
  }
  if (id !== taskId) return
  const n = toplam() - once
  gorevNotu(id, n > 0 ? `Eşyalarımı topladım (${n} eşya).` : 'Öldüğüm yerde eşya bulamadım (yanmış ya da kaybolmuş olabilir).')
  if (o.komut) devamEt(o.komut)
}

async function olumdenDon() {
  const o = olum
  olum = null
  if (!o || !hazir || !bot.entity) return
  const son = olumZamanlari.filter((t) => Date.now() - t < 10 * 60000)
  olumZamanlari.splice(0, olumZamanlari.length, ...son)
  if (son.length >= 3) {
    console.log('[olum] 10 dakikada 3 kez öldüm, işe devam etmiyorum. Beni güvenli bir yere götür.')
    say('Kısa sürede çok öldüm, işi bıraktım. Beni güvenli bir yere götür.')
    return
  }
  // sunucuda "keepInventory" açıksa eşyalar zaten üstünde
  if (!bot.inventory.items().length) {
    const uzak = (o.boyut && bot.game?.dimension && bot.game.dimension !== o.boyut) || bot.entity.position.distanceTo(o.pos) > 300
    if (Date.now() - o.zaman > 4 * 60000) {
      console.log('[olum] Eşyalarım çoktan kaybolmuştur, toplamaya gitmiyorum.')
    } else if (uzak) {
      console.log(`[olum] Öldüğüm yer çok uzak (${konumYaz(o.pos.floored())}), eşyalarımı alamıyorum.`)
      say('Öldüğüm yer çok uzak, eşyalarımı alamıyorum.')
    } else {
      startTask('esya', (id) => esyaTopla(id, o), 0, o.komut) // burada da ölürse aynı işe dönsün
      return
    }
  }
  if (o.komut) devamEt(o.komut)
}

// ---------- ÇİFTÇİLİK ----------
// ürün adı -> { olgun yaş, ekim eşyası }
const CROPS = {
  wheat: { age: 7, seed: 'wheat_seeds' },
  carrots: { age: 7, seed: 'carrot' },
  potatoes: { age: 7, seed: 'potato' },
  beetroots: { age: 3, seed: 'beetroot_seeds' },
  nether_wart: { age: 3, seed: 'nether_wart', toprak: 'soul_sand' },
}
// Ekilmeden toplananlar: şeker kamışı / bambu (en alttaki kök kalır, yeniden büyür),
// kabak / karpuz (sadece sapı bağlı olan, yani tarladaki; süs kabağına dokunmaz)
const UZAYAN = new Set(['sugar_cane', 'bamboo'])
const MEYVE = { pumpkin: ['attached_pumpkin_stem', 'pumpkin_stem'], melon: ['attached_melon_stem', 'melon_stem'] }
function hasatEdilir(b) {
  if (!b) return false
  if (CROPS[b.name]) return isRipe(b)
  if (UZAYAN.has(b.name)) return bot.blockAt(b.position.offset(0, -1, 0))?.name === b.name
  if (MEYVE[b.name]) {
    return YATAY.some((d) => MEYVE[b.name].includes(bot.blockAt(b.position.plus(d))?.name))
  }
  return false
}

function isRipe(block) {
  const crop = CROPS[block.name]
  // Yeni sürümlerde (1.20+) özellik metin olarak gelir: age '7'. Sayıya
  // çevirmezsek hiçbir ekin olgun görünmez ve bot hiç hasat yapmaz.
  return !!crop && Number(block.getProperties().age) === crop.age
}

async function replant(pos, cropName) {
  const seedName = CROPS[cropName].seed
  const seed = bot.inventory.items().find((i) => i.name === seedName)
  if (!seed) return
  const farmland = bot.blockAt(pos.offset(0, -1, 0))
  if (!farmland || farmland.name !== (CROPS[cropName].toprak || 'farmland')) return
  await bot.equip(seed, 'hand')
  try {
    await bot.placeBlock(farmland, new Vec3(0, 1, 0))
  } catch (_) {}
}

async function farmTask(id) {
  const skipped = new Set()
  const cropIds = [...Object.keys(CROPS), ...UZAYAN, ...Object.keys(MEYVE)]
    .map((n) => bot.registry.blocksByName[n])
    .filter(Boolean) // eski sürümlerde bazı ekinler yok
    .map((b) => b.id)

  while (calisiyor(id)) {
    const dolu = await yerAc(id)
    if (dolu) return gorevNotu(id, dolu)
    await gerekirseBosalt(id)
    await yemekGerekirse() // farm süresiz ve alet almıyor: yemeği burada yer

    // önce türüne göre hızlı ara, sonra olgun mu / toplanır mı bak
    const positions = bot
      .findBlocks({ matching: cropIds, maxDistance: SEARCH_RADIUS, count: 300 })
      .filter((p) => !skipped.has(key(p)) && hasatEdilir(bot.blockAt(p)))
      .slice(0, 30)

    if (positions.length === 0) {
      afkKipirda() // ürün beklerken AFK diye atılmasın
      await sleep(5000) // ürünlerin büyümesini bekle
      skipped.clear()
      continue
    }

    positions.sort(
      (a, b) =>
        a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
    )

    for (const pos of positions) {
      if (!calisiyor(id)) break
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
        const block = bot.blockAt(pos)
        if (!hasatEdilir(block)) continue
        const cropName = block.name
        if (MEYVE[cropName]) await equipTool('axe', { sandiktan: false }) // kabak/karpuz baltayla hızlı
        await kaz(block)
        if (CROPS[cropName]) await replant(pos, cropName)
        bot._hasat = (bot._hasat || 0) + 1
        if (bot._hasat % 10 === 0) console.log(`[farm] ${bot._hasat} ürün hasat edildi (son: ${cropName})`)
      } catch (_) {
        skipped.add(key(pos))
      }
    }
    await collectDrops(id)
  }
}

process.on('uncaughtException', (e) => {
  console.log('[hata] Beklenmeyen hata, bot kapanıyor:', e.message)
  console.error('[satıcı] Beklenmeyen hata:', e.stack)
  process.exit(1)
})
// ---------- SUNUCU GİRİŞİ (AuthMe vb.) ----------
// Crack sunucuların çoğu girişte /register ya da /login ister. Şifre Discord'dan
// /giris ile verilir (müşterinin klasöründe, sunucu başına durur). Şifre hiçbir
// loga yazılmaz; sohbette geçerse de **** olarak gösterilir.
const SIFRE_RE = /^[^\s]{3,64}$/
let GIRIS_SIFRE = SIFRE_RE.test(process.env.MC_GIRIS_SIFRE || '') ? process.env.MC_GIRIS_SIFRE : ''
let girisDeneme = 0
let girisSon = 0
let girisYapildi = false
let girisHatali = false
let girisBekleyen = null // oyuna doğmadan gelen istek: doğunca yapılır
let girisPenceresi = Date.now() + 3 * 60000 // girişten sonraki ilk dakikalarda dinlenir
let sifreYokUyarildi = false
const gizle = (t) => (GIRIS_SIFRE ? String(t).split(GIRIS_SIFRE).join('****') : String(t))
// Mesajlar Türkçe harfleri sadeleştirilip karşılaştırılır: AuthMe'nin Türkçe dili
// "Yanlis sifre!", "Basariyla kaydoldun!" gibi ASCII yazar, başka eklentiler "ş/ı" ile.
const sade = (t) =>
  String(t)
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
const KAYIT_RE = /\/(register|reg|kayit)\b|kayit ol|kaydol|please register/
const GIRIS_RE = /\/(login|l|log|giris)\b|giris yap|please log ?in|log in with/
// "bu ad zaten kayıtlı": kayıt değil giriş gerekir
const ZATEN_KAYITLI_RE = /zaten kayitli|daha once.*kaydol|already registered/
const BASARILI_RE = /basariyla (giris|kay)|giris yapildi|giris basarili|kayit basarili|zaten giris|oturuma girisiniz|successful(ly)? (logged|registered|login|register)|logged in successfully|login successful|you are now logged|already logged in|logged-in due to session/
const HATALI_RE = /yanlis sifre|hatali sifre|sifre yanlis|sifreniz yanlis|wrong password|incorrect password|invalid password/

let girisZamanlayici = null
function girisKomutu(tur) {
  if (!GIRIS_SIFRE) {
    girisBekleyen = tur // şifre /giris ile gelince doğru komut (kayıt mı giriş mi) yazılsın
    return
  }
  if (girisHatali || girisYapildi || girisDeneme >= 4) return // döngüye girmesin
  const bekle = 4000 - (Date.now() - girisSon)
  if (bekle > 0) {
    // az önce denendi: sunucunun cevabı ("önce kayıt ol" gibi) kaybolmasın, biraz sonra yap
    girisBekleyen = tur
    clearTimeout(girisZamanlayici)
    girisZamanlayici = setTimeout(() => girisBekleyen && girisKomutu(girisBekleyen), bekle + 50)
    return
  }
  girisBekleyen = null
  girisSon = Date.now()
  girisDeneme++
  try {
    bot.chat(tur === 'kayit' ? `/register ${GIRIS_SIFRE} ${GIRIS_SIFRE}` : `/login ${GIRIS_SIFRE}`)
  } catch (_) {}
  console.log(tur === 'kayit' ? '[giris] Sunucu kayıt istedi, şifreyle kayıt oluyorum.' : '[giris] Sunucu giriş istedi, şifreyle giriş yapıyorum.')
}

bot.on('messagestr', (ham, poz) => {
  // oyuncuların yazdıkları değil, sunucunun mesajları (oyuncu "register" yazınca tetiklenmesin)
  if (poz === 'chat' || girisYapildi || Date.now() > girisPenceresi) return
  const metin = sade(ham)
  if (HATALI_RE.test(metin)) {
    if (!girisHatali) console.log('[giris] Sunucu şifrenin yanlış olduğunu söyledi! Discord odanda /giris sifre:DOĞRU_ŞİFRE yaz.')
    girisHatali = true
    return
  }
  if (BASARILI_RE.test(metin)) {
    girisYapildi = true
    console.log('[giris] Sunucuya giriş yapıldı.')
    return
  }
  const tur = ZATEN_KAYITLI_RE.test(metin) ? 'giris' : KAYIT_RE.test(metin) ? 'kayit' : GIRIS_RE.test(metin) ? 'giris' : null
  if (!tur) return
  if (!GIRIS_SIFRE) {
    if (!sifreYokUyarildi) console.log('[giris] Sunucu şifreyle giriş istiyor: Discord odanda /giris sifre:ŞİFREN yaz.')
    sifreYokUyarildi = true
    girisBekleyen = tur
    return
  }
  if (!hazir) girisBekleyen = tur
  else girisKomutu(tur)
})

// ---------- SOHBET KÖPRÜSÜ ----------
// Oyundaki sohbet müşterinin Discord odasına düşer ([sohbet] satırları).
// Discord'dan /sohbet ile kapatılır, /yaz ile odadan oyuna yazılır.
let SOHBET = process.env.MC_SOHBET !== '0'
let sonYazma = 0
bot.on('messagestr', (metin, poz) => {
  if (!SOHBET || poz === 'game_info') return // aksiyon çubuğu (sürekli değişen yazılar) değil
  // botun kendi yazdıkları zaten [bot] satırı olarak düşüyor
  if (sonGonderen && bot.player?.uuid && uuidTemiz(sonGonderen) === uuidTemiz(bot.player.uuid)) return
  const t = gizle(String(metin).replace(/\s+/g, ' ').trim())
  if (t) console.log('[sohbet] ' + t.slice(0, 300))
})

// ---------- YEMEK ----------
// Acıkınca yanındaki en iyi yemeği yer. Zehirli/kötü yemekleri ve değerli
// altın elmaları yemez. Görevin ortasında değil, alet alırken ya da boştayken yer.
const KOTU_YEMEK = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew',
  'chorus_fruit', 'chicken', 'golden_apple', 'enchanted_golden_apple',
])
let yiyor = false
const acMi = () => hazir && bot.food !== undefined && (bot.food <= 14 || (bot.health < 14 && bot.food < 18))
function enIyiYemek() {
  const yemekler = bot.registry.foodsByName || {}
  return (
    bot.inventory
      .items()
      .filter((i) => yemekler[i.name] && !KOTU_YEMEK.has(i.name))
      .sort((a, b) => (yemekler[b.name].effectiveQuality || 0) - (yemekler[a.name].effectiveQuality || 0))[0] || null
  )
}
let yemekBekle = 0 // yiyemezse her blokta tekrar denemesin
async function yemekGerekirse() {
  if (yiyor || !acMi() || bot.game?.gameMode === 'creative' || Date.now() < yemekBekle) return false
  const yemek = enIyiYemek()
  if (!yemek) {
    uyar('yemek-yok', 'Acıktım ama yanımda yemek yok. Envanterime ya da sandığa yemek koy.', 10 * 60000)
    return false
  }
  yiyor = true
  const oncekiAclik = bot.food
  const adet = () => bot.inventory.items().filter((i) => i.name === yemek.name).reduce((t, i) => t + i.count, 0)
  const oncekiAdet = adet()
  const yedi = () => bot.food > oncekiAclik || adet() < oncekiAdet
  try {
    if (bot.heldItem?.slot !== yemek.slot) await bot.equip(yemek, 'hand')
    try {
      await bot.consume()
    } catch (e) {
      // mineflayer 2,5 sn sonra vazgeçer ama yavaş sunucuda yeme sürüyor olabilir: bırakma, biraz bekle
      if (!/timed out/i.test(e.message)) throw e
      for (let i = 0; i < 35 && !yedi(); i++) await sleep(100)
      if (!yedi()) throw new Error('yemek yenemedi (zaman aşımı)')
    }
    console.log(`[yemek] ${yemek.name} yedim (açlık ${bot.food}/20).`)
    return true
  } catch (e) {
    try {
      bot.deactivateItem()
    } catch (_) {}
    yemekBekle = Date.now() + 60000
    console.log('[yemek] Yiyemedim:', e.message)
    return false
  } finally {
    yiyor = false
  }
}

// ---------- AFK KORUMASI ----------
// Boştayken sunucu "AFK" diye atmasın: arada etrafa bakar, zıplar, kolunu sallar.
// Boştayken acıktıysa da burada yer.
let sonAfk = Date.now()
function afkKipirda() {
  if (!hazir || yiyor || Date.now() - sonAfk < 40000 + Math.random() * 20000) return
  sonAfk = Date.now()
  try {
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, false).catch(() => {})
    bot.swingArm()
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 350)
  } catch (_) {}
}
setInterval(() => {
  if (!hazir || currentTask || yiyor) return
  yemekGerekirse().catch(() => {})
  afkKipirda()
}, 10000).unref()

let sifreReddedildi = false
// Atılma nedeni JSON sohbet metni olarak gelir: okunur hâle getir
function sohbetMetni(r) {
  let v = r
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch (_) {
      return v
    }
  }
  const parca = (x) =>
    typeof x === 'string'
      ? x
      : !x || typeof x !== 'object'
        ? ''
        : (x.text || x.translate || '') + (Array.isArray(x.extra) ? x.extra.map(parca).join('') : '') +
          (Array.isArray(x.with) ? ' ' + x.with.map(parca).join(' ') : '')
  return parca(v).replace(/§./g, '').trim() || JSON.stringify(r)
}
bot.on('kicked', (r) => {
  const metin = JSON.stringify(r)
  console.log('[olay] Sunucudan atıldı:', gizle(sohbetMetni(r)).slice(0, 300))
  // AuthMe varsayılanı: yanlış şifrede mesaj değil atma gelir. Aynı yanlış şifreyle
  // tekrar tekrar bağlanmasın (sunucu banlayabilir).
  if (GIRIS_SIFRE && girisDeneme > 0 && !girisYapildi && HATALI_RE.test(sade(metin))) {
    sifreReddedildi = girisHatali = true
    console.log('[giris] Sunucu şifrenin yanlış olduğunu söyledi ve attı! Discord odanda /giris sifre:DOĞRU_ŞİFRE yaz, sonra /baslat.')
  }
})
let sonHata = ''
bot.on('error', (e) => {
  // bağlantı hataları (sunucu kapalı, port yanlış...) anlaşılır ve bir kez yazılır
  const metin = e && e.code && e.syscall === 'connect' ? baglantiHatasiMetni(e.code, `${e.address || HOST}:${e.port || PORT}`) : e.message || String(e)
  if (metin !== sonHata) console.log('[olay] Hata:', metin)
  sonHata = metin
  // Daha bağlanmadan (ör. Microsoft girişi başarısız) hata olursa 'end' gelmez
  if (!hazir && !bot._client?.socket) process.exit(1)
})
// Bazı sunucular (ör. Cuberite) yeniden doğunca can paketini doğma paketinden önce
// yollar: mineflayer botu ölü sanıp konum göndermeyi bırakır ve sonraki ölümü
// kaçırır. Doğduktan sonra canı varsa canlı say; ölümü candan da yakala.
let oluKayitli = false
bot.on('respawn', () => {
  setTimeout(() => {
    if (bot.isAlive === false && bot.health > 0) bot.isAlive = true
  }, 1500)
})
bot.on('health', () => {
  if (bot.health > 0) oluKayitli = false
  else if (!bot.isAlive && !oluKayitli && hazir) bot.emit('death') // mineflayer bu ölümü yaymayacak
})
bot.on('death', () => {
  if (oluKayitli) return
  oluKayitli = true
  console.log('[olay] Bot öldü')
  const p = bot.entity ? bot.entity.position : null
  const yer = p ? `konum ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : ''
  // doğunca eşyaları toplamaya dönmek ve işe devam etmek için
  const komutu = currentTask && gorev ? gorev.komut : null
  olum = p ? { pos: p.clone(), boyut: bot.game?.dimension, zaman: Date.now(), komut: komutu } : null
  olumZamanlari.push(Date.now())
  istatistikEkle('olum')
  const olumYeri = p ? p.floored() : null // p canlı nesne: doğunca yeni yere döner
  setTimeout(() => {
    const neden = Date.now() - sonOlumMesaji.zaman < 5000 ? sonOlumMesaji.metin : ''
    console.log(`[olum] Öldüm${olumYeri ? ` (${konumYaz(olumYeri)})` : ''}${neden ? `: ${neden}` : ''}. Doğunca eşyalarımı toplamaya gideceğim.`)
  }, 800)
  if (currentTask && gorev) {
    // Görevi bitir: doğunca eski yerine geri yürümeye çalışmasın. Ölüm,
    // görevin sonucu olarak deneyim defterine yazılır ve ders çıkarılır.
    gorev.not = `öldü${yer ? ` (${yer})` : ''}`
    stopTask()
    return
  }
  const olay = { gorev: '-', sebep: 'öldü', ozet: yer }
  brain.recordEvent(olay)
  brain.reflect(olay).then((t) => t && say(t)).catch(() => {})
})
bot.on('end', (reason) => {
  console.log('[olay] Bağlantı koptu:', reason)
  process.exit(sifreReddedildi ? 4 : 0) // 4 = şifre yanlış: discordbot.js tekrar bağlanmasın
})
