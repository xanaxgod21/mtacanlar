#!/usr/bin/env node
/*
 * Sunucu kopyalayici (selfbot): bir Discord sunucusundaki kategori, kanal,
 * rol ve mesajlari baska bir sunucuya tasir.
 *
 * NE YAPAR:
 *   - AYARLAR'da kaynak/hedef sunucu yaziliysa calistirdigin an hicbir sey
 *     sormadan tum kanallari, rolleri ve mesajlari tasir. Bos birakirsan
 *     sunuculari ve kanallari sana sordurur.
 *   - Rolleri (isim, renk, izinler, sira) kopyalar; hedefte ayni isimli
 *     rol varsa yenisini acmaz, onu kullanir.
 *   - Kanallari ayarlariyla kopyalar: konu, NSFW, yavas mod, bitrate,
 *     kisi limiti, forum etiketleri ve kanal izinleri (rol eslemesiyle).
 *   - Mesajlari eskiden yeniye, webhook ile orijinal yazarin adi ve
 *     profil fotografiyla gonderir; dosyalar ve embedler de gelir.
 *   - Ilerlemeyi ilerleme_*.json dosyasina yazar. Yarida kesilirse tekrar
 *     calistirinca ayni kanallari yeniden acmaz, mesajlara kaldigi yerden
 *     devam eder.
 *
 * NE YAPMAZ:
 *   - Thread'leri, forum gonderilerini, tepkileri (reaction) tasimaz.
 *   - Hedef sunucuda hicbir seyi silmez.
 *   - Kimseyi etiketlemez (@everyone, @rol, @kisi bildirim gondermez).
 *
 * UYARI: Kullanici hesabi token'i ile calisir. Bu Discord kurallarina
 * aykiridir, hesabin kapatilabilir. Token'i kimseyle paylasma.
 * Token DISCORD_TOKEN ortam degiskeninden okunur (bkz. baslat.ps1),
 * yoksa sorulur; hicbir dosyaya kaydedilmez.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { Client } = require('discord.js-selfbot-v13');

// ----------------- AYARLAR -----------------
const AYARLAR = {
  kaynakSunucu: process.env.KAYNAK_SUNUCU ?? '1291429958895407248', // bos ('') birakirsan sorar
  hedefSunucu: process.env.HEDEF_SUNUCU ?? '1555467184984293416',
  rolleriKopyala: true,
  mesajlariKopyala: true,
  tarihEkle: true, // mesajin altina orijinal tarihini kucuk yazi olarak ekler
  bekleme: 1500, // kanal/rol olusturma arasi bekleme (ms)
  mesajBekleme: 1200, // mesajlar arasi bekleme (ms); hesabi korumak icin dusurme
};
// -------------------------------------------

const WEBHOOK_NAME = 'Sunucu Tasima';

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async q => (await rl.question(q)).trim();
const yes = async q => /^e/i.test(await ask(q));
const wait = ms => new Promise(r => setTimeout(r, ms));

// Hedef sunucu Topluluk (Community) degilse bu kanal turleri acilamaz;
// en yakin normal ture cevrilir.
const COMMUNITY_FALLBACK = {
  GUILD_NEWS: 'GUILD_TEXT',
  GUILD_STAGE_VOICE: 'GUILD_VOICE',
  GUILD_FORUM: 'GUILD_TEXT',
  GUILD_MEDIA: 'GUILD_TEXT',
};

const TYPE_LABEL = {
  GUILD_TEXT: 'yazi',
  GUILD_VOICE: 'ses',
  GUILD_NEWS: 'duyuru',
  GUILD_STAGE_VOICE: 'sahne',
  GUILD_FORUM: 'forum',
  GUILD_MEDIA: 'medya',
};

const VOICE_TYPES = new Set(['GUILD_VOICE', 'GUILD_STAGE_VOICE']);
// Mesajlari dogrudan kanalda duran turler (forum/medya gonderileri thread'dir).
const MESSAGE_TYPES = new Set(['GUILD_TEXT', 'GUILD_NEWS', 'GUILD_VOICE', 'GUILD_STAGE_VOICE']);

// Sunucunun boost seviyesine gore webhook dosya yukleme siniri.
const UPLOAD_LIMIT = { TIER_2: 50, TIER_3: 100 };
const uploadLimit = guild => (UPLOAD_LIMIT[guild.premiumTier] ?? 10) * 1024 * 1024;

// ----------------- ilerleme dosyasi -----------------

function loadState(source, target) {
  const file = path.join(__dirname, `ilerleme_${source.id}_${target.id}.json`);
  let data = { roles: {}, channels: {}, messages: {} };
  if (fs.existsSync(file)) {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    console.log(`Onceki ilerleme bulundu, kaldigi yerden devam ediliyor (${path.basename(file)}).`);
  }
  return { data, save: () => fs.writeFileSync(file, JSON.stringify(data, null, 2)) };
}

// ----------------- secim -----------------

function parseSelection(input, max) {
  if (/^(h|hepsi|all|\*)$/i.test(input)) return new Set(Array.from({ length: max }, (_, i) => i + 1));
  const picked = new Set();
  for (const part of input.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    const [a, b] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)];
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`Gecersiz secim: ${part}`);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (i < 1 || i > max) throw new Error(`Listede olmayan numara: ${i}`);
      picked.add(i);
    }
  }
  return picked;
}

async function pickGuild(label, guilds) {
  while (true) {
    const n = Number(await ask(`${label} sunucu numarasi: `));
    if (guilds[n - 1]) return guilds[n - 1];
    console.log('Gecersiz numara.');
  }
}

function listChannels(source) {
  const all = source.channels.cache;
  const byPos = (a, b) => a.rawPosition - b.rawPosition;
  const categories = [...all.filter(c => c.type === 'GUILD_CATEGORY').values()].sort(byPos);
  const byParent = parent =>
    [...all.filter(c => c.type in TYPE_LABEL && (c.parentId ?? null) === parent).values()].sort(byPos);
  return { categories, byParent, byPos };
}

// Kaynaktaki kategori/kanallari numarali listeler, secimi alir.
// Bir kategori secilirse altindaki tum kanallar da gelir.
async function pickChannels(source) {
  const { categories, byParent, byPos } = listChannels(source);
  const entries = [];
  const show = (ch, indent) => {
    entries.push(ch);
    const label = ch.type === 'GUILD_CATEGORY' ? 'KATEGORI' : TYPE_LABEL[ch.type];
    console.log(`${String(entries.length).padStart(4)}) ${indent}${ch.name}  [${label}]`);
  };
  byParent(null).forEach(c => show(c, ''));
  for (const cat of categories) {
    show(cat, '');
    byParent(cat.id).forEach(c => show(c, '    '));
  }

  console.log('\nOrnek secim: 1,3,5-8   ya da   hepsi');
  while (true) {
    try {
      const picked = parseSelection(await ask('Kopyalanacaklar: '), entries.length);
      if (!picked.size) continue;
      const result = new Set();
      for (const i of picked) {
        const ch = entries[i - 1];
        result.add(ch);
        if (ch.type === 'GUILD_CATEGORY') byParent(ch.id).forEach(c => result.add(c));
      }
      return {
        categories: categories.filter(c => result.has(c)),
        channels: [...result].filter(c => c.type !== 'GUILD_CATEGORY').sort(byPos),
      };
    } catch (err) {
      console.log(err.message);
    }
  }
}

function allChannels(source) {
  const { categories, byParent, byPos } = listChannels(source);
  const channels = [byParent(null), ...categories.map(c => byParent(c.id))].flat().sort(byPos);
  return { categories, channels };
}

// ----------------- roller ve kanallar -----------------

// Kaynak rol id -> hedef rol id eslemesi kurar. copy=true ise hedefte
// olmayan rolleri olusturur; aksi halde sadece isimle eslestirir.
async function mapRoles(source, target, copy, state) {
  const map = new Map([[source.id, target.id]]); // @everyone
  const roles = [...source.roles.cache.values()]
    .filter(r => r.id !== source.id && !r.managed)
    .sort((a, b) => b.position - a.position); // ustten alta

  if (copy) {
    await target.roles.everyone
      .setPermissions(source.roles.everyone.permissions)
      .catch(err => console.log(`  ! @everyone izinleri ayarlanamadi: ${err.message}`));
  }

  for (const role of roles) {
    const saved = state.data.roles[role.id];
    const existing = (saved && target.roles.cache.get(saved)) || target.roles.cache.find(r => r.name === role.name && !r.managed);
    if (existing) {
      map.set(role.id, existing.id);
      continue;
    }
    if (!copy) continue;
    try {
      // Yeni rol en alta eklenir; ustten alta olusturunca sira korunur.
      const created = await target.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions,
        reason: 'Sunucu tasima',
      });
      map.set(role.id, created.id);
      state.data.roles[role.id] = created.id;
      state.save();
      console.log(`  + rol: ${role.name}`);
    } catch (err) {
      console.log(`  ! rol olusturulamadi (${role.name}): ${err.message}`);
    }
    await wait(AYARLAR.bekleme);
  }
  return map;
}

// Kanal izinlerini hedef sunucuya uyarlar. Eslesmeyen roller ve hedefte
// olmayan uyeler atlanir.
async function convertOverwrites(channel, target, roleMap) {
  const result = [];
  for (const ow of channel.permissionOverwrites.cache.values()) {
    let id = null;
    if (ow.type === 'role') {
      id = roleMap.get(ow.id) ?? null;
    } else if (await target.members.fetch(ow.id).catch(() => null)) {
      id = ow.id;
    }
    if (id) result.push({ id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield });
  }
  return result;
}

// Ozel (sunucuya ait) emojiler hedefte olmadigi icin sadece unicode emojiler korunur.
const unicodeOnly = emoji => (emoji && !emoji.id && emoji.name ? { id: null, name: emoji.name } : null);

function channelOptions(ch, target, parentId, permissionOverwrites) {
  let type = ch.type;
  if (!target.features.includes('COMMUNITY') && COMMUNITY_FALLBACK[type]) {
    console.log(`  ~ ${ch.name}: hedef Topluluk sunucusu degil, ${TYPE_LABEL[type]} -> ${TYPE_LABEL[COMMUNITY_FALLBACK[type]]}`);
    type = COMMUNITY_FALLBACK[type];
  }
  const opts = { type, parent: parentId, permissionOverwrites, nsfw: ch.nsfw, reason: 'Sunucu tasima' };

  if (VOICE_TYPES.has(type)) {
    opts.bitrate = Math.min(ch.bitrate ?? 64000, target.maximumBitrate);
    opts.userLimit = ch.userLimit ?? 0;
    if (ch.rtcRegion) opts.rtcRegion = ch.rtcRegion;
    if (ch.videoQualityMode) opts.videoQualityMode = ch.videoQualityMode;
  } else {
    if (ch.topic) opts.topic = ch.topic;
    if (ch.rateLimitPerUser) opts.rateLimitPerUser = ch.rateLimitPerUser;
  }
  if (type === 'GUILD_FORUM' || type === 'GUILD_MEDIA') {
    opts.availableTags = (ch.availableTags ?? []).map(t => ({
      name: t.name,
      moderated: t.moderated,
      emoji: unicodeOnly(t.emoji),
    }));
    const reaction = unicodeOnly(ch.defaultReactionEmoji);
    if (reaction) opts.defaultReactionEmoji = reaction;
    if (ch.defaultSortOrder != null) opts.defaultSortOrder = ch.defaultSortOrder;
    if (ch.defaultForumLayout != null) opts.defaultForumLayout = ch.defaultForumLayout;
    if (ch.defaultThreadRateLimitPerUser) opts.defaultThreadRateLimitPerUser = ch.defaultThreadRateLimitPerUser;
  }
  return opts;
}

// Kanali (ya da kategoriyi) hedefte olusturur. Onceki calismada
// olusturulmus ve hala duruyorsa yenisini acmaz.
async function ensureChannel(ch, target, state, create) {
  const saved = state.data.channels[ch.id];
  if (saved && target.channels.cache.has(saved)) return { id: saved, created: false };
  const made = await create();
  state.data.channels[ch.id] = made.id;
  state.save();
  return { id: made.id, created: true };
}

// ----------------- mesajlar -----------------

// Webhook kullanici adinda "discord"/"clyde" gecemez, 1-80 karakter olmali.
function webhookName(msg) {
  const raw = msg.member?.displayName ?? msg.author.globalName ?? msg.author.username ?? 'Uye';
  const clean = raw.replace(/discord|clyde/gi, m => m[0] + '​' + m.slice(1)).slice(0, 80);
  return clean.trim() || 'Uye';
}

function splitContent(text, size = 2000) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

// Tek bir mesaji webhook ile yeniden gonderir. Gonderilecek bir sey yoksa
// (sistem mesaji, bos mesaj) false doner.
async function copyMessage(msg, hook, limit) {
  if (msg.system) return false;

  const files = [];
  const links = [];
  for (const a of msg.attachments.values()) {
    if (a.size <= limit) files.push({ attachment: a.url, name: a.name });
    else links.push(a.url);
  }
  for (const s of msg.stickers.values()) links.push(`[cikartma: ${s.name}]`);

  let content = msg.content ?? '';
  if (links.length) content += (content ? '\n' : '') + links.join('\n');
  const embeds = msg.embeds.filter(e => e.type === 'rich').slice(0, 10);
  if (!content && !files.length && !embeds.length) return false;
  if (AYARLAR.tarihEkle) content += `${content ? '\n' : ''}-# <t:${Math.floor(msg.createdTimestamp / 1000)}:f>`;

  const base = {
    username: webhookName(msg),
    avatarURL: msg.author.displayAvatarURL({ dynamic: true }),
    allowedMentions: { parse: [] },
  };
  const parts = splitContent(content);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const payload = { ...base, content: parts[i] || undefined };
    if (last) {
      payload.files = files;
      payload.embeds = embeds;
    }
    try {
      await hook.send(payload);
    } catch (err) {
      if (!last || !files.length) throw err;
      // Dosya yuklenemediyse linkleriyle gonder.
      const fallback = [parts[i], ...files.map(f => f.attachment)].filter(Boolean).join('\n');
      await hook.send({ ...base, content: fallback.slice(0, 2000), embeds });
    }
  }
  return true;
}

async function getWebhook(target, channelId, hooks) {
  const existing = hooks.find(h => h.channelId === channelId && h.name === WEBHOOK_NAME && h.token);
  if (existing) return existing;
  return target.channels.createWebhook(channelId, WEBHOOK_NAME, { reason: 'Sunucu tasima' });
}

async function copyMessages(source, target, channels, state) {
  const hooks = [...(await target.fetchWebhooks().catch(() => new Map())).values()];
  const limit = uploadLimit(target);
  let total = 0;

  for (const ch of channels) {
    if (!MESSAGE_TYPES.has(ch.type) || !ch.messages) continue;
    const targetId = state.data.channels[ch.id];
    if (!targetId || !target.channels.cache.has(targetId)) continue;
    if (state.data.messages[ch.id] === 'bitti') continue;

    let hook;
    try {
      hook = await getWebhook(target, targetId, hooks);
    } catch (err) {
      console.log(`  ! #${ch.name}: webhook olusturulamadi, mesajlar atlandi (${err.message})`);
      continue;
    }

    console.log(`  # ${ch.name} mesajlari aktariliyor...`);
    let after = state.data.messages[ch.id] ?? '0';
    let count = 0;
    while (true) {
      let page;
      try {
        page = await ch.messages.fetch({ limit: 100, after }, { cache: false });
      } catch (err) {
        console.log(`  ! #${ch.name}: mesajlar okunamadi (${err.message})`);
        break;
      }
      if (!page.size) {
        state.data.messages[ch.id] = 'bitti';
        state.save();
        break;
      }
      // API en yeniden eskiye dondurur; eskiden yeniye gonderiyoruz.
      const sorted = [...page.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const msg of sorted) {
        try {
          if (await copyMessage(msg, hook, limit)) {
            count++;
            await wait(AYARLAR.mesajBekleme);
          }
        } catch (err) {
          console.log(`    ! mesaj gonderilemedi (${msg.id}): ${err.message}`);
        }
        after = msg.id;
        state.data.messages[ch.id] = after;
        state.save();
      }
      console.log(`    ${count} mesaj`);
    }
    total += count;
  }
  return total;
}

// ----------------- ana akis -----------------

async function chooseJob(client) {
  const { kaynakSunucu, hedefSunucu } = AYARLAR;
  if (kaynakSunucu && hedefSunucu) {
    const source = client.guilds.cache.get(kaynakSunucu);
    const target = client.guilds.cache.get(hedefSunucu);
    if (!source) throw new Error(`Kaynak sunucu bulunamadi (${kaynakSunucu}). Hesabin o sunucuda mi?`);
    if (!target) throw new Error(`Hedef sunucu bulunamadi (${hedefSunucu}). Hesabin o sunucuda mi?`);
    await source.channels.fetch();
    return {
      source,
      target,
      ...allChannels(source),
      copyRoles: AYARLAR.rolleriKopyala,
      copyMessages: AYARLAR.mesajlariKopyala,
    };
  }

  const guilds = [...client.guilds.cache.values()];
  console.log('\nBulundugun sunucular:');
  guilds.forEach((g, i) => console.log(`  ${i + 1}) ${g.name} (${g.id})`));
  const source = await pickGuild('KAYNAK (kopyalanacak)', guilds);
  const target = await pickGuild('HEDEF (yeni)', guilds);
  await source.channels.fetch();
  console.log(`\n"${source.name}" kanallari:`);
  const selection = await pickChannels(source);
  const copyRoles = await yes('\nRoller de kopyalansin mi? (e/h): ');
  const copyMessages = await yes('Mesajlar da kopyalansin mi? (e/h): ');
  const job = { source, target, ...selection, copyRoles, copyMessages };
  printSummary(job);
  return (await yes('Baslatilsin mi? (e/h): ')) ? job : null;
}

function printSummary({ source, target, categories, channels, copyRoles, copyMessages }) {
  console.log(`\n"${source.name}" -> "${target.name}"`);
  console.log(`  ${categories.length} kategori, ${channels.length} kanal`);
  console.log(`  roller: ${copyRoles ? 'evet' : 'hayir'}, mesajlar: ${copyMessages ? 'evet' : 'hayir'}`);
}

async function run(client) {
  const job = await chooseJob(client);
  if (!job) return;
  const { source, target, categories, channels } = job;
  if (source.id === target.id) throw new Error('Kaynak ve hedef ayni sunucu olamaz.');
  if (AYARLAR.kaynakSunucu && AYARLAR.hedefSunucu) printSummary(job);

  await source.roles.fetch();
  await target.roles.fetch();
  await target.channels.fetch();
  const state = loadState(source, target);

  console.log('\nRoller esleniyor...');
  const roleMap = await mapRoles(source, target, job.copyRoles, state);

  console.log('\nKanallar olusturuluyor...');
  let ok = 0;
  let failed = 0;
  for (const cat of categories) {
    try {
      const res = await ensureChannel(cat, target, state, async () =>
        target.channels.create(cat.name, {
          type: 'GUILD_CATEGORY',
          permissionOverwrites: await convertOverwrites(cat, target, roleMap),
          reason: 'Sunucu tasima',
        }),
      );
      if (res.created) {
        console.log(`  + kategori: ${cat.name}`);
        ok++;
        await wait(AYARLAR.bekleme);
      }
    } catch (err) {
      console.log(`  ! kategori olusturulamadi (${cat.name}): ${err.message}`);
      failed++;
    }
  }

  // Kategorisi kopyalanmamis kanallar, hedefte ayni isimli kategori varsa oraya gider.
  const parentFor = ch => {
    if (!ch.parentId) return null;
    const mapped = state.data.channels[ch.parentId];
    if (mapped && target.channels.cache.has(mapped)) return mapped;
    const name = source.channels.cache.get(ch.parentId)?.name;
    return target.channels.cache.find(c => c.type === 'GUILD_CATEGORY' && c.name === name)?.id ?? null;
  };

  for (const ch of channels) {
    try {
      const res = await ensureChannel(ch, target, state, async () => {
        // Kategoriyle senkron kanallar kategorinin izinlerini alir.
        const permSource = ch.permissionsLocked && ch.parent ? ch.parent : ch;
        const overwrites = await convertOverwrites(permSource, target, roleMap);
        return target.channels.create(ch.name, channelOptions(ch, target, parentFor(ch), overwrites));
      });
      if (res.created) {
        console.log(`  + ${TYPE_LABEL[ch.type]}: ${ch.name}`);
        ok++;
        await wait(AYARLAR.bekleme);
      }
    } catch (err) {
      console.log(`  ! kanal olusturulamadi (${ch.name}): ${err.message}`);
      failed++;
    }
  }
  console.log(`Kanallar: ${ok} olusturuldu, ${failed} hata.`);

  if (job.copyMessages) {
    console.log('\nMesajlar aktariliyor (uzun surebilir, Ctrl+C ile durdurup sonra devam ettirebilirsin)...');
    const total = await copyMessages(source, target, channels, state);
    console.log(`Mesajlar: ${total} mesaj aktarildi.`);
  }

  console.log('\nBitti.');
}

async function main() {
  const token = process.env.DISCORD_TOKEN || (await ask('Hesap token: '));
  const client = new Client();
  const ready = new Promise(resolve => client.once('ready', resolve));
  await client.login(token);
  await ready;
  console.log(`Giris yapildi: ${client.user.tag}`);
  try {
    await run(client);
  } finally {
    rl.close();
    client.destroy();
  }
}

main().catch(err => {
  console.error(`\nHata: ${err.message}`);
  rl.close();
  process.exit(1);
});
