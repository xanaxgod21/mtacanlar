// zanaat.js — Yaren'in kendi aletini yapması
//
// Alet lazım olunca (kazması, baltası kırıldı ya da yok) üstündeki en değerli
// malzemeden yenisini yapar: elmas > demir > taş > tahta. Ham metali (ham demir,
// demir cevheri) varsa fırın kurup eritir, külçeden alet yapar. Kütükten tahta,
// tahtadan çubuk, gerekirse çalışma masası ve fırın da yapar; işi bitince koyduğu
// masayı ve fırını geri alır. Yakındaki masayı / boş fırını kullanır.
//
// Kurulum: const zanaat = require('./zanaat')(bot, ayarlar) -- ayarlar aşağıda

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TURLER = {
  pickaxe: { ad: 'kazma', malzeme: 3, cubuk: 2 },
  axe: { ad: 'balta', malzeme: 3, cubuk: 2 },
  shovel: { ad: 'kürek', malzeme: 1, cubuk: 2 },
  sword: { ad: 'kılıç', malzeme: 2, cubuk: 1 },
  hoe: { ad: 'çapa', malzeme: 2, cubuk: 2 },
}
const TAS = ['cobblestone', 'cobbled_deepslate', 'blackstone']
const DEMIR_HAM = ['raw_iron', 'iron_ore', 'deepslate_iron_ore']
// yakıt: bir tanesi kaç eşya pişirir
const YAKIT = [
  [/^(coal|charcoal)$/, 8],
  [/^coal_block$/, 80],
  [/^blaze_rod$/, 12],
  [/_planks$|^planks$/, 1.5],
  [/_log$|_wood$|_stem$|_hyphae$|^log2?$/, 1.5],
  [/^stick$/, 0.5],
]
const KUTUK_RE = /_log$|_wood$|_stem$|_hyphae$|^log2?$/
const KALAS_RE = /_planks$|^planks$/

module.exports = function kurZanaat(bot, ay) {
  // ay: { goals, log, kaz(blok), topla(), aletTuru(item), istatistik(tur, ad), mesgul: () => bool }
  const kayit = () => bot.registry
  const esya = (ad) => kayit().itemsByName[ad]
  const adet = (test) =>
    bot.inventory.items().reduce((t, i) => t + ((typeof test === 'string' ? i.name === test : test(i.name)) ? i.count : 0), 0)
  const ilk = (test) => bot.inventory.items().find((i) => (typeof test === 'string' ? i.name === test : test(i.name))) || null

  // ---------- tahta, çubuk ----------
  function kalasAdi(kutuk) {
    if (kutuk === 'log' || kutuk === 'log2') return 'planks' // eski sürüm
    const ad = kutuk.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '_planks')
    return esya(ad) ? ad : null
  }
  const kalasSayisi = () => adet((n) => KALAS_RE.test(n))
  const kutukSayisi = () => adet((n) => KUTUK_RE.test(n) && !!kalasAdi(n))

  async function zanaatYap(ad, kac, masa = null) {
    const it = esya(ad)
    if (!it) throw new Error(`${ad} bu sürümde yok`)
    const tarif = bot.recipesFor(it.id, null, 1, masa)[0]
    if (!tarif) throw new Error(`${ad} için malzeme yok`)
    await bot.craft(tarif, kac, masa)
  }

  async function kalasYap(gereken) {
    for (let deneme = 0; deneme < 6 && kalasSayisi() < gereken; deneme++) {
      const kutuk = ilk((n) => KUTUK_RE.test(n) && !!kalasAdi(n))
      if (!kutuk) break
      const kac = Math.min(kutuk.count, Math.ceil((gereken - kalasSayisi()) / 4))
      await zanaatYap(kalasAdi(kutuk.name), kac)
    }
    return kalasSayisi() >= gereken
  }

  async function cubukYap(gereken) {
    const eksik = gereken - adet('stick')
    if (eksik <= 0) return true
    const kac = Math.ceil(eksik / 4) // 2 tahta -> 4 çubuk
    if (!(await kalasYap(kac * 2))) return false
    await zanaatYap('stick', kac)
    return adet('stick') >= gereken
  }

  // ---------- yere koyma / geri alma ----------
  // Blok koymaya uygun yerler, yakından uzağa
  function yerler() {
    const ben = bot.entity.position.floored()
    const hepsi = []
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (Math.abs(dx) + Math.abs(dz) === 0) continue // kendi durduğu yer
          const p = ben.offset(dx, dy, dz)
          const b = bot.blockAt(p)
          const alt = bot.blockAt(p.offset(0, -1, 0))
          if (!b || !alt || b.boundingBox !== 'empty' || b.name.includes('water') || b.name.includes('lava')) continue
          if (alt.boundingBox !== 'block' || /chest|barrel|furnace|crafting/.test(alt.name)) continue
          // kendi kafasının olduğu yere koymasın
          if (p.x === ben.x && p.z === ben.z) continue
          const d = p.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.6, 0))
          if (d > 4) continue
          hepsi.push({ p, alt, d })
        }
      }
    }
    return hepsi.sort((a, b) => a.d - b.d)
  }

  async function koy(ad) {
    const { Vec3 } = require('vec3')
    const adaylar = yerler()
    if (!adaylar.length) throw new Error('koyacak yer bulamadım')
    let hata = null
    // sunucu bir yeri reddedebilir (yanındaki oyuncu, eklenti): birkaç yer dener
    for (const yer of adaylar.slice(0, 3)) {
      const it = ilk(ad)
      if (!it) throw new Error(`${ad} yok`)
      await bot.equip(it, 'hand')
      try {
        await bot.placeBlock(yer.alt, new Vec3(0, 1, 0))
      } catch (e) {
        hata = e
        await sleep(500) // sunucu geç onaylayabilir: blok yerinde mi bak
      }
      const b = bot.blockAt(yer.p)
      if (b && b.name === ad) return b
    }
    throw hata || new Error(`${ad} konamadı`)
  }

  async function geriAl(blok, aletTuru) {
    const b = blok && bot.blockAt(blok.position)
    if (!b || b.boundingBox === 'empty') return
    if (aletTuru === 'pickaxe' && !bot.inventory.items().some((i) => ay.aletTuru(i) === 'pickaxe')) {
      ay.log(`[zanaat] ${b.name} kazmasız kırılınca düşmez, yerinde bıraktım.`)
      return
    }
    const alet = bot.inventory.items().find((i) => ay.aletTuru(i) === aletTuru)
    if (alet) await bot.equip(alet, 'hand').catch(() => {})
    await ay.kaz(b)
    await sleep(300)
    await ay.topla()
  }

  // ---------- çalışma masası ----------
  async function masaHazirla() {
    const id = kayit().blocksByName.crafting_table?.id
    const yakin = bot.findBlock({ matching: id, maxDistance: 4 })
    if (yakin) return { blok: yakin, koyduk: false }
    if (!adet('crafting_table')) {
      if (!(await kalasYap(4))) throw new Error('çalışma masası için tahta yok')
      await zanaatYap('crafting_table', 1)
    }
    return { blok: await koy('crafting_table'), koyduk: true }
  }

  // ---------- fırın ve eritme ----------
  function yakitSec(kacEsya) {
    for (const [re, deger] of YAKIT) {
      const it = bot.inventory.items().filter((i) => re.test(i.name))
      const toplam = it.reduce((t, i) => t + i.count, 0)
      const gereken = Math.ceil(kacEsya / deger)
      if (toplam >= gereken && it.length) return { ad: it[0].name, adet: Math.min(gereken, it[0].count), hepsi: it }
    }
    return null
  }

  async function firinHazirla(masa) {
    const id = kayit().blocksByName.furnace?.id
    // yakındaki boş fırın (içinde başkasının eşyası olmayan)
    const yakin = bot.findBlocks({ matching: id, maxDistance: 5, count: 4 }).map((p) => bot.blockAt(p))
    for (const f of yakin) {
      if (f) return { blok: f, koyduk: false, bos: true }
    }
    if (!adet('furnace')) {
      if (adet((n) => TAS.includes(n)) < 8) throw new Error('fırın için 8 taş (cobblestone) yok')
      await zanaatYap('furnace', 1, masa)
    }
    return { blok: await koy('furnace'), koyduk: true }
  }

  // hamAdlar'dan kac tanesini eritir; çıkan külçe sayısını döndürür
  async function erit(hamAdlar, kac, masa) {
    const yakit = yakitSec(kac)
    if (!yakit) throw new Error('fırın için yakıt (kömür ya da tahta) yok')
    const firin = await firinHazirla(masa)
    let pencere
    let cikan = 0
    try {
      pencere = await bot.openFurnace(firin.blok)
      if (pencere.inputItem() || pencere.outputItem()) {
        // başkasının işi var: dokunma
        throw new Error('yakındaki fırın dolu')
      }
      const sonuc = kayit().itemsByName.iron_ingot.id
      await pencere.putFuel(esya(yakit.ad).id, null, yakit.adet)
      let konan = 0
      for (const ad of hamAdlar) {
        const n = Math.min(adet(ad), kac - konan)
        if (n > 0) {
          await pencere.putInput(esya(ad).id, null, n)
          konan += n
        }
        if (konan >= kac) break
      }
      ay.log(`[zanaat] Fırında ${konan} ham demir eritiyorum (~${konan * 10} sn).`)
      const t0 = Date.now()
      while (Date.now() - t0 < konan * 12000 + 15000) {
        const c = pencere.outputItem()
        if (c && c.type === sonuc && c.count >= konan) break
        if (!pencere.inputItem() && c) break // girdi bitti
        await sleep(500)
      }
      if (pencere.outputItem()) {
        cikan = pencere.outputItem().count
        await pencere.takeOutput()
      }
    } finally {
      try {
        pencere?.close()
      } catch (_) {}
    }
    if (firin.koyduk) await geriAl(firin.blok, 'pickaxe').catch(() => {})
    return cikan
  }

  // ---------- alet ----------
  const SIRA = ['diamond', 'iron', 'stone', 'wooden']
  function malzemeDurumu(tur, { masaVar }) {
    const t = TURLER[tur]
    const durum = []
    if (adet('diamond') >= t.malzeme) durum.push({ mal: 'diamond' })
    const kulce = adet('iron_ingot')
    const ham = adet((n) => DEMIR_HAM.includes(n))
    if (kulce >= t.malzeme) durum.push({ mal: 'iron' })
    else if (kulce + ham >= t.malzeme && yakitSec(t.malzeme - kulce)) {
      // eritmek için fırın lazım: elde fırın, yakında fırın ya da 8 taş
      durum.push({ mal: 'iron', erit: t.malzeme - kulce })
    }
    if (adet((n) => TAS.includes(n)) >= t.malzeme) durum.push({ mal: 'stone' })
    const tahtaLazim = t.malzeme + (masaVar ? 0 : 4)
    if (kalasSayisi() + kutukSayisi() * 4 >= tahtaLazim) durum.push({ mal: 'wooden' })
    return durum.sort((a, b) => SIRA.indexOf(a.mal) - SIRA.indexOf(b.mal))
  }

  const katman = (ad) => {
    const i = SIRA.findIndex((m) => ad.startsWith(m + '_') || (m === 'wooden' && ad.startsWith('wooden_')))
    return i === -1 ? SIRA.length : i // küçük = daha iyi
  }

  // tur: pickaxe | axe | shovel | sword | hoe | fishing_rod
  // sadece: 'iron' verilirse sadece demirden yapılır (yükseltme: elmasları harcamaz)
  // Döner: { ok, ad } ya da { ok: false, neden }
  let calisiyor = false
  async function aletYap(tur, { sadece = null } = {}) {
    if (calisiyor) return { ok: false, neden: 'zaten bir şey yapıyorum' }
    calisiyor = true
    const koyulanlar = []
    try {
      if (tur === 'fishing_rod') {
        if (adet('string') < 2) return { ok: false, neden: 'olta için 2 ip lazım' }
        if (!(await cubukYap(3))) return { ok: false, neden: 'olta için çubuk yapacak tahta yok' }
        const masa = await masaHazirla()
        if (masa.koyduk) koyulanlar.push(masa)
        await zanaatYap('fishing_rod', 1, masa.blok)
        ay.istatistik('yapilan', 'fishing_rod')
        return { ok: true, ad: 'fishing_rod' }
      }
      const t = TURLER[tur]
      if (!t) return { ok: false, neden: 'bilmediğim alet' }
      const masaId = kayit().blocksByName.crafting_table?.id
      const masaVar = !!adet('crafting_table') || !!bot.findBlock({ matching: masaId, maxDistance: 4 })
      let secenekler = malzemeDurumu(tur, { masaVar })
      if (sadece) secenekler = secenekler.filter((s) => s.mal === sadece)
      if (!secenekler.length) {
        return { ok: false, neden: `${t.ad} yapacak malzeme yok (elmas, demir, taş ya da tahta/kütük lazım)` }
      }
      let sonHata = ''
      for (const s of secenekler) {
        const ad = `${s.mal}_${tur}`
        if (!esya(ad)) continue
        try {
          if (!(await cubukYap(t.cubuk))) throw new Error('çubuk yapacak tahta yok')
          const masa = await masaHazirla()
          if (masa.koyduk) koyulanlar.push(masa)
          if (s.erit) {
            const cikan = await erit(DEMIR_HAM, s.erit, masa.blok)
            if (adet('iron_ingot') < t.malzeme) throw new Error(`yeterli demir eritilemedi (${cikan} külçe)`)
          }
          // tahta aletin malzemesi: masa ve çubuktan sonra kalan kütükler de tahtaya çevrilir
          if (s.mal === 'wooden' && !(await kalasYap(t.malzeme))) throw new Error('yeterli tahta yok')
          const once = adet(ad)
          await zanaatYap(ad, 1, masa.blok)
          if (adet(ad) <= once) throw new Error(`${ad} yapılamadı`)
          ay.log(`[zanaat] Yeni ${t.ad} yaptım: ${ad}.`)
          ay.istatistik('yapilan', ad)
          return { ok: true, ad }
        } catch (e) {
          sonHata = e.message || String(e)
          ay.log(`[zanaat] ${ad} yapılamadı: ${sonHata}`)
        }
      }
      return { ok: false, neden: sonHata || `${t.ad} yapılamadı` }
    } catch (e) {
      return { ok: false, neden: e.message || String(e) }
    } finally {
      // koyduğu masayı geri al (fırın erit() içinde alındı)
      for (const k of koyulanlar) await geriAl(k.blok, 'axe').catch(() => {})
      calisiyor = false
    }
  }

  // Kazması demirden kötüyse ve demir yapacak malzemesi (külçe ya da eritilecek ham
  // demir + yakıt) varsa true: demir kazma yapılabilir (elmaslara dokunulmaz)
  function yukseltilebilir(tur = 'pickaxe') {
    const enIyi = bot.inventory.items().filter((i) => ay.aletTuru(i) === tur).map((i) => katman(i.name))
    const simdiki = enIyi.length ? Math.min(...enIyi) : SIRA.length
    if (simdiki <= SIRA.indexOf('iron')) return false
    const masaId = kayit().blocksByName.crafting_table?.id
    const masaVar = !!adet('crafting_table') || !!bot.findBlock({ matching: masaId, maxDistance: 4 })
    return malzemeDurumu(tur, { masaVar }).some((s) => s.mal === 'iron')
  }

  // Elindekilerle bu alet yapılabilir mi (görev başlamadan "kazmam yok" demesin)
  function yapilabilir(tur) {
    if (!TURLER[tur]) return false
    const masaId = kayit().blocksByName.crafting_table?.id
    const masaVar = !!adet('crafting_table') || !!bot.findBlock({ matching: masaId, maxDistance: 4 })
    return malzemeDurumu(tur, { masaVar }).length > 0
  }

  return { aletYap, yukseltilebilir, yapilabilir, katman, TURLER, mesgul: () => calisiyor }
}
