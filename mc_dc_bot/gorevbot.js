// Mineflayer çok görevli bot: çiftçilik, odun kırma, taş kırma
// Kurulum: npm install mineflayer mineflayer-pathfinder vec3
// Çalıştırma: node gorevbot.js
//
// Oyun içi komutlar (sadece OWNER yazabilir):
//   !farm   -> olgun ürünleri toplar ve yeniden eker
//   !odun   -> yakındaki ağaçları keser
//   !tas    -> taş / cobblestone kırar
//   !gel    -> sana gelir
//   !dur    -> mevcut görevi durdurur
//   !durum  -> ne yaptığını söyler

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')

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
  })
}

// ---------- AYARLAR ----------
// discordbot.js bu değerleri ortam değişkeniyle verir.
// Elle çalıştırırsan sağdaki varsayılanlar kullanılır.
const OWNER = process.env.MC_OWNER || 'Lyraiv'
const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565', 10)
const BOT_NAME = process.env.MC_BOT_NAME || 'GorevBot'
const AUTH = process.env.MC_AUTH || 'offline' // 'offline' veya 'microsoft'
const VERSION = process.env.MC_VERSION || ''  // boşsa otomatik algılanır
const SEARCH_RADIUS = 48

// Yapay zeka: anahtarı ortam değişkeninden ya da anahtar.txt dosyasından okur.
// İkisi de yoksa yapay zeka kapalı kalır, bot eskisi gibi çalışır.
function readKeyFile() {
  try {
    return fs.readFileSync(path.join(__dirname, 'anahtar.txt'), 'utf-8').trim()
  } catch (_) {
    return ''
  }
}
const API_KEY = process.env.ANTHROPIC_API_KEY || readKeyFile()
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001'
// -----------------------------

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: BOT_NAME,
  auth: AUTH,
  ...(VERSION ? { version: VERSION } : {}),
})
bot.loadPlugin(pathfinder)

let taskId = 0          // her yeni görevde artar, eski görev bunu görünce durur
let currentTask = null  // 'farm' | 'odun' | 'tas' | null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = (p) => `${p.x},${p.y},${p.z}`

bot.once('spawn', () => {
  normalMovements = new Movements(bot)
  woodMovements = new Movements(bot)
  woodMovements.canDig = false // odun toplarken yaprakları kırmasın
  restoreMovements()
  console.log(`[olay] Sunucuya girdi: ${HOST}:${PORT} (${BOT_NAME})`)
  say('Hazırım! Komutlar: !farm !odun !tas !gel !dur !durum')
})

let lastSay = ''
function say(msg) {
  lastSay = String(msg)
  console.log('[bot]', msg)
  const parts = lastSay.match(/.{1,200}/gs) || []
  parts.forEach((p) => bot.chat(p)) // sohbet sınırı: parça parça gönder
}

// ---------- KOMUTLAR ----------
bot.on('chat', async (username, message) => {
  if (username !== OWNER) return
  const text = message.trim()
  if (text.startsWith('!')) return handleCommand(text.toLowerCase())
  const m = text.match(/^yaren[\s,:!]*(.*)$/i)
  if (m && brain.enabled) {
    const metin = m[1] || 'merhaba'
    console.log('[duydum]', metin)
    say(await brain.ask(metin))
  }
})

function handleCommand(cmd) {
  console.log('[komut]', cmd)
  if (['!farm', '!odun', '!tas', '!gel', '!dur'].includes(cmd)) otonomRun = 0
  switch (cmd) {
    case '!farm': return startTask('farm', farmTask)
    case '!odun': return startTask('odun', woodTask)
    case '!tas': return startTask('tas', stoneTask)
    case '!topla': return startTask('topla', () => collectDrops(16, 30))
    case '!otonom': return say(setAuto(true))
    case '!dur': return stopTask()
    case '!durum':
      return say(currentTask ? `Şu an görev: ${currentTask}` : 'Boştayım.')
    case '!gel': {
      stopTask()
      const p = bot.players[OWNER]?.entity
      if (!p) return say('Seni göremiyorum, yakın değilsin.')
      bot.pathfinder.goto(new goals.GoalNear(p.position.x, p.position.y, p.position.z, 2))
        .catch(() => say('Sana ulaşamadım.'))
      return
    }
  }
}

// ---------- YAPAY ZEKA BAĞLANTISI ----------
const counters = {} // kırılan blok sayaçları (görev özeti için)
bot.on('diggingCompleted', (block) => {
  counters[block.name] = (counters[block.name] || 0) + 1
})

let lastResult = ''  // son görevin özeti
let endNote = ''     // görevin neden bittiği (süre doldu vb.)
let otonomRun = 0    // 0 = kapalı, değilse çalışan döngünün numarası
let otonomSeq = 0

// Yapay zekanın "durum_bak" ile gördüğü bilgiler
function snapshot() {
  const envanter = {}
  for (const it of bot.inventory.items()) {
    envanter[it.name] = (envanter[it.name] || 0) + it.count
  }
  const p = bot.entity.position
  return {
    aktif_gorev: currentTask,
    otonom: otonomRun !== 0,
    konum: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
    can: bot.health,
    aclik: bot.food,
    gunduz: bot.time ? bot.time.isDay : null,
    bos_slot: bot.inventory.emptySlotCount(),
    envanter,
    son_gorev_sonucu: lastResult || null,
  }
}

// Süre sınırlı görev başlatır
function startTimed(gorev, dakika, otonom) {
  const fns = { farm: farmTask, odun: woodTask, tas: stoneTask }
  const fn = fns[gorev]
  if (!fn) return `Bilmediğim görev: ${gorev}`
  if (gorev === 'tas' && !bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) {
    return 'Kazmam yok, taş kıramam. Sahibimden kazma istemeliyim.'
  }
  if (!otonom) otonomRun = 0 // kullanıcı bir şey isteyince otonom biter
  const mins = dakika || (otonom ? 5 : 0)
  startTask(gorev, fn)
  const myId = taskId
  if (mins > 0) {
    setTimeout(() => {
      if (taskId === myId) {
        endNote = 'süre doldu'
        stopTask()
      }
    }, mins * 60000)
  }
  return `${gorev} görevi başladı${mins ? ` (${mins} dk)` : ''}.`
}

function setAuto(on) {
  if (!on) {
    otonomRun = 0
    return 'Otonom mod kapalı.'
  }
  if (!brain.enabled) return 'Otonom mod için yapay zeka anahtarı gerekli.'
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
  owner: OWNER,
  dataFile: path.join(__dirname, 'deneyim.json'),
  log: (...a) => console.log(...a),
  getState: snapshot,
  actions: {
    start: (gorev, dakika, otonom) => startTimed(gorev, dakika, otonom),
    stop: () => {
      handleCommand('!dur')
      return 'Görevi durdurdum.'
    },
    come: () => {
      handleCommand('!gel')
      return 'Yanına geliyorum.'
    },
    auto: (on) => setAuto(on),
  },
})
console.log('[ai]', brain.enabled ? `açık (${AI_MODEL})` : 'kapalı (anahtar yok)')

// Görev bitince: özet çıkar, deneyim defterine yaz, başarısızsa ders çıkar
function onTaskEnd({ name, natural, hata, startedAt, before, sebep }) {
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
  if (hata) neden = `hata: ${hata.message || hata}`
  else if (!natural) neden = endNote || 'durduruldu'
  else neden = sebep || 'bitti'
  endNote = ''

  const olay = { gorev: name, sebep: neden, ozet, dakika: dk }
  lastResult = `${name} (${dk} dk): ${ozet}; sebep: ${neden}`
  console.log(`[sonuç] ${lastResult}`)
  brain.recordEvent(olay)

  const kotu = hata || /bulamadım|envanter|kalmadı|kazma|hata|öldü/i.test(neden)
  if (kotu && name !== 'topla') {
    brain
      .reflect(olay)
      .then((t) => t && say(t))
      .catch(() => {})
  }
}

// ---------- SESLİ KOMUT İÇİN YEREL SUNUCU ----------
// ses.py buraya POST atar:
//   /komut {"komut": "farm"}        -> sabit komut
//   /soyle {"metin": "odun lazım"}  -> yapay zekaya serbest cümle
const http = require('http')
http
  .createServer((req, res) => {
    if (req.method !== 'POST' || (req.url !== '/komut' && req.url !== '/soyle')) {
      res.writeHead(404)
      return res.end()
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        const json = JSON.parse(body)
        if (req.url === '/komut') {
          handleCommand('!' + String(json.komut).toLowerCase())
          res.writeHead(200)
          return res.end('ok')
        }
        if (!brain.enabled) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ hata: 'yapay zeka kapalı' }))
        }
        const metin = String(json.metin || '').trim()
        console.log('[duydum]', metin)
        const cevap = await brain.ask(metin || 'merhaba')
        console.log('[yaren]', cevap)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ cevap }))
      } catch (_) {
        res.writeHead(400)
        res.end('hata')
      }
    })
  })
  .listen(3030, '127.0.0.1', () =>
    console.log('Ses komut sunucusu: 127.0.0.1:3030')
  )

function startTask(name, fn) {
  stopTask()
  const id = ++taskId
  currentTask = name
  const startedAt = Date.now()
  const before = { ...counters }
  say(`${name} görevi başladı.`)
  lastSay = ''
  let hata = null
  fn(id)
    .catch((e) => {
      hata = e
      console.error('Görev hatası:', e)
    })
    .finally(() => {
      const sebep = lastSay
      const natural = id === taskId
      if (natural) {
        currentTask = null
        say(`${name} görevi bitti.`)
      }
      onTaskEnd({ name, natural, hata, startedAt, before, sebep })
    })
}

function stopTask() {
  if (currentTask) console.log(`[görev] ${currentTask} durduruldu`)
  taskId++ // eski görev döngüsü id uyuşmazlığı görüp çıkar
  currentTask = null
  bot.pathfinder.setGoal(null)
}

// ---------- ARAÇ SEÇİMİ ----------
const MATERIALS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

async function equipTool(kind) {
  const rank = (item) => MATERIALS.findIndex((m) => item.name.startsWith(m))
  const tools = bot.inventory.items().filter((i) => i.name.endsWith('_' + kind))
  tools.sort((a, b) => rank(a) - rank(b))
  if (tools[0]) await bot.equip(tools[0], 'hand')
  return !!tools[0]
}

// ---------- YERDEKİ EŞYALARI TOPLA ----------
async function collectDrops(range = 8, maxItems = 12) {
  const ignore = new Set()
  for (let i = 0; i < maxItems; i++) {
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
async function gatherTask(id, { matchFn, toolKind, label, maxCount = 200, afterDig }) {
  const skipped = new Set() // ulaşılamayan blokları tekrar deneme
  let count = 0

  while (id === taskId && count < maxCount) {
    const positions = bot
      .findBlocks({
        matching: matchFn,
        maxDistance: SEARCH_RADIUS,
        count: 20,
      })
      .filter((p) => !skipped.has(key(p)))

    if (positions.length === 0) {
      say(`Yakında ${label} kalmadı.`)
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
      if (toolKind) await equipTool(toolKind)
      const block = bot.blockAt(pos)
      if (!block || !matchFn(block)) continue
      if (!bot.canDigBlock(block)) {
        skipped.add(key(pos))
        continue
      }
      await bot.dig(block)
      count++
      if (count % 5 === 0) console.log(`[${label}] ${count} blok kırıldı (son: ${block.name})`)
      await collectDrops()
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
const CLEAN_LEAVES = false // true yaparsan ağaç bitince yaprakları da kırar

// Hangi görev çalışıyorsa onun hareket ayarına dön
function restoreMovements() {
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
      await equipTool('shovel')
      await bot.dig(below)
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
          await equipTool('shovel')
          await bot.dig(b)
          n++
        }
      } catch (_) {}
    }
  } finally {
    restoreMovements()
  }
  if (n > 0) console.log(`[temizlik] ${n} iskele bloğu toplandı`)
  await collectDrops()
}

// Yaprakları kır (ulaşabildiği kadar); fidan, elma, çubuk yere düşer ve toplanır
async function cleanLeaves(id) {
  const skipped = new Set()
  let n = 0
  bot.pathfinder.setMovements(cleanMovements())
  try {
    while (id === taskId && n < 60) {
      const leaves = bot
        .findBlocks({ matching: isLeaves, maxDistance: 8, count: 20 })
        .filter((p) => !skipped.has(key(p)))
      if (leaves.length === 0) break
      leaves.sort(
        (a, b) =>
          a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
      )
      const pos = leaves[0]
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3))
        const b = bot.blockAt(pos)
        if (b && isLeaves(b) && bot.canDigBlock(b)) {
          await bot.dig(b)
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
  if (n > 0) console.log(`[temizlik] ${n} yaprak kırıldı`)
  await collectDrops(12, 30) // fidan, elma, çubuk
}

// Ağaç bitince (yakında kütük kalmayınca) temizle
async function treeCleanup(id) {
  await cleanBelow(id)
  if (CLEAN_LEAVES) await cleanLeaves(id)
  await collectDrops(14, 12) // kütük, fidan, elma, çubuk
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
    await bot.dig(b)
    return true
  } catch (_) {
    skipped.add(key(block.position))
    return false
  }
}

// Kesilen ağaca uygun fidanı seç (yoksa herhangi bir fidan)
function pickSapling(logName) {
  const species = logName.replace('_log', '')
  const exact = species === 'mangrove' ? 'mangrove_propagule' : `${species}_sapling`
  const items = bot.inventory.items()
  return (
    items.find((i) => i.name === exact && i.name !== 'dark_oak_sapling') ||
    items.find(
      (i) =>
        (i.name.endsWith('_sapling') || i.name === 'mangrove_propagule') &&
        i.name !== 'dark_oak_sapling' // tek fidan büyümez (2x2 ister)
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
  const structures = new Set() // çok büyük kütük yığınları (yapı olabilir), dokunma
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

  while (id === taskId) {
    try {
      if (bot.inventory.emptySlotCount() === 0) {
        say('Envanterim doldu, duruyorum.')
        break
      }

      markVisited()
      await collectDrops(14, 12) // düşen fidan, elma, çubuk vb. otomatik topla

      const target = findVisibleLog(skipped, structures)
      if (!target) {
        misses++
        if (misses === 1 || misses % 5 === 0) {
          console.log(`[odun] ağaç göremiyorum, yürüyorum (${misses}. deneme)`)
        }
        if (misses > 30) {
          say('Etrafta ağaç bulamadım, duruyorum.')
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

      const cut = await cutTree(id, tree.logs, skipped)
      if (cut > 0) {
        count += cut
        console.log(`[odun] ağaç kesildi (${cut} kütük, toplam ${count})`)
        await collectDrops()
        await treeCleanup(id)
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
        say('Üst üste hata aldım, duruyorum.')
        break
      }
      await sleep(1000)
    }
  }

  if (id === taskId) {
    try {
      await cleanBelow(id)
      await cleanLeftovers(id)
      if (CLEAN_LEAVES) await cleanLeaves(id)
      await collectDrops(14, 12)
      await plantSaplings(id)
    } catch (e) {
      console.log(`[hata] son temizlik: ${e.message || e}`)
    }
  }
}

// ---------- TAŞ ----------
async function stoneTask(id) {
  const hasPick = await equipTool('pickaxe')
  if (!hasPick) {
    say('Kazma yok! Envanterime bir kazma ver.')
    return
  }
  return gatherTask(id, {
    matchFn: (b) => b.name === 'stone' || b.name === 'cobblestone',
    toolKind: 'pickaxe',
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
  return !!crop && block.getProperties().age === crop.age
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
  const cropIds = Object.keys(CROPS).map((n) => bot.registry.blocksByName[n].id)

  while (id === taskId) {
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
      if (id !== taskId) return
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
        const block = bot.blockAt(pos)
        if (!block || !isRipe(block)) continue
        const cropName = block.name
        await bot.dig(block)
        await replant(pos, cropName)
        bot._hasat = (bot._hasat || 0) + 1
        if (bot._hasat % 10 === 0) console.log(`[farm] ${bot._hasat} ürün hasat edildi (son: ${cropName})`)
      } catch (_) {
        skipped.add(key(pos))
      }
    }
    await collectDrops()
  }
}

bot.on('kicked', (r) => console.log('[olay] Sunucudan atıldı:', JSON.stringify(r)))
bot.on('error', (e) => console.log('[olay] Hata:', e.message || e))
bot.on('death', () => {
  console.log('[olay] Bot öldü')
  const p = bot.entity ? bot.entity.position : null
  const olay = {
    gorev: currentTask || '-',
    sebep: 'öldü',
    ozet: p ? `konum ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '',
  }
  brain.recordEvent(olay)
  brain.reflect(olay).then((t) => t && say(t)).catch(() => {})
})
bot.on('end', (reason) => {
  console.log('[olay] Bağlantı koptu:', reason)
  process.exit(0) // discordbot.js kapanışı görsün
})
