// Mineflayer çok görevli bot: çiftçilik, odun kırma, taş kırma
// Kurulum: npm install
// Çalıştırma: node discordbot.js (bu dosyayı o başlatır) ya da elle: node gorevbot.js
//
// Oyun içi komutlar (sadece sahip yazabilir, fısıltıyla da olur; sahip Discord'da
// /sahip ile verilir, büyük/küçük harf fark etmez):
//   !farm   -> olgun ürünleri toplar ve yeniden eker
//   !odun   -> yakındaki ağaçları keser
//   !tas    -> taş kırar (kazma gerekir)
//   !topla  -> yerdeki eşyaları toplar
//   !bosalt -> topladıklarını belirlenen sandıklara bırakır
//   !sandik ekle|sil|liste|temizle -> sandık göster (dibinde dur ya da x y z yaz)
//   !otonom -> yapay zeka kendi karar verip görev seçer
//   !gel    -> sana gelir
//   !dur    -> mevcut görevi ve otonom modu durdurur
//   !durum  -> ne yaptığını, canını, açlığını söyler
//   Yaren <cümle> -> yapay zekayla serbest konuşma ("Yaren biraz odun lazım")

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const ayarlar = require('./ayarlar')
const { guvenliBaglanti } = require('./ag')

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

const YARDIM = 'Komutlar: !farm !odun !tas !topla !bosalt !sandik !gel !dur !durum !otonom'

const botSecenek = {
  host: HOST,
  port: PORT,
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
let currentTask = null  // 'farm' | 'odun' | 'tas' | 'topla' | null
let gorev = null        // çalışan görevin bilgisi: { id, bitis, not, zamanlayici }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = (p) => `${p.x},${p.y},${p.z}`

bot.once('spawn', () => {
  normalMovements = new Movements(bot)
  woodMovements = new Movements(bot)
  woodMovements.canDig = false // odun toplarken yaprakları kırmasın
  hazir = true
  restoreMovements()
  console.log(`[olay] Sunucuya girdi: ${HOST}:${PORT} (${BOT_NAME})`)
  if (!OWNER) {
    console.log('[sahip] Henüz sahibim yok, kimsenin yazdığını yapmıyorum. Discord odana /sahip ad:OyunAdın yaz.')
  } else {
    console.log(`[sahip] Oyunda sadece ${OWNER} oyuncusunun yazdıklarını yapıyorum.`)
  }
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
  if (m && brain.enabled) {
    const metin = m[1] || 'merhaba'
    console.log('[duydum]', metin)
    say(await brain.ask(metin))
  }
}
bot.on('chat', onOwnerMessage)
bot.on('whisper', onOwnerMessage) // /msg GorevBot !odun da çalışsın

const KOMUTLAR = ['!farm', '!odun', '!tas', '!topla', '!bosalt', '!sandik', '!otonom', '!dur', '!durum', '!gel', '!yardim']

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
    case '!bosalt': {
      const gorevAdi = ad.slice(1)
      return baslamaEngeli(gorevAdi) || startTask(gorevAdi, GOREVLER[gorevAdi])
    }
    case '!sandik':
      return sandikKomutu(arg)
    case '!otonom':
      return setAuto(true)
    case '!dur':
      stopTask()
      return 'Durdum.'
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

async function kaz(block) {
  const ad = block.name
  await bot.dig(block)
  counters[ad] = (counters[ad] || 0) + 1
}

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
  topla: (id) => collectDrops(id, 16, 30),
  bosalt: (id) => bosaltTask(id),
}

async function bosaltTask(id) {
  if (!sandiklar().length) return gorevNotu(id, 'Hiç sandık göstermedin: sandığın dibinde dur ve !sandik ekle yaz.')
  if (!birakmaPlani(bot.inventory.items()).length) return gorevNotu(id, 'Sandığa bırakacak bir şeyim yok.')
  const r = await sandikZiyareti(id, { don: false })
  if (!r.ulasilan) gorevNotu(id, 'Sandıklara ulaşamadım.')
}

const hasPickaxe = () => bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))

// Görev hiç başlamadan anlamsızsa nedenini döndürür
function baslamaEngeli(ad) {
  // sandık varsa oradan kazma alabilir / oraya boşaltabilir
  const sandikVar = sandiklar().length > 0
  if (ad === 'tas' && !hasPickaxe() && !sandikVar) {
    return 'Kazmam yok, taş kıramam. Envanterime ya da sandığa bir kazma koy.'
  }
  if (ad !== 'bosalt' && bot.inventory.emptySlotCount() === 0 && !sandikVar) {
    return 'Envanterim dolu. Boşaltmam için bir sandık göster: !sandik ekle'
  }
  return null
}

// Yapay zekanın başlattığı (istenirse süre sınırlı) görev
function startTimed(ad, dakika, otonom) {
  if (!hazir) return 'Henüz oyuna girmedim.'
  if (!GOREVLER[ad]) return `Bilmediğim görev: ${ad}`
  const engel = baslamaEngeli(ad)
  if (engel) return engel
  if (!otonom) otonomRun = 0 // kullanıcı bir şey isteyince otonom biter
  let mins = Math.max(0, Math.round(Number(dakika) || 0))
  if (otonom) mins = Math.min(mins || 5, 8) // otonomda süresiz ya da çok uzun görev olmasın
  const text = startTask(ad, GOREVLER[ad], mins)
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
    start: (gorev, dakika, otonom) => startTimed(gorev, dakika, otonom),
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
async function istekIsle(tip, veri) {
  if (tip === 'durum') return { kod: 200, veri: snapshot() }
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
  if (tip === 'soyle') {
    if (!brain.enabled) return { kod: 503, veri: { hata: 'yapay zeka kapalı' } }
    const metin = String(veri.metin || '').trim().slice(0, 500)
    console.log('[duydum]', metin)
    const cevap = await brain.ask(metin || 'merhaba')
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
  if (req.method === 'GET' && req.url === '/durum') {
    return istekIsle('durum').then((s) => cevapVer(s.kod, s.veri))
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

function startTask(name, fn, dakika = 0) {
  stopTask()
  const id = ++taskId
  const g = { id, bitis: dakika > 0 ? Date.now() + dakika * 60000 : 0, not: '', zamanlayici: null }
  gorev = g
  currentTask = name
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
  return `${name} görevi başladı${dakika ? ` (${dakika} dk)` : ''}.`
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
async function equipTool(kind, { sandiktan = true } = {}) {
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
    return `Sandık eklendi: ${konumYaz(p)}. Envanterim yarı dolunca topladıklarımı buraya bırakacağım.`
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
const TOHUMLAR = new Set(['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato'])
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
function birakmaPlani(items) {
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
    const fazla = y.toplam - tutulacak(y.ad)
    if (fazla > 0) plan.push({ ad: y.ad, type: y.type, adet: fazla })
  }
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

async function sandigaBirak(pencere) {
  let birakilan = 0
  for (const p of birakmaPlani(pencere.items())) {
    try {
      if (p.slot != null) await slotTasi(pencere, p.slot, 0, pencere.inventoryStart)
      else await pencere.deposit(p.type, null, p.adet)
      birakilan += p.adet
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

// Belirlenen sandıklara (yakından uzağa) gider: fazlaları bırakır, istenirse
// sağlam alet alır, sonra işin olduğu yere döner.
async function sandikZiyareti(id, { alet = null, don = true } = {}) {
  const sonuc = { birakilan: 0, alindi: false, ulasilan: 0, dolu: 0 }
  if (sandikta || !hazir) return sonuc
  sandikta = true
  const donus = bot.entity.position.clone()
  try {
    const sirali = sandiklar().sort(
      (a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
    )
    for (const pos of sirali) {
      if (id !== taskId) break
      const aletLazim = alet && !iyiAlet(alet)
      if (!aletLazim && birakmaPlani(bot.inventory.items()).length === 0) break
      try {
        await gotoTimeout(new goals.GoalGetToBlock(pos.x, pos.y, pos.z), 60000)
      } catch (_) {
        console.log(`[sandık] ${konumYaz(pos)} sandığına gidemedim`)
        continue
      }
      if (id !== taskId) break
      const blok = bot.blockAt(pos)
      if (!blok || !SANDIK_TURLERI.has(blok.name)) {
        console.log(`[sandık] ${konumYaz(pos)} konumunda sandık yok`)
        continue
      }
      let pencere
      try {
        pencere = await sureli(bot.openContainer(blok), 8000, 'sandık açılmadı')
      } catch (e) {
        console.log(`[sandık] ${konumYaz(pos)} açılamadı: ${e.message}`)
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        continue
      }
      sonuc.ulasilan++
      try {
        const b = await sandigaBirak(pencere)
        sonuc.birakilan += b.birakilan
        if (b.dolu) {
          sonuc.dolu++
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
  if (sonuc.birakilan) say(`Sandığa ${sonuc.birakilan} eşya bıraktım.`)
  if (sonuc.dolu && sonuc.dolu === sonuc.ulasilan) {
    uyar('sandik-dolu', 'Sandıklarım doldu, yeni sandık göster (!sandik ekle).')
  }
  // işin olduğu yere dön
  if (don && id === taskId && bot.entity.position.distanceTo(donus) > 3) {
    await gotoTimeout(new goals.GoalNear(donus.x, donus.y, donus.z, 2), 60000).catch(() => {})
  }
  return sonuc
}

let bosaltmaEsigi = YARI_DOLU
const doluYuva = () => ENVANTER_YUVA - bot.inventory.emptySlotCount()

// Envanter yarı dolduysa sandıklara boşaltır (görev döngülerinin başında)
async function gerekirseBosalt(id) {
  if (doluYuva() < bosaltmaEsigi) return
  if (!sandiklar().length) {
    uyar(
      'sandik-yok',
      'Envanterim yarı doldu. Sandık gösterirsen (dibinde dur, !sandik ekle) oraya boşaltırım, yoksa dolunca dururum.',
      30 * 60000
    )
    return
  }
  await sandikZiyareti(id)
  // yanımda kalması gerekenler yüzünden hâlâ yarıdan fazlaysa her turda sandığa gitmesin
  bosaltmaEsigi = Math.max(YARI_DOLU, doluYuva() + 6)
}

// Envanter tamamen doluysa sandığa boşaltmayı dener. Yer açılmazsa nedeni döner.
async function yerAc(id) {
  if (bot.inventory.emptySlotCount() > 0) return null
  if (!sandiklar().length) return 'Envanterim doldu, duruyorum. (Sandık gösterirsen oraya boşaltırım: !sandik ekle)'
  await sandikZiyareti(id)
  return bot.inventory.emptySlotCount() > 0 ? null : 'Envanterim de sandıklarım da doldu, duruyorum.'
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

    const positions = bot
      .findBlocks({
        matching: matchFn,
        maxDistance: SEARCH_RADIUS,
        count: 20,
      })
      .filter((p) => !skipped.has(key(p)))

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
    if (!near && typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(b)) continue
    return b
  }
  return null
}

// Takılırsa vazgeçsin diye süreli yürüme
function gotoTimeout(goal, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      bot.pathfinder.setGoal(null)
      reject(new Error('zaman aşımı'))
    }, ms)
    bot.pathfinder.goto(goal).then(
      () => {
        clearTimeout(t)
        resolve()
      },
      (e) => {
        clearTimeout(t)
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

// ---------- ÇİFTÇİLİK ----------
// ürün adı -> { olgun yaş, ekim eşyası }
const CROPS = {
  wheat: { age: 7, seed: 'wheat_seeds' },
  carrots: { age: 7, seed: 'carrot' },
  potatoes: { age: 7, seed: 'potato' },
  beetroots: { age: 3, seed: 'beetroot_seeds' },
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
  if (!farmland || farmland.name !== 'farmland') return
  await bot.equip(seed, 'hand')
  try {
    await bot.placeBlock(farmland, new Vec3(0, 1, 0))
  } catch (_) {}
}

async function farmTask(id) {
  const skipped = new Set()
  const cropIds = Object.keys(CROPS)
    .map((n) => bot.registry.blocksByName[n])
    .filter(Boolean) // eski sürümlerde bazı ekinler yok
    .map((b) => b.id)

  while (calisiyor(id)) {
    const dolu = await yerAc(id)
    if (dolu) return gorevNotu(id, dolu)
    await gerekirseBosalt(id)

    const positions = bot
      .findBlocks({
        matching: (b) => cropIds.includes(b.type) && isRipe(b),
        maxDistance: SEARCH_RADIUS,
        count: 30,
      })
      .filter((p) => !skipped.has(key(p)))

    if (positions.length === 0) {
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
        if (!block || !isRipe(block)) continue
        const cropName = block.name
        await kaz(block)
        await replant(pos, cropName)
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
bot.on('kicked', (r) => console.log('[olay] Sunucudan atıldı:', JSON.stringify(r).slice(0, 300)))
bot.on('error', (e) => {
  console.log('[olay] Hata:', e.message || e)
  // Daha bağlanmadan (ör. Microsoft girişi başarısız) hata olursa 'end' gelmez
  if (!hazir && !bot._client?.socket) process.exit(1)
})
bot.on('death', () => {
  console.log('[olay] Bot öldü')
  const p = bot.entity ? bot.entity.position : null
  const yer = p ? `konum ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : ''
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
  process.exit(0) // discordbot.js kapanışı görsün
})
