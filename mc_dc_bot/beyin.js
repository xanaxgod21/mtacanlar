// beyin.js — Yaren'in yapay zeka beyni (Anthropic API)
//
// Ne yapar:
//  - Serbest cümleleri anlar ("biraz odun lazım" gibi) ve görev araçlarını çağırır
//  - Karar vermeden önce durumuna bakar (envanter, can, açlık, gece/gündüz)
//  - Görev sonuçlarını ve hataları deneyim defterine (deneyim.json) yazar
//  - Başarısızlıklardan ders çıkarır; dersler sonraki konuşma ve kararlarda
//    sistem talimatına eklenir (model yeniden eğitilmez, defter okunur)
//
// Hareket, kırma ve ekme işini hâlâ gorevbot.js'deki kod yapar.

const fs = require('fs')
const path = require('path')

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_TIMEOUT_MS = 30000
const MAX_DERS = 40
const MAX_OLAY = 100

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TOOLS = [
  {
    name: 'gorev_baslat',
    description:
      'Bir görev başlatır. farm: olgun ekinleri toplar ve yeniden eker. odun: ağacı baltayla keser, yapraklarını elle kırar, fidan diker (ev gibi yapılara dokunmaz). tas: doğal taş kırar, cobblestone yapılara dokunmaz (kazma gerekir). maden: cevher kazar (kömür, demir, bakır, altın, elmas...), görünen cevher yoksa tünel açarak arar (kazma gerekir). bosalt: topladıklarını sandığa bırakır. Görevler topladığını kendiliğinden sandığa götürür (bir yığın toplayınca, envanter dolunca ve görev bitince): sahip sandık gösterdiyse oraya, göstermediyse görevin başladığı yere en yakın sandığa. Alet kırılmak üzereyse gösterilen sandıktan yenisi alınır. Çalışan görev varsa onu bırakıp yenisine geçer.',
    input_schema: {
      type: 'object',
      properties: {
        gorev: { type: 'string', enum: ['farm', 'odun', 'tas', 'maden', 'bosalt'] },
        dakika: {
          type: 'integer',
          description: 'Kaç dakika çalışsın. Boşsa durdurulana kadar. Otonom modda en fazla 8.',
        },
      },
      required: ['gorev'],
    },
  },
  {
    name: 'gorev_durdur',
    description: 'Çalışan görevi ve otonom modu durdurur.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'yanima_gel',
    description: 'Sahibinin yanına yürür ve mevcut görevi bırakır.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'durum_bak',
    description:
      'Konum, can, açlık, gece/gündüz, boş slot, envanter, aktif görev ve son görev sonucunu verir. Karar vermeden önce bak.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'otonom_mod',
    description:
      'Açıksa kendi kendine karar verip görevleri sırayla yapar. Kapatmak için ac=false.',
    input_schema: {
      type: 'object',
      properties: { ac: { type: 'boolean' } },
      required: ['ac'],
    },
  },
  {
    name: 'ders_kaydet',
    description:
      'Bir deneyimden çıkardığın kısa, genel ve uygulanabilir dersi deneyim defterine yazar. Sadece gelecekte işe yarayacak dersleri yaz.',
    input_schema: {
      type: 'object',
      properties: {
        gorev: { type: 'string', description: 'farm, odun, tas, maden veya genel' },
        ders: { type: 'string', description: 'Tek cümlelik ders' },
      },
      required: ['ders'],
    },
  },
]

function createBrain({
  apiKey,
  model,
  owner,
  dataFile,
  log,
  getState,
  actions,
  fetchFn,
  gunlukLimit = 0, // günde en fazla bu kadar API isteği (0 = sınırsız)
  kullanimDosyasi = null,
}) {
  const doFetch = fetchFn || fetch
  // sahip sonradan değişebilir (/sahip): her istekte güncel adı al
  const sahipAdi = () => (typeof owner === 'function' ? owner() : owner) || 'henüz belli değil'
  const enabled = !!apiKey
  const say = log || (() => {})

  // ---------- Günlük kullanım sınırı ----------
  // Satışta yapay zeka parasını sen ödersin: bir müşteri günde sınırsız
  // konuşup faturanı şişirmesin. Sayım dosyada tutulur, bot yeniden
  // başlayınca sıfırlanmaz.
  const bugun = () => new Date().toLocaleDateString('sv-SE') // 2026-10-06 (yerel saat)
  let kullanim = { gun: bugun(), sayi: 0 }
  if (kullanimDosyasi) {
    try {
      const k = JSON.parse(fs.readFileSync(kullanimDosyasi, 'utf-8'))
      if (k && typeof k.sayi === 'number') kullanim = k
    } catch (_) {}
  }
  function hakKullan() {
    if (!gunlukLimit) return
    if (kullanim.gun !== bugun()) kullanim = { gun: bugun(), sayi: 0 }
    if (kullanim.sayi >= gunlukLimit) {
      const e = new Error('günlük yapay zeka sınırı doldu')
      e.limit = true
      throw e
    }
    kullanim.sayi++
    if (kullanimDosyasi) {
      try {
        fs.writeFileSync(kullanimDosyasi, JSON.stringify(kullanim), 'utf-8')
      } catch (_) {}
    }
  }

  // ---------- Deneyim defteri ----------
  let data = { dersler: [], olaylar: [] }
  let ham = ''
  try {
    ham = fs.readFileSync(dataFile, 'utf-8')
  } catch (_) {} // dosya yoksa sıfırdan başla
  if (ham.trim()) {
    try {
      const raw = JSON.parse(ham.replace(/^\uFEFF/, ''))
      data = {
        dersler: Array.isArray(raw.dersler) ? raw.dersler : [],
        olaylar: Array.isArray(raw.olaylar) ? raw.olaylar : [],
      }
    } catch (e) {
      // Bozuk dosyanın üstüne yazıp bütün dersleri kaybetmeyelim: önce yedeğini al
      const yedek = `${dataFile}.bozuk-${Date.now()}`
      try {
        fs.copyFileSync(dataFile, yedek)
      } catch (_) {}
      say('[ai] deneyim defteri bozuk, yedeği alındı:', path.basename(yedek))
    }
  }

  function save() {
    try {
      // Önce geçici dosyaya yaz, sonra yerine koy. Bot yazarken kapatılırsa
      // (/durdur) deneyim.json yarım kalıp bozulmasın.
      const tmp = dataFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
      fs.renameSync(tmp, dataFile)
    } catch (e) {
      say('[ai] deneyim defteri kaydedilemedi:', e.message)
    }
  }

  function recordEvent(olay) {
    data.olaylar.push({ t: new Date().toISOString(), ...olay })
    while (data.olaylar.length > MAX_OLAY) data.olaylar.shift()
    save()
  }

  function addDers(gorev, ders) {
    const text = String(ders || '').trim().slice(0, 220)
    if (!text) return 'Boş ders kaydedilemez.'
    if (data.dersler.some((d) => d.ders.toLowerCase() === text.toLowerCase())) {
      return 'Bu ders zaten kayıtlı.'
    }
    data.dersler.push({
      t: new Date().toISOString(),
      gorev: String(gorev || 'genel').slice(0, 20),
      ders: text,
    })
    while (data.dersler.length > MAX_DERS) data.dersler.shift()
    save()
    say('[ders] ' + text)
    return 'Ders kaydedildi.'
  }

  // ---------- Sistem talimatı ----------
  function systemPrompt() {
    const dersler =
      data.dersler
        .slice(-20)
        .map((d) => `- (${d.gorev || 'genel'}) ${d.ders}`)
        .join('\n') || '- (henüz yok)'
    return `Sen "Yaren" adında, Minecraft dünyasında yaşayan bir NPC'sin. Sahibin ${sahipAdi()}. Onun isteklerini yerine getirirsin.

Konuşma: Türkçe, samimi ve KISA konuş (en fazla 2 kısa cümle, sesli okunacak). Emoji ve madde işareti kullanma.

Nasıl çalışırsın:
- Bir oyuncu gibi düşün. Karar vermeden önce durum_bak ile envanterine, canına, açlığına ve gece/gündüze bak.
- Görevleri araçlarla başlatırsın. Yürüme, kırma ve ekme işini oyun kodu yapar; sen neyin ne zaman yapılacağına karar verirsin.
- Koşul uygun değilse (kazma yok, gece ve can düşük, envanter dolu) görevi başlatma. Nedenini sahibine söyle ve ne gerektiğini iste.
- Görevler topladığını kendiliğinden sandığa götürür: sahibin sandık gösterdiyse (durum_bak: sandik_sayisi) oraya, göstermediyse görevin başladığı yere en yakın sandığa. "Odun kes, sandığa götür" gibi isteklerde sadece görevi başlatman yeter. Yakında hiç sandık yoksa ve envanter dolarsa sahibinden "!sandik ekle" ile sandık göstermesini iste ve otonom modu kapat.
- Yapamayacağın bir şeyi yapabiliyormuş gibi davranma, dürüstçe söyle.
- Bir görev başarısız olursa nedenini düşün. Gelecekte işe yarayacak genel bir ders çıkarırsan ders_kaydet ile yaz.

Geçmiş deneyimlerinden çıkardığın dersler (bunlara göre karar ver):
${dersler}`
  }

  // ---------- API ----------
  async function callApi(system, messages) {
    hakKullan()
    // 429 (çok istek), 5xx ve 529 (aşırı yoğunluk) geçicidir: bekleyip 3 kez dene
    for (let deneme = 1; ; deneme++) {
      let r
      try {
        r = await doFetch(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({ model, max_tokens: 500, system, tools: TOOLS, messages }),
          // Cevap hiç gelmezse sonsuza kadar bekleme: istekler sıraya girdiği
          // için takılan tek istek bütün yapay zekayı kilitler.
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
      } catch (e) {
        if (deneme < 3) {
          await sleep(1000 * deneme)
          continue
        }
        throw new Error(e.name === 'TimeoutError' ? 'API zaman aşımı' : e.message)
      }
      if (r.ok) return r.json()
      if ((r.status === 429 || r.status >= 500) && deneme < 3) {
        const sn = Number(r.headers?.get?.('retry-after')) || deneme * 2
        await sleep(Math.min(sn, 10) * 1000)
        continue
      }
      const t = await r.text().catch(() => '')
      // Ayrıntı (ör. "kredi bitti", "anahtar geçersiz") sadece satıcının loguna
      say('[satıcı] Anthropic API hatası', r.status, String(t).slice(0, 300))
      throw new Error(`API ${r.status}`)
    }
  }

  async function runTool(name, input, ctx) {
    if (ctx.yansitma && !['ders_kaydet', 'durum_bak'].includes(name)) {
      return 'Şu an sadece ders kaydedebilirsin.'
    }
    switch (name) {
      case 'gorev_baslat':
        return actions.start(input.gorev, input.dakika, ctx.otonom)
      case 'gorev_durdur':
        return actions.stop()
      case 'yanima_gel':
        return actions.come()
      case 'durum_bak':
        return JSON.stringify(getState())
      case 'otonom_mod':
        return actions.auto(!!input.ac)
      case 'ders_kaydet':
        return addDers(input.gorev, input.ders)
      default:
        return 'Bilinmeyen araç: ' + name
    }
  }

  // Araç çağırma döngüsü: model araç ister, biz çalıştırır, sonucu veririz
  async function run({ userText, history, ctx }) {
    const system = systemPrompt()
    const messages = [...(history || []), { role: 'user', content: userText }]
    for (let round = 0; round < 6; round++) {
      const res = await callApi(system, messages)
      res.content = res.content || []
      messages.push({ role: 'assistant', content: res.content })
      if (res.stop_reason !== 'tool_use') {
        return res.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim()
      }
      const results = []
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue
        let out
        try {
          out = await runTool(b.name, b.input || {}, ctx)
        } catch (e) {
          out = 'Hata: ' + e.message
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: String(out) })
      }
      messages.push({ role: 'user', content: results })
    }
    return 'Biraz kafam karıştı, tekrar söyler misin?'
  }

  // Aynı anda birden fazla çağrı çakışmasın
  let chain = Promise.resolve()
  function queue(fn) {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }

  // ---------- Dışarı açılanlar ----------
  const history = []

  function ask(text) {
    if (!enabled) return Promise.resolve('Yapay zeka anahtarı yok.')
    return queue(async () => {
      try {
        const cevap =
          (await run({ userText: text, history, ctx: { otonom: false } })) || 'Tamam.'
        history.push({ role: 'user', content: text }, { role: 'assistant', content: cevap })
        while (history.length > 12) history.splice(0, 2)
        return cevap
      } catch (e) {
        say('[ai] hata:', e.message)
        if (e.limit) return 'Bugünlük konuşma hakkım bitti, yarın yine konuşalım.'
        return 'Şu an düşünemiyorum.'
      }
    })
  }

  // Otonom modda: durumuna bakıp sıradaki görevi seçer
  function decide(sonSonuc) {
    if (!enabled) return Promise.resolve('')
    return queue(async () => {
      try {
        const prompt = `Otonom moddasın. Son görev sonucu: ${sonSonuc || 'yok (yeni başlıyorsun)'}.
Önce durum_bak ile durumuna bak, sonra bir oyuncu gibi düşünüp şu an en mantıklı görevi gorev_baslat ile başlat (dakika ver, en fazla 8). Hiçbir görev uygun değilse görev başlatma ve nedenini kısaca söyle.`
        return await run({ userText: prompt, history: [], ctx: { otonom: true } })
      } catch (e) {
        say('[ai] karar hatası:', e.message)
        return ''
      }
    })
  }

  // Başarısızlıktan ders çıkarır (en fazla 2 dakikada bir)
  let sonYansitma = 0
  function reflect(olay) {
    if (!enabled) return Promise.resolve('')
    if (Date.now() - sonYansitma < 120000) return Promise.resolve('')
    sonYansitma = Date.now()
    return queue(async () => {
      try {
        const son = data.olaylar
          .slice(-8)
          .map((o) => `- ${o.gorev}: ${o.sebep} (${o.ozet || ''})`)
          .join('\n')
        const prompt = `Az önce şu oldu: ${olay.gorev} görevi "${olay.sebep}" nedeniyle sonlandı. Sonuç: ${olay.ozet || 'yok'}.
Son olaylar:
${son}

Bundan gelecekte işe yarayacak GENEL bir ders çıkar ve ders_kaydet ile yaz (zaten yazılı bir dersin tekrarı olmasın). Sahibine söylemeye değer bir şey varsa tek kısa cümleyle söyle, yoksa sadece "sessiz" yaz.`
        const t = await run({
          userText: prompt,
          history: [],
          ctx: { otonom: false, yansitma: true },
        })
        return /^sessiz\.?$/i.test(t.trim()) ? '' : t
      } catch (e) {
        say('[ai] yansıtma hatası:', e.message)
        return ''
      }
    })
  }

  return {
    enabled,
    ask,
    decide,
    reflect,
    recordEvent,
    dersler: () => data.dersler,
    kullanim: () => ({ ...kullanim, limit: gunlukLimit }),
  }
}

module.exports = createBrain
