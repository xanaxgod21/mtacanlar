#!/usr/bin/env python3
"""
Ticket bildirim botu (normal Discord BOT hesabi ile calisir, selfbot DEGIL).

NE YAPAR:
  - Belirledigin kategoride yeni bir kanal acildiginda (istersen sadece adi
    belirledigin onekle baslayanlar) sana haber verir:
      * bilgisayarda bildirim sesi calar ve pencere yanip soner
        (exe'nin yanina "bildirim.wav" koyarsan o ses calar)
      * istersen webhook'una mesaj atar (telefonda bildirim olarak duser)
      * istersen sana DM de atar
  - Mesajda kanala tek tikla gitmen icin link olur, claim'e SEN basarsin.

NE YAPMAZ:
  - Hicbir butona basmaz, ticket'i claimlemez, kanala yazmaz.
  - Kullanici hesabinla calismaz (token olarak BOT token'i ister).

KURULUM:
  1) https://discord.com/developers/applications -> New Application -> Bot
     -> Reset Token ile bot token'ini al.
  2) OAuth2 -> URL Generator -> scope: "bot", izin: "View Channels"
     Linki sunucu sahibine/yetkiliye ver, botu sunucuya eklesin.
  3) Ticket kanallari gizliyse bot da gorebilmeli: ticket kategorisinde bota
     (ya da botun rolune) "Kanali Gor" izni verilmeli. Goremedigi kanalin
     acildigindan haberi olmaz.
  4) pip install -U discord.py
  5) python ticket_bildirim.py  -> ilk acilista ayarlari sorar ve
     ticket_config.json dosyasina kaydeder.
"""

import os
import sys
import json
import threading

try:
    import discord
except ImportError:
    print("discord.py kurulu degil. Once: pip install -U discord.py")
    sys.exit(1)

CONFIG_NAME = "ticket_config.json"
SOUND_NAME  = "bildirim.wav"   # exe'nin yanina koyarsan bu ses calar


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def ask(prompt, default=""):
    val = input(prompt).strip()
    return val or default


def parse_ids(text):
    return [int(x) for x in text.replace(" ", "").split(",") if x.isdigit()]


def load_config():
    path = os.path.join(app_dir(), CONFIG_NAME)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    print("Ilk kurulum. Bos biraktiklarin kullanilmaz.\n")
    cfg = {
        "token": ask("Bot token'i: "),
        "category_ids": parse_ids(ask("Ticket kategori ID'leri (virgulle, bos = hepsi): ")),
        "name_prefixes": [
            p.strip().lower()
            for p in ask("Kanal adi onekleri (virgulle, bos = kategorideki her kanal): ").split(",")
            if p.strip()
        ],
        "webhook_url": ask("Bildirim webhook adresi (bos = kullanma): "),
        "dm_user_ids": parse_ids(ask("DM atilacak kullanici ID'leri (virgulle, bos = DM yok): ")),
        "ping_user_id": ask("Webhook mesajinda etiketlenecek kullanici ID'si (bos = etiket yok): "),
        "sound_repeat": int(ask("Bildirim sesi kac kez calsin (varsayilan 3, 0 = ses yok): ", "3") or 0),
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"Kaydedildi -> {path}\n")
    return cfg


def flash_window():
    # Konsol penceresini gorev cubugunda, pencereye tiklayana kadar yakip sondurur
    try:
        import ctypes
        from ctypes import wintypes

        class FLASHWINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.UINT),
                ("hwnd", wintypes.HWND),
                ("dwFlags", wintypes.DWORD),
                ("uCount", wintypes.UINT),
                ("dwTimeout", wintypes.DWORD),
            ]

        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            FLASHW_ALL, FLASHW_TIMERNOFG = 0x3, 0xC
            info = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0)
            ctypes.windll.user32.FlashWindowEx(ctypes.byref(info))
    except Exception:
        pass


def play_sound(repeat):
    if repeat <= 0:
        return
    if sys.platform != "win32":
        print("\a", end="", flush=True)
        return

    import winsound
    wav = os.path.join(app_dir(), SOUND_NAME)

    def run():
        for _ in range(repeat):
            try:
                if os.path.exists(wav):
                    winsound.PlaySound(wav, winsound.SND_FILENAME)
                else:
                    winsound.PlaySound("SystemExclamation", winsound.SND_ALIAS)
            except Exception:
                winsound.MessageBeep()

    # Ayri thread'de cal ki bot beklemesin
    threading.Thread(target=run, daemon=True).start()
    flash_window()


def is_ticket(channel, cfg):
    if not isinstance(channel, discord.TextChannel):
        return False
    cats = cfg.get("category_ids") or []
    if cats and channel.category_id not in cats:
        return False
    prefixes = cfg.get("name_prefixes") or []
    if prefixes and not any(channel.name.lower().startswith(p) for p in prefixes):
        return False
    return True


def main():
    cfg = load_config()
    if not cfg.get("token"):
        print("Token girilmedi, cikiliyor.")
        return
    sound_repeat = int(cfg.get("sound_repeat", 3) or 0)
    if not sound_repeat and not cfg.get("webhook_url") and not cfg.get("dm_user_ids"):
        print("Ses, webhook ve DM kapali; bildirim gidecek yer yok, cikiliyor.")
        return

    intents = discord.Intents.none()
    intents.guilds = True  # kanal olusturma olaylari icin yeterli
    client = discord.Client(intents=intents)

    @client.event
    async def on_ready():
        print(f"Giris yapildi: {client.user} | {len(client.guilds)} sunucu izleniyor")

    @client.event
    async def on_guild_channel_create(channel):
        if not is_ticket(channel, cfg):
            return

        link = f"https://discord.com/channels/{channel.guild.id}/{channel.id}"
        text = f"Yeni ticket: **#{channel.name}** ({channel.guild.name})\n{link}"
        print(text.replace("**", ""))
        play_sound(sound_repeat)

        if cfg.get("webhook_url"):
            ping = cfg.get("ping_user_id")
            content = f"<@{ping}> {text}" if ping else text
            try:
                webhook = discord.Webhook.from_url(cfg["webhook_url"], client=client)
                await webhook.send(
                    content,
                    username="Ticket Bildirim",
                    allowed_mentions=discord.AllowedMentions(users=True, everyone=False, roles=False),
                )
            except Exception as e:
                print(f"  webhook hatasi: {e}")

        for uid in cfg.get("dm_user_ids") or []:
            try:
                user = client.get_user(uid) or await client.fetch_user(uid)
                await user.send(text)
            except Exception as e:
                # DM icin bot ile ortak sunucuda olman ve DM'lerin acik olmasi gerekir
                print(f"  DM atilamadi ({uid}): {e}")

    try:
        client.run(cfg["token"])
    except discord.LoginFailure:
        print(f"Token gecersiz. {CONFIG_NAME} dosyasini silip tekrar dene.")


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            input("\nKapatmak icin Enter'a bas...")
        except EOFError:
            pass
