#!/usr/bin/env python3
"""Discord bot that hands out Scarface Proxy license keys.

Uses the key server's database (keys.db) directly, so run it on the same
machine as ``keyserver.py serve``. Settings come from environment variables or
a ``bot.env`` file next to this script; see README.md.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import logging
import os
import sqlite3
import sys
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

import discord
from discord import app_commands

import discord_ui as ui
import keybot
import keyserver as ks
from discord_ui import send

log = logging.getLogger("keybot")

DEFAULT_ENV_FILE = Path(__file__).with_name("bot.env")
DEFAULT_RESET_COOLDOWN_DAYS = 7

T = TypeVar("T")


# --- Settings ------------------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    token: str
    guild_id: int
    admin_role_ids: frozenset[int]
    log_channel_id: int | None
    announce_channel_id: int | None
    banner_url: str
    reset_cooldown_days: int
    db: Path


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines into os.environ; real environment variables win."""
    if not path.exists():
        return
    # utf-8-sig: Windows editors may save the file with a BOM.
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip("\"'"))


def _env_int(name: str, *, required: bool = False) -> int | None:
    text = os.environ.get(name, "").strip()
    if not text:
        if required:
            raise ks.KeyServerError(f"{name} is not set")
        return None
    try:
        return int(text)
    except ValueError:
        raise ks.KeyServerError(f"{name} must be a number, got {text!r}") from None


def load_settings(db: Path) -> Settings:
    token = os.environ.get("DISCORD_TOKEN", "").strip()
    if not token:
        raise ks.KeyServerError("DISCORD_TOKEN is not set")
    roles = os.environ.get("ADMIN_ROLE_IDS", "").replace(",", " ").split()
    try:
        admin_role_ids = frozenset(int(role) for role in roles)
    except ValueError:
        raise ks.KeyServerError("ADMIN_ROLE_IDS must be role ids separated by commas") from None
    cooldown = _env_int("HWID_RESET_COOLDOWN_DAYS")
    return Settings(
        token=token,
        guild_id=_env_int("GUILD_ID", required=True),
        admin_role_ids=admin_role_ids,
        log_channel_id=_env_int("LOG_CHANNEL_ID"),
        announce_channel_id=_env_int("ANNOUNCE_CHANNEL_ID"),
        banner_url=os.environ.get("BANNER_URL", "").strip(),
        reset_cooldown_days=DEFAULT_RESET_COOLDOWN_DAYS if cooldown is None else max(cooldown, 0),
        db=db,
    )


# --- Bot -------------------------------------------------------------------------


class KeyBot(discord.Client):
    def __init__(self, settings: Settings) -> None:
        super().__init__(intents=discord.Intents.default())
        self.settings = settings
        self.tree = app_commands.CommandTree(self)
        self.tree.on_error = self.on_app_command_error

    async def setup_hook(self) -> None:
        # Panels posted earlier keep working after a restart.
        self.add_view(ui.AdminPanelView(self))
        self.add_view(ui.UserPanelView(self))

        guild = discord.Object(id=self.settings.guild_id)
        self.tree.add_command(AdminCommands(self), guild=guild)
        for command in user_commands(self):
            self.tree.add_command(command, guild=guild)
        for command in announce_commands(self):
            self.tree.add_command(command, guild=guild)
        synced = await self.tree.sync(guild=guild)
        log.info("Synced %d command(s) to guild %d", len(synced), self.settings.guild_id)

    async def on_ready(self) -> None:
        log.info("Logged in as %s", self.user)

    async def db(self, func: Callable[..., T], /, **kwargs: object) -> T:
        """Run a keybot function with a fresh connection on a worker thread."""

        def run() -> T:
            with closing(ks.open_db(self.settings.db)) as conn:
                return func(conn, now=ks.now_unix(), **kwargs)

        return await asyncio.to_thread(run)

    def is_admin(self, user: discord.abc.User) -> bool:
        if not isinstance(user, discord.Member):
            return False
        if user.guild_permissions.administrator:
            return True
        return any(role.id in self.settings.admin_role_ids for role in user.roles)

    async def audit(self, text: str) -> None:
        """Post to the log channel (if set). Never pass full keys here."""
        log.info("%s", text)
        if self.settings.log_channel_id is None:
            return
        try:
            channel = self.get_channel(self.settings.log_channel_id) or await self.fetch_channel(
                self.settings.log_channel_id
            )
            await channel.send(text, allowed_mentions=ui.NO_MENTIONS)
        except discord.HTTPException as exc:
            log.warning("Cannot post to log channel: %s", exc)

    async def on_app_command_error(
        self, interaction: discord.Interaction, error: app_commands.AppCommandError
    ) -> None:
        await ui.report_error(interaction, error)


# --- Admin commands --------------------------------------------------------------

Days = app_commands.Range[int, 0, ks.MAX_DAYS]
ExtendDays = app_commands.Range[int, 1, ks.MAX_DAYS]
Note = app_commands.Range[str, 0, 100]
PANEL_CHOICES = [
    app_commands.Choice(name="Yönetim paneli (yetkililer için)", value="admin"),
    app_commands.Choice(name="Üye paneli (herkes için)", value="user"),
]


class AdminCommands(app_commands.Group):
    def __init__(self, bot: KeyBot) -> None:
        # Without admin roles only administrators see the commands; with them, everyone
        # sees them and interaction_check decides.
        permissions = None if bot.settings.admin_role_ids else discord.Permissions(administrator=True)
        super().__init__(
            name="key",
            description="Key yönetimi (yetkililer için)",
            guild_only=True,
            default_permissions=permissions,
        )
        self.bot = bot

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return self.bot.is_admin(interaction.user)

    @app_commands.command(name="panel", description="Bu kanala butonlu key paneli kurar")
    @app_commands.describe(tur="Hangi panel")
    @app_commands.choices(tur=PANEL_CHOICES)
    async def panel(self, interaction: discord.Interaction, tur: app_commands.Choice[str]) -> None:
        if tur.value == "admin":
            embed = ui.admin_panel_embed(await self.bot.db(keybot.key_stats))
            view: discord.ui.View = ui.AdminPanelView(self.bot)
            done = (
                "✅ Yönetim paneli kuruldu. Butonları sadece yetkililer kullanabilir ama sayılar"
                " herkese görünür, o yüzden yetkili kanalında dursun."
            )
        else:
            embed = ui.user_panel_embed(self.bot.settings.reset_cooldown_days)
            view = ui.UserPanelView(self.bot)
            done = "✅ Üye paneli kuruldu."
        try:
            await interaction.channel.send(embed=embed, view=view)
        except discord.Forbidden:
            raise keybot.BotError(
                "Bu kanala mesaj atma yetkim yok. Bota *Mesaj Gönder* ve *Bağlantı Yerleştir* izni ver."
            ) from None
        await send(interaction, done)

    @app_commands.command(name="ver", description="Bir üyeye yeni key oluşturup DM ile gönderir")
    @app_commands.describe(uye="Key'i alacak üye", gun="Kaç günlük (0 = ömür boyu)", not_="Kendin için not")
    @app_commands.rename(not_="not")
    async def give(
        self, interaction: discord.Interaction, uye: discord.Member, gun: Days, not_: Note = ""
    ) -> None:
        await ui.give_key_to(self.bot, interaction, uye, gun, not_)

    @app_commands.command(name="olustur", description="Kimseye bağlı olmayan key'ler oluşturur (satış için)")
    @app_commands.describe(
        gun="Kaç günlük (0 = ömür boyu)", adet=f"Kaç tane (en fazla {ui.MAX_BULK_KEYS})", not_="Kendin için not"
    )
    @app_commands.rename(not_="not")
    async def create(
        self,
        interaction: discord.Interaction,
        gun: Days,
        adet: app_commands.Range[int, 1, ui.MAX_BULK_KEYS] = 1,
        not_: Note = "",
    ) -> None:
        await ui.create_bulk_keys(self.bot, interaction, gun, adet, not_)

    @app_commands.command(name="liste", description="Key listesini açar (filtre ve sayfalar ile)")
    async def list_keys(self, interaction: discord.Interaction) -> None:
        view = ui.KeyListView(self.bot)
        await view.load()
        await send(interaction, embed=view.embed, view=view)

    @app_commands.command(name="bilgi", description="Bir key'i gösterir ve yönetme butonlarını açar")
    @app_commands.describe(key="Key numarası (#12 için 12) veya key'in tamamı")
    async def info(self, interaction: discord.Interaction, key: str) -> None:
        info = await self.bot.db(keybot.key_info, key_or_id=key.lstrip("#"))
        await send(interaction, embed=ui.key_embed(info, admin=True), view=ui.KeyManageView(self.bot, info))

    @app_commands.command(name="uye", description="Bir üyenin key'lerini gösterir")
    async def member(self, interaction: discord.Interaction, uye: discord.User) -> None:
        keys = await self.bot.db(keybot.user_keys, user_id=uye.id)
        if not keys:
            await send(interaction, f"{uye.mention} kişisine bağlı key yok.")
            return
        view = ui.BaseView(timeout=900)
        view.add_item(ui.ManageKeySelect(self.bot, keys, row=0))
        await send(interaction, embed=ui.keys_embed(f"{uye.display_name} kişisinin key'leri", keys, admin=True), view=view)

    @app_commands.command(name="iptal", description="Key'i iptal eder (program kapanır)")
    @app_commands.describe(key="Key numarası veya key'in tamamı")
    async def revoke(self, interaction: discord.Interaction, key: str) -> None:
        await self._action(interaction, "⛔", keybot.revoke, key_or_id=key.lstrip("#"))

    @app_commands.command(name="geri-ac", description="İptal edilen key'i tekrar açar")
    @app_commands.describe(key="Key numarası veya key'in tamamı")
    async def unrevoke(self, interaction: discord.Interaction, key: str) -> None:
        await self._action(interaction, "♻️", keybot.unrevoke, key_or_id=key.lstrip("#"))

    @app_commands.command(name="hwid-sifirla", description="Key'i bilgisayardan çözer (bekleme süresi yok)")
    @app_commands.describe(key="Key numarası veya key'in tamamı")
    async def reset_hwid(self, interaction: discord.Interaction, key: str) -> None:
        await self._action(interaction, "🖥️", keybot.reset_hwid, key_or_id=key.lstrip("#"))

    @app_commands.command(name="uzat", description="Key'in süresini uzatır")
    @app_commands.describe(key="Key numarası veya key'in tamamı", gun="Kaç gün eklensin")
    async def extend(self, interaction: discord.Interaction, key: str, gun: ExtendDays) -> None:
        await self._action(interaction, "⏳", keybot.extend, key_or_id=key.lstrip("#"), days=gun)

    async def _action(
        self,
        interaction: discord.Interaction,
        icon: str,
        func: Callable[..., tuple[str, keybot.KeyInfo]],
        **kwargs: object,
    ) -> None:
        message, info = await self.bot.db(func, **kwargs)
        await send(
            interaction, f"✅ {message}", embed=ui.key_embed(info, admin=True), view=ui.KeyManageView(self.bot, info)
        )
        await self.bot.audit(f"{icon} {interaction.user.mention}: {message}")


# --- User commands -------------------------------------------------------------


def user_commands(bot: KeyBot) -> list[app_commands.Command]:
    @app_commands.command(name="keylerim", description="Hesabına bağlı key'leri gösterir")
    @app_commands.guild_only()
    async def my_keys(interaction: discord.Interaction) -> None:
        keys = await bot.db(keybot.user_keys, user_id=interaction.user.id)
        await send(interaction, embed=ui.my_keys_embed(keys))

    @app_commands.command(name="key-bagla", description="Satın aldığın key'i Discord hesabına bağlar")
    @app_commands.describe(key="Key'in tamamı (SCAR-XXXXX-...)")
    @app_commands.guild_only()
    async def link(interaction: discord.Interaction, key: app_commands.Range[str, 1, ks.MAX_KEY_LENGTH]) -> None:
        await ui.link_key_for(bot, interaction, key)

    cooldown = bot.settings.reset_cooldown_days
    cooldown_text = f" ({cooldown} günde bir)" if cooldown else ""

    @app_commands.command(
        name="hwid-sifirla", description=f"Key'ini başka bilgisayarda kullanmak için sıfırlar{cooldown_text}"
    )
    @app_commands.describe(key_id="Key numarası (tek key'in varsa boş bırak)")
    @app_commands.guild_only()
    async def reset_hwid(interaction: discord.Interaction, key_id: int | None = None) -> None:
        await send(interaction, await ui.reset_hwid_for(bot, interaction, key_id))

    return [my_keys, link, reset_hwid]


# --- Update announcement ---------------------------------------------------------


def announce_commands(bot: KeyBot) -> list[app_commands.Command]:
    @app_commands.command(
        name="guncelleduyur",
        description="Güncel exe'yi duyuru kanalına atar (yetkililer için)",
    )
    @app_commands.guild_only()
    @app_commands.default_permissions(administrator=True)
    @app_commands.describe(
        surum="Sürüm (örn. v3.1)",
        notlar="Bu güncellemede neler değişti (satır için \\n yazabilirsin)",
        dosya="Güncel exe dosyası (isteğe bağlı, Discord sınırına takılırsa link kullan)",
        link="İndirme linki (dosya çok büyükse)",
        herkese="@everyone etiketlensin mi",
    )
    async def guncelleduyur(
        interaction: discord.Interaction,
        surum: str = "",
        notlar: app_commands.Range[str, 0, 1500] = "",
        dosya: discord.Attachment | None = None,
        link: app_commands.Range[str, 0, 300] = "",
        herkese: bool = False,
    ) -> None:
        # Server-side gate: default_permissions only hides the command in the UI.
        if not bot.is_admin(interaction.user):
            raise app_commands.CheckFailure()

        await interaction.response.defer(ephemeral=True)

        channel: object = interaction.channel
        if bot.settings.announce_channel_id is not None:
            channel = bot.get_channel(bot.settings.announce_channel_id) or await bot.fetch_channel(
                bot.settings.announce_channel_id
            )
        if not isinstance(channel, (discord.TextChannel, discord.Thread)):
            raise keybot.BotError(
                "Duyuru kanalı bulunamadı. Bu komutu bir metin kanalında kullan ya da ANNOUNCE_CHANNEL_ID ayarla."
            )

        title = f"🎭 {ui.PRODUCT_NAME} güncellendi"
        if surum.strip():
            title += f" — {surum.strip()}"
        embed = discord.Embed(
            title=title,
            description=notlar.replace("\\n", "\n").strip()
            or "Yeni sürüm hazır! Güncel exe'yi indirip çalıştırabilirsin.",
            color=discord.Color.from_rgb(201, 24, 24),
            timestamp=discord.utils.utcnow(),
        )
        if link.strip():
            embed.add_field(name="⬇️ İndirme", value=link.strip(), inline=False)
        if dosya is not None:
            embed.add_field(name="📎 Dosya", value=f"`{dosya.filename}` aşağıda 👇", inline=False)
        if bot.settings.banner_url:
            embed.set_image(url=bot.settings.banner_url)
        embed.set_footer(text=f"{ui.PRODUCT_NAME} • güncel sürüm")

        content = "@everyone" if herkese else None
        mentions = discord.AllowedMentions(everyone=True) if herkese else ui.NO_MENTIONS

        file: discord.File | None = None
        if dosya is not None:
            try:
                data = await dosya.read()
            except discord.HTTPException as exc:
                raise keybot.BotError(f"Dosya indirilemedi: {exc}") from None
            file = discord.File(io.BytesIO(data), filename=dosya.filename)

        try:
            await channel.send(content=content, embed=embed, file=file, allowed_mentions=mentions)
        except discord.Forbidden:
            raise keybot.BotError(
                "Bu kanala mesaj atamıyorum. Bota *Mesaj Gönder*, *Bağlantı Yerleştir* ve *Dosya Ekle* izni ver."
            ) from None
        except discord.HTTPException as exc:
            too_big = file is not None and (exc.status == 413 or getattr(exc, "code", 0) == 40005)
            if not too_big:
                raise
            # Exe exceeds this server's upload limit: post the announcement without it.
            await channel.send(content=content, embed=embed, allowed_mentions=mentions)
            await send(
                interaction,
                "⚠️ Exe, Discord'un dosya boyutu sınırını aştığı için duyuru dosyasız atıldı. "
                "`link` seçeneğiyle bir indirme bağlantısı paylaş.",
            )
            return

        await send(interaction, f"✅ Duyuru {channel.mention} kanalına atıldı.")

    return [guncelleduyur]


# --- Main ------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=f"{ui.PRODUCT_NAME} key Discord bot.")
    parser.add_argument("--db", type=Path, default=ks.DEFAULT_DB, metavar="FILE", help=f"default: {ks.DEFAULT_DB}")
    parser.add_argument(
        "--env-file", type=Path, default=DEFAULT_ENV_FILE, metavar="FILE", help="default: bot.env next to this script"
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        load_env_file(args.env_file)
        settings = load_settings(args.db)
        with closing(ks.open_db(settings.db)) as conn:
            keybot.init_links(conn)
    except (ks.KeyServerError, sqlite3.Error, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    KeyBot(settings).run(settings.token, log_handler=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
