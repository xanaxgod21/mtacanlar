#!/usr/bin/env python3
"""
Discord sunucu tasima botu.

NE YAPAR (eski sunucu -> yeni sunucu):
  - Sunucu ayarlari: isim, ikon, banner, aciklama, dogrulama seviyesi,
    bildirim ayari, AFK / sistem kanali vb.
  - Roller: isim, renk, yetkiler, ayri gosterim, etiketlenebilirlik, sira.
  - @everyone yetkileri.
  - Emojiler ve cikartmalar (stickers).
  - Kategoriler ve kanallar (yazi, ses, duyuru, sahne, forum) +
    kanal izinleri, konu, yavas mod, NSFW, bitrate, kisi limiti, sira.
  - (Istege bagli) Banlar.
  - (Istege bagli) Her yazi kanalinin son N mesaji, webhook ile
    orijinal kullanici adi + avatar ile tekrar gonderilir.

NE YAPAMAZ (Discord izin vermiyor):
  - Uyeleri yeni sunucuya tasiyamaz. Uyelerin davet linkiyle gelmesi gerekir.
    (Geldiklerinde rollerini elle / baska botla vermen gerekir.)
  - Mesajlar birebir "ayni kisi atmis" gibi olmaz; webhook ile isim+avatar
    taklit edilir, tarih bilgisi yeni tarih olur.
  - Thread / forum gonderilerinin icerigini kopyalamaz (kanallar kopyalanir).

Ayarlar ilk acilista sorulur ve yanindaki tasima_config.json dosyasina kaydedilir.
"""

import io
import os
import sys
import json
import asyncio

try:
    import discord
except ImportError:
    print("discord.py kurulu degil. Once su komutu calistir:  pip install -r requirements.txt")
    input("Cikmak icin Enter'a bas...")
    sys.exit(1)

CONFIG_NAME = "tasima_config.json"


def app_dir():
    # Exe olarak paketlenince exe'nin yanini, script olarak calisinca script'in yanini kullan
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


CONFIG_PATH = os.path.join(app_dir(), CONFIG_NAME)


# ----------------- AYARLAR (soru-cevap) -----------------

def ask(prompt, default=None):
    suffix = f" [{default}]" if default not in (None, "") else ""
    val = input(f"{prompt}{suffix}: ").strip()
    return val if val else (default if default is not None else "")


def ask_yes(prompt, default=True):
    d = "e" if default else "h"
    val = ask(f"{prompt} (e/h)", d).lower()
    return val.startswith("e") or val.startswith("y")


def ask_int(prompt, default):
    while True:
        val = ask(prompt, str(default))
        if val.isdigit():
            return int(val)
        print("  Lutfen sayi gir.")


def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}

    print("=" * 60)
    print(" DISCORD SUNUCU TASIMA BOTU")
    print("=" * 60)
    print("Enter'a basarsan [koseli parantez] icindeki deger kullanilir.\n")

    token = ask("Bot token", "(kayitli)" if cfg.get("token") else None)
    if token != "(kayitli)":
        cfg["token"] = token

    print()
    cfg["wipe_target"] = ask_yes("Yeni sunucudaki mevcut kanal/rol/emojiler SILINSIN mi?", cfg.get("wipe_target", True))
    cfg["copy_settings"] = ask_yes("Sunucu ayarlari (isim, ikon, banner...) kopyalansin mi?", cfg.get("copy_settings", True))
    cfg["copy_roles"] = ask_yes("Roller kopyalansin mi?", cfg.get("copy_roles", True))
    cfg["copy_emojis"] = ask_yes("Emoji ve cikartmalar kopyalansin mi?", cfg.get("copy_emojis", True))
    cfg["copy_channels"] = ask_yes("Kategori ve kanallar kopyalansin mi?", cfg.get("copy_channels", True))
    cfg["copy_bans"] = ask_yes("Banlar kopyalansin mi?", cfg.get("copy_bans", False))
    cfg["messages_per_channel"] = ask_int(
        "Her yazi kanalindan kac mesaj kopyalansin? (0 = kopyalama)", cfg.get("messages_per_channel", 0)
    )

    if not str(cfg.get("token", "")).strip():
        print("HATA: token bos olamaz.")
        input("Cikmak icin Enter'a bas...")
        sys.exit(1)

    save_config(cfg)
    print(f"\nAyarlar kaydedildi: {CONFIG_PATH}\n")
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def pick_guild(guilds, prompt, default_id=None, exclude=None):
    """Botun bulundugu sunuculardan birini numarayla sectirir."""
    choices = [g for g in guilds if g != exclude]
    default = None
    for i, g in enumerate(choices, start=1):
        mark = ""
        if default_id and str(g.id) == str(default_id):
            default = str(i)
            mark = "  (son secim)"
        print(f"  {i}) {g.name}  [{g.member_count} uye]{mark}")
    while True:
        val = ask(prompt, default)
        if val.isdigit() and 1 <= int(val) <= len(choices):
            return choices[int(val) - 1]
        print("  Listeden gecerli bir numara gir.")


# ----------------- YARDIMCILAR -----------------

def log(msg):
    print(msg, flush=True)


async def safe(desc, coro):
    """Bir islemi dener; hata olursa yazar ve devam eder."""
    try:
        return await coro
    except discord.HTTPException as e:
        log(f"  [!] {desc} basarisiz: {e.status} {e.text}")
    except Exception as e:
        log(f"  [!] {desc} basarisiz: {e}")
    return None


async def read_asset(asset):
    if asset is None:
        return None
    try:
        return await asset.read()
    except Exception:
        return None


def clean_webhook_name(name):
    # Webhook kullanici adinda "discord" / "clyde" gecemez, 1-80 karakter olmali
    for bad in ("discord", "Discord", "DISCORD", "clyde", "Clyde", "CLYDE"):
        name = name.replace(bad, bad[0] + "​" + bad[1:])
    name = name.strip() or "Kullanici"
    return name[:80]


# ----------------- TASIYICI -----------------

class Migrator:
    def __init__(self, client, src, dst, cfg):
        self.client = client
        self.src = src
        self.dst = dst
        self.cfg = cfg
        self.role_map = {}      # eski rol id -> yeni rol
        self.channel_map = {}   # eski kanal id -> yeni kanal
        self.emoji_map = {}     # eski emoji id -> yeni emoji

    # ---- 0) Hedefi temizle ----
    async def wipe(self):
        log("\n[1/7] Yeni sunucu temizleniyor...")
        for ch in list(self.dst.channels):
            await safe(f"Kanal silme #{ch.name}", ch.delete(reason="Sunucu tasima"))
        me_top = self.dst.me.top_role
        for role in list(self.dst.roles):
            if role.is_default() or role.managed or role >= me_top:
                continue
            await safe(f"Rol silme @{role.name}", role.delete(reason="Sunucu tasima"))
        for emoji in list(self.dst.emojis):
            await safe(f"Emoji silme :{emoji.name}:", emoji.delete(reason="Sunucu tasima"))
        for sticker in list(self.dst.stickers):
            await safe(f"Cikartma silme {sticker.name}", sticker.delete(reason="Sunucu tasima"))
        log("  Temizlik bitti.")

    # ---- 1) Roller ----
    async def copy_roles(self):
        log("\n[2/7] Roller kopyalaniyor...")
        await safe(
            "@everyone yetkileri",
            self.dst.default_role.edit(permissions=self.src.default_role.permissions, reason="Sunucu tasima"),
        )

        can_icon = "ROLE_ICONS" in self.dst.features
        # En ustteki rolden baslayarak olustur: yeni rol hep en alta eklendigi icin
        # sonunda sira eski sunucudakiyle ayni olur.
        roles = sorted(
            (r for r in self.src.roles if not r.is_default() and not r.managed),
            key=lambda r: r.position,
            reverse=True,
        )
        for role in roles:
            kwargs = dict(
                name=role.name,
                permissions=role.permissions,
                colour=role.colour,
                hoist=role.hoist,
                mentionable=role.mentionable,
                reason="Sunucu tasima",
            )
            if can_icon and role.display_icon is not None:
                if isinstance(role.display_icon, str):
                    kwargs["display_icon"] = role.display_icon
                else:
                    data = await read_asset(role.display_icon)
                    if data:
                        kwargs["display_icon"] = data
            new = await safe(f"Rol @{role.name}", self.dst.create_role(**kwargs))
            if new is None and "display_icon" in kwargs:
                kwargs.pop("display_icon")
                new = await safe(f"Rol @{role.name} (ikonsuz)", self.dst.create_role(**kwargs))
            if new is not None:
                self.role_map[role.id] = new
                log(f"  + @{role.name}")

        log(f"  {len(self.role_map)} rol olusturuldu.")

    # ---- 2) Emoji / Cikartma ----
    async def copy_emojis(self):
        log("\n[3/7] Emojiler ve cikartmalar kopyalaniyor...")
        count = 0
        for emoji in self.src.emojis:
            if emoji.managed:
                continue
            data = await read_asset(emoji)
            if not data:
                continue
            roles = [self.role_map[r.id] for r in emoji.roles if r.id in self.role_map]
            new = await safe(
                f"Emoji :{emoji.name}:",
                self.dst.create_custom_emoji(name=emoji.name, image=data, roles=roles or discord.utils.MISSING,
                                             reason="Sunucu tasima"),
            )
            if new is not None:
                self.emoji_map[emoji.id] = new
                count += 1
        log(f"  {count}/{len(self.src.emojis)} emoji kopyalandi.")

        count = 0
        for sticker in self.src.stickers:
            data = await read_asset(sticker)
            if not data:
                continue
            ext = "json" if sticker.format == discord.StickerFormatType.lottie else \
                  "gif" if sticker.format == discord.StickerFormatType.gif else "png"
            new = await safe(
                f"Cikartma {sticker.name}",
                self.dst.create_sticker(
                    name=sticker.name,
                    description=sticker.description or "",
                    emoji=sticker.emoji or "⭐",
                    file=discord.File(io.BytesIO(data), filename=f"sticker.{ext}"),
                    reason="Sunucu tasima",
                ),
            )
            if new is not None:
                count += 1
        log(f"  {count}/{len(self.src.stickers)} cikartma kopyalandi.")

    # ---- 3) Kanallar ----
    def map_overwrites(self, overwrites):
        result = {}
        for target, ow in overwrites.items():
            if isinstance(target, discord.Role):
                if target.is_default():
                    result[self.dst.default_role] = ow
                elif target.id in self.role_map:
                    result[self.role_map[target.id]] = ow
                # Bot rolleri gibi kopyalanmayan roller atlanir
            else:
                # Uye izni: ayni kullanici ID'si ile tasinir
                result[discord.Object(id=target.id)] = ow
        return result

    def map_tag_emoji(self, emoji):
        if emoji is None:
            return None
        if emoji.id is None:
            return emoji.name  # normal (unicode) emoji
        new = self.emoji_map.get(emoji.id)
        return new if new is not None else None

    async def create_channel(self, ch, category):
        ows = self.map_overwrites(ch.overwrites)
        base = dict(name=ch.name, category=category, reason="Sunucu tasima")
        community = "COMMUNITY" in self.dst.features

        async def attempt(overwrites):
            if isinstance(ch, discord.ForumChannel):
                tags = []
                for t in ch.available_tags:
                    tags.append(discord.ForumTag(name=t.name, emoji=self.map_tag_emoji(t.emoji), moderated=t.moderated))
                kwargs = dict(
                    topic=ch.topic or discord.utils.MISSING,
                    nsfw=ch.nsfw,
                    slowmode_delay=ch.slowmode_delay,
                    default_auto_archive_duration=ch.default_auto_archive_duration,
                    default_thread_slowmode_delay=ch.default_thread_slowmode_delay,
                    default_layout=ch.default_layout,
                    available_tags=tags,
                    overwrites=overwrites,
                    media=ch.is_media(),
                )
                if ch.default_sort_order is not None:
                    kwargs["default_sort_order"] = ch.default_sort_order
                if ch.default_reaction_emoji is not None:
                    e = self.map_tag_emoji(ch.default_reaction_emoji)
                    if e is not None:
                        kwargs["default_reaction_emoji"] = e
                return await self.dst.create_forum(**base, **kwargs)

            if isinstance(ch, discord.StageChannel) and community:
                return await self.dst.create_stage_channel(
                    **base, overwrites=overwrites,
                    bitrate=min(ch.bitrate, int(self.dst.bitrate_limit)),
                    user_limit=ch.user_limit, rtc_region=ch.rtc_region,
                )

            if isinstance(ch, (discord.VoiceChannel, discord.StageChannel)):
                kwargs = dict(
                    overwrites=overwrites,
                    bitrate=min(ch.bitrate, int(self.dst.bitrate_limit)),
                    user_limit=min(ch.user_limit, 99),
                    rtc_region=ch.rtc_region,
                    nsfw=ch.nsfw,
                )
                if isinstance(ch, discord.VoiceChannel):
                    kwargs["video_quality_mode"] = ch.video_quality_mode
                return await self.dst.create_voice_channel(**base, **kwargs)

            if isinstance(ch, discord.TextChannel):
                kwargs = dict(
                    overwrites=overwrites,
                    topic=ch.topic or discord.utils.MISSING,
                    nsfw=ch.nsfw,
                    slowmode_delay=ch.slowmode_delay,
                    default_auto_archive_duration=ch.default_auto_archive_duration,
                )
                if ch.default_thread_slowmode_delay:
                    kwargs["default_thread_slowmode_delay"] = ch.default_thread_slowmode_delay
                if ch.is_news() and community:
                    kwargs["news"] = True
                return await self.dst.create_text_channel(**base, **kwargs)

            log(f"  [!] Desteklenmeyen kanal tipi atlandi: {ch.name} ({ch.type})")
            return None

        try:
            return await attempt(ows)
        except discord.HTTPException as e:
            # Uye izinleri (yeni sunucuda olmayan kisiler) sorun cikarirsa sadece rol izinleriyle dene
            role_only = {k: v for k, v in ows.items() if isinstance(k, discord.Role)}
            if len(role_only) != len(ows):
                try:
                    return await attempt(role_only)
                except discord.HTTPException as e2:
                    e = e2
            if isinstance(ch, discord.ForumChannel):
                log(f"  [!] Forum #{ch.name} olusturulamadi ({e.text}), yazi kanali olarak aciliyor.")
                return await safe(
                    f"Kanal #{ch.name}",
                    self.dst.create_text_channel(**base, overwrites=role_only, topic=ch.topic or discord.utils.MISSING),
                )
            log(f"  [!] Kanal #{ch.name} basarisiz: {e.status} {e.text}")
            return None

    async def copy_channels(self):
        log("\n[4/7] Kategoriler ve kanallar kopyalaniyor...")
        for category, channels in self.src.by_category():
            new_cat = None
            if category is not None:
                new_cat = await safe(
                    f"Kategori {category.name}",
                    self.dst.create_category(
                        name=category.name,
                        overwrites=self.map_overwrites(category.overwrites),
                        reason="Sunucu tasima",
                    ),
                )
                if new_cat is None:
                    new_cat = await safe(
                        f"Kategori {category.name} (izinsiz)",
                        self.dst.create_category(name=category.name, reason="Sunucu tasima"),
                    )
                if new_cat is not None:
                    self.channel_map[category.id] = new_cat
                    log(f"  + [{category.name}]")
            for ch in channels:
                new = await self.create_channel(ch, new_cat)
                if new is not None:
                    self.channel_map[ch.id] = new
                    log(f"      + #{ch.name}")

    # ---- 4) Sunucu ayarlari ----
    async def copy_settings(self):
        log("\n[5/7] Sunucu ayarlari kopyalaniyor...")
        src, dst = self.src, self.dst
        cm = self.channel_map

        def mapped(ch):
            return cm.get(ch.id) if ch is not None else None

        basic = dict(
            name=src.name,
            description=src.description,
            verification_level=src.verification_level,
            default_notifications=src.default_notifications,
            explicit_content_filter=src.explicit_content_filter,
            afk_timeout=src.afk_timeout,
            system_channel_flags=src.system_channel_flags,
            preferred_locale=src.preferred_locale,
            reason="Sunucu tasima",
        )
        afk = mapped(src.afk_channel)
        if isinstance(afk, discord.VoiceChannel):
            basic["afk_channel"] = afk
        sys_ch = mapped(src.system_channel)
        if isinstance(sys_ch, discord.TextChannel):
            basic["system_channel"] = sys_ch
        if "COMMUNITY" in dst.features:
            rules = mapped(src.rules_channel)
            if isinstance(rules, discord.TextChannel):
                basic["rules_channel"] = rules
            upd = mapped(src.public_updates_channel)
            if isinstance(upd, discord.TextChannel):
                basic["public_updates_channel"] = upd
        await safe("Temel ayarlar", dst.edit(**basic))

        icon = await read_asset(src.icon)
        if icon:
            await safe("Sunucu ikonu", dst.edit(icon=icon))
        banner = await read_asset(src.banner)
        if banner:
            await safe("Banner (boost gerekir)", dst.edit(banner=banner))
        splash = await read_asset(src.splash)
        if splash:
            await safe("Davet arka plani (boost gerekir)", dst.edit(splash=splash))
        log("  Ayarlar tamam.")

    # ---- 5) Banlar ----
    async def copy_bans(self):
        log("\n[6/7] Banlar kopyalaniyor...")
        count = 0
        try:
            async for entry in self.src.bans(limit=None):
                try:
                    await self.dst.ban(entry.user, reason=(entry.reason or "Sunucu tasima")[:512],
                                       delete_message_seconds=0)
                    count += 1
                except discord.HTTPException as e:
                    log(f"  [!] Ban {entry.user} basarisiz: {e.status} {e.text}")
        except discord.Forbidden:
            log("  [!] Eski sunucuda ban listesini okuma yetkisi yok.")
        log(f"  {count} ban kopyalandi.")

    # ---- 6) Mesajlar ----
    async def copy_messages(self, limit):
        log(f"\n[7/7] Mesajlar kopyalaniyor (kanal basina en fazla {limit})...")
        size_limit = self.dst.filesize_limit
        for old in self.src.text_channels:
            new = self.channel_map.get(old.id)
            if not isinstance(new, discord.TextChannel):
                continue
            try:
                messages = [m async for m in old.history(limit=limit)]
            except discord.Forbidden:
                log(f"  [!] #{old.name}: okuma yetkisi yok, atlandi.")
                continue
            messages.reverse()  # eskiden yeniye
            if not messages:
                continue

            hook = await safe(f"Webhook #{new.name}", new.create_webhook(name="Sunucu Tasima"))
            if hook is None:
                continue
            sent = 0
            for msg in messages:
                if msg.type not in (discord.MessageType.default, discord.MessageType.reply):
                    continue
                files = []
                for att in msg.attachments:
                    if att.size <= size_limit:
                        f = await safe(f"Dosya {att.filename}", att.to_file())
                        if f is not None:
                            files.append(f)
                embeds = [e for e in msg.embeds if e.type == "rich"][:10]
                content = msg.content or ""
                if not content and not files and not embeds:
                    continue
                ok = await safe(
                    f"Mesaj #{new.name}",
                    hook.send(
                        content=content[:2000] or discord.utils.MISSING,
                        username=clean_webhook_name(msg.author.display_name),
                        avatar_url=msg.author.display_avatar.url,
                        embeds=embeds or discord.utils.MISSING,
                        files=files or discord.utils.MISSING,
                        allowed_mentions=discord.AllowedMentions.none(),
                        wait=True,
                    ),
                )
                if ok is not None:
                    sent += 1
            await safe("Webhook silme", hook.delete())
            log(f"  #{new.name}: {sent} mesaj")

    async def run(self):
        cfg = self.cfg
        if cfg["wipe_target"]:
            await self.wipe()
        if cfg["copy_roles"]:
            await self.copy_roles()
        if cfg["copy_emojis"]:
            await self.copy_emojis()
        if cfg["copy_channels"]:
            await self.copy_channels()
        if cfg["copy_settings"]:
            await self.copy_settings()
        if cfg["copy_bans"]:
            await self.copy_bans()
        if cfg["messages_per_channel"] > 0 and cfg["copy_channels"]:
            await self.copy_messages(cfg["messages_per_channel"])
        log("\n" + "=" * 60)
        log(" TASIMA BITTI!")
        log(" Simdi yeni sunucu icin davet linki olusturup uyelere paylas.")
        log("=" * 60)


# ----------------- BOT -----------------

def main():
    cfg = load_config()

    intents = discord.Intents.default()
    if cfg["messages_per_channel"] > 0:
        intents.message_content = True  # Developer Portal'da da acik olmali
    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        log(f"Bot giris yapti: {client.user}")
        try:
            guilds = sorted(client.guilds, key=lambda g: g.name.lower())
            if len(guilds) < 2:
                invite = discord.utils.oauth_url(client.user.id, permissions=discord.Permissions(administrator=True))
                log("\nHATA: Bot en az 2 sunucuda olmali (eski ve yeni).")
                log(f"Botu su linkle iki sunucuya da ekle, sonra tekrar calistir:\n{invite}")
                return

            print("\nBotun bulundugu sunucular:")
            src = await asyncio.to_thread(pick_guild, guilds, "KOPYALANACAK (eski) sunucunun numarasi",
                                          cfg.get("source_id"))
            print(f"\n'{src.name}' sunucusu su sunucuya kopyalanacak:")
            dst = await asyncio.to_thread(pick_guild, guilds, "HEDEF (yeni) sunucunun numarasi",
                                          cfg.get("target_id"), src)
            cfg["source_id"], cfg["target_id"] = str(src.id), str(dst.id)
            save_config(cfg)
            log(f"Eski sunucu: {src.name}  ->  Yeni sunucu: {dst.name}")
            if not dst.me.guild_permissions.administrator:
                log("HATA: Bot yeni sunucuda Yonetici (Administrator) yetkisine sahip olmali.")
                return
            if not src.me.guild_permissions.administrator:
                log("UYARI: Bot eski sunucuda Yonetici degil; gizli kanallar / banlar okunamayabilir.")
            if cfg["wipe_target"]:
                log(f"\nDIKKAT: '{dst.name}' sunucusundaki kanal, rol ve emojiler SILINECEK.")
                confirm = await asyncio.to_thread(input, "Devam etmek icin yeni sunucunun adini aynen yaz: ")
                if confirm.strip() != dst.name:
                    log("Isim eslesmedi, iptal edildi.")
                    return
            await Migrator(client, src, dst, cfg).run()
        except Exception as e:
            log(f"Beklenmeyen hata: {e!r}")
        finally:
            await client.close()

    try:
        client.run(cfg["token"], log_handler=None)
    except discord.LoginFailure:
        print("HATA: Token gecersiz. tasima_config.json dosyasini silip tekrar dene.")
    except discord.PrivilegedIntentsRequired:
        print("HATA: Developer Portal > Bot > 'Message Content Intent' acik olmali (mesaj kopyalama icin).")
    input("\nCikmak icin Enter'a bas...")


if __name__ == "__main__":
    main()
