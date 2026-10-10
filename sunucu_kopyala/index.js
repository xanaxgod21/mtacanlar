#!/usr/bin/env node
/*
 * Sunucu kopyalayici (selfbot): bir Discord sunucusundaki secilen
 * kategori/kanallari (ve istege bagli rolleri) baska bir sunucuya kopyalar.
 *
 * NE YAPAR:
 *   - Kaynak sunucudaki kategori ve kanallari listeler, hangilerini
 *     kopyalayacagini sen secersin.
 *   - Rolleri (isim, renk, izinler, sira) kopyalar; hedefte ayni isimli
 *     rol varsa yenisini acmaz, onu kullanir.
 *   - Kanallari ayarlariyla kopyalar: konu, NSFW, yavas mod, bitrate,
 *     kisi limiti, forum etiketleri ve kanal izinleri (rol eslemesiyle).
 *
 * NE YAPMAZ:
 *   - Mesajlari, webhooklari, emojileri, uyeleri kopyalamaz.
 *   - Hedef sunucuda hicbir seyi silmez.
 *
 * UYARI: Kullanici hesabi token'i ile calisir. Bu Discord kurallarina
 * aykiridir, hesabin kapatilabilir. Token'i kimseyle paylasma.
 * Token DISCORD_TOKEN ortam degiskeninden okunur, yoksa sorulur;
 * hicbir yere kaydedilmez.
 */

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { Client } = require('discord.js-selfbot-v13');

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async q => (await rl.question(q)).trim();
const wait = ms => new Promise(r => setTimeout(r, ms));

const DELAY_MS = 1500; // her olusturma arasi bekleme; hesabi korumak icin dusurme

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

async function pickGuild(client, label, guilds) {
  while (true) {
    const n = Number(await ask(`${label} sunucu numarasi: `));
    if (guilds[n - 1]) return guilds[n - 1];
    console.log('Gecersiz numara.');
  }
}

// Kaynaktaki kategori/kanallari numarali listeler, secimi alir.
// Bir kategori secilirse altindaki tum kanallar da gelir.
async function pickChannels(source) {
  const all = source.channels.cache;
  const byPos = (a, b) => a.rawPosition - b.rawPosition;
  const categories = [...all.filter(c => c.type === 'GUILD_CATEGORY').values()].sort(byPos);
  const byParent = parent =>
    [...all.filter(c => c.type in TYPE_LABEL && (c.parentId ?? null) === parent).values()].sort(byPos);

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

// Kaynak rol id -> hedef rol id eslemesi kurar. copy=true ise hedefte
// olmayan rolleri olusturur; aksi halde sadece isimle eslestirir.
async function mapRoles(source, target, copy) {
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
    const existing = target.roles.cache.find(r => r.name === role.name && !r.managed);
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
      console.log(`  + rol: ${role.name}`);
    } catch (err) {
      console.log(`  ! rol olusturulamadi (${role.name}): ${err.message}`);
    }
    await wait(DELAY_MS);
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

async function run(client) {
  const guilds = [...client.guilds.cache.values()];
  console.log('\nBulundugun sunucular:');
  guilds.forEach((g, i) => console.log(`  ${i + 1}) ${g.name} (${g.id})`));
  const source = await pickGuild(client, 'KAYNAK (kopyalanacak)', guilds);
  const target = await pickGuild(client, 'HEDEF (yeni)', guilds);
  if (source.id === target.id) throw new Error('Kaynak ve hedef ayni sunucu olamaz.');

  await source.channels.fetch();
  await source.roles.fetch();
  await target.roles.fetch();
  await target.channels.fetch();

  console.log(`\n"${source.name}" kanallari:`);
  const { categories, channels } = await pickChannels(source);
  const copyRoles = /^e/i.test(await ask('\nRoller de kopyalansin mi? (e/h): '));

  console.log(`\nOzet: ${categories.length} kategori, ${channels.length} kanal -> "${target.name}"`);
  if (!/^e/i.test(await ask('Baslatilsin mi? (e/h): '))) return;

  console.log('\nRoller esleniyor...');
  const roleMap = await mapRoles(source, target, copyRoles);

  const categoryMap = new Map();
  let ok = 0;
  let failed = 0;
  for (const cat of categories) {
    try {
      const created = await target.channels.create(cat.name, {
        type: 'GUILD_CATEGORY',
        permissionOverwrites: await convertOverwrites(cat, target, roleMap),
        reason: 'Sunucu tasima',
      });
      categoryMap.set(cat.id, created.id);
      console.log(`  + kategori: ${cat.name}`);
      ok++;
    } catch (err) {
      console.log(`  ! kategori olusturulamadi (${cat.name}): ${err.message}`);
      failed++;
    }
    await wait(DELAY_MS);
  }

  // Kategorisi secilmemis kanallar, hedefte ayni isimli kategori varsa oraya gider.
  const parentFor = ch => {
    if (!ch.parentId) return null;
    if (categoryMap.has(ch.parentId)) return categoryMap.get(ch.parentId);
    const name = source.channels.cache.get(ch.parentId)?.name;
    return target.channels.cache.find(c => c.type === 'GUILD_CATEGORY' && c.name === name)?.id ?? null;
  };

  for (const ch of channels) {
    try {
      // Kategoriyle senkron kanallar kategorinin izinlerini alir.
      const permSource = ch.permissionsLocked && ch.parent ? ch.parent : ch;
      const overwrites = await convertOverwrites(permSource, target, roleMap);
      await target.channels.create(ch.name, channelOptions(ch, target, parentFor(ch), overwrites));
      console.log(`  + ${TYPE_LABEL[ch.type]}: ${ch.name}`);
      ok++;
    } catch (err) {
      console.log(`  ! kanal olusturulamadi (${ch.name}): ${err.message}`);
      failed++;
    }
    await wait(DELAY_MS);
  }

  console.log(`\nBitti: ${ok} olusturuldu, ${failed} hata.`);
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
