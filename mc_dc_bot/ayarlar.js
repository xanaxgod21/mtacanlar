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
const ham = oku('ayarlar.json')
if (ham) {
  try {
    json = JSON.parse(ham)
  } catch (e) {
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

module.exports = {
  discordToken: al('DISCORD_TOKEN', 'discord_token'),
  guildId: al('GUILD_ID', 'guild_id'),
  logKanalId: al('LOG_CHANNEL_ID', 'log_kanal_id'), // satıcı logu (satışlar, hatalar)
  discordSahipId: al('DISCORD_OWNER_ID', 'discord_sahip_id'), // satıcı (admin)
  musteriKategoriId: al('MUSTERI_KATEGORI_ID', 'musteri_kategori_id'), // boşsa bot açar
  maxBot: sayi('MAX_BOT', 'max_bot', 20), // aynı anda en fazla kaç müşteri botu
  aiGunlukLimit: sayi('AI_GUNLUK_LIMIT', 'ai_gunluk_limit', 200), // müşteri başı, 0 = sınırsız
  mcSahip: al('MC_OWNER', 'mc_sahip', 'Lyraiv'),
  apiKey: al('ANTHROPIC_API_KEY', 'anthropic_api_key') || oku('anahtar.txt').trim(),
  aiModel: al('AI_MODEL', 'ai_model', 'claude-haiku-4-5-20251001'),
}
