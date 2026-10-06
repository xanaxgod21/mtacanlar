// ag.js — müşteri botlarının bağlanabileceği adresler
//
// Botlar SENİN makinende çalışır. Müşteri host olarak 127.0.0.1 ya da
// 192.168.x.x yazarsa (ya da kendi alan adını sonradan oraya çevirirse) bot
// senin yerel ağındaki şeylere bağlanmaya çalışır. Sadece internetteki
// sunuculara izin ver.

const dns = require('dns').promises
const net = require('net')

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

module.exports = { ozelAdres, hedefCoz, hedefKontrol, guvenliBaglanti }
