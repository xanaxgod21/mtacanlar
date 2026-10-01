#!/usr/bin/env python3
"""
Ticket bildirim botu - arayuzlu (normal Discord BOT hesabi ile calisir, selfbot DEGIL).

NE YAPAR:
  - Belirledigin kategoride yeni bir kanal acildiginda (istersen sadece adi
    belirledigin onekle baslayanlar) sana haber verir:
      * bilgisayarda bildirim sesi calar ve pencere yanip soner
        (exe'nin yanina "bildirim.wav" koyarsan o ses calar)
      * istersen webhook'una mesaj atar (telefonda bildirim olarak duser)
      * istersen sana DM de atar
  - Gelen ticket'lar listede gorunur, cift tiklayinca kanal acilir.
    Claim'e SEN basarsin.

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
  4) pip install -U discord.py customtkinter pillow
  5) python ticket_bildirim.py -> ayarlari pencereden gir, Baslat'a bas.
     Ayarlar ticket_config.json dosyasina kaydedilir.
"""

import os
import sys
import json
import time
import queue
import asyncio
import threading
import webbrowser
import tkinter as tk
from tkinter import messagebox

import customtkinter as ctk

try:
    from PIL import Image, ImageTk, ImageDraw, ImageEnhance
except ImportError:
    Image = None

try:
    import discord
except ImportError:
    discord = None

CONFIG_NAME = "ticket_config.json"
SOUND_NAME  = "bildirim.wav"   # exe'nin yanina koyarsan bu ses calar

# Renkler: arka plan resmine uygun kirmizi/siyah tema, yuzeyler koyu bordo
BG        = "#0b0405"
SIDEBAR   = "#0e0607"
CARD      = "#170a0c"
CARD_HI   = "#1f0e10"
CARD_ROW  = "#1a0b0d"
FIELD     = "#120708"
BORDER    = "#33161a"
BORDER_HI = "#5a1d24"
TEXT      = "#f3e7e8"
MUTED     = "#a88c8f"
ACCENT    = "#e8283a"
ACCENT_H  = "#c01d2e"
GLOW      = "#ff5a68"
GREEN     = "#4ade80"
YELLOW    = "#fbbf24"


# ----------------- yardimcilar -----------------

def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def config_path():
    return os.path.join(app_dir(), CONFIG_NAME)


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

    # Ayri thread'de cal ki arayuz donmasin
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


# ----------------- bot (arka plan thread'i) -----------------

class BotRunner:
    """discord.py client'ini ayri bir thread'de calistirir, olaylari kuyruga atar."""

    def __init__(self, cfg, events):
        self.cfg = cfg
        self.events = events
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

        @client.event
        async def on_guild_channel_create(channel):
            if not is_ticket(channel, cfg):
                return
            link = f"https://discord.com/channels/{channel.guild.id}/{channel.id}"
            self._emit("ticket", channel.guild.name, channel.name, link)
            await self._notify_remote(channel, link)

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

    async def _notify_remote(self, channel, link):
        cfg = self.cfg
        text = f"Yeni ticket: **#{channel.name}** ({channel.guild.name})\n{link}"

        if cfg.get("webhook_url"):
            ping = cfg.get("ping_user_id")
            content = f"<@{ping}> {text}" if ping else text
            try:
                webhook = discord.Webhook.from_url(cfg["webhook_url"], client=self.client)
                await webhook.send(
                    content,
                    username="Ticket Bildirim",
                    allowed_mentions=discord.AllowedMentions(users=True, everyone=False, roles=False),
                )
            except Exception as e:
                self._emit("log", f"Webhook hatasi: {e}")

        for uid in cfg.get("dm_user_ids") or []:
            try:
                user = self.client.get_user(uid) or await self.client.fetch_user(uid)
                await user.send(text)
            except Exception as e:
                # DM icin bot ile ortak sunucuda olman ve DM'lerin acik olmasi gerekir
                self._emit("log", f"DM atilamadi ({uid}): {e}")


# ----------------- arayuz -----------------

FONT = "Segoe UI"
BG_NAME = "arka_plan.jpg"   # exe'nin yanina ayni isimle koyarsan arka plan o olur


def font(size=13, weight="normal"):
    return ctk.CTkFont(family=FONT, size=size, weight=weight)


def resource(name):
    # Once exe'nin yanina bak (kullanici degistirebilsin), yoksa exe'nin icindekini kullan
    outside = os.path.join(app_dir(), name)
    if os.path.exists(outside):
        return outside
    base = getattr(sys, "_MEIPASS", app_dir())
    return os.path.join(base, "assets", name)


def load_bg():
    if Image is None:
        return None
    try:
        return Image.open(resource(BG_NAME)).convert("RGB")
    except Exception:
        return None


class Background:
    """Canvas'a resmi 'cover' seklinde, yazilar okunsun diye karartilmis olarak ciziz."""

    def __init__(self, canvas, image):
        self.canvas = canvas
        self.src = image
        self.photo = None
        self.size = None
        self.item = canvas.create_image(0, 0, anchor="nw")
        canvas.tag_lower(self.item)

    def render(self, w, h, focus_x):
        """focus_x: resmin ortasinin (karakterin) gelecegi x noktasi."""
        key = (w, h, int(focus_x))
        if self.src is None or w < 10 or h < 10 or self.size == key:
            return
        self.size = key
        iw, ih = self.src.size
        # Yuksekligi tam doldur, karakter sag taraftaki bos alanda dursun
        scale = max(h / ih, (w - focus_x) * 2 / iw)
        img = self.src.resize((int(iw * scale) + 1, int(ih * scale) + 1), Image.LANCZOS)
        img = ImageEnhance.Brightness(img).enhance(0.8)
        canvas = Image.new("RGB", (w, h), (11, 4, 5))
        canvas.paste(img, (int(focus_x - img.width / 2), int((h - img.height) / 2)))

        # Soldan saga karartma: kartlarin oldugu taraf koyu, karakter tarafi parlak
        ramp = Image.new("L", (w, 1))
        img_left = focus_x - img.width / 2
        fade = max(1.0, img.width * 0.3)
        for x in range(w):
            t = min(1.0, max(0.0, (x - img_left) / fade))
            t = t * t * (3 - 2 * t)  # yumusak gecis
            ramp.putpixel((x, 0), int(255 * (1 - t) + 30 * t))
        mask = ramp.resize((w, h))
        img = Image.composite(Image.new("RGB", (w, h), (11, 4, 5)), canvas, mask)
        self.photo = ImageTk.PhotoImage(img)
        self.canvas.itemconfigure(self.item, image=self.photo)


class Card(ctk.CTkFrame):
    def __init__(self, master, **kw):
        kw.setdefault("fg_color", CARD)
        kw.setdefault("corner_radius", 12)
        kw.setdefault("border_width", 1)
        kw.setdefault("border_color", BORDER)
        super().__init__(master, **kw)


class StatCard(Card):
    def __init__(self, master, title, value, color=TEXT):
        super().__init__(master, corner_radius=0, border_color=BORDER_HI)
        ctk.CTkLabel(self, text=title.upper(), font=font(11, "bold"), text_color=MUTED).pack(
            anchor="w", padx=18, pady=(14, 0))
        self.value = ctk.CTkLabel(self, text=value, font=font(17, "bold"), text_color=color)
        self.value.pack(anchor="w", padx=18, pady=(0, 14))

    def set(self, value, color=None):
        self.value.configure(text=value)
        if color:
            self.value.configure(text_color=color)


class TicketRow(ctk.CTkFrame):
    def __init__(self, master, guild, name, link, when):
        super().__init__(master, fg_color=CARD_HI, corner_radius=10, border_width=1,
                         border_color=ACCENT)
        self.columnconfigure(1, weight=1)

        ctk.CTkFrame(self, width=4, height=36, corner_radius=2, fg_color=ACCENT).grid(
            row=0, column=0, rowspan=2, padx=(12, 10), pady=12)
        ctk.CTkLabel(self, text=f"#{name}", font=font(14, "bold"), text_color=TEXT,
                     anchor="w").grid(row=0, column=1, sticky="w", pady=(10, 0))
        ctk.CTkLabel(self, text=f"{guild}  •  {when}", font=font(12), text_color=MUTED,
                     anchor="w").grid(row=1, column=1, sticky="w", pady=(0, 10))
        ctk.CTkButton(self, text="Kanala git", width=104, height=32, corner_radius=8,
                      font=font(12, "bold"), fg_color=ACCENT, hover_color=ACCENT_H,
                      command=lambda: webbrowser.open(link)).grid(
            row=0, column=2, rowspan=2, padx=12)

        # Yeni gelen satir bir sure vurgulu kalir, sonra sakinlesir
        self.after(6000, lambda: self.configure(border_color=BORDER, fg_color=CARD_ROW))


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

        root.title("Ticket Bildirim")
        root.geometry("1180x720")
        root.minsize(980, 620)
        root.configure(fg_color=BG)

        cfg = load_config()
        self.vars = {
            "token": tk.StringVar(value=cfg.get("token", "")),
            "category_ids": tk.StringVar(value=ids_to_text(cfg.get("category_ids"))),
            "name_prefixes": tk.StringVar(value=", ".join(cfg.get("name_prefixes") or [])),
            "webhook_url": tk.StringVar(value=cfg.get("webhook_url", "")),
            "dm_user_ids": tk.StringVar(value=ids_to_text(cfg.get("dm_user_ids"))),
            "ping_user_id": tk.StringVar(value=cfg.get("ping_user_id", "")),
        }
        self.sound_repeat = tk.IntVar(value=int(cfg.get("sound_repeat", 3) or 0))
        self.bg_image = load_bg()

        root.columnconfigure(1, weight=1)
        root.rowconfigure(0, weight=1)
        self._build_sidebar()

        # Icerik alani bir canvas: arka plan resmi burada, kartlar ustune yerlestiriliyor
        self.canvas = tk.Canvas(root, bg=BG, highlightthickness=0, bd=0)
        self.canvas.grid(row=0, column=1, sticky="nsew")
        self.bg = Background(self.canvas, self.bg_image)

        self.pages = {"panel": self._build_panel(), "ayarlar": self._build_settings()}
        self.canvas.bind("<Configure>", lambda e: self.relayout())
        self.show_page("ayarlar" if not cfg.get("token") else "panel")

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(100, self.poll_events)

        if discord is None:
            self.set_status("discord.py yok", ACCENT)
            self.log("discord.py kurulu degil: pip install -U discord.py")
            self.start_btn.configure(state="disabled")

    # --- canvas yardimcilari ---
    def _text(self, tag, text, size, weight="normal", color=TEXT):
        # Golgeli yazi: resmin uzerinde de net okunsun
        f = (FONT, size, weight)
        sh = self.canvas.create_text(0, 0, text=text, font=f, fill="#000000", anchor="nw",
                                     tags=(tag, f"{tag}-shadow"))
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

    # --- yan menu ---
    def _build_sidebar(self):
        side = ctk.CTkFrame(self.root, width=230, corner_radius=0, fg_color=SIDEBAR,
                            border_width=0)
        side.grid(row=0, column=0, sticky="nsw")
        side.grid_propagate(False)
        ctk.CTkFrame(self.root, width=1, corner_radius=0, fg_color=BORDER_HI).grid(
            row=0, column=0, sticky="nse")

        brand = ctk.CTkFrame(side, fg_color="transparent")
        brand.pack(fill="x", padx=18, pady=(24, 28))
        avatar = self._avatar(44)
        if avatar:
            ctk.CTkLabel(brand, text="", image=avatar).pack(side="left")
        else:
            ctk.CTkLabel(brand, text="●", font=font(18), text_color=ACCENT).pack(side="left")
        titles = ctk.CTkFrame(brand, fg_color="transparent")
        titles.pack(side="left", padx=(12, 0))
        ctk.CTkLabel(titles, text="Ticket Bildirim", font=font(15, "bold"),
                     text_color=TEXT, height=20).pack(anchor="w")
        ctk.CTkLabel(titles, text="yeni ticket alarmi", font=font(11),
                     text_color=MUTED, height=16).pack(anchor="w")

        self.nav = {}
        for key, label in (("panel", "Panel"), ("ayarlar", "Ayarlar")):
            b = ctk.CTkButton(side, text=f"   {label}", anchor="w", height=42, corner_radius=10,
                              font=font(13, "bold"), fg_color="transparent",
                              hover_color=CARD_HI, text_color=MUTED, border_width=0,
                              command=lambda k=key: self.show_page(k))
            b.pack(fill="x", padx=14, pady=3)
            self.nav[key] = b

        bottom = ctk.CTkFrame(side, fg_color="transparent")
        bottom.pack(side="bottom", fill="x", padx=14, pady=20)

        pill = ctk.CTkFrame(bottom, fg_color=CARD, corner_radius=10, border_width=1,
                            border_color=BORDER)
        pill.pack(fill="x", pady=(0, 12))
        self.status_dot = ctk.CTkLabel(pill, text="●", font=font(14), text_color=MUTED)
        self.status_dot.pack(side="left", padx=(14, 6), pady=10)
        self.status_lbl = ctk.CTkLabel(pill, text="Durduruldu", font=font(13, "bold"),
                                       text_color=TEXT)
        self.status_lbl.pack(side="left")

        self.start_btn = ctk.CTkButton(bottom, text="BASLAT", height=46, corner_radius=10,
                                       font=font(14, "bold"), fg_color=ACCENT,
                                       hover_color=ACCENT_H, border_width=1,
                                       border_color=GLOW, command=self.toggle_run)
        self.start_btn.pack(fill="x")

    def _avatar(self, size):
        if self.bg_image is None:
            return None
        src = self.bg_image
        s = min(src.size)
        # Resmin ortasindaki kismi yuvarlak kirp
        img = src.crop(((src.width - s) // 2, int(s * 0.12), (src.width + s) // 2, int(s * 0.12) + s))
        img = img.resize((size * 3, size * 3), Image.LANCZOS)
        mask = Image.new("L", img.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, img.width - 1, img.height - 1), fill=255)
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        return ctk.CTkImage(light_image=out, dark_image=out, size=(size, size))

    def show_page(self, key):
        self.page = key
        for k in self.pages:
            state = "normal" if k == key else "hidden"
            self.canvas.itemconfigure(k, state=state)
            self.nav[k].configure(fg_color=CARD_HI if k == key else "transparent",
                                  text_color=TEXT if k == key else MUTED,
                                  border_width=1 if k == key else 0,
                                  border_color=BORDER_HI)
        self.relayout()

    def relayout(self):
        w, h = self.canvas.winfo_width(), self.canvas.winfo_height()
        if w < 10:
            return
        split = self.split(w)
        self.bg.render(w, h, split + (w - split) / 2)
        self.pages[self.page](w, h)

    def split(self, w):
        # Kartlar solda bu genislige kadar, saginda arka plan resmi gorunur
        return self.PAD + (w - 2 * self.PAD) * 0.62

    # --- panel sayfasi ---
    def _build_panel(self):
        tag = "panel"
        title = self._text(tag, "Panel", 24, "bold")
        sub = self._text(tag, "Yeni ticket acildiginda ses calar ve burada listelenir.", 12, color=MUTED)

        self.stat_status = StatCard(self.canvas, "Durum", "Durduruldu", MUTED)
        self.stat_count = StatCard(self.canvas, "Bu oturumda", "0 ticket")
        self.stat_last = StatCard(self.canvas, "Son ticket", "-")
        stats = [self._window(tag, s) for s in (self.stat_status, self.stat_count, self.stat_last)]

        box = Card(self.canvas, corner_radius=0, border_color=BORDER_HI)
        box.columnconfigure(0, weight=1)
        box.rowconfigure(1, weight=1)
        head = ctk.CTkFrame(box, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=18, pady=(14, 6))
        ctk.CTkLabel(head, text="GELEN TICKET'LAR", font=font(12, "bold"),
                     text_color=TEXT).pack(side="left")
        ctk.CTkButton(head, text="Temizle", width=80, height=28, corner_radius=8,
                      font=font(12), fg_color=CARD_HI, hover_color=BORDER,
                      text_color=MUTED, command=self.clear).pack(side="right")
        self.list = ctk.CTkScrollableFrame(box, fg_color="transparent",
                                           scrollbar_button_color=BORDER_HI,
                                           scrollbar_button_hover_color=ACCENT)
        self.list.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        self.list.columnconfigure(0, weight=1)
        self.empty = ctk.CTkLabel(self.list, text="Henuz ticket yok.\nBaslat'a bas, yeni ticket gelince burada gorunur.",
                                  font=font(13), text_color=MUTED, justify="center")
        self.empty.grid(row=0, column=0, pady=60)
        box_item = self._window(tag, box)

        self.log_text = self._text(tag, "", 11, color=MUTED)

        def layout(w, h):
            p = self.PAD
            self._move_text(title, p, 22)
            self._move_text(sub, p, 62)
            right = self.split(w)
            gap = 12
            sw = (right - p - 2 * gap) / 3
            for i, item in enumerate(stats):
                self._place(item, p + i * (sw + gap), 98, sw, 84)
            self._place(box_item, p, 194, right - p, h - 194 - 44)
            self._move_text(self.log_text, p, h - 30)
        return layout

    # --- ayarlar sayfasi ---
    def _field(self, parent, row, label, key, hint="", secret=False):
        ctk.CTkLabel(parent, text=label, font=font(13, "bold"), text_color=TEXT,
                     anchor="w").grid(row=row, column=0, sticky="w", padx=18, pady=(10, 0))
        if hint:
            ctk.CTkLabel(parent, text=hint, font=font(12), text_color=MUTED,
                         anchor="e").grid(row=row, column=1, sticky="e", padx=18, pady=(10, 0))
        e = ctk.CTkEntry(parent, textvariable=self.vars[key], height=38, corner_radius=8,
                         fg_color=FIELD, border_color=BORDER, border_width=1,
                         text_color=TEXT, font=font(13), show="•" if secret else "")
        e.grid(row=row + 1, column=0, columnspan=2, sticky="ew", padx=18, pady=(6, 4))
        self.inputs.append(e)
        return e

    def _section(self, parent, title, subtitle):
        card = Card(parent, fg_color=CARD_HI)
        card.pack(fill="x", pady=(0, 12), padx=(0, 6))
        card.columnconfigure(0, weight=1)
        ctk.CTkLabel(card, text=title.upper(), font=font(12, "bold"), text_color=ACCENT,
                     anchor="w").grid(row=0, column=0, sticky="w", padx=18, pady=(16, 0))
        ctk.CTkLabel(card, text=subtitle, font=font(12), text_color=MUTED,
                     anchor="w").grid(row=1, column=0, columnspan=2, sticky="w", padx=18)
        return card

    def _build_settings(self):
        tag = "ayarlar"
        title = self._text(tag, "Ayarlar", 24, "bold")
        sub = self._text(tag, "Baslat'a bastiginda ayarlar otomatik kaydedilir.", 12, color=MUTED)

        outer = Card(self.canvas, corner_radius=0, border_color=BORDER_HI)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(0, weight=1)
        body = ctk.CTkScrollableFrame(outer, fg_color="transparent",
                                      scrollbar_button_color=BORDER_HI,
                                      scrollbar_button_hover_color=ACCENT)
        body.grid(row=0, column=0, sticky="nsew", padx=12, pady=12)
        self.inputs = []

        c = self._section(body, "Baglanti", "Developer Portal'dan aldigin BOT token'i.")
        self.token_entry = self._field(c, 2, "Bot token", "token", secret=True)
        self.show_token = ctk.CTkCheckBox(c, text="Token'i goster", font=font(12),
                                          text_color=MUTED, fg_color=ACCENT,
                                          hover_color=ACCENT_H, border_color=BORDER_HI,
                                          checkbox_width=18, checkbox_height=18,
                                          command=self.toggle_token)
        self.show_token.grid(row=4, column=0, sticky="w", padx=18, pady=(4, 16))

        c = self._section(body, "Filtre", "Hangi kanallar ticket sayilsin.")
        self._field(c, 2, "Kategori ID'leri", "category_ids", "virgulle ayir, bos = hepsi")
        self._field(c, 4, "Kanal adi onekleri", "name_prefixes", "bos = kategorideki her kanal")
        ctk.CTkFrame(c, height=12, fg_color="transparent").grid(row=6, column=0)

        c = self._section(body, "Bildirim", "Ses bu bilgisayarda calar; webhook ve DM istege bagli.")
        ctk.CTkLabel(c, text="Ses tekrari", font=font(13, "bold"), text_color=TEXT,
                     anchor="w").grid(row=2, column=0, sticky="w", padx=18, pady=(10, 0))
        srow = ctk.CTkFrame(c, fg_color="transparent")
        srow.grid(row=3, column=0, columnspan=2, sticky="ew", padx=18, pady=(6, 4))
        srow.columnconfigure(0, weight=1)
        self.sound_lbl = ctk.CTkLabel(srow, text="", width=70, font=font(13, "bold"),
                                      text_color=TEXT)
        slider = ctk.CTkSlider(srow, from_=0, to=10, number_of_steps=10,
                               variable=self.sound_repeat, progress_color=ACCENT,
                               button_color=ACCENT, button_hover_color=GLOW,
                               fg_color=BORDER, command=lambda _v: self._sound_text())
        slider.grid(row=0, column=0, sticky="ew")
        self.inputs.append(slider)
        self.sound_lbl.grid(row=0, column=1, padx=(12, 8))
        ctk.CTkButton(srow, text="Sesi dene", width=96, height=32, corner_radius=8,
                      font=font(12, "bold"), fg_color=CARD, hover_color=BORDER,
                      border_width=1, border_color=BORDER_HI,
                      text_color=TEXT, command=self.test_sound).grid(row=0, column=2)
        self._sound_text()
        self._field(c, 4, "Webhook adresi", "webhook_url", "istege bagli")
        self._field(c, 6, "DM atilacak kullanici ID'leri", "dm_user_ids", "virgulle ayir")
        self._field(c, 8, "Webhook'ta etiketlenecek kullanici ID'si", "ping_user_id", "istege bagli")
        ctk.CTkFrame(c, height=12, fg_color="transparent").grid(row=10, column=0)
        outer_item = self._window(tag, outer)

        save_btn = ctk.CTkButton(self.canvas, text="KAYDET", width=130, height=40, corner_radius=0,
                                 font=font(13, "bold"), fg_color=ACCENT, hover_color=ACCENT_H,
                                 border_width=1, border_color=GLOW, command=self.save)
        save_item = self._window(tag, save_btn)
        self.save_text = self._text(tag, "", 12, "bold", color=GREEN)

        def layout(w, h):
            p = self.PAD
            self._move_text(title, p, 22)
            self._move_text(sub, p, 62)
            right = self.split(w)
            self._place(outer_item, p, 98, right - p, h - 98 - 76)
            self._place(save_item, right - 130, h - 60, 130, 40)
            self._move_text(self.save_text, p, h - 50)
        return layout

    # --- islemler ---
    def _sound_text(self):
        n = int(self.sound_repeat.get())
        self.sound_lbl.configure(text="Kapali" if n == 0 else f"{n} kez")

    def toggle_token(self):
        self.token_entry.configure(show="" if self.show_token.get() else "•")

    def set_status(self, text, color):
        self.status_lbl.configure(text=text)
        self.status_dot.configure(text_color=color)
        self.stat_status.set(text, color)

    def log(self, text):
        self._set_text(self.log_text, f"{time.strftime('%H:%M:%S')}   {text}")

    def collect_config(self):
        v = self.vars
        return {
            "token": v["token"].get().strip(),
            "category_ids": parse_ids(v["category_ids"].get()),
            "name_prefixes": [p.strip().lower() for p in v["name_prefixes"].get().split(",") if p.strip()],
            "webhook_url": v["webhook_url"].get().strip(),
            "dm_user_ids": parse_ids(v["dm_user_ids"].get()),
            "ping_user_id": v["ping_user_id"].get().strip(),
            "sound_repeat": int(self.sound_repeat.get()),
        }

    def save(self):
        try:
            save_config(self.collect_config())
            self._set_text(self.save_text, "Kaydedildi", GREEN)
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
            messagebox.showwarning("Ticket Bildirim", "Once Ayarlar'dan bot token'ini gir.")
            return
        if not cfg["sound_repeat"] and not cfg["webhook_url"] and not cfg["dm_user_ids"]:
            messagebox.showwarning("Ticket Bildirim", "Ses, webhook ve DM kapali; bildirim gidecek yer yok.")
            return
        try:
            save_config(cfg)
        except Exception as e:
            self.log(f"Ayarlar kaydedilemedi: {e}")
        self.cfg = cfg
        self.runner = BotRunner(cfg, self.events)
        self.runner.start()
        self.set_inputs(False)
        self.start_btn.configure(text="DURDUR", fg_color=CARD_HI, hover_color=BORDER,
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
        play_sound(int(self.sound_repeat.get()) or 1)

    def clear(self):
        for r in self.rows:
            r.destroy()
        self.rows.clear()
        self.count = 0
        self.stat_count.set("0 ticket")
        self.stat_last.set("-")
        self.empty.grid(row=0, column=0, pady=60)

    def on_ticket(self, guild, name, link):
        when = time.strftime("%H:%M:%S")
        self.empty.grid_forget()
        row = TicketRow(self.list, guild, name, link, when)
        self.rows.insert(0, row)
        for i, r in enumerate(self.rows):
            r.grid(row=i, column=0, sticky="ew", pady=4)
        self.count += 1
        self.stat_count.set(f"{self.count} ticket")
        self.stat_last.set(f"#{name}")
        self.log(f"Yeni ticket: #{name} ({guild})")
        play_sound(self.cfg.get("sound_repeat", 3))
        flash_window(self.root)

    def poll_events(self):
        try:
            while True:
                kind, *data = self.events.get_nowait()
                if kind == "ready":
                    user, guilds = data
                    self.set_status("Calisiyor", GREEN)
                    self.log(f"Giris yapildi: {user}  •  {guilds} sunucu izleniyor")
                elif kind == "ticket":
                    self.on_ticket(*data)
                elif kind == "log":
                    self.log(data[0])
                elif kind == "error":
                    self.log(data[0])
                    messagebox.showerror("Ticket Bildirim", data[0])
                elif kind == "stopped":
                    self.runner = None
                    self.set_inputs(True)
                    self.start_btn.configure(text="BASLAT", state="normal", fg_color=ACCENT,
                                             hover_color=ACCENT_H, border_color=GLOW)
                    self.set_status("Durduruldu", MUTED)
        except queue.Empty:
            pass
        self.root.after(100, self.poll_events)

    def on_close(self):
        if self.runner:
            self.runner.stop()
        self.root.destroy()


def main():
    ctk.set_appearance_mode("dark")
    root = ctk.CTk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
