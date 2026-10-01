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
  4) pip install -U discord.py
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
from tkinter import ttk, messagebox

try:
    import discord
except ImportError:
    discord = None

CONFIG_NAME = "ticket_config.json"
SOUND_NAME  = "bildirim.wav"   # exe'nin yanina koyarsan bu ses calar

BG      = "#1e1f22"
PANEL   = "#2b2d31"
FIELD   = "#383a40"
TEXT    = "#f2f3f5"
MUTED   = "#b5bac1"
ACCENT  = "#5865f2"
GREEN   = "#23a55a"
RED     = "#f23f43"
YELLOW  = "#f0b232"


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

class App:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.runner = None
        self.cfg = {}
        self.links = {}
        self.count = 0

        root.title("Ticket Bildirim")
        root.geometry("780x620")
        root.minsize(660, 540)
        root.configure(bg=BG)
        self._style()

        cfg = load_config()
        self.vars = {
            "token": tk.StringVar(value=cfg.get("token", "")),
            "category_ids": tk.StringVar(value=ids_to_text(cfg.get("category_ids"))),
            "name_prefixes": tk.StringVar(value=", ".join(cfg.get("name_prefixes") or [])),
            "webhook_url": tk.StringVar(value=cfg.get("webhook_url", "")),
            "dm_user_ids": tk.StringVar(value=ids_to_text(cfg.get("dm_user_ids"))),
            "ping_user_id": tk.StringVar(value=cfg.get("ping_user_id", "")),
            "sound_repeat": tk.StringVar(value=str(int(cfg.get("sound_repeat", 3) or 0))),
        }
        self.show_token = tk.BooleanVar(value=False)

        self._build()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(100, self.poll_events)

        if discord is None:
            self.set_status("discord.py yok", RED)
            self.log("discord.py kurulu degil: pip install -U discord.py")
            self.start_btn.state(["disabled"])

    # --- gorunum ---
    def _style(self):
        s = ttk.Style()
        s.theme_use("clam")
        s.configure(".", background=BG, foreground=TEXT, fieldbackground=FIELD,
                    bordercolor=PANEL, font=("Segoe UI", 10))
        s.configure("TFrame", background=BG)
        s.configure("Panel.TFrame", background=PANEL)
        s.configure("TLabel", background=PANEL, foreground=MUTED)
        s.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 16, "bold"))
        s.configure("Head.TLabel", background=PANEL, foreground=TEXT, font=("Segoe UI", 11, "bold"))
        s.configure("Status.TLabel", background=BG, font=("Segoe UI", 10, "bold"))
        s.configure("Count.TLabel", background=BG, foreground=MUTED)
        s.configure("TEntry", fieldbackground=FIELD, foreground=TEXT, insertcolor=TEXT,
                    bordercolor=FIELD, lightcolor=FIELD, darkcolor=FIELD, padding=6)
        s.map("TEntry", fieldbackground=[("disabled", PANEL)], foreground=[("disabled", MUTED)])
        s.configure("TSpinbox", fieldbackground=FIELD, foreground=TEXT, arrowcolor=TEXT,
                    background=FIELD, bordercolor=FIELD, lightcolor=FIELD, darkcolor=FIELD,
                    insertcolor=TEXT, padding=4)
        s.configure("TCheckbutton", background=PANEL, foreground=MUTED)
        s.map("TCheckbutton", background=[("active", PANEL)])
        for name, color in (("Accent", ACCENT), ("Danger", RED), ("Plain", FIELD)):
            s.configure(f"{name}.TButton", background=color, foreground="white",
                        bordercolor=color, focuscolor=color, padding=(14, 7),
                        font=("Segoe UI", 10, "bold"))
            s.map(f"{name}.TButton",
                  background=[("disabled", "#4e5058"), ("active", color)],
                  foreground=[("disabled", "#949ba4")])
        s.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT,
                    rowheight=26, bordercolor=PANEL)
        s.configure("Treeview.Heading", background=FIELD, foreground=TEXT,
                    font=("Segoe UI", 10, "bold"), relief="flat")
        s.map("Treeview", background=[("selected", ACCENT)])
        s.configure("Vertical.TScrollbar", background=FIELD, troughcolor=PANEL,
                    bordercolor=PANEL, arrowcolor=TEXT)

    def _build(self):
        root = self.root
        top = ttk.Frame(root, padding=(16, 14, 16, 6))
        top.pack(fill="x")
        ttk.Label(top, text="Ticket Bildirim", style="Title.TLabel").pack(side="left")
        self.status = ttk.Label(top, text="● Durduruldu", style="Status.TLabel", foreground=MUTED)
        self.status.pack(side="right")

        # Ayarlar paneli
        panel = ttk.Frame(root, style="Panel.TFrame", padding=14)
        panel.pack(fill="x", padx=16, pady=6)
        panel.columnconfigure(1, weight=1)
        ttk.Label(panel, text="Ayarlar", style="Head.TLabel").grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 8))

        rows = [
            ("Bot token", "token", None),
            ("Kategori ID'leri", "category_ids", "virgulle ayir, bos = hepsi"),
            ("Kanal adi onekleri", "name_prefixes", "bos = kategorideki her kanal"),
            ("Webhook", "webhook_url", "istege bagli"),
            ("DM atilacak ID'ler", "dm_user_ids", "istege bagli"),
            ("Webhook'ta etiketle", "ping_user_id", "kullanici ID, istege bagli"),
        ]
        self.inputs = []
        for i, (label, key, hint) in enumerate(rows, start=1):
            ttk.Label(panel, text=label).grid(row=i, column=0, sticky="w", padx=(0, 10), pady=3)
            e = ttk.Entry(panel, textvariable=self.vars[key])
            if key == "token":
                e.configure(show="•")
                self.token_entry = e
            e.grid(row=i, column=1, sticky="ew", pady=3)
            self.inputs.append(e)
            if hint:
                ttk.Label(panel, text=hint).grid(row=i, column=2, sticky="w", padx=(8, 0))

        ttk.Checkbutton(panel, text="Goster", variable=self.show_token,
                        command=self.toggle_token).grid(row=1, column=2, sticky="w", padx=(8, 0))

        r = len(rows) + 1
        ttk.Label(panel, text="Ses tekrari").grid(row=r, column=0, sticky="w", padx=(0, 10), pady=3)
        sound_row = ttk.Frame(panel, style="Panel.TFrame")
        sound_row.grid(row=r, column=1, sticky="w", pady=3)
        spin = ttk.Spinbox(sound_row, from_=0, to=20, width=5, textvariable=self.vars["sound_repeat"])
        spin.pack(side="left")
        self.inputs.append(spin)
        ttk.Label(sound_row, text="  0 = ses yok").pack(side="left")
        ttk.Button(panel, text="Sesi dene", style="Plain.TButton",
                   command=self.test_sound).grid(row=r, column=2, sticky="w", padx=(8, 0))

        # Butonlar
        btns = ttk.Frame(root, padding=(16, 6))
        btns.pack(fill="x")
        self.start_btn = ttk.Button(btns, text="▶  Baslat", style="Accent.TButton", command=self.start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(btns, text="■  Durdur", style="Danger.TButton", command=self.stop)
        self.stop_btn.pack(side="left", padx=8)
        self.stop_btn.state(["disabled"])
        ttk.Button(btns, text="Listeyi temizle", style="Plain.TButton",
                   command=self.clear).pack(side="right")
        self.count_lbl = ttk.Label(btns, text="0 ticket", style="Count.TLabel")
        self.count_lbl.pack(side="right", padx=10)

        # Log satiri (en alta sabit)
        self.log_lbl = ttk.Label(root, text="Ayarlari girip Baslat'a bas.", style="Count.TLabel",
                                 padding=(16, 0, 16, 10))
        self.log_lbl.pack(side="bottom", fill="x")

        # Ticket listesi
        listp = ttk.Frame(root, style="Panel.TFrame", padding=10)
        listp.pack(fill="both", expand=True, padx=16, pady=(6, 6))
        ttk.Label(listp, text="Gelen ticket'lar  (cift tikla = kanali ac)",
                  style="Head.TLabel").pack(anchor="w", pady=(0, 6))
        cols = ("saat", "sunucu", "kanal")
        self.tree = ttk.Treeview(listp, columns=cols, show="headings", height=8)
        for c, w in zip(cols, (90, 220, 300)):
            self.tree.heading(c, text=c.capitalize())
            self.tree.column(c, width=w, anchor="w")
        sb = ttk.Scrollbar(listp, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", self.open_selected)

    # --- islemler ---
    def toggle_token(self):
        self.token_entry.configure(show="" if self.show_token.get() else "•")

    def set_status(self, text, color):
        self.status.configure(text=f"● {text}", foreground=color)

    def log(self, text):
        self.log_lbl.configure(text=f"[{time.strftime('%H:%M:%S')}] {text}")

    def collect_config(self):
        v = self.vars
        try:
            repeat = max(0, int(v["sound_repeat"].get()))
        except ValueError:
            repeat = 3
        return {
            "token": v["token"].get().strip(),
            "category_ids": parse_ids(v["category_ids"].get()),
            "name_prefixes": [p.strip().lower() for p in v["name_prefixes"].get().split(",") if p.strip()],
            "webhook_url": v["webhook_url"].get().strip(),
            "dm_user_ids": parse_ids(v["dm_user_ids"].get()),
            "ping_user_id": v["ping_user_id"].get().strip(),
            "sound_repeat": repeat,
        }

    def set_inputs(self, enabled):
        for e in self.inputs:
            e.state(["!disabled"] if enabled else ["disabled"])

    def start(self):
        cfg = self.collect_config()
        if not cfg["token"]:
            messagebox.showwarning("Ticket Bildirim", "Bot token'i girmen lazim.")
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
        self.start_btn.state(["disabled"])
        self.stop_btn.state(["!disabled"])
        self.set_status("Baglaniyor...", YELLOW)
        self.log("Discord'a baglaniliyor...")

    def stop(self):
        if self.runner:
            self.runner.stop()
            self.stop_btn.state(["disabled"])
            self.set_status("Durduruluyor...", YELLOW)

    def test_sound(self):
        play_sound(self.collect_config()["sound_repeat"] or 1)

    def clear(self):
        self.tree.delete(*self.tree.get_children())
        self.links.clear()
        self.count = 0
        self.count_lbl.configure(text="0 ticket")

    def open_selected(self, _event=None):
        for item in self.tree.selection():
            link = self.links.get(item)
            if link:
                webbrowser.open(link)

    def on_ticket(self, guild, name, link):
        item = self.tree.insert("", 0, values=(time.strftime("%H:%M:%S"), guild, f"#{name}"))
        self.links[item] = link
        self.tree.selection_set(item)
        self.count += 1
        self.count_lbl.configure(text=f"{self.count} ticket")
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
                    self.log(f"Giris yapildi: {user} | {guilds} sunucu izleniyor")
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
                    self.start_btn.state(["!disabled"])
                    self.stop_btn.state(["disabled"])
                    self.set_status("Durduruldu", MUTED)
        except queue.Empty:
            pass
        self.root.after(100, self.poll_events)

    def on_close(self):
        if self.runner:
            self.runner.stop()
        self.root.destroy()


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
