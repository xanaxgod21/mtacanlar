// ag.js — müşteri botlarının bağlanabileceği adresler
//
// Botlar SENİN makinende çalışır. Müşteri host olarak 127.0.0.1 ya da
// 192.168.x.x yazarsa (ya da kendi alan adını sonradan oraya çevirirse) bot
// senin yerel ağındaki şeylere bağlanmaya çalışır. Sadece internetteki
// sunuculara izin ver.

const dns = require('dns').promises
const net = require('net')
const dgram = require('dgram')

function ozelAdres(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    const v4 = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (v4) return ozelAdres(v4[1])
    return (
      l === '::' ||
      l === '::1' ||
      /^f[cd]/.test(l) || // fc00::/7 özel
      /^fe[89ab]/.test(l) || // fe80::/10 yerel
      /^ff/.test(l) // çoklu yayın
    )
  }
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

// minecraft-protocol'ün yaptığı gibi: varsayılan portta SRV kaydına bak
// ("oyna.sunucu.com" gerçek sunucuyu SRV ile gösterebilir), sonra IP'leri çöz.
async function hedefCoz(host, port, { lookup = dns.lookup, resolveSrv = dns.resolveSrv } = {}) {
  let h = host
  let p = port
  if (p === 25565 && !net.isIP(h) && h !== 'localhost') {
    try {
      const srv = await resolveSrv(`_minecraft._tcp.${h}`)
      if (srv && srv.length) {
        h = srv[0].name
        p = srv[0].port
      }
    } catch (_) {}
  }
  let adresler = []
  let hata = null
  try {
    adresler = (await lookup(h, { all: true })).map((a) => a.address)
  } catch (e) {
    hata = e.code || 'HATA'
  }
  return { host: h, port: p, adresler, hata }
}

// /baslat anında müşteriye hızlı cevap için. Sorun yoksa null, varsa mesaj.
async function hedefKontrol(host, port, dnsFn) {
  const { adresler } = await hedefCoz(host, port, dnsFn)
  if (adresler.length === 0) return 'Bu sunucu adresi bulunamadı, doğru yazdığından emin ol.'
  if (adresler.some(ozelAdres)) return 'Bu adrese bağlanamam: yerel/özel ağ adresi. İnternetteki bir sunucu yaz.'
  return null
}

// mineflayer/minecraft-protocol için "connect" seçeneği: adres kontrolü
// soketin açıldığı anda yapılır ve kontrol edilen IP'ye doğrudan bağlanılır.
// Böylece otomatik yeniden bağlanmada da, alan adı sonradan iç ağa
// çevrilse de (DNS hilesi) bot iç ağa giremez.
// reddet(neden, kalici): kalici=false ise (geçici DNS sorunu) tekrar denenebilir.
function guvenliBaglanti(secenek, reddet, dnsFn) {
  return (client) => {
    hedefCoz(secenek.host, secenek.port, dnsFn).then(
      ({ host, port, adresler, hata }) => {
        if (adresler.length === 0) {
          // ENOTFOUND: böyle bir adres yok (kalıcı). EAI_AGAIN vb.: DNS anlık sorunlu
          return reddet(`sunucu adresi çözülemedi (${hata})`, hata === 'ENOTFOUND')
        }
        if (adresler.some(ozelAdres)) return reddet('yerel/özel ağ adresine bağlanmak yasak', true)
        secenek.host = host // el sıkışmada sunucu adı (minecraft-protocol da SRV'de böyle yapar)
        secenek.port = port
        client.setSocket(net.connect(port, adresler[0]))
      },
      (e) => reddet(e.message, false)
    )
  }
}

// Sunucu gerçekten cevap veriyor mu: verilen IP:port'a TCP bağlantısı açılabiliyor mu.
// { ok: true } ya da { kod: 'ETIMEDOUT' | 'ECONNREFUSED' | ... }
function tcpDene(ip, port, ms = 8000) {
  return new Promise((coz) => {
    const soket = net.connect({ host: ip, port })
    let bitti = false
    const bitir = (sonuc) => {
      if (bitti) return
      bitti = true
      soket.destroy()
      coz(sonuc)
    }
    soket.setTimeout(ms, () => bitir({ kod: 'ETIMEDOUT' }))
    soket.once('connect', () => bitir({ ok: true }))
    soket.once('error', (e) => bitir({ kod: e.code || 'HATA' }))
  })
}

// Bedrock (telefon / Windows 10 / konsol) sunucusu mu: RakNet "unconnected ping" (UDP).
// Cevap verirse { surum, motd }, vermezse null. Bot Bedrock sunucularına giremez.
const RAKNET_SIHIR = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex')
function bedrockDene(ip, port, ms = 2500) {
  return new Promise((coz) => {
    let soket
    try {
      soket = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4')
    } catch (_) {
      return coz(null)
    }
    let bitti = false
    const bitir = (sonuc) => {
      if (bitti) return
      bitti = true
      clearTimeout(zaman)
      try {
        soket.close()
      } catch (_) {}
      coz(sonuc)
    }
    const zaman = setTimeout(() => bitir(null), ms)
    soket.on('error', () => bitir(null))
    soket.on('message', (m) => {
      // 0x1c: unconnected pong = id(1) zaman(8) sunucuGuid(8) sihir(16) uzunluk(2) "MCPE;motd;protokol;sürüm;..."
      if (m[0] !== 0x1c || m.length < 35 || !m.subarray(17, 33).equals(RAKNET_SIHIR)) return
      const metin = m.subarray(35, 35 + m.readUInt16BE(33)).toString('utf8').split(';')
      bitir({ surum: metin[3] || '', motd: metin[1] || '' })
    })
    const paket = Buffer.alloc(33)
    paket[0] = 0x01
    paket.writeBigInt64BE(BigInt(Date.now()), 1)
    RAKNET_SIHIR.copy(paket, 9)
    paket.writeBigInt64BE(2n, 25)
    soket.send(paket, port, ip, (e) => e && bitir(null))
  })
}

// /baslat'ta botu başlatmadan önce: adresi (SRV dahil) çöz, sunucuya bağlanılabiliyor mu bak.
// Java bağlantısı olmazsa Bedrock sunucusu mu diye de bakar (aynı port ve Bedrock'un 19132'si).
async function sunucuyaUlasilir(host, port, dnsFn, ms) {
  const r = await hedefCoz(host, port, dnsFn)
  if (!r.adresler.length) return { kod: r.hata || 'ENOTFOUND', host: r.host, port: r.port }
  const ip = r.adresler[0]
  const tcp = await tcpDene(ip, r.port, ms)
  if (!tcp.ok) {
    const portlar = [...new Set([r.port, 19132])]
    const cevaplar = await Promise.all(portlar.map((p) => bedrockDene(ip, p))) // aynı anda: en fazla ~2,5 sn
    const n = cevaplar.findIndex(Boolean)
    if (n >= 0) return { kod: 'BEDROCK', bedrock: { ...cevaplar[n], port: portlar[n] }, host: r.host, port: r.port }
  }
  return { ...tcp, host: r.host, port: r.port }
}

// Bağlantı hatalarının müşteriye anlaşılır açıklaması (ham hata yığını yerine)
function baglantiHatasiMetni(kod, adres, ek = {}) {
  switch (kod) {
    case 'BEDROCK':
      return (
        `Bu bir **Bedrock** sunucusu (${adres}${ek.surum ? `, sürüm ${ek.surum}` : ''}): telefon / Windows 10 / konsol sürümü. ` +
        'Bot sadece **Java** sürümü sunuculara girebilir, Bedrock\'a giremez. Sunucunun ayrı bir Java adresi/portu varsa onu yaz.'
      )
    case 'ETIMEDOUT':
      return (
        `Sunucu cevap vermedi (${adres}). Olası nedenler: sunucu kapalı, adres ya da port yanlış, ` +
        'ya da bu bir Bedrock (telefon / Windows 10 / konsol) sunucusu. Bot sadece Java sürümü sunuculara girer. ' +
        'Sunucunun Java adresini ve portunu kontrol et: /baslat host:ADRES port:PORT'
      )
    case 'ECONNREFUSED':
      return `Sunucu bağlantıyı reddetti (${adres}): bu portta açık bir Minecraft sunucusu yok. Port yanlış ya da sunucu kapalı. Doğru portu yaz: /baslat host:ADRES port:PORT`
    case 'ECONNRESET':
      return `Sunucu bağlantıyı hemen kesti (${adres}). Sunucu yeniden başlıyor ya da bot koruması olabilir; biraz sonra tekrar dene.`
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Sunucuya ulaşılamıyor (${adres}): botun çalıştığı bilgisayarın internet bağlantısını ve adresi kontrol et.`
    case 'ENOTFOUND':
      return `Bu sunucu adresi bulunamadı (${adres}), doğru yazdığından emin ol.`
    default:
      return `Sunucuya bağlanılamadı (${adres}, ${kod}).`
  }
}

module.exports = { ozelAdres, hedefCoz, hedefKontrol, guvenliBaglanti, tcpDene, sunucuyaUlasilir, baglantiHatasiMetni }
