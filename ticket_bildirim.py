#!/usr/bin/env python3
"""
Ticket alarm - arayuzlu (normal Discord BOT hesabi ile calisir, selfbot DEGIL).

NE YAPAR:
  - Belirledigin kategoride yeni bir kanal acildiginda bu bilgisayarda
    sesli bildirim verir, sagdan Windows bildirimi cikar, pencere yanip soner.
  - Windows bildirimine ya da "Kanala git"e tiklayinca Discord uygulamasi
    o ticket kanalinda acilir. Claim'e SEN basarsin.

NE YAPMAZ:
  - Hicbir butona basmaz, ticket'i claimlemez, kanala yazmaz.
  - Webhook'a / DM'e mesaj atmaz.
  - Kullanici hesabinla calismaz (token olarak BOT token'i ister).

KURULUM:
  1) https://discord.com/developers/applications -> New Application -> Bot
     -> Reset Token ile bot token'ini al.
  2) OAuth2 -> URL Generator -> scope: "bot", izin: "View Channels"
     Linki sunucu sahibine/yetkiliye ver, botu sunucuya eklesin.
  3) Ticket kanallari gizliyse bot da gorebilmeli: ticket kategorisinde bota
     (ya da botun rolune) "Kanali Gor" izni verilmeli. Goremedigi kanalin
     acildigindan haberi olmaz.
  4) pip install -U discord.py customtkinter pillow
  5) python ticket_bildirim.py -> ayarlari pencereden gir, Baslat'a bas.
     Ayarlar ticket_config.json dosyasina kaydedilir.
"""

import os
import sys
import json
import time
import base64
import tempfile
import subprocess
from xml.sax.saxutils import escape
import queue
import asyncio
import threading
import webbrowser
import tkinter as tk
from tkinter import messagebox, filedialog

import customtkinter as ctk

try:
    from PIL import Image, ImageTk, ImageDraw, ImageEnhance, ImageFilter
except ImportError:
    Image = None

try:
    import discord
except ImportError:
    discord = None

try:
    import pystray
except Exception:
    pystray = None

CONFIG_NAME = "ticket_config.json"
SOUND_NAME  = "bildirim.wav"   # exe'nin yanina koyarsan bu ses calar
BG_NAME     = "arka_plan.jpg"  # exe'nin yanina ayni isimle koyarsan arka plan o olur
APP_NAME    = "Ticket Alarm"

# Renkler: arka plan resmine uygun kirmizi/siyah tema, yuzeyler koyu bordo
BG        = "#0b0405"
SIDEBAR   = "#0e0607"
CARD      = "#160a0c"
CARD_HI   = "#1f0e10"
CARD_ROW  = "#1a0b0d"
FIELD     = "#100607"
BORDER    = "#33161a"
BORDER_HI = "#5a1d24"
TEXT      = "#f3e7e8"
MUTED     = "#a88c8f"
ACCENT    = "#e8283a"
ACCENT_H  = "#c01d2e"
GLOW      = "#ff5a68"
GREEN     = "#4ade80"
GREEN_DIM = "#1f6b3e"
YELLOW    = "#fbbf24"

FONT = "Segoe UI"


# ----------------- yardimcilar -----------------

def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def config_path():
    return os.path.join(app_dir(), CONFIG_NAME)


def resource(name):
    # Once exe'nin yanina bak (kullanici degistirebilsin), yoksa exe'nin icindekini kullan
    outside = os.path.join(app_dir(), name)
    if os.path.exists(outside):
        return outside
    base = getattr(sys, "_MEIPASS", app_dir())
    return os.path.join(base, "assets", name)


def parse_ids(text):
    return [int(x) for x in str(text).replace(" ", "").split(",") if x.isdigit()]


def ids_to_text(ids):
    return ", ".join(str(i) for i in ids or [])


def load_config():
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def parse_names(text):
    return [n.strip() for n in str(text).split(",") if n.strip()]


def name_matches(category_name, names):
    # Buyuk/kucuk harf fark etmez, kategori adinin icinde gecmesi yeterli
    # ("ticket" yazinca "╭・📩 Ticketlar 2" de eslesir)
    cat = (category_name or "").casefold()
    return any(n.casefold() in cat for n in names)


def is_ticket(channel, cfg, category_name=None):
    """Kanal izlenen bir kategoride mi? ID ile ya da kategori adiyla bakar.
    Ad ile bakmak, ticket botu kategoriyi silip yeniden acsa da calisir."""
    if not isinstance(channel, discord.TextChannel) or channel.category_id is None:
        return False
    if channel.category_id in (cfg.get("category_ids") or []):
        return True
    if category_name is None and channel.category is not None:
        category_name = channel.category.name
    return name_matches(category_name, cfg.get("category_names") or [])


TICKET_WORDS = ("ticket", "destek", "support", "talep")


def looks_like_ticket(channel_name, category_name):
    # Kanali kimin actigi ogrenilemezse yedek kontrol: adlarda ticket'a benzer kelime var mi
    return name_matches(category_name, TICKET_WORDS) or name_matches(channel_name, TICKET_WORDS)


DEFAULT_MESSAGE = "Merhaba {acan}, ticketin alindi. En kisa surede ilgilenecegim."


def format_message(template, channel_name, guild_name, opener_mention):
    # Mesajdaki degiskenleri doldurur: {acan} {kanal} {sunucu}
    return (template.replace("{acan}", opener_mention)
                    .replace("{kanal}", f"#{channel_name}")
                    .replace("{sunucu}", guild_name)).strip()


def has_target(cfg):
    return bool(cfg.get("auto_detect", True) or cfg.get("category_ids") or cfg.get("category_names"))


_sound_stop = threading.Event()


def sound_path(sound_file=""):
    # Sira: secilen dosya > exe'nin yanindaki bildirim.wav > exe'nin icindeki ses
    for path in (sound_file, resource(SOUND_NAME)):
        if path and os.path.exists(path):
            return path
    return ""


def play_sound(repeat, sound_file=""):
    if repeat <= 0:
        return
    if sys.platform != "win32":
        print("\a", end="", flush=True)
        return

    import winsound
    wav = sound_path(sound_file)
    stop_sound()
    _sound_stop.clear()

    def run():
        for _ in range(repeat):
            if _sound_stop.is_set():
                break
            try:
                if wav:
                    winsound.PlaySound(wav, winsound.SND_FILENAME)
                else:
                    winsound.PlaySound("SystemExclamation", winsound.SND_ALIAS)
            except Exception:
                winsound.MessageBeep()

    # Ayri thread'de cal ki arayuz donmasin
    threading.Thread(target=run, daemon=True).start()


def stop_sound():
    _sound_stop.set()
    if sys.platform == "win32":
        try:
            import winsound
            winsound.PlaySound(None, 0)
        except Exception:
            pass


def open_link(app_link, web_link):
    # Discord uygulamasinda ac; uygulama yoksa tarayicida ac
    if sys.platform == "win32":
        try:
            os.startfile(app_link)
            return
        except OSError:
            pass
    webbrowser.open(web_link)


# Bildirimler bu kimlikle gosterilir; ilk kullanimda Windows'a (sadece bu kullanici icin) kaydedilir
TOAST_APP_ID = "MDTicket.TicketAlarm"
# Kayit ise yaramazsa Windows'un hazir PowerShell kimligi denenir
PS_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"


def register_toast_app(icon=""):
    """Bildirimin sahibi olarak 'Ticket Alarm'i Windows'a tanitir (yonetici izni gerekmez)."""
    if sys.platform != "win32":
        return False
    try:
        import winreg
        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                               rf"Software\Classes\AppUserModelId\{TOAST_APP_ID}")
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(key, "ShowInSettings", 0, winreg.REG_DWORD, 1)
        if icon:
            winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, icon)
        winreg.CloseKey(key)
        return True
    except Exception:
        return False


def windows_toast(title, body, app_link, icon="", report=None):
    """Sag alttan Windows bildirimi; tiklayinca app_link (discord://) acilir.
    Hata olursa report(mesaj) cagrilir."""
    if sys.platform != "win32":
        return
    link = escape(app_link, {'"': "&quot;"})
    img = ""
    if icon:
        src = escape("file:///" + icon.replace("\\", "/"), {'"': "&quot;"})
        img = f'<image placement="appLogoOverride" hint-crop="circle" src="{src}"/>'
    xml = (
        f'<toast activationType="protocol" launch="{link}" duration="long">'
        f'<visual><binding template="ToastGeneric">'
        f'<text>{escape(title)}</text><text>{escape(body)}</text>{img}'
        f'</binding></visual>'
        f'<audio silent="true"/>'
        f'<actions><action content="Ticket\'a git" activationType="protocol" arguments="{link}"/></actions>'
        f'</toast>'
    )
    ps = (
        "$ErrorActionPreference = 'Stop'\n"
        "$ProgressPreference = 'SilentlyContinue'\n"
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null\n"
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null\n"
        "$x = New-Object Windows.Data.Xml.Dom.XmlDocument\n"
        "$x.LoadXml(@'\n" + xml + "\n'@)\n"
        "$t = [Windows.UI.Notifications.ToastNotification]::new($x)\n"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('__APPID__').Show($t)\n"
    )

    def run_ps(app_id):
        script = ps.replace("__APPID__", app_id)
        encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
            capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        err = (r.stderr or "").strip()
        return r.returncode == 0 and "Exception" not in err, err

    def run():
        # Arayuz donmasin diye ayri thread'de; once kendi kimligimizle, olmazsa PowerShell kimligiyle
        try:
            ok, err = run_ps(TOAST_APP_ID) if register_toast_app(icon) else (False, "")
            if not ok:
                ok, err = run_ps(PS_APP_ID)
            if not ok and report:
                report("Windows bildirimi gosterilemedi: " + (err.splitlines()[0] if err else "bilinmeyen hata"))
        except Exception as e:
            if report:
                report(f"Windows bildirimi gosterilemedi: {e}")

    threading.Thread(target=run, daemon=True).start()


def flash_window(root):
    # Pencereyi gorev cubugunda, uzerine gelene kadar yakip sondurur (sadece Windows)
    if sys.platform != "win32":
        return
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

        hwnd = ctypes.windll.user32.GetParent(root.winfo_id()) or root.winfo_id()
        FLASHW_ALL, FLASHW_TIMERNOFG = 0x3, 0xC
        info = FLASHWINFO(ctypes.sizeof(FLASHWINFO), hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0)
        ctypes.windll.user32.FlashWindowEx(ctypes.byref(info))
    except Exception:
        pass


# ----------------- kullanim kolayligi: tek kopya, otomatik baslatma, kisayol -----------------

AUTOSTART_NAME = "TicketAlarm"
AUTOSTART_ARG = "--autostart"
HOTKEYS = {  # id: (tus adi, Windows modifier, sanal tus kodu, olay)
    1: ("Ctrl+F9", 0x0002, 0x78, "open_last"),
    2: ("Ctrl+F10", 0x0002, 0x79, "silence"),
}
_mutex = None


def already_running():
    # Ayni anda iki kopya calismasin (biri Windows acilisindan, biri elle acilmis olabilir)
    global _mutex
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        _mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\TicketAlarmTekKopya")
        return ctypes.windll.kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return False


def autostart_command():
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" {AUTOSTART_ARG}'
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    exe = pyw if os.path.exists(pyw) else sys.executable
    return f'"{exe}" "{os.path.abspath(__file__)}" {AUTOSTART_ARG}'


def set_autostart(enabled):
    """Windows acilinca programi baslatir (sadece bu kullanici, yonetici izni gerekmez).
    Basariliysa None, degilse hata mesaji doner."""
    if sys.platform != "win32":
        return "sadece Windows'ta calisir"
    try:
        import winreg
        key = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,
                                 r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
        if enabled:
            winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(key, AUTOSTART_NAME)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return None
    except Exception as e:
        return str(e) or e.__class__.__name__


class HotkeyListener:
    """Program arka plandayken bile calisan kisayol tuslari (RegisterHotKey)."""

    def __init__(self, on_key):
        self.on_key = on_key
        self.thread_id = None
        self.failed = []

    def start(self):
        if sys.platform != "win32":
            return
        ready = threading.Event()
        threading.Thread(target=self._run, args=(ready,), daemon=True).start()
        ready.wait(2)

    def _run(self, ready):
        import ctypes
        from ctypes import wintypes
        user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
        self.thread_id = kernel32.GetCurrentThreadId()
        for hid, (name, mod, vk, _event) in HOTKEYS.items():
            if not user32.RegisterHotKey(None, hid, mod | 0x4000, vk):  # 0x4000 = tekrar etme
                self.failed.append(name)
        ready.set()
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == 0x0312 and msg.wParam in HOTKEYS:  # WM_HOTKEY
                self.on_key(HOTKEYS[msg.wParam][3])
        for hid in HOTKEYS:
            user32.UnregisterHotKey(None, hid)

    def stop(self):
        if self.thread_id:
            import ctypes
            ctypes.windll.user32.PostThreadMessageW(self.thread_id, 0x0012, 0, 0)  # WM_QUIT


# ----------------- bot (arka plan thread'i) -----------------

class BotRunner:
    """discord.py client'ini ayri bir thread'de calistirir, olaylari kuyruga atar."""

    def __init__(self, cfg, events):
        self.cfg = cfg
        self.events = events
        self.message_turn = 0  # sirayla mesaj: kacinci ticket
        self.loop = None
        self.client = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        if self.loop and self.client and not self.loop.is_closed():
            asyncio.run_coroutine_threadsafe(self.client.close(), self.loop)

    def _emit(self, kind, *data):
        self.events.put((kind, *data))

    def _check(self):
        """Kurulum hatalarini bulur: bot sunucuda mi, kategori dogru mu, kanallari gorebilir mi."""
        client, problems = self.client, []
        if not client.guilds:
            return ["Bot hicbir sunucuda degil. Once botu sunucuna ekle "
                    "(Developer Portal > OAuth2 > URL Generator > bot)."]
        names = self.cfg.get("category_names") or []
        auto = self.cfg.get("auto_detect", True)
        if auto:
            self._emit("log", "Otomatik algilama acik: botun gordugu tum sunucularda, ticket botunun "
                              "actigi her yeni kanal icin alarm calar.")
        if names or auto:
            for guild in client.guilds:
                if not guild.me.guild_permissions.administrator:
                    problems.append(f"Bot '{guild.name}' sunucusunda yonetici degil. Ticket botlari "
                                    "kanallari gizli acar; bot goremedigi kanalin acildigini fark etmez. "
                                    "Bota Yonetici yetkisi olan bir rol ver.")
        if names and not auto:
            found = [c for g in client.guilds for c in g.categories if name_matches(c.name, names)]
            # Kategori su an yoksa sorun degil: ticket botu acinca otomatik izlenir
            self._emit("log", "Izlenen kategori: " + ", ".join(c.name for c in found) if found else
                       "Su an bu adla kategori yok; ticket botu acinca otomatik izlenecek.")
        for cid in self.cfg.get("category_ids") or []:
            ch = client.get_channel(cid)
            if ch is None:
                problems.append(f"{cid} ID'li kategori bulunamadi. ID yanlis olabilir ya da bot "
                                "o kategoriyi goremiyor.")
            elif not isinstance(ch, discord.CategoryChannel):
                problems.append(f"{cid} bir kategori degil (#{ch.name} kanali). Kanala degil, "
                                "kategorinin basligina sag tik > ID'yi Kopyala.")
            elif not (names or auto) and not ch.permissions_for(ch.guild.me).administrator:
                problems.append(f"Bot '{ch.guild.name}' sunucusunda yonetici degil. Ticket botlari "
                                "kanallari gizli acar; bot goremedigi kanalin acildigini fark etmez. "
                                "Bota Yonetici yetkisi olan bir rol ver.")
        return problems

    async def _send_message(self, channel):
        """Ticket kanalina, ticket botunun mesajindan sonra, belirlenen mesaji bot hesabiyla atar."""
        cfg = self.cfg
        await asyncio.sleep(max(0.0, float(cfg.get("message_delay", 2))))
        # Ticket'i acan kisi: kanalda ozel izni olan, bot olmayan uye
        opener = next((t for t in channel.overwrites
                       if isinstance(t, discord.Member) and not t.bot), None)
        text = format_message(cfg.get("message_text", ""), channel.name, channel.guild.name,
                              opener.mention if opener else "")
        if not text:
            return
        try:
            await channel.send(text[:2000], allowed_mentions=discord.AllowedMentions(
                users=True, roles=False, everyone=False))
            self._emit("log", f"Mesaj atildi: #{channel.name}")
        except discord.Forbidden:
            self._emit("log", f"#{channel.name} kanalina mesaj atilamadi: botun yazma izni yok.")
        except Exception as e:
            self._emit("log", f"#{channel.name} kanalina mesaj atilamadi: {e}")

    async def _creator(self, channel):
        """Kanali kim acti? Denetim kaydindan bakar; izin yoksa None doner."""
        for _ in range(4):
            try:
                async for entry in channel.guild.audit_logs(limit=15, action=discord.AuditLogAction.channel_create):
                    if entry.target is not None and entry.target.id == channel.id:
                        return entry.user
            except discord.Forbidden:
                return None
            except Exception:
                pass
            await asyncio.sleep(0.6)  # kayit bazen kanaldan biraz sonra dusuyor
        return None

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        intents = discord.Intents.none()
        intents.guilds = True  # kanal olusturma olaylari icin yeterli
        self.client = discord.Client(intents=intents)
        cfg, client = self.cfg, self.client

        @client.event
        async def on_ready():
            self._emit("ready", str(client.user), len(client.guilds))
            self._emit("check", self._check())

        @client.event
        async def on_guild_channel_create(channel):
            category_name = None
            if channel.category is None and channel.category_id and cfg.get("category_names"):
                # Kategori kanalla ayni anda acildiysa henuz hafizada olmayabilir; Discord'dan sor
                try:
                    category_name = (await client.fetch_channel(channel.category_id)).name
                except Exception:
                    pass
            ticket = is_ticket(channel, cfg, category_name)
            if not ticket and cfg.get("auto_detect", True) and isinstance(channel, discord.TextChannel):
                # Otomatik: kanali bir bot (ticket botu) actiysa ticket say
                creator = await self._creator(channel)
                if creator is not None:
                    ticket = creator.bot and creator.id != client.user.id
                else:
                    if category_name is None and channel.category is not None:
                        category_name = channel.category.name
                    ticket = looks_like_ticket(channel.name, category_name)
            if ticket:
                path = f"channels/{channel.guild.id}/{channel.id}"
                link = (f"discord://-/{path}", f"https://discord.com/{path}")
                auto = bool(cfg.get("auto_message") and (cfg.get("message_text") or "").strip())
                manual = False
                if auto and cfg.get("message_alternate"):
                    # Sirayla: 1. ticket'a bot yazar, 2. ticket'a sen, 3.'ye bot...
                    self.message_turn += 1
                    auto = self.message_turn % 2 == 1
                    manual = not auto
                self._emit("ticket", channel.guild.name, channel.name, link, manual)
                if auto:
                    asyncio.ensure_future(self._send_message(channel))
            else:
                self._emit("log", f"Kanal acildi ama ticket degil: #{channel.name}")

        try:
            self.loop.run_until_complete(client.start(cfg["token"]))
        except discord.LoginFailure:
            self._emit("error", "Token gecersiz. Bot token'ini kontrol et.")
        except Exception as e:
            self._emit("error", f"Baglanti hatasi: {e}")
        finally:
            try:
                if not client.is_closed():
                    self.loop.run_until_complete(client.close())
            except Exception:
                pass
            self.loop.close()
            self._emit("stopped")


# ----------------- arayuz parcalari -----------------

def font(size=13, weight="normal"):
    return ctk.CTkFont(family=FONT, size=size, weight=weight)


def load_bg():
    if Image is None:
        return None
    try:
        return Image.open(resource(BG_NAME)).convert("RGB")
    except Exception:
        return None


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Background:
    """Canvas'a arka plan resmini ve kartlarin arkasindaki kirmizi parlamayi cizer."""

    def __init__(self, canvas, image):
        self.canvas = canvas
        self.src = image
        self.photo = None
        self.key = None
        self.base_key = None
        self.base = None
        self.item = canvas.create_image(0, 0, anchor="nw")
        canvas.tag_lower(self.item)

    def _base(self, w, h, focus_x):
        key = (w, h, int(focus_x))
        if self.base_key == key:
            return self.base
        dark = hex_rgb(BG)
        out = Image.new("RGB", (w, h), dark)
        if self.src is not None:
            iw, ih = self.src.size
            # Yuksekligi tam doldur, karakter sag taraftaki bos alanda dursun
            scale = max(h / ih, (w - focus_x) * 2 / iw)
            img = self.src.resize((int(iw * scale) + 1, int(ih * scale) + 1), Image.LANCZOS)
            img = ImageEnhance.Brightness(img).enhance(0.85)
            out.paste(img, (int(focus_x - img.width / 2), int((h - img.height) / 2)))

            # Soldan saga yumusak karartma: kart tarafi koyu, karakter tarafi parlak
            ramp = Image.new("L", (w, 1))
            img_left = focus_x - img.width / 2
            fade = max(1.0, img.width * 0.3)
            for x in range(w):
                t = min(1.0, max(0.0, (x - img_left) / fade))
                t = t * t * (3 - 2 * t)
                ramp.putpixel((x, 0), int(255 * (1 - t) + 25 * t))
            out = Image.composite(Image.new("RGB", (w, h), dark), out, ramp.resize((w, h)))

        # Sol ust koseden hafif kirmizi isik
        light = Image.new("L", (w, h), 0)
        ImageDraw.Draw(light).ellipse((-w * 0.35, -h * 0.6, w * 0.45, h * 0.35), fill=70)
        light = light.filter(ImageFilter.GaussianBlur(120))
        out = Image.composite(Image.new("RGB", (w, h), hex_rgb(ACCENT_H)), out, light)

        self.base_key, self.base = key, out
        return out

    def render(self, w, h, focus_x, glows):
        if Image is None or w < 10 or h < 10:
            return
        key = (w, h, int(focus_x), tuple(glows))
        if self.key == key:
            return
        self.key = key
        img = self._base(w, h, focus_x).copy()

        # Kartlarin arkasina bulanik kirmizi parlama
        if glows:
            mask = Image.new("L", (w, h), 0)
            d = ImageDraw.Draw(mask)
            for x, y, gw, gh, strength in glows:
                d.rectangle((x - 2, y - 2, x + gw + 2, y + gh + 2), fill=strength)
            mask = mask.filter(ImageFilter.GaussianBlur(16))
            img = Image.composite(Image.new("RGB", (w, h), hex_rgb(ACCENT)), img, mask)

        self.photo = ImageTk.PhotoImage(img)
        self.canvas.itemconfigure(self.item, image=self.photo)


class Card(ctk.CTkFrame):
    def __init__(self, master, **kw):
        kw.setdefault("fg_color", CARD)
        kw.setdefault("corner_radius", 0)
        kw.setdefault("border_width", 1)
        kw.setdefault("border_color", BORDER_HI)
        super().__init__(master, **kw)


class StatCard(Card):
    def __init__(self, master, icon, title, value, color=TEXT):
        super().__init__(master)
        ctk.CTkFrame(self, height=2, corner_radius=0, fg_color=ACCENT).pack(fill="x", padx=1, pady=(1, 0))
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", padx=18, pady=(12, 0))
        ctk.CTkLabel(top, text=icon, font=font(13, "bold"), text_color=ACCENT,
                     width=16).pack(side="left")
        ctk.CTkLabel(top, text="  " + title.upper(), font=font(11, "bold"),
                     text_color=MUTED).pack(side="left")
        self.value = ctk.CTkLabel(self, text=value, font=font(19, "bold"), text_color=color)
        self.value.pack(anchor="w", padx=18, pady=(0, 12))

    def set(self, value, color=None):
        self.value.configure(text=value)
        if color:
            self.value.configure(text_color=color)


class TicketRow(ctk.CTkFrame):
    def __init__(self, master, guild, name, link, when):
        super().__init__(master, fg_color=CARD_HI, corner_radius=10, border_width=1,
                         border_color=ACCENT)
        self.columnconfigure(1, weight=1)

        ctk.CTkFrame(self, width=4, height=38, corner_radius=2, fg_color=ACCENT).grid(
            row=0, column=0, rowspan=2, padx=(12, 12), pady=12)
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.grid(row=0, column=1, sticky="w", pady=(10, 0))
        ctk.CTkLabel(head, text=f"#{name}", font=font(14, "bold"), text_color=TEXT).pack(side="left")
        self.badge = ctk.CTkLabel(head, text=" YENI ", font=font(10, "bold"), text_color="white",
                                  fg_color=ACCENT, corner_radius=6, height=18)
        self.badge.pack(side="left", padx=(8, 0))
        ctk.CTkLabel(self, text=f"{guild}  •  {when}", font=font(12), text_color=MUTED,
                     anchor="w").grid(row=1, column=1, sticky="w", pady=(0, 10))
        ctk.CTkButton(self, text="Kanala git  ›", width=112, height=34, corner_radius=8,
                      font=font(12, "bold"), fg_color=ACCENT, hover_color=ACCENT_H,
                      border_width=1, border_color=GLOW,
                      command=lambda: (stop_sound(), open_link(*link))).grid(
            row=0, column=2, rowspan=2, padx=12)

        # Yeni gelen satir bir sure vurgulu kalir, sonra sakinlesir
        self.after(8000, self._calm)

    def _calm(self):
        self.configure(border_color=BORDER, fg_color=CARD_ROW)
        self.badge.pack_forget()


# ----------------- ana pencere -----------------

class App:
    PAD = 28

    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.runner = None
        self.cfg = {}
        self.count = 0
        self.rows = []
        self.page = None
        self.started_at = None
        self.pulse_on = False
        self.alarm_steps = 0
        self.toast_job = None

        root.title(APP_NAME)
        root.geometry("1180x720")
        root.minsize(980, 640)
        root.configure(fg_color=BG)

        cfg = load_config()
        self.vars = {
            "token": tk.StringVar(value=cfg.get("token", "")),
            "category_ids": tk.StringVar(value=ids_to_text(cfg.get("category_ids"))),
            "category_names": tk.StringVar(value=", ".join(cfg.get("category_names") or [])),
        }
        self.auto_detect = tk.BooleanVar(value=bool(cfg.get("auto_detect", True)))
        self.auto_open = tk.BooleanVar(value=bool(cfg.get("auto_open", False)))
        self.auto_message = tk.BooleanVar(value=bool(cfg.get("auto_message", False)))
        self.message_text = cfg.get("message_text", DEFAULT_MESSAGE)
        self.message_delay = tk.IntVar(value=int(cfg.get("message_delay", 2)))
        self.message_alternate = tk.BooleanVar(value=bool(cfg.get("message_alternate", False)))
        self.sound_repeat = tk.IntVar(value=int(cfg.get("sound_repeat", 1) or 0))
        self.sound_file = cfg.get("sound_file", "")
        self.bring_front = tk.BooleanVar(value=bool(cfg.get("bring_front", True)))
        self.win_toast = tk.BooleanVar(value=bool(cfg.get("windows_toast", True)))
        self.to_tray = tk.BooleanVar(value=bool(cfg.get("minimize_to_tray", True)))
        self.autostart = tk.BooleanVar(value=bool(cfg.get("autostart", False)))
        self.hotkeys_on = tk.BooleanVar(value=bool(cfg.get("hotkeys", True)))
        self.last_link = None
        self.tray = None
        self.tray_hint_shown = False
        self.hotkeys = None
        self.toast_icon = ""
        self.bg_image = load_bg()

        root.columnconfigure(1, weight=1)
        root.rowconfigure(0, weight=1)
        self._build_sidebar()

        # Icerik alani bir canvas: arka plan resmi burada, kartlar ustune yerlestiriliyor
        self.canvas = tk.Canvas(root, bg=BG, highlightthickness=0, bd=0)
        self.canvas.grid(row=0, column=1, sticky="nsew")
        self.bg = Background(self.canvas, self.bg_image)
        self.alarm = self.canvas.create_rectangle(0, 0, 0, 0, outline=ACCENT, width=6, state="hidden")

        self.pages = {"panel": self._build_panel(), "ayarlar": self._build_settings()}
        self._build_toast()
        self.canvas.bind("<Configure>", lambda e: self.relayout())
        self.show_page("ayarlar" if not cfg.get("token") or not has_target(cfg) else "panel")

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(100, self.poll_events)
        root.after(500, self.tick)
        self._start_tray()
        self.apply_hotkeys()

        if discord is None:
            self.set_status("discord.py yok", ACCENT)
            self.log("discord.py kurulu degil: pip install -U discord.py")
            self.start_btn.configure(state="disabled")

    # --- canvas yardimcilari ---
    def _text(self, tag, text, size, weight="normal", color=TEXT):
        # Golgeli yazi: resmin uzerinde de net okunsun
        f = (FONT, size, weight)
        sh = self.canvas.create_text(0, 0, text=text, font=f, fill="#000000", anchor="nw", tags=(tag,))
        tx = self.canvas.create_text(0, 0, text=text, font=f, fill=color, anchor="nw", tags=(tag,))
        return sh, tx

    def _move_text(self, pair, x, y):
        self.canvas.coords(pair[0], x + 1, y + 2)
        self.canvas.coords(pair[1], x, y)

    def _set_text(self, pair, text, color=None):
        for i in pair:
            self.canvas.itemconfigure(i, text=text)
        if color:
            self.canvas.itemconfigure(pair[1], fill=color)

    def _window(self, tag, widget):
        return self.canvas.create_window(0, 0, window=widget, anchor="nw", tags=(tag,))

    def _place(self, item, x, y, w, h):
        self.canvas.coords(item, x, y)
        self.canvas.itemconfigure(item, width=max(1, int(w)), height=max(1, int(h)))
        return (int(x), int(y), int(w), int(h))

    def _title_glow(self, pair):
        x1, y1, x2, y2 = self.canvas.bbox(pair[1])
        return (x1 + 4, y1 + 10, x2 - x1 - 8, y2 - y1 - 16, 70)

    # --- yan menu ---
    def _build_sidebar(self):
        side = ctk.CTkFrame(self.root, width=236, corner_radius=0, fg_color=SIDEBAR, border_width=0)
        side.grid(row=0, column=0, sticky="nsw")
        side.grid_propagate(False)
        ctk.CTkFrame(self.root, width=1, corner_radius=0, fg_color=BORDER_HI).grid(
            row=0, column=0, sticky="nse")

        brand = ctk.CTkFrame(side, fg_color="transparent")
        brand.pack(fill="x", padx=18, pady=(24, 8))
        avatar = self._avatar(48)
        if avatar:
            ctk.CTkLabel(brand, text="", image=avatar).pack(side="left")
        titles = ctk.CTkFrame(brand, fg_color="transparent")
        titles.pack(side="left", padx=(12, 0))
        ctk.CTkLabel(titles, text="TICKET", font=font(17, "bold"), text_color=TEXT,
                     height=20).pack(anchor="w")
        ctk.CTkLabel(titles, text="ALARM", font=font(17, "bold"), text_color=ACCENT,
                     height=20).pack(anchor="w")
        ctk.CTkFrame(side, height=1, fg_color=BORDER).pack(fill="x", padx=18, pady=(14, 18))

        ctk.CTkLabel(side, text="MENU", font=font(10, "bold"), text_color=MUTED).pack(
            anchor="w", padx=24, pady=(0, 6))
        self.nav = {}
        for key, icon, label in (("panel", "▣", "Panel"), ("ayarlar", "⚙", "Ayarlar")):
            b = ctk.CTkButton(side, text=f"  {icon}   {label}", anchor="w", height=44,
                              corner_radius=10, font=font(13, "bold"), fg_color="transparent",
                              hover_color=CARD_HI, text_color=MUTED, border_width=0,
                              command=lambda k=key: self.show_page(k))
            b.pack(fill="x", padx=14, pady=3)
            self.nav[key] = b

        bottom = ctk.CTkFrame(side, fg_color="transparent")
        bottom.pack(side="bottom", fill="x", padx=14, pady=20)

        pill = ctk.CTkFrame(bottom, fg_color=CARD, corner_radius=12, border_width=1,
                            border_color=BORDER)
        pill.pack(fill="x", pady=(0, 12))
        row = ctk.CTkFrame(pill, fg_color="transparent")
        row.pack(fill="x", padx=14, pady=(10, 0))
        self.status_dot = ctk.CTkLabel(row, text="●", font=font(15), text_color=MUTED, width=14)
        self.status_dot.pack(side="left")
        self.status_lbl = ctk.CTkLabel(row, text="Durduruldu", font=font(13, "bold"), text_color=TEXT)
        self.status_lbl.pack(side="left", padx=(8, 0))
        self.uptime_lbl = ctk.CTkLabel(pill, text="Calisma suresi  --:--:--", font=font(11),
                                       text_color=MUTED)
        self.uptime_lbl.pack(anchor="w", padx=14, pady=(0, 10))

        self.start_btn = ctk.CTkButton(bottom, text="▶   BASLAT", height=50, corner_radius=12,
                                       font=font(14, "bold"), fg_color=ACCENT,
                                       hover_color=ACCENT_H, border_width=1,
                                       border_color=GLOW, command=self.toggle_run)
        self.start_btn.pack(fill="x")

    def _avatar(self, size):
        if self.bg_image is None:
            return None
        src = self.bg_image
        s = int(min(src.size) * 0.62)
        cx, cy = src.width // 2, int(src.height * 0.40)
        img = src.crop((cx - s // 2, cy - s // 2, cx + s // 2, cy + s // 2))
        big = size * 3
        img = img.resize((big, big), Image.LANCZOS)
        mask = Image.new("L", img.size, 0)
        ImageDraw.Draw(mask).ellipse((6, 6, big - 7, big - 7), fill=255)
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(out).ellipse((0, 0, big - 1, big - 1), fill=hex_rgb(ACCENT) + (255,))
        out.paste(img, (0, 0), mask)
        self.icon_image = out
        try:
            self.toast_icon = os.path.join(tempfile.gettempdir(), "ticket_alarm_icon.png")
            out.save(self.toast_icon)
        except Exception:
            self.toast_icon = ""
        return ctk.CTkImage(light_image=out, dark_image=out, size=(size, size))

    def show_page(self, key):
        self.page = key
        for k in self.pages:
            self.canvas.itemconfigure(k, state="normal" if k == key else "hidden")
            self.nav[k].configure(fg_color=CARD_HI if k == key else "transparent",
                                  text_color=TEXT if k == key else MUTED,
                                  border_width=1 if k == key else 0, border_color=BORDER_HI)
        self.relayout()

    def split(self, w):
        # Kartlar solda bu genislige kadar, saginda arka plan resmi gorunur
        return self.PAD + (w - 2 * self.PAD) * 0.62

    def relayout(self):
        w, h = self.canvas.winfo_width(), self.canvas.winfo_height()
        if w < 10:
            return
        split = self.split(w)
        glows = self.pages[self.page](w, h)
        self.bg.render(w, h, split + (w - split) / 2, glows)
        self.canvas.coords(self.alarm, 3, 3, w - 3, h - 3)
        self._place(self.toast_item, split + 24, 24, w - split - 24 - self.PAD, 96)
        self.canvas.tag_raise(self.alarm)

    # --- panel sayfasi ---
    def _build_panel(self):
        tag = "panel"
        title = self._text(tag, "Panel", 26, "bold")
        sub = self._text(tag, "Kategoride yeni kanal acilinca ses calar ve burada listelenir.", 12, color=MUTED)

        self.stat_status = StatCard(self.canvas, "◉", "Durum", "Durduruldu", MUTED)
        self.stat_count = StatCard(self.canvas, "#", "Bu oturumda", "0 ticket")
        self.stat_uptime = StatCard(self.canvas, "◷", "Calisma suresi", "--:--:--")
        stats = [self._window(tag, s) for s in (self.stat_status, self.stat_count, self.stat_uptime)]

        box = Card(self.canvas)
        box.columnconfigure(0, weight=1)
        box.rowconfigure(1, weight=1)
        head = ctk.CTkFrame(box, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=18, pady=(14, 6))
        ctk.CTkLabel(head, text="▌", font=font(14, "bold"), text_color=ACCENT).pack(side="left")
        ctk.CTkLabel(head, text=" GELEN TICKET'LAR", font=font(12, "bold"),
                     text_color=TEXT).pack(side="left")
        ctk.CTkButton(head, text="Temizle", width=80, height=28, corner_radius=8,
                      font=font(12), fg_color=CARD_HI, hover_color=BORDER, border_width=1,
                      border_color=BORDER, text_color=MUTED, command=self.clear).pack(side="right")
        ctk.CTkButton(head, text="Test bildirimi", width=110, height=28, corner_radius=8,
                      font=font(12, "bold"), fg_color=ACCENT, hover_color=ACCENT_H,
                      command=self.test_ticket).pack(side="right", padx=(0, 8))
        self.list = ctk.CTkScrollableFrame(box, fg_color="transparent",
                                           scrollbar_button_color=BORDER_HI,
                                           scrollbar_button_hover_color=ACCENT)
        self.list.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        self.list.columnconfigure(0, weight=1)
        self.empty = ctk.CTkFrame(self.list, fg_color="transparent")
        ctk.CTkLabel(self.empty, text="◎", font=font(42), text_color=BORDER_HI).pack()
        ctk.CTkLabel(self.empty, text="Henuz ticket yok", font=font(15, "bold"),
                     text_color=TEXT).pack(pady=(4, 2))
        ctk.CTkLabel(self.empty, text="Baslat'a bas, kategoride kanal acilinca burada gorunur.",
                     font=font(12), text_color=MUTED).pack()
        self.empty.grid(row=0, column=0, pady=70)
        box_item = self._window(tag, box)

        self.log_text = self._text(tag, "", 11, color=MUTED)

        def layout(w, h):
            p, right = self.PAD, self.split(w)
            self._move_text(title, p, 20)
            self._move_text(sub, p, 64)
            gap = 14
            sw = (right - p - 2 * gap) / 3
            glows = [self._title_glow(title)]
            for i, item in enumerate(stats):
                glows.append(self._place(item, p + i * (sw + gap), 100, sw, 90) + (110,))
            glows.append(self._place(box_item, p, 206, right - p, h - 206 - 44) + (90,))
            self._move_text(self.log_text, p, h - 30)
            return glows
        return layout

    # --- ayarlar sayfasi ---
    def _section(self, parent, icon, title, subtitle):
        card = Card(parent, fg_color=CARD_HI, corner_radius=12, border_color=BORDER)
        card.pack(fill="x", pady=(0, 12), padx=(0, 6))
        card.columnconfigure(0, weight=1)
        head = ctk.CTkFrame(card, fg_color="transparent")
        head.grid(row=0, column=0, columnspan=2, sticky="w", padx=18, pady=(16, 0))
        ctk.CTkLabel(head, text=icon, font=font(14, "bold"), text_color=ACCENT, width=18).pack(side="left")
        ctk.CTkLabel(head, text="  " + title.upper(), font=font(12, "bold"),
                     text_color=TEXT).pack(side="left")
        ctk.CTkLabel(card, text=subtitle, font=font(12), text_color=MUTED, anchor="w",
                     justify="left").grid(row=1, column=0, columnspan=2, sticky="w", padx=18, pady=(2, 0))
        return card

    def _entry(self, parent, row, key, secret=False, placeholder=""):
        e = ctk.CTkEntry(parent, textvariable=self.vars[key], height=40, corner_radius=8,
                         fg_color=FIELD, border_color=BORDER_HI, border_width=1,
                         text_color=TEXT, font=font(13), show="•" if secret else "",
                         placeholder_text=placeholder, placeholder_text_color=MUTED)
        e.grid(row=row, column=0, columnspan=2, sticky="ew", padx=18, pady=(10, 4))
        self.inputs.append(e)
        return e

    def _small_btn(self, parent, text, cmd, width=110):
        return ctk.CTkButton(parent, text=text, width=width, height=34, corner_radius=8,
                             font=font(12, "bold"), fg_color=CARD, hover_color=BORDER,
                             border_width=1, border_color=BORDER_HI, text_color=TEXT,
                             command=cmd)

    def _build_settings(self):
        tag = "ayarlar"
        title = self._text(tag, "Ayarlar", 26, "bold")
        sub = self._text(tag, "Baslat'a bastiginda ayarlar otomatik kaydedilir.", 12, color=MUTED)

        outer = Card(self.canvas)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(0, weight=1)
        body = ctk.CTkScrollableFrame(outer, fg_color="transparent",
                                      scrollbar_button_color=BORDER_HI,
                                      scrollbar_button_hover_color=ACCENT)
        body.grid(row=0, column=0, sticky="nsew", padx=12, pady=12)
        self.inputs = []

        c = self._section(body, "⚿", "Bot token", "Developer Portal > Bot > Reset Token ile aldigin BOT token'i.")
        self.token_entry = self._entry(c, 2, "token", secret=True)
        self.show_token = ctk.CTkCheckBox(c, text="Token'i goster", font=font(12),
                                          text_color=MUTED, fg_color=ACCENT,
                                          hover_color=ACCENT_H, border_color=BORDER_HI,
                                          checkbox_width=18, checkbox_height=18,
                                          command=self.toggle_token)
        self.show_token.grid(row=3, column=0, sticky="w", padx=18, pady=(4, 16))

        c = self._section(body, "▤", "Ticket kategorisi",
                          "Hangi kanallar acilinca alarm calsin.")
        sw = ctk.CTkSwitch(c, text="Otomatik algila  (onerilen)", variable=self.auto_detect,
                           font=font(13, "bold"), text_color=TEXT, progress_color=ACCENT,
                           button_color=TEXT, button_hover_color="white", fg_color=BORDER)
        sw.grid(row=2, column=0, sticky="w", padx=18, pady=(12, 0))
        self.inputs.append(sw)
        ctk.CTkLabel(c, text="Botun gordugu tum sunucularda, ticket botunun actigi her yeni kanal icin\n"
                             "alarm calar. Kategori adi/ID girmene gerek yok, kategori silinip yeniden\n"
                             "acilsa da calisir. Bota Yonetici yetkisi verilmis olmali.",
                     font=font(11), text_color=MUTED, anchor="w", justify="left").grid(
            row=3, column=0, sticky="w", padx=18, pady=(4, 0))
        ctk.CTkLabel(c, text="Elle ekle  (istege bagli)", font=font(13, "bold"), text_color=TEXT,
                     anchor="w").grid(row=4, column=0, sticky="w", padx=18, pady=(16, 0))
        ctk.CTkLabel(c, text="Kategori adinda gecen kelime (ornek: genel destek) ya da kategori ID.\n"
                             "Birden fazlaysa virgulle ayir. Otomatik algilamayla birlikte de calisir.",
                     font=font(11), text_color=MUTED, anchor="w", justify="left").grid(
            row=5, column=0, sticky="w", padx=18)
        for row, key, label in ((6, "category_names", "Kategori adi"), (8, "category_ids", "Kategori ID")):
            ctk.CTkLabel(c, text=label, font=font(12), text_color=MUTED, anchor="w").grid(
                row=row, column=0, sticky="w", padx=18, pady=(10, 0))
            self._entry(c, row + 1, key).grid_configure(pady=(4, 4))
        ctk.CTkFrame(c, height=12, fg_color="transparent").grid(row=10, column=0)

        c = self._section(body, "➤", "Otomatik islemler", "Ticket gelince senin yerine yapilacaklar.")
        sw = ctk.CTkSwitch(c, text="Discord'u otomatik ac ve ticket'a git", variable=self.auto_open,
                           font=font(13, "bold"), text_color=TEXT, progress_color=ACCENT,
                           button_color=TEXT, button_hover_color="white", fg_color=BORDER)
        sw.grid(row=2, column=0, sticky="w", padx=18, pady=(12, 0))
        self.inputs.append(sw)
        sw = ctk.CTkSwitch(c, text="Ticket'a otomatik mesaj at", variable=self.auto_message,
                           font=font(13, "bold"), text_color=TEXT, progress_color=ACCENT,
                           button_color=TEXT, button_hover_color="white", fg_color=BORDER)
        sw.grid(row=3, column=0, sticky="w", padx=18, pady=(14, 0))
        self.inputs.append(sw)
        ctk.CTkLabel(c, text="Mesaj botun hesabindan gider. Kullanabilecegin degiskenler:\n"
                             "{acan} = ticket'i acani etiketler   {kanal} = kanal adi   {sunucu} = sunucu adi",
                     font=font(11), text_color=MUTED, anchor="w", justify="left").grid(
            row=4, column=0, sticky="w", padx=18, pady=(4, 0))
        self.message_box = ctk.CTkTextbox(c, height=90, corner_radius=8, fg_color=FIELD,
                                          border_color=BORDER_HI, border_width=1, text_color=TEXT,
                                          font=font(13), wrap="word")
        self.message_box.grid(row=5, column=0, columnspan=2, sticky="ew", padx=18, pady=(8, 4))
        self.message_box.insert("1.0", self.message_text)
        self.inputs.append(self.message_box)
        drow = ctk.CTkFrame(c, fg_color="transparent")
        drow.grid(row=6, column=0, columnspan=2, sticky="ew", padx=18, pady=(8, 16))
        drow.columnconfigure(1, weight=1)
        ctk.CTkLabel(drow, text="Bekleme", font=font(13, "bold"), text_color=TEXT).grid(row=0, column=0, padx=(0, 14))
        dslider = ctk.CTkSlider(drow, from_=0, to=10, number_of_steps=10, height=18,
                                variable=self.message_delay, progress_color=ACCENT,
                                button_color=ACCENT, button_hover_color=GLOW, fg_color=BORDER,
                                command=lambda _v: self._delay_text())
        dslider.grid(row=0, column=1, sticky="ew")
        self.inputs.append(dslider)
        self.delay_lbl = ctk.CTkLabel(drow, text="", width=64, font=font(13, "bold"), text_color=ACCENT)
        self.delay_lbl.grid(row=0, column=2, padx=(12, 0))
        ctk.CTkLabel(c, text="Ticket botunun mesajindan sonra gitsin diye mesaj bu kadar saniye bekler.",
                     font=font(11), text_color=MUTED, anchor="w").grid(
            row=7, column=0, sticky="w", padx=18, pady=(0, 0))
        drow.grid_configure(pady=(8, 0))
        self._delay_text()
        sw = ctk.CTkSwitch(c, text="Sirayla yaz  (1. ticket'a bot, 2. ticket'a sen, 3.'ye bot...)",
                           variable=self.message_alternate, font=font(13, "bold"), text_color=TEXT,
                           progress_color=ACCENT, button_color=TEXT, button_hover_color="white",
                           fg_color=BORDER)
        sw.grid(row=8, column=0, sticky="w", padx=18, pady=(14, 0))
        self.inputs.append(sw)
        ctk.CTkLabel(c, text="Sira sendeyken bot yazmaz; program 'bu ticket'a sen yaz' diye haber verir.",
                     font=font(11), text_color=MUTED, anchor="w").grid(
            row=9, column=0, sticky="w", padx=18, pady=(4, 16))

        c = self._section(body, "♪", "Bildirim", "Ticket gelince bu bilgisayarda ses calar ve bildirim cikar.")
        srow = ctk.CTkFrame(c, fg_color="transparent")
        srow.grid(row=2, column=0, columnspan=2, sticky="ew", padx=18, pady=(12, 4))
        srow.columnconfigure(1, weight=1)
        ctk.CTkLabel(srow, text="Tekrar", font=font(13, "bold"), text_color=TEXT).grid(row=0, column=0, padx=(0, 14))
        slider = ctk.CTkSlider(srow, from_=0, to=10, number_of_steps=10, height=18,
                               variable=self.sound_repeat, progress_color=ACCENT,
                               button_color=ACCENT, button_hover_color=GLOW,
                               fg_color=BORDER, command=lambda _v: self._sound_text())
        slider.grid(row=0, column=1, sticky="ew")
        self.inputs.append(slider)
        self.sound_lbl = ctk.CTkLabel(srow, text="", width=64, font=font(13, "bold"), text_color=ACCENT)
        self.sound_lbl.grid(row=0, column=2, padx=(12, 0))
        self._sound_text()

        self.sound_file_lbl = ctk.CTkLabel(c, text="", font=font(12), text_color=MUTED, anchor="w")
        self.sound_file_lbl.grid(row=3, column=0, columnspan=2, sticky="ew", padx=18, pady=(10, 0))
        frow = ctk.CTkFrame(c, fg_color="transparent")
        frow.grid(row=4, column=0, columnspan=2, sticky="w", padx=18, pady=(6, 4))
        self._small_btn(frow, "Ses sec (.wav)", self.pick_sound, 120).pack(side="left")
        self._small_btn(frow, "Varsayilan", self.reset_sound, 96).pack(side="left", padx=(8, 0))
        self._small_btn(frow, "▶  Dene", self.test_sound, 80).pack(side="left", padx=(8, 0))
        self._small_btn(frow, "■  Sustur", stop_sound, 90).pack(side="left", padx=(8, 0))
        self._sound_file_text()

        sw = ctk.CTkSwitch(c, text="Ticket gelince pencereyi one getir", variable=self.bring_front,
                           font=font(12), text_color=TEXT, progress_color=ACCENT,
                           button_color=TEXT, button_hover_color="white", fg_color=BORDER)
        sw.grid(row=5, column=0, sticky="w", padx=18, pady=(12, 4))
        self.inputs.append(sw)
        sw2 = ctk.CTkSwitch(c, text="Sagdan Windows bildirimi goster (tiklayinca Discord'da ticket acilir)",
                            variable=self.win_toast, font=font(12), text_color=TEXT,
                            progress_color=ACCENT, button_color=TEXT, button_hover_color="white",
                            fg_color=BORDER)
        sw2.grid(row=6, column=0, sticky="w", padx=18, pady=(8, 16))
        self.inputs.append(sw2)

        keys = "   •   ".join(f"{name}: {'son ticket' if ev == 'open_last' else 'sesi sustur'}"
                              for name, _m, _v, ev in HOTKEYS.values())
        c = self._section(body, "⌘", "Kullanim", "Program arka planda sessizce calissin.")
        for i, (var, text, cmd) in enumerate((
            (self.to_tray, "Kapatinca sistem tepsisine kucult (arka planda calismaya devam eder)", None),
            (self.autostart, "Windows acilinca otomatik baslat (tepside acilir ve izlemeye baslar)", self.apply_autostart),
            (self.hotkeys_on, f"Kisayol tuslari  ({keys})", self.apply_hotkeys),
        )):
            sw = ctk.CTkSwitch(c, text=text, variable=var, font=font(12), text_color=TEXT,
                               progress_color=ACCENT, button_color=TEXT, button_hover_color="white",
                               fg_color=BORDER, command=cmd)
            sw.grid(row=2 + i, column=0, sticky="w", padx=18, pady=(12 if i == 0 else 8, 16 if i == 2 else 0))
            if sys.platform != "win32" and cmd is not None:
                sw.configure(state="disabled")
        outer_item = self._window(tag, outer)

        save_btn = ctk.CTkButton(self.canvas, text="✓  KAYDET", width=140, height=42, corner_radius=0,
                                 font=font(13, "bold"), fg_color=ACCENT, hover_color=ACCENT_H,
                                 border_width=1, border_color=GLOW, command=self.save)
        save_item = self._window(tag, save_btn)
        self.save_text = self._text(tag, "", 12, "bold", color=GREEN)

        def layout(w, h):
            p, right = self.PAD, self.split(w)
            self._move_text(title, p, 20)
            self._move_text(sub, p, 64)
            glows = [self._title_glow(title)]
            glows.append(self._place(outer_item, p, 100, right - p, h - 100 - 78) + (90,))
            glows.append(self._place(save_item, right - 140, h - 62, 140, 42) + (150,))
            self._move_text(self.save_text, p, h - 52)
            return glows
        return layout

    # --- ticket uyarisi (sag ustte, resmin uzerinde) ---
    def _build_toast(self):
        t = ctk.CTkFrame(self.canvas, fg_color=CARD, corner_radius=0, border_width=2,
                         border_color=ACCENT)
        ctk.CTkFrame(t, width=6, corner_radius=0, fg_color=ACCENT).pack(side="left", fill="y")
        # Buton once yerlesiyor ki uzun yazi onu kutunun disina itmesin
        self.toast_btn = ctk.CTkButton(t, text="Kanala git  ›", width=110, height=36, corner_radius=8,
                                       font=font(12, "bold"), fg_color=ACCENT, hover_color=ACCENT_H)
        self.toast_btn.pack(side="right", padx=14)
        inner = ctk.CTkFrame(t, fg_color="transparent")
        inner.pack(side="left", fill="both", expand=True, padx=16, pady=12)
        self.toast_head = ctk.CTkLabel(inner, text="", font=font(12, "bold"), anchor="w")
        self.toast_head.pack(anchor="w")
        self.toast_name = ctk.CTkLabel(inner, text="", font=font(18, "bold"), text_color=TEXT, anchor="w")
        self.toast_name.pack(anchor="w")
        self.toast_sub = ctk.CTkLabel(inner, text="", font=font(11), text_color=MUTED, anchor="w")
        self.toast_sub.pack(anchor="w")
        self.toast_item = self.canvas.create_window(0, 0, window=t, anchor="nw", state="hidden")

    def show_toast(self, guild, name, link, manual=False):
        self.toast_name.configure(text=f"#{name}")
        self.toast_head.configure(text="⚠  SIRA SENDE" if manual else "⚠  YENI TICKET",
                                  text_color=YELLOW if manual else ACCENT)
        self.toast_sub.configure(text=f"{guild}  •  {time.strftime('%H:%M:%S')}")
        self.toast_btn.configure(command=lambda: (stop_sound(), open_link(*link), self.hide_toast()))
        self.canvas.itemconfigure(self.toast_item, state="normal")
        if self.toast_job:
            self.root.after_cancel(self.toast_job)
        self.toast_job = self.root.after(12000, self.hide_toast)

    def hide_toast(self):
        self.toast_job = None
        self.canvas.itemconfigure(self.toast_item, state="hidden")

    def start_alarm(self):
        self.alarm_steps = 10
        self._alarm_step()

    def _alarm_step(self):
        if self.alarm_steps <= 0:
            self.canvas.itemconfigure(self.alarm, state="hidden")
            return
        self.canvas.itemconfigure(self.alarm, state="normal" if self.alarm_steps % 2 else "hidden")
        self.alarm_steps -= 1
        self.root.after(280, self._alarm_step)

    # --- islemler ---
    def _delay_text(self):
        self.delay_lbl.configure(text=f"{int(self.message_delay.get())} sn")

    def _sound_text(self):
        n = int(self.sound_repeat.get())
        self.sound_lbl.configure(text="Kapali" if n == 0 else f"{n} kez")

    def _sound_file_text(self):
        if self.sound_file:
            name = os.path.basename(self.sound_file)
        else:
            name = "Varsayilan (programin kendi sesi)" if sound_path() else "Windows uyari sesi"
        self.sound_file_lbl.configure(text=f"Ses:  {name}")

    def pick_sound(self):
        path = filedialog.askopenfilename(title="Bildirim sesi sec",
                                          filetypes=[("WAV ses dosyasi", "*.wav")])
        if path:
            self.sound_file = path
            self._sound_file_text()

    def reset_sound(self):
        self.sound_file = ""
        self._sound_file_text()

    def toggle_token(self):
        self.token_entry.configure(show="" if self.show_token.get() else "•")

    def set_status(self, text, color):
        self.status_lbl.configure(text=text)
        self.status_dot.configure(text_color=color)
        self.stat_status.set(text, color)

    def log(self, text):
        self._set_text(self.log_text, f"{time.strftime('%H:%M:%S')}   {text}")

    def collect_config(self):
        return {
            "token": self.vars["token"].get().strip(),
            "category_ids": parse_ids(self.vars["category_ids"].get()),
            "category_names": parse_names(self.vars["category_names"].get()),
            "auto_detect": bool(self.auto_detect.get()),
            "auto_open": bool(self.auto_open.get()),
            "auto_message": bool(self.auto_message.get()),
            "message_text": self.message_box.get("1.0", "end").strip(),
            "message_delay": int(self.message_delay.get()),
            "message_alternate": bool(self.message_alternate.get()),
            "sound_repeat": int(self.sound_repeat.get()),
            "sound_file": self.sound_file,
            "bring_front": bool(self.bring_front.get()),
            "windows_toast": bool(self.win_toast.get()),
            "minimize_to_tray": bool(self.to_tray.get()),
            "autostart": bool(self.autostart.get()),
            "hotkeys": bool(self.hotkeys_on.get()),
        }

    def save(self):
        try:
            save_config(self.collect_config())
            self._set_text(self.save_text, "✓ Kaydedildi", GREEN)
        except Exception as e:
            self._set_text(self.save_text, f"Kaydedilemedi: {e}", ACCENT)
        self.root.after(2500, lambda: self._set_text(self.save_text, ""))

    def set_inputs(self, enabled):
        for e in self.inputs:
            e.configure(state="normal" if enabled else "disabled")

    def toggle_run(self):
        if self.runner:
            self.stop()
        else:
            self.start()

    def start(self):
        cfg = self.collect_config()
        if not cfg["token"]:
            self.show_page("ayarlar")
            messagebox.showwarning(APP_NAME, "Once Ayarlar'dan bot token'ini gir.")
            return
        if not has_target(cfg):
            self.show_page("ayarlar")
            messagebox.showwarning(APP_NAME, "Once Ayarlar'dan ticket kategorisinin adini ya da ID'sini gir.")
            return
        if not cfg["sound_repeat"]:
            messagebox.showwarning(APP_NAME, "Ses tekrari 0; ticket gelince ses calmaz.")
        try:
            save_config(cfg)
        except Exception as e:
            self.log(f"Ayarlar kaydedilemedi: {e}")
        self.cfg = cfg
        self.runner = BotRunner(cfg, self.events)
        self.runner.start()
        self.set_inputs(False)
        self.start_btn.configure(text="■   DURDUR", fg_color=CARD_HI, hover_color=BORDER,
                                 border_color=BORDER_HI)
        self.set_status("Baglaniyor", YELLOW)
        self.log("Discord'a baglaniliyor...")
        self.show_page("panel")

    def stop(self):
        if self.runner:
            self.runner.stop()
            self.start_btn.configure(state="disabled")
            self.set_status("Durduruluyor", YELLOW)

    def test_sound(self):
        play_sound(int(self.sound_repeat.get()) or 1, self.sound_file)

    def clear(self):
        for r in self.rows:
            r.destroy()
        self.rows.clear()
        self.count = 0
        self.stat_count.set("0 ticket")
        self.empty.grid(row=0, column=0, pady=70)

    def test_ticket(self):
        # Discord'a baglanmadan ses + Windows bildirimi + ekrandaki uyariyi dener
        self.on_ticket("Test", "test-ticket",
                       ("discord://-/channels/@me", "https://discord.com/channels/@me"))

    def on_ticket(self, guild, name, link, manual=False):
        """manual=True: sirayla yazmada sira kullanicida, bot bu ticket'a yazmadi."""
        cfg = self.cfg if self.runner else self.collect_config()
        when = time.strftime("%H:%M:%S")
        self.empty.grid_forget()
        row = TicketRow(self.list, guild, name, link, when)
        self.rows.insert(0, row)
        for i, r in enumerate(self.rows):
            r.grid(row=i, column=0, sticky="ew", pady=4)
        self.count += 1
        self.stat_count.set(f"{self.count} ticket")
        self.log(f"Yeni ticket: #{name} ({guild})" + ("  •  SIRA SENDE: bu ticket'a sen yaz" if manual else ""))
        self.last_link = link

        play_sound(cfg.get("sound_repeat", 1), cfg.get("sound_file", ""))
        if cfg.get("windows_toast", True):
            windows_toast("Yeni ticket - sira sende, sen yaz" if manual else "Yeni ticket acildi",
                          f"#{name}  •  {guild}", link[0], self.toast_icon,
                          report=lambda msg: self.events.put(("toast_error", msg)))
        flash_window(self.root)
        self.show_toast(guild, name, link, manual)
        self.start_alarm()
        if self.page != "panel":
            self.show_page("panel")
        if cfg.get("auto_open"):
            # Discord one gelecegi icin bu pencereyi one getirmiyoruz
            open_link(*link)
        elif cfg.get("bring_front", True):
            self.root.deiconify()
            self.root.lift()
            self.root.attributes("-topmost", True)
            self.root.after(400, lambda: self.root.attributes("-topmost", False))

    def tick(self):
        # Calisirken durum noktasi nabiz gibi atar, sure sayaci ilerler
        if self.started_at:
            self.pulse_on = not self.pulse_on
            self.status_dot.configure(text_color=GREEN if self.pulse_on else GREEN_DIM)
            secs = int(time.time() - self.started_at)
            up = f"{secs // 3600:02d}:{secs % 3600 // 60:02d}:{secs % 60:02d}"
            self.stat_uptime.set(up)
            self.uptime_lbl.configure(text=f"Calisma suresi  {up}")
        self.root.after(500, self.tick)

    def poll_events(self):
        try:
            while True:
                kind, *data = self.events.get_nowait()
                if kind == "ready":
                    user, guilds = data
                    self.started_at = self.started_at or time.time()
                    self.set_status("Calisiyor", GREEN)
                    self.log(f"Giris yapildi: {user}  •  {guilds} sunucu izleniyor")
                elif kind == "ticket":
                    self.on_ticket(*data)
                elif kind == "log":
                    self.log(data[0])
                elif kind == "check":
                    problems = data[0]
                    if problems:
                        self.set_status("Uyari var", YELLOW)
                        self.log(problems[0])
                        self.show_window()
                        messagebox.showwarning(APP_NAME, "Bot calisiyor ama su sorunlar var:\n\n- "
                                               + "\n\n- ".join(problems))
                    else:
                        self.log("Kurulum dogru: kategori bulundu, bot kanallari gorebiliyor.")
                elif kind == "toast_error":
                    self.log(data[0])
                    messagebox.showwarning(APP_NAME, data[0] + "\n\nWindows Ayarlar > Sistem > "
                                           "Bildirimler'de bildirimlerin acik oldugundan emin ol.")
                elif kind == "error":
                    self.log(data[0])
                    self.show_window()
                    messagebox.showerror(APP_NAME, data[0])
                elif kind == "tray":
                    self.on_tray(data[0])
                elif kind == "hotkey":
                    if data[0] == "open_last":
                        self.open_last()
                    elif data[0] == "silence":
                        stop_sound()
                elif kind == "stopped":
                    self.runner = None
                    self.started_at = None
                    self.set_inputs(True)
                    self.start_btn.configure(text="▶   BASLAT", state="normal", fg_color=ACCENT,
                                             hover_color=ACCENT_H, border_color=GLOW)
                    self.set_status("Durduruldu", MUTED)
                    self.uptime_lbl.configure(text="Calisma suresi  --:--:--")
        except queue.Empty:
            pass
        self.root.after(100, self.poll_events)

    # --- tepsi, kisayol, otomatik baslatma ---
    def _start_tray(self):
        if pystray is None or sys.platform != "win32":
            return
        image = getattr(self, "icon_image", None) or Image.new("RGB", (64, 64), hex_rgb(ACCENT))
        send = lambda action: (lambda icon, item: self.events.put(("tray", action)))
        menu = pystray.Menu(
            pystray.MenuItem("Goster", send("show"), default=True),
            pystray.MenuItem("Son ticket'i ac", send("open_last"),
                             enabled=lambda item: self.last_link is not None),
            pystray.MenuItem("Sesi sustur", send("silence")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(lambda item: "Durdur" if self.runner else "Baslat", send("toggle")),
            pystray.MenuItem("Cikis", send("quit")),
        )
        try:
            self.tray = pystray.Icon("ticket_alarm", image, APP_NAME, menu)
            self.tray.run_detached()
        except Exception:
            self.tray = None

    def on_tray(self, action):
        if action == "show":
            self.show_window()
        elif action == "open_last":
            self.open_last()
        elif action == "silence":
            stop_sound()
        elif action == "toggle":
            self.toggle_run()
        elif action == "quit":
            self.quit()

    def show_window(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def open_last(self):
        if self.last_link:
            stop_sound()
            open_link(*self.last_link)
            self.hide_toast()

    def apply_hotkeys(self):
        if self.hotkeys:
            self.hotkeys.stop()
            self.hotkeys = None
        if self.hotkeys_on.get() and sys.platform == "win32":
            self.hotkeys = HotkeyListener(lambda ev: self.events.put(("hotkey", ev)))
            self.hotkeys.start()
            if self.hotkeys.failed:
                self.log("Kisayol baska bir program tarafindan kullaniliyor: " + ", ".join(self.hotkeys.failed))

    def apply_autostart(self):
        err = set_autostart(bool(self.autostart.get()))
        if err:
            self.log(f"Windows acilisina eklenemedi: {err}")
        try:
            save_config(self.collect_config())
        except Exception:
            pass

    def on_close(self):
        # X'e basinca: tepsi aciksa arka plana in, degilse tamamen kapat
        if self.tray and self.to_tray.get():
            self.root.withdraw()
            if not self.tray_hint_shown:
                self.tray_hint_shown = True
                try:
                    self.tray.notify("Program arka planda calismaya devam ediyor. "
                                     "Saatin yanindaki simgeden acabilirsin.", APP_NAME)
                except Exception:
                    pass
            return
        self.quit()

    def quit(self):
        stop_sound()
        if self.runner:
            self.runner.stop()
        if self.hotkeys:
            self.hotkeys.stop()
        if self.tray:
            try:
                self.tray.stop()
            except Exception:
                pass
        self.root.destroy()


def main():
    if already_running():
        r = tk.Tk()
        r.withdraw()
        messagebox.showinfo(APP_NAME, "Ticket Alarm zaten acik.\nSaatin yanindaki simgesinden acabilirsin.")
        r.destroy()
        return
    ctk.set_appearance_mode("dark")
    root = ctk.CTk()
    app = App(root)
    if AUTOSTART_ARG in sys.argv:
        # Windows acilisinda: pencere acilmadan tepside basla ve izlemeye gec
        if app.tray:
            root.withdraw()
        cfg = app.collect_config()
        if cfg["token"] and has_target(cfg):
            root.after(500, app.start)
    root.mainloop()


if __name__ == "__main__":
    main()
