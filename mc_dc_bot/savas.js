// savas.js — Yaren'in kendini koruması
//
// Yakına gelen düşman yaratıklarla (zombi, iskelet, örümcek...) en iyi kılıcı ya da
// baltasıyla savaşır. Creeper, warden gibi tehlikelilerden ve canı azalınca kaçar.
// Savaş sürerken görevler bekler (gorevbot.js yürümeyi ve kazmayı sarmalar), savaş
// bitince elindeki aleti geri alır ve görev kaldığı yerden devam eder.
// Oyunculara ve adı konmuş yaratıklara (sunucu NPC'si, evcil) hiç dokunmaz.
//
// Kurulum: const savas = require('./savas')(bot, ayarlar) -- ayarlar aşağıda

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Kovalayıp savaştıkları
const KOVALA = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'spider', 'cave_spider', 'witch', 'slime', 'magma_cube', 'silverfish', 'endermite', 'pillager',
  'vindicator', 'hoglin', 'zoglin', 'piglin_brute',
])
// Sadece yanına gelince vurdukları (uçanlar, kovalaması tehlikeli olanlar)
const YERINDE = new Set(['phantom', 'blaze', 'vex', 'guardian'])
// Kaçtıkları
const KACIS = new Set(['creeper', 'warden', 'ravager', 'evoker'])
// Uzaktan saldıranlar: daha uzaktan fark edilir
const UZAKTAN = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze'])
// XP (yaratık çiftliği) modunda bunlar da vurulur: çiftlikte toplanmış olurlar
const CIFTLIK = new Set(['zombified_piglin', 'zombie_pigman', 'enderman', 'piglin'])

const KACIS_CAN = 6 // can bu kadar ya da azsa savaşmaz, kaçar (20 üzerinden)

module.exports = function kurSavas(bot, ay) {
  // ay: { goals, log, iyiSilah, yemekYe, istatistik, acik: () => bool,
  //       yerinde: () => bool (XP modu: yerinden kıpırdama), korunan: () => entity | null }
  const { goals } = ay
  let savasta = false
  let seq = 0 // kaç kez savaşa girildi: görevler kesintinin savaştan olduğunu anlasın
  let bekleyenler = []
  let sonVurulma = 0

  let yeniSavas = true // 1.9+ vuruş bekleme süresi
  try {
    yeniSavas = bot.registry.version['>=']('1.9')
  } catch (_) {}

  const canli = (e) => !!e && bot.entities[e.id] === e
  const mesafe = (e) => e.position.distanceTo(bot.entity.position)
  function adliMi(e) {
    try {
      return !!e.getCustomName?.()
    } catch (_) {
      return false
    }
  }
  // gözünden yaratığın gövdesine engel yok mu (duvarın arkasındakiyle uğraşma)
  function gorur(e) {
    const goz = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
    const yon = e.position.offset(0, (e.height || 1.8) * 0.7, 0).minus(goz)
    const uzunluk = yon.norm()
    if (uzunluk < 1) return true
    const carpan = bot.world.raycast(goz, yon.normalize(), uzunluk) // normalize yerinde değiştirir: uzunluk önce
    return !carpan
  }

  // En tehlikeli yakın yaratık: { e, kac } ya da null
  function tehditBul(genis = false) {
    if (!bot.entity) return null
    const yerinde = ay.yerinde()
    const korunan = yerinde ? null : ay.korunan()
    let en = null
    let enPuan = Infinity
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position || e.type === 'player' || !e.name) continue
      const ad = e.name
      const kac = KACIS.has(ad) && !yerinde
      if (!kac && !KOVALA.has(ad) && !YERINDE.has(ad) && !(yerinde && CIFTLIK.has(ad))) continue
      if (adliMi(e)) continue
      const d = mesafe(e)
      let menzil = yerinde ? 4.5 : kac ? 5 : UZAKTAN.has(ad) ? 12 : 7
      if (genis && !yerinde) menzil = Math.max(menzil, 16) // vurulduysa uzaktakini de ara
      const korunanaYakin = korunan && e.position.distanceTo(korunan.position) <= 8
      if (d > menzil && !korunanaYakin) continue
      if (d > 3 && Math.abs(e.position.y - bot.entity.position.y) > 5) continue // başka katta (mağara)
      if (ad === 'drowned' && d > 3) continue // suyun içindekini kovalama
      if (YERINDE.has(ad) && d > 4.5) continue
      if (!gorur(e)) continue
      const puan = kac ? d - 100 : d // kaçılacak olan önce
      if (puan < enPuan) [en, enPuan] = [{ e, kac }, puan]
    }
    return en
  }

  function vurusAraligi(el) {
    if (!yeniSavas) return 300
    if (!el) return 300
    if (el.name.endsWith('_sword')) return 650
    if (el.name.endsWith('_axe')) return 1050
    if (el.name.endsWith('_pickaxe')) return 850
    return 300
  }

  async function kac(e, sure = 8000) {
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(e, 12)), true)
    const t0 = Date.now()
    while (canli(e) && bot.health > 0 && mesafe(e) < 12 && Date.now() - t0 < sure) await sleep(150)
    bot.pathfinder.setGoal(null)
  }

  async function vurus(e) {
    const silah = ay.iyiSilah()
    if (silah && bot.heldItem?.slot !== silah.slot) await bot.equip(silah, 'hand').catch(() => {})
    const kovala = KOVALA.has(e.name) && !ay.yerinde()
    if (kovala) bot.pathfinder.setGoal(new goals.GoalFollow(e, 1.5), true)
    const aralik = vurusAraligi(bot.heldItem)
    let son = 0
    const t0 = Date.now()
    while (canli(e) && bot.health > 0 && Date.now() - t0 < 30000) {
      if (bot.health <= KACIS_CAN && !ay.yerinde()) {
        ay.log(`[savas] Canım azaldı (${Math.round(bot.health)}/20), ${e.name} yaratığından kaçıyorum.`)
        await kac(e)
        return false
      }
      const d = mesafe(e)
      if (d > (kovala ? 16 : 5)) break // uzaklaştı
      if (d < 3.3 && Date.now() - son >= aralik) {
        await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.8, 0), true).catch(() => {})
        bot.attack(e)
        son = Date.now()
      }
      await sleep(60)
    }
    return !canli(e)
  }

  async function savas(t) {
    savasta = true
    seq++
    const oncekiEl = bot.heldItem ? bot.heldItem.name : null
    const ad = t.e.name
    try {
      try {
        bot.stopDigging()
      } catch (_) {}
      bot.pathfinder.setGoal(null)
      if (t.kac || bot.health <= KACIS_CAN) {
        if (!ay.yerinde()) {
          ay.log(`[savas] ${ad} yaklaştı, uzaklaşıyorum.`)
          await kac(t.e)
        }
      } else {
        ay.log(`[savas] ${ad} saldırıyor, savaşıyorum.`)
        const oldu = await vurus(t.e)
        if (oldu) {
          ay.log(`[savas] ${ad} öldürüldü.`)
          ay.istatistik('yaratik', ad)
        }
      }
    } catch (err) {
      ay.log(`[savas] hata: ${err.message || err}`)
    } finally {
      try {
        bot.pathfinder.setGoal(null)
        bot.clearControlStates()
      } catch (_) {}
      // savaş bitince canı azsa yemek yer (iyileşmek için doymuş olmak lazım)
      if (bot.health > 0 && bot.health < 14) await ay.yemekYe().catch(() => {})
      // görevin aletini geri al
      if (oncekiEl && bot.heldItem?.name !== oncekiEl) {
        const it = bot.inventory.items().find((i) => i.name === oncekiEl)
        if (it) await bot.equip(it, 'hand').catch(() => {})
      }
      savasta = false
      for (const coz of bekleyenler.splice(0)) coz()
    }
  }

  let calisiyor = false
  async function tik(genis = false) {
    if (calisiyor || savasta || !ay.acik() || !bot.entity || !(bot.health > 0) || bot.currentWindow) return
    calisiyor = true
    try {
      const t = tehditBul(genis)
      if (t) await savas(t)
    } finally {
      calisiyor = false
    }
  }
  const zamanlayici = setInterval(() => tik().catch(() => {}), 250)
  zamanlayici.unref?.()
  // vurulunca (ör. uzaktan ok) daha geniş ara
  bot.on('entityHurt', (e) => {
    if (e !== bot.entity) return
    sonVurulma = Date.now()
    tik(true).catch(() => {})
  })
  bot.on('death', () => {
    // ölünce savaş biter, bekleyen görevler takılı kalmasın
    if (savasta) {
      savasta = false
      for (const coz of bekleyenler.splice(0)) coz()
    }
  })

  return {
    savasta: () => savasta,
    seq: () => seq,
    sonVurulma: () => sonVurulma,
    // savaş bitene kadar bekler (savaş yoksa hemen döner)
    bekle: () => (savasta ? new Promise((coz) => bekleyenler.push(coz)) : Promise.resolve()),
    tehditBul,
  }
}
