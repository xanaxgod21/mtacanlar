"""Embeds, panels, buttons, menus and forms of the key bot (see discord_bot.py).

The two panels are persistent: their buttons keep working after a bot restart.
Everything else is sent as a private (ephemeral) reply.
"""

from __future__ import annotations

import io
import logging
import math
import sqlite3
from collections.abc import Callable
from typing import TYPE_CHECKING

import discord
from discord import app_commands

import keybot
import keyserver as ks

if TYPE_CHECKING:
    from discord_bot import KeyBot

log = logging.getLogger("keybot")

PRODUCT_NAME = "Scarface Proxy"
MAX_BULK_KEYS = 50
PAGE_SIZE = 10
INLINE_KEYS_LIMIT = 1900  # characters; longer key lists are sent as a file
MAX_SELECT_OPTIONS = 25

NO_MENTIONS = discord.AllowedMentions.none()

STATUS_EMOJI = {"active": "🟢", "unused": "🟡", "expired": "⚫", "revoked": "🔴"}
STATUS_LABEL = {
    "active": "Aktif",
    "unused": "Kullanılmadı",
    "expired": "Süresi doldu",
    "revoked": "İptal edildi",
}
STATUS_TEXT = {status: f"{STATUS_EMOJI[status]} {STATUS_LABEL[status]}" for status in STATUS_LABEL}
STATUS_COLOR = {
    "active": discord.Color.green(),
    "unused": discord.Color.gold(),
    "expired": discord.Color.dark_grey(),
    "revoked": discord.Color.red(),
}


# --- Formatting --------------------------------------------------------------------


def format_duration(days: int) -> str:
    return "Ömür boyu" if days == 0 else f"{days} gün"


def duration_label(days: int) -> str:
    """For "<label> key": "30 günlük" or "ömür boyu"."""
    return "ömür boyu" if days == 0 else f"{days} günlük"


def format_expiry(info: keybot.KeyInfo) -> str:
    if info.expires_at is None:
        return f"İlk girişte başlar ({format_duration(info.duration_days)})"
    if info.expires_at == 0:
        return "Hiçbir zaman"
    return f"<t:{info.expires_at}:f> (<t:{info.expires_at}:R>)"


def key_title(info: keybot.KeyInfo) -> str:
    return f"#{info.id} · {info.prefix}"


def describe_key(info: keybot.KeyInfo, *, admin: bool) -> str:
    lines = [
        f"Durum: {STATUS_TEXT[info.status]}",
        f"Bitiş: {format_expiry(info)}",
        f"Bilgisayar: {'Kilitli' if info.bound else 'Kilitli değil'}",
    ]
    if admin:
        owner = f"<@{info.discord_user_id}>" if info.discord_user_id else "Yok"
        lines.append(f"Sahibi: {owner}")
        if info.note:
            lines.append(f"Not: {discord.utils.escape_markdown(info.note)}")
    return "\n".join(lines)


def key_line(info: keybot.KeyInfo) -> str:
    parts = [f"`#{info.id}` `{info.prefix}`", STATUS_TEXT[info.status]]
    if info.status == "active":
        parts.append("ömür boyu" if info.expires_at == 0 else f"bitiş <t:{info.expires_at}:R>")
    elif info.status == "unused":
        parts.append(duration_label(info.duration_days))
    if info.discord_user_id:
        parts.append(f"<@{info.discord_user_id}>")
    return " · ".join(parts)


def key_embed(info: keybot.KeyInfo, *, admin: bool) -> discord.Embed:
    return discord.Embed(
        title=f"🔑 {key_title(info)}",
        description=describe_key(info, admin=admin),
        color=STATUS_COLOR[info.status],
    )


def keys_embed(title: str, keys: list[keybot.KeyInfo], *, admin: bool) -> discord.Embed:
    embed = discord.Embed(title=title, color=discord.Color.blurple())
    for info in keys[:MAX_SELECT_OPTIONS]:
        embed.add_field(name=key_title(info), value=describe_key(info, admin=admin), inline=False)
    if not admin:
        embed.set_footer(text="Key'lerin tamamı güvenlik için gösterilmez; DM'deki mesajda duruyor.")
    return embed


def my_keys_embed(keys: list[keybot.KeyInfo]) -> discord.Embed:
    if not keys:
        return discord.Embed(
            title="Key'lerin",
            description="Hesabına bağlı key yok. Key'in varsa **Key Bağla** ile hesabına bağlayabilirsin.",
            color=discord.Color.blurple(),
        )
    return keys_embed("Key'lerin", keys, admin=False)


def key_dm_embed(key: str, info: keybot.KeyInfo) -> discord.Embed:
    embed = discord.Embed(
        title=f"🔑 {PRODUCT_NAME} key'in",
        description=f"```\n{key}\n```",
        color=discord.Color.green(),
    )
    embed.add_field(name="Süre", value=format_expiry(info), inline=False)
    embed.add_field(
        name="Nasıl kullanılır",
        value=(
            "Programı aç, key sorulunca bunu yapıştır. Key ilk girdiğin bilgisayara kilitlenir.\n"
            "Bilgisayar değiştirirsen sunucudaki key panelinden **HWID Sıfırla**'ya bas."
        ),
        inline=False,
    )
    embed.set_footer(text="Bu key'i kimseyle paylaşma.")
    return embed


def admin_panel_embed(stats: dict[str, int]) -> discord.Embed:
    embed = discord.Embed(
        title="🛠️ Key Yönetim Paneli",
        description=(
            "Key vermek, oluşturmak ve yönetmek için butonları kullan.\n"
            "Cevaplar sadece butona basan kişiye görünür."
        ),
        color=discord.Color.blurple(),
    )
    for status in keybot.STATUSES:
        embed.add_field(name=STATUS_TEXT[status], value=f"**{stats[status]}**")
    embed.add_field(name="📦 Toplam", value=f"**{sum(stats.values())}**")
    embed.add_field(name="🕒 Güncellendi", value=f"<t:{ks.now_unix()}:R>")
    embed.set_footer(text=PRODUCT_NAME)
    return embed


def user_panel_embed(cooldown_days: int) -> discord.Embed:
    cooldown = f" ({cooldown_days} günde bir)" if cooldown_days else ""
    return discord.Embed(
        title=f"🔑 {PRODUCT_NAME} Key Paneli",
        description=(
            "**📋 Key'lerim**: key'lerinin durumunu ve bitiş tarihini gösterir.\n"
            "**🔗 Key Bağla**: satın aldığın key'i Discord hesabına bağlar.\n"
            f"**🖥️ HWID Sıfırla**: bilgisayar değiştirdiysen key'ini yeni bilgisayara taşır{cooldown}.\n\n"
            "Cevaplar sadece sana görünür."
        ),
        color=discord.Color.green(),
    ).set_footer(text=PRODUCT_NAME)


# --- Replies and errors ------------------------------------------------------------


async def send(interaction: discord.Interaction, content: str | None = None, **kwargs: object) -> None:
    """Reply privately, whether or not the interaction was answered already."""
    kwargs.setdefault("allowed_mentions", NO_MENTIONS)
    for name in ("view", "file"):
        if kwargs.get(name) is None:
            kwargs.pop(name, None)
    if interaction.response.is_done():
        await interaction.followup.send(content, ephemeral=True, **kwargs)
    else:
        await interaction.response.send_message(content, ephemeral=True, **kwargs)


async def report_error(interaction: discord.Interaction, error: Exception) -> None:
    original = getattr(error, "original", error)
    if isinstance(error, app_commands.CheckFailure):
        message = "Bu komutu kullanma yetkin yok."
    elif isinstance(original, keybot.BotError):
        message = f"❌ {original}"
    elif isinstance(original, (ks.KeyServerError, sqlite3.Error)):
        log.error("Database error: %s", original)
        message = "❌ Key veritabanına ulaşılamadı, biraz sonra tekrar dene."
    else:
        log.error("Unexpected error", exc_info=original)
        message = "❌ Bir hata oluştu."
    try:
        await send(interaction, message)
    except discord.HTTPException as exc:
        log.warning("Cannot report error to user: %s", exc)


def parse_number(text: str, *, low: int, high: int, what: str) -> int:
    try:
        value = int(text.strip())
    except ValueError:
        value = low - 1
    if not low <= value <= high:
        raise keybot.BotError(f"{what} {low} ile {high} arasında bir sayı olmalı.")
    return value


class BaseView(discord.ui.View):
    async def on_error(self, interaction: discord.Interaction, error: Exception, item: discord.ui.Item) -> None:
        await report_error(interaction, error)


class BaseModal(discord.ui.Modal):
    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        await report_error(interaction, error)


class AdminView(BaseView):
    """A view only admins may use."""

    def __init__(self, bot: KeyBot, *, timeout: float | None) -> None:
        super().__init__(timeout=timeout)
        self.bot = bot

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if self.bot.is_admin(interaction.user):
            return True
        await send(interaction, "Bunu kullanma yetkin yok.")
        return False


# --- Shared actions ----------------------------------------------------------------


async def give_key_to(
    bot: KeyBot, interaction: discord.Interaction, member: discord.abc.User, days: int, note: str
) -> None:
    if member.bot:
        raise keybot.BotError("Botlara key verilemez.")
    await interaction.response.defer(ephemeral=True, thinking=True)
    key, info = await bot.db(keybot.give_key, user_id=member.id, days=days, note=note or f"discord:{member}")
    try:
        await member.send(embed=key_dm_embed(key, info))
    except discord.HTTPException:
        await send(
            interaction,
            f"⚠️ {member.mention} DM'leri kapalı olduğu için key'i gönderemedim. Key:\n"
            f"```\n{key}\n```Bunu ona kendin ilet; bir daha gösterilmeyecek.",
        )
    else:
        await send(
            interaction,
            f"✅ {member.mention} kişisine {duration_label(days)} key DM ile gönderildi (`{key_title(info)}`).",
        )
    await bot.audit(
        f"🔑 {interaction.user.mention}, {member.mention} kişisine {duration_label(days)} key verdi"
        f" (`{key_title(info)}`)."
    )


async def create_bulk_keys(
    bot: KeyBot, interaction: discord.Interaction, days: int, count: int, note: str
) -> None:
    await interaction.response.defer(ephemeral=True, thinking=True)
    keys = await bot.db(keybot.create_keys, days=days, count=count, note=note)
    header = (
        f"✅ {count} adet {duration_label(days)} key oluşturuldu. Bunlar bir daha gösterilmeyecek,"
        " şimdi kaydet. Alan kişi **Key Bağla** ile hesabına bağlayabilir."
    )
    body = "\n".join(keys)
    if len(header) + len(body) < INLINE_KEYS_LIMIT:
        await send(interaction, f"{header}\n```\n{body}\n```")
    else:
        await send(interaction, header, file=discord.File(io.BytesIO((body + "\n").encode()), filename="keyler.txt"))
    await bot.audit(f"🧾 {interaction.user.mention}, {count} adet {duration_label(days)} key oluşturdu.")


async def link_key_for(bot: KeyBot, interaction: discord.Interaction, key: str) -> None:
    info = await bot.db(keybot.link_key, user_id=interaction.user.id, key=key)
    await send(
        interaction,
        f"✅ Key hesabına bağlandı (`{key_title(info)}`). Artık **Key'lerim** ve **HWID Sıfırla** ile yönetebilirsin.",
    )
    await bot.audit(f"🔗 {interaction.user.mention} `{key_title(info)}` key'ini hesabına bağladı.")


async def reset_hwid_for(bot: KeyBot, interaction: discord.Interaction, key_id: int | None) -> str:
    """Self-service reset; returns the text to show the user."""
    info = await bot.db(
        keybot.self_reset_hwid,
        user_id=interaction.user.id,
        key_id=key_id,
        cooldown_days=bot.settings.reset_cooldown_days,
    )
    await bot.audit(f"🖥️ {interaction.user.mention} `{key_title(info)}` key'inin HWID'sini sıfırladı.")
    return (
        f"✅ `{key_title(info)}` sıfırlandı. Programı yeni bilgisayarda açıp key'i girdiğinde oraya kilitlenecek."
    )


# --- Admin panel -------------------------------------------------------------------


class AdminPanelView(AdminView):
    def __init__(self, bot: KeyBot) -> None:
        super().__init__(bot, timeout=None)

    @discord.ui.button(label="Key Ver", emoji="🔑", style=discord.ButtonStyle.success, custom_id="keypanel:admin:give", row=0)
    async def give(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await send(interaction, "Key verilecek üyeyi seç:", view=MemberPickerView(self.bot, give=True))
        await self.refresh(interaction.message)

    @discord.ui.button(label="Key Oluştur", emoji="🧾", style=discord.ButtonStyle.primary, custom_id="keypanel:admin:create", row=0)
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await interaction.response.send_modal(CreateKeysModal(self.bot))

    @discord.ui.button(label="Key Listesi", emoji="📋", style=discord.ButtonStyle.primary, custom_id="keypanel:admin:list", row=0)
    async def list_keys(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        view = KeyListView(self.bot)
        await view.load()
        await send(interaction, embed=view.embed, view=view)
        await self.refresh(interaction.message)

    @discord.ui.button(label="Key Yönet", emoji="🔧", style=discord.ButtonStyle.secondary, custom_id="keypanel:admin:manage", row=1)
    async def manage(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await interaction.response.send_modal(FindKeyModal(self.bot))

    @discord.ui.button(label="Üye Key'leri", emoji="👤", style=discord.ButtonStyle.secondary, custom_id="keypanel:admin:member", row=1)
    async def member_keys(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await send(interaction, "Key'lerini görmek istediğin üyeyi seç:", view=MemberPickerView(self.bot, give=False))

    @discord.ui.button(label="Yenile", emoji="🔄", style=discord.ButtonStyle.secondary, custom_id="keypanel:admin:refresh", row=1)
    async def reload(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        stats = await self.bot.db(keybot.key_stats)
        await interaction.response.edit_message(embed=admin_panel_embed(stats), view=self)

    async def refresh(self, message: discord.Message | None) -> None:
        """Update the panel's numbers; failures only cost freshness."""
        if message is None:
            return
        try:
            await message.edit(embed=admin_panel_embed(await self.bot.db(keybot.key_stats)))
        except (discord.HTTPException, ks.KeyServerError, sqlite3.Error) as exc:
            log.warning("Cannot refresh admin panel: %s", exc)


class MemberPickerView(AdminView):
    """Pick a member, then give them a key (``give``) or show their keys."""

    def __init__(self, bot: KeyBot, *, give: bool) -> None:
        super().__init__(bot, timeout=600)
        self.give = give
        self.manage_select: ManageKeySelect | None = None

    @discord.ui.select(cls=discord.ui.UserSelect, placeholder="Üye seç", row=0)
    async def pick(self, interaction: discord.Interaction, select: discord.ui.UserSelect) -> None:
        member = select.values[0]
        if self.give:
            if member.bot:
                raise keybot.BotError("Botlara key verilemez.")
            await interaction.response.send_modal(GiveKeyModal(self.bot, member))
            return
        keys = await self.bot.db(keybot.user_keys, user_id=member.id)
        if self.manage_select is not None:
            self.remove_item(self.manage_select)
            self.manage_select = None
        if keys:
            self.manage_select = ManageKeySelect(self.bot, keys, row=1)
            self.add_item(self.manage_select)
            embed = keys_embed(f"{member.display_name} kişisinin key'leri", keys, admin=True)
        else:
            embed = discord.Embed(description=f"{member.mention} kişisine bağlı key yok.")
        await interaction.response.edit_message(content=None, embed=embed, view=self)


class GiveKeyModal(BaseModal, title="Key Ver"):
    days = discord.ui.TextInput(label="Kaç günlük? (0 = ömür boyu)", default="30", max_length=5)
    note = discord.ui.TextInput(label="Not (isteğe bağlı)", required=False, max_length=100)

    def __init__(self, bot: KeyBot, member: discord.abc.User) -> None:
        super().__init__(title=f"Key ver: {member.display_name}"[:45])
        self.bot = bot
        self.member = member

    async def on_submit(self, interaction: discord.Interaction) -> None:
        days = parse_number(self.days.value, low=0, high=ks.MAX_DAYS, what="Gün")
        await give_key_to(self.bot, interaction, self.member, days, self.note.value)


class CreateKeysModal(BaseModal, title="Key Oluştur"):
    days = discord.ui.TextInput(label="Kaç günlük? (0 = ömür boyu)", default="30", max_length=5)
    count = discord.ui.TextInput(label=f"Kaç tane? (en fazla {MAX_BULK_KEYS})", default="1", max_length=2)
    note = discord.ui.TextInput(label="Not (isteğe bağlı)", required=False, max_length=100)

    def __init__(self, bot: KeyBot) -> None:
        super().__init__()
        self.bot = bot

    async def on_submit(self, interaction: discord.Interaction) -> None:
        days = parse_number(self.days.value, low=0, high=ks.MAX_DAYS, what="Gün")
        count = parse_number(self.count.value, low=1, high=MAX_BULK_KEYS, what="Adet")
        await create_bulk_keys(self.bot, interaction, days, count, self.note.value)


class FindKeyModal(BaseModal, title="Key Yönet"):
    key = discord.ui.TextInput(label="Key numarası (12) veya key'in tamamı", max_length=ks.MAX_KEY_LENGTH)

    def __init__(self, bot: KeyBot) -> None:
        super().__init__()
        self.bot = bot

    async def on_submit(self, interaction: discord.Interaction) -> None:
        info = await self.bot.db(keybot.key_info, key_or_id=self.key.value.strip().lstrip("#"))
        await send(interaction, embed=key_embed(info, admin=True), view=KeyManageView(self.bot, info))


# --- Key list and key management ----------------------------------------------------


class ManageKeySelect(discord.ui.Select):
    """Opens the management view of the chosen key."""

    def __init__(self, bot: KeyBot, keys: list[keybot.KeyInfo], *, row: int) -> None:
        options = [
            discord.SelectOption(
                label=key_title(info),
                value=str(info.id),
                description=f"{STATUS_LABEL[info.status]} · {format_duration(info.duration_days)}",
                emoji=STATUS_EMOJI[info.status],
            )
            for info in keys[:MAX_SELECT_OPTIONS]
        ]
        super().__init__(placeholder="🔧 Yönetmek için bir key seç", options=options, row=row)
        self.bot = bot

    async def callback(self, interaction: discord.Interaction) -> None:
        info = await self.bot.db(keybot.key_info, key_or_id=self.values[0])
        await send(interaction, embed=key_embed(info, admin=True), view=KeyManageView(self.bot, info))


class KeyListView(AdminView):
    """Paged key list with a status filter."""

    def __init__(self, bot: KeyBot, status: str | None = None) -> None:
        super().__init__(bot, timeout=900)
        self.status = status
        self.page = 0
        self.embed = discord.Embed()

    async def load(self) -> None:
        stats = await self.bot.db(keybot.key_stats)
        total = stats[self.status] if self.status else sum(stats.values())
        pages = max(1, math.ceil(total / PAGE_SIZE))
        self.page = min(self.page, pages - 1)
        keys = await self.bot.db(
            keybot.list_keys, status=self.status, offset=self.page * PAGE_SIZE, limit=PAGE_SIZE
        )

        title = f"📋 Key Listesi · {STATUS_TEXT[self.status] if self.status else 'Tümü'}"
        self.embed = discord.Embed(
            title=title,
            description="\n".join(key_line(info) for info in keys) or "Bu listede key yok.",
            color=STATUS_COLOR[self.status] if self.status else discord.Color.blurple(),
        )
        self.embed.set_footer(text=f"Sayfa {self.page + 1}/{pages} · {total} key")

        self.clear_items()
        filter_select = discord.ui.Select(
            placeholder="Duruma göre filtrele",
            options=[
                discord.SelectOption(
                    label=f"Tümü ({sum(stats.values())})", value="all", emoji="📋", default=self.status is None
                ),
                *(
                    discord.SelectOption(
                        label=f"{STATUS_LABEL[status]} ({stats[status]})",
                        value=status,
                        emoji=STATUS_EMOJI[status],
                        default=self.status == status,
                    )
                    for status in keybot.STATUSES
                ),
            ],
            row=0,
        )
        filter_select.callback = self.on_filter
        self.add_item(filter_select)
        if keys:
            self.add_item(ManageKeySelect(self.bot, keys, row=1))
        self._button("Önceki", "◀️", self.on_previous, disabled=self.page == 0)
        self._button(f"{self.page + 1}/{pages}", None, None, disabled=True)
        self._button("Sonraki", "▶️", self.on_next, disabled=self.page >= pages - 1)
        self._button("Yenile", "🔄", self.on_reload)

    def _button(self, label: str, emoji: str | None, callback: Callable | None, *, disabled: bool = False) -> None:
        button = discord.ui.Button(label=label, emoji=emoji, style=discord.ButtonStyle.secondary, disabled=disabled, row=2)
        if callback is not None:
            button.callback = callback
        self.add_item(button)

    async def show(self, interaction: discord.Interaction) -> None:
        await self.load()
        await interaction.response.edit_message(embed=self.embed, view=self)

    async def on_filter(self, interaction: discord.Interaction) -> None:
        value = interaction.data["values"][0]
        self.status = None if value == "all" else value
        self.page = 0
        await self.show(interaction)

    async def on_previous(self, interaction: discord.Interaction) -> None:
        self.page = max(0, self.page - 1)
        await self.show(interaction)

    async def on_next(self, interaction: discord.Interaction) -> None:
        self.page += 1
        await self.show(interaction)

    async def on_reload(self, interaction: discord.Interaction) -> None:
        await self.show(interaction)


class KeyManageView(AdminView):
    """Buttons for one key: revoke / unrevoke, reset HWID, extend, refresh."""

    def __init__(self, bot: KeyBot, info: keybot.KeyInfo) -> None:
        super().__init__(bot, timeout=900)
        self.info = info
        self._build()

    def _build(self) -> None:
        self.clear_items()
        info = self.info
        if info.status == "revoked":
            self._button("Geri Aç", "♻️", discord.ButtonStyle.success, self.on_unrevoke)
        else:
            self._button("İptal Et", "⛔", discord.ButtonStyle.danger, self.on_revoke)
        self._button("HWID Sıfırla", "🖥️", discord.ButtonStyle.secondary, self.on_reset, disabled=not info.bound)
        self._button("Süre Uzat", "⏳", discord.ButtonStyle.primary, self.on_extend, disabled=info.duration_days == 0)
        self._button("Yenile", "🔄", discord.ButtonStyle.secondary, self.on_reload)

    def _button(self, label: str, emoji: str, style: discord.ButtonStyle, callback: Callable, *, disabled: bool = False) -> None:
        button = discord.ui.Button(label=label, emoji=emoji, style=style, disabled=disabled)
        button.callback = callback
        self.add_item(button)

    async def show(self, interaction: discord.Interaction, info: keybot.KeyInfo, message: str | None = None) -> None:
        self.info = info
        self._build()
        await interaction.response.edit_message(
            content=f"✅ {message}" if message else None,
            embed=key_embed(info, admin=True),
            view=self,
            allowed_mentions=NO_MENTIONS,
        )

    async def run(self, interaction: discord.Interaction, icon: str, func: Callable, **kwargs: object) -> None:
        message, info = await self.bot.db(func, key_or_id=str(self.info.id), **kwargs)
        await self.show(interaction, info, message)
        await self.bot.audit(f"{icon} {interaction.user.mention}: {message}")

    async def on_revoke(self, interaction: discord.Interaction) -> None:
        await self.run(interaction, "⛔", keybot.revoke)

    async def on_unrevoke(self, interaction: discord.Interaction) -> None:
        await self.run(interaction, "♻️", keybot.unrevoke)

    async def on_reset(self, interaction: discord.Interaction) -> None:
        await self.run(interaction, "🖥️", keybot.reset_hwid)

    async def on_extend(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_modal(ExtendModal(self))

    async def on_reload(self, interaction: discord.Interaction) -> None:
        await self.show(interaction, await self.bot.db(keybot.key_info, key_or_id=str(self.info.id)))


class ExtendModal(BaseModal, title="Süre Uzat"):
    days = discord.ui.TextInput(label="Kaç gün eklensin?", default="30", max_length=5)

    def __init__(self, manage_view: KeyManageView) -> None:
        super().__init__()
        self.manage_view = manage_view

    async def on_submit(self, interaction: discord.Interaction) -> None:
        days = parse_number(self.days.value, low=1, high=ks.MAX_DAYS, what="Gün")
        await self.manage_view.run(interaction, "⏳", keybot.extend, days=days)


# --- Member panel --------------------------------------------------------------------


class UserPanelView(BaseView):
    def __init__(self, bot: KeyBot) -> None:
        super().__init__(timeout=None)
        self.bot = bot

    @discord.ui.button(label="Key'lerim", emoji="📋", style=discord.ButtonStyle.primary, custom_id="keypanel:user:keys")
    async def my_keys(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        keys = await self.bot.db(keybot.user_keys, user_id=interaction.user.id)
        await send(interaction, embed=my_keys_embed(keys))

    @discord.ui.button(label="Key Bağla", emoji="🔗", style=discord.ButtonStyle.success, custom_id="keypanel:user:link")
    async def link(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await interaction.response.send_modal(LinkKeyModal(self.bot))

    @discord.ui.button(label="HWID Sıfırla", emoji="🖥️", style=discord.ButtonStyle.secondary, custom_id="keypanel:user:reset")
    async def reset(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        keys = await self.bot.db(keybot.user_keys, user_id=interaction.user.id)
        if not keys:
            raise keybot.BotError("Hesabına bağlı key yok. Önce **Key Bağla** ile key'ini bağla.")
        resettable = [info for info in keys if info.bound and info.status == "active"]
        if not resettable:
            raise keybot.BotError(
                "Sıfırlanacak key'in yok. Key'in hiçbir bilgisayara kilitli değilse istediğin bilgisayarda girebilirsin."
            )
        cooldown = self.bot.settings.reset_cooldown_days
        note = f" Her key {cooldown} günde bir sıfırlanabilir." if cooldown else ""
        if len(resettable) == 1:
            text = f"`{key_title(resettable[0])}` key'ini sıfırlamak istediğine emin misin?{note}"
        else:
            text = f"Hangi key'i sıfırlamak istiyorsun?{note}"
        await send(interaction, text, view=HwidResetView(self.bot, resettable))


class LinkKeyModal(BaseModal, title="Key Bağla"):
    key = discord.ui.TextInput(label="Key'in tamamı", placeholder="SCAR-XXXXX-XXXXX-XXXXX-XXXXX", max_length=ks.MAX_KEY_LENGTH)

    def __init__(self, bot: KeyBot) -> None:
        super().__init__()
        self.bot = bot

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await link_key_for(self.bot, interaction, self.key.value)


class HwidResetView(BaseView):
    """A confirm button for one key, a menu for several."""

    def __init__(self, bot: KeyBot, keys: list[keybot.KeyInfo]) -> None:
        super().__init__(timeout=300)
        self.bot = bot
        if len(keys) == 1:
            button = discord.ui.Button(label="Evet, sıfırla", emoji="🖥️", style=discord.ButtonStyle.danger)
            key_id = keys[0].id

            async def confirm(interaction: discord.Interaction) -> None:
                await self.reset(interaction, key_id)

            button.callback = confirm
            self.add_item(button)
        else:
            select = discord.ui.Select(
                placeholder="Sıfırlanacak key'i seç",
                options=[
                    discord.SelectOption(label=key_title(info), value=str(info.id), emoji="🖥️")
                    for info in keys[:MAX_SELECT_OPTIONS]
                ],
            )

            async def chosen(interaction: discord.Interaction) -> None:
                await self.reset(interaction, int(select.values[0]))

            select.callback = chosen
            self.add_item(select)

    async def reset(self, interaction: discord.Interaction, key_id: int) -> None:
        text = await reset_hwid_for(self.bot, interaction, key_id)
        await interaction.response.edit_message(content=text, view=None)
