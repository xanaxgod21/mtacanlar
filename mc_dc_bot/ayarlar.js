// ayarlar.js — token, anahtar ve kanal ayarlarını tek yerden okur
//
// Gizli bilgiler artık kodun içinde durmaz. ayarlar.ornek.json dosyasını
// ayarlar.json adıyla kopyala ve doldur (ayarlar.json git'e girmez).
// Aynı isimli ortam değişkeni varsa dosyadaki değerin yerine o kullanılır.
// Eski anahtar.txt dosyası da hâlâ okunur.

const fs = require('fs')
const path = require('path')

function oku(dosya) {
  try {
    // Not Defteri dosyanın başına BOM koyabilir, JSON.parse onu sevmez
    return fs.readFileSync(path.join(__dirname, dosya), 'utf-8').replace(/^\uFEFF/, '')
  } catch (_) {
    return ''
  }
}

let json = {}
let bozukHata = '' // ayarlar.json var ama okunamıyorsa nedeni (bot açılmaz, düzeltilmesini ister)
const ham = oku('ayarlar.json')
if (ham) {
  try {
    json = JSON.parse(ham)
  } catch (e) {
    bozukHata = e.message
    console.log('[ayar] ayarlar.json bozuk, okunamadı:', e.message)
  }
}

const env = process.env
// Örnek dosyadan kalan "BURAYA_..." yazıları boş sayılır
// (0 sayısı boş değildir: "ai_gunluk_limit": 0 sınırsız demek)
const bosMu = (v) => v === undefined || v === null || v === '' || String(v).startsWith('BURAYA_')
const al = (envAdi, jsonAdi, varsayilan = '') => {
  if (!bosMu(env[envAdi])) return String(env[envAdi]).trim()
  if (!bosMu(json[jsonAdi])) return String(json[jsonAdi]).trim()
  return varsayilan
}

const sayi = (envAdi, jsonAdi, varsayilan) => {
  const n = parseInt(al(envAdi, jsonAdi, ''), 10)
  return Number.isFinite(n) && n >= 0 ? n : varsayilan
}

// Bot kendisi ayar yazar (konsola yapıştırılan token, /kur'un açtığı kanal ve
// roller): ayarlar.json yoksa örnekten oluşturur, sadece verilen alanları değiştirir.
// Dosya bozuksa üstüne yazmaz (içindeki anahtarlar kaybolmasın), hata verir.
function kaydet(degisen) {
  const dosya = path.join(__dirname, 'ayarlar.json')
  let mevcut = null
  const metin = oku('ayarlar.json')
  if (metin) {
    try {
      mevcut = JSON.parse(metin)
    } catch (e) {
      throw new Error(`ayarlar.json bozuk (${e.message}), üstüne yazılmadı`)
    }
  }
  if (!mevcut) {
    try {
      mevcut = JSON.parse(oku('ayarlar.ornek.json') || '{}')
    } catch (_) {
      mevcut = {}
    }
  }
  Object.assign(mevcut, degisen)
  try {
    fs.writeFileSync(dosya + '.tmp', JSON.stringify(mevcut, null, 2) + '\n', 'utf-8')
    fs.renameSync(dosya + '.tmp', dosya)
  } catch (e) {
    fs.rmSync(dosya + '.tmp', { force: true }) // token'lı geçici dosya ortada kalmasın
    throw e
  }
  json = mevcut
}

// Değer ortam değişkeninden mi geliyor (öyleyse dosyaya yazılan değer kullanılmaz)
const envden = (envAdi) => !bosMu(env[envAdi])

module.exports = {
  kaydet,
  envden,
  bozuk: bozukHata,
  discordToken: al('DISCORD_TOKEN', 'discord_token'),
  guildId: al('GUILD_ID', 'guild_id'),
  logKanalId: al('LOG_CHANNEL_ID', 'log_kanal_id'), // satıcı logu (satışlar, hatalar)
  keyLogKanalId: al('KEY_LOG_CHANNEL_ID', 'key_log_kanal_id'), // key geçmişi (boşsa satıcı loguna)
  discordSahipId: al('DISCORD_OWNER_ID', 'discord_sahip_id'), // satıcı (admin)
  yetkiliRolId: al('YETKILI_ROL_ID', 'yetkili_rol_id'), // bu roldekiler de key verebilir (boş = sadece sen)
  musteriRolId: al('MUSTERI_ROL_ID', 'musteri_rol_id'), // key girene verilir, süre bitince alınır (boş = kapalı)
  logRolId: al('LOG_ROL_ID', 'log_rol_id'), // log kanallarını görür (key veremez); /kur açar
  gunlukYedek: !['0', 'false', 'hayir', 'hayır'].includes(al('GUNLUK_YEDEK', 'gunluk_yedek', '1').toLowerCase()), // her gün yedek DM'i
  odaSilmeSaat: sayi('ODA_SILME_SAAT', 'oda_silme_saat', 0), // süre bitince oda kaç saat sonra silinsin (0 = hemen)
  musteriKategoriId: al('MUSTERI_KATEGORI_ID', 'musteri_kategori_id'), // boşsa bot açar
  maxBot: sayi('MAX_BOT', 'max_bot', 20), // aynı anda en fazla kaç müşteri botu
  raporSaati: al('RAPOR_SAATI', 'rapor_saati', '23:55'), // günlük rapor saati (TR), "kapali" = gönderme
  aiGunlukLimit: sayi('AI_GUNLUK_LIMIT', 'ai_gunluk_limit', 200), // müşteri başı, 0 = sınırsız
  mcSahip: al('MC_OWNER', 'mc_sahip', 'Lyraiv'),
  apiKey: al('ANTHROPIC_API_KEY', 'anthropic_api_key') || oku('anahtar.txt').trim(),
  aiModel: al('AI_MODEL', 'ai_model', 'claude-haiku-4-5-20251001'),
}
