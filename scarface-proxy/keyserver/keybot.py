"""Key database operations for the Discord bot (discord_bot.py).

Links license keys to Discord accounts in an extra ``discord_links`` table of
the key server's database. Kept free of discord.py so it can be unit tested.
Messages in ``BotError`` are shown to Discord users as-is.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import keyserver as ks

LINK_SCHEMA = """
CREATE TABLE IF NOT EXISTS discord_links (
    key_id             INTEGER PRIMARY KEY REFERENCES keys (id),
    discord_user_id    INTEGER NOT NULL,
    linked_at          INTEGER NOT NULL,
    last_hwid_reset_at INTEGER              -- last self-service reset, NULL = never
)
"""
LINK_INDEX = "CREATE INDEX IF NOT EXISTS discord_links_user ON discord_links (discord_user_id)"

_SELECT_INFO = (
    "SELECT k.*, l.discord_user_id, l.last_hwid_reset_at"
    " FROM keys k LEFT JOIN discord_links l ON l.key_id = k.id"
)


class BotError(Exception):
    """A user-facing error; the bot replies with its message."""


@dataclass(frozen=True)
class KeyInfo:
    id: int
    prefix: str
    note: str
    duration_days: int  # 0 = lifetime
    status: str  # unused, active, expired or revoked (ks.key_status)
    bound: bool  # locked to a computer
    expires_at: int | None  # 0 = never, None until first activation
    discord_user_id: int | None
    last_hwid_reset_at: int | None


def _info(row: sqlite3.Row, now: int) -> KeyInfo:
    return KeyInfo(
        id=row["id"],
        prefix=row["prefix"],
        note=row["note"],
        duration_days=row["duration_days"],
        status=ks.key_status(row, now),
        bound=row["hwid"] is not None,
        expires_at=row["expires_at"],
        discord_user_id=row["discord_user_id"],
        last_hwid_reset_at=row["last_hwid_reset_at"],
    )


def init_links(conn: sqlite3.Connection) -> None:
    with ks.transaction(conn):
        conn.execute(LINK_SCHEMA)
        conn.execute(LINK_INDEX)


def _info_by_id(conn: sqlite3.Connection, key_id: int, now: int) -> KeyInfo:
    return _info(conn.execute(f"{_SELECT_INFO} WHERE k.id = ?", (key_id,)).fetchone(), now)


def _row_by_key(conn: sqlite3.Connection, key: str) -> sqlite3.Row | None:
    """Look up by the full key only; users must not be able to address keys by id."""
    return conn.execute(
        f"{_SELECT_INFO} WHERE k.key_hash = ?", (ks.hash_key(ks.normalize_key(key)),)
    ).fetchone()


def _row_by_key_or_id(conn: sqlite3.Connection, key_or_id: str) -> sqlite3.Row:
    """Admin lookup by row id or full key, like the key server CLI."""
    try:
        key_id = ks.find_key(conn, key_or_id)["id"]
    except ks.KeyServerError:
        raise BotError("Key bulunamadı.") from None
    return conn.execute(f"{_SELECT_INFO} WHERE k.id = ?", (key_id,)).fetchone()


# --- Handing out keys ----------------------------------------------------------


def give_key(
    conn: sqlite3.Connection, *, user_id: int, days: int, note: str, now: int
) -> tuple[str, KeyInfo]:
    """Create one key linked to ``user_id``; returns the full key (shown only once)."""
    key = ks.generate_key()
    with ks.transaction(conn):
        cursor = conn.execute(
            "INSERT INTO keys (key_hash, prefix, note, duration_days, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (ks.hash_key(key), ks.display_prefix(key), note, days, now),
        )
        conn.execute(
            "INSERT INTO discord_links (key_id, discord_user_id, linked_at) VALUES (?, ?, ?)",
            (cursor.lastrowid, user_id, now),
        )
        info = _info_by_id(conn, cursor.lastrowid, now)
    return key, info


def create_keys(conn: sqlite3.Connection, *, days: int, count: int, note: str, now: int) -> list[str]:
    """Unlinked keys, e.g. to sell elsewhere; buyers link them with ``link_key``."""
    return ks.create_keys(conn, days=days, count=count, note=note, now=now)


def link_key(conn: sqlite3.Connection, *, user_id: int, key: str, now: int) -> KeyInfo:
    with ks.transaction(conn):
        row = _row_by_key(conn, key)
        if row is None:
            raise BotError("Böyle bir key yok.")
        if row["discord_user_id"] == user_id:
            raise BotError("Bu key zaten hesabına bağlı.")
        if row["discord_user_id"] is not None:
            raise BotError("Bu key başka bir Discord hesabına bağlı.")
        if row["revoked_at"] is not None:
            raise BotError("Bu key iptal edilmiş.")
        conn.execute(
            "INSERT INTO discord_links (key_id, discord_user_id, linked_at) VALUES (?, ?, ?)",
            (row["id"], user_id, now),
        )
        return _info_by_id(conn, row["id"], now)


# --- Lookups -----------------------------------------------------------------


def user_keys(conn: sqlite3.Connection, *, user_id: int, now: int) -> list[KeyInfo]:
    rows = conn.execute(
        f"{_SELECT_INFO} WHERE l.discord_user_id = ? ORDER BY k.id", (user_id,)
    ).fetchall()
    return [_info(row, now) for row in rows]


def key_info(conn: sqlite3.Connection, *, key_or_id: str, now: int) -> KeyInfo:
    return _info(_row_by_key_or_id(conn, key_or_id), now)


STATUSES = ("active", "unused", "expired", "revoked")

# SQL versions of ks.key_status, for filtering and counting in the database.
_STATUS_WHERE = {
    "revoked": "k.revoked_at IS NOT NULL",
    "unused": "k.revoked_at IS NULL AND k.activated_at IS NULL",
    "expired": "k.revoked_at IS NULL AND k.activated_at IS NOT NULL"
    " AND k.expires_at != 0 AND k.expires_at <= :now",
    "active": "k.revoked_at IS NULL AND k.activated_at IS NOT NULL"
    " AND (k.expires_at = 0 OR k.expires_at > :now)",
}


def key_stats(conn: sqlite3.Connection, *, now: int) -> dict[str, int]:
    """Number of keys per status (every status is present)."""
    stats = dict.fromkeys(STATUSES, 0)
    for status, where in _STATUS_WHERE.items():
        stats[status] = conn.execute(
            f"SELECT COUNT(*) FROM keys k WHERE {where}", {"now": now}
        ).fetchone()[0]
    return stats


def list_keys(
    conn: sqlite3.Connection, *, status: str | None, offset: int, limit: int, now: int
) -> list[KeyInfo]:
    """One page of keys, newest first; ``status`` None means all."""
    where = _STATUS_WHERE[status] if status else "1"
    rows = conn.execute(
        f"{_SELECT_INFO} WHERE {where} ORDER BY k.id DESC LIMIT :limit OFFSET :offset",
        {"now": now, "limit": limit, "offset": offset},
    ).fetchall()
    return [_info(row, now) for row in rows]


# --- Self-service HWID reset ---------------------------------------------------


def self_reset_hwid(
    conn: sqlite3.Connection, *, user_id: int, key_id: int | None, cooldown_days: int, now: int
) -> KeyInfo:
    """Unbind one of the user's own keys, at most once per ``cooldown_days``.

    ``key_id`` may be omitted when the user has exactly one key.
    """
    with ks.transaction(conn):
        if key_id is None:
            rows = conn.execute(
                f"{_SELECT_INFO} WHERE l.discord_user_id = ?", (user_id,)
            ).fetchall()
            if not rows:
                raise BotError("Hesabına bağlı key yok.")
            if len(rows) > 1:
                raise BotError(
                    "Birden fazla key'in var. Hangisini sıfırlayacağını `key_id` ile seç"
                    " (numaraları `/keylerim` gösterir)."
                )
            row = rows[0]
        else:
            row = conn.execute(f"{_SELECT_INFO} WHERE k.id = ?", (key_id,)).fetchone()
            if row is None or row["discord_user_id"] != user_id:
                raise BotError("Bu numarada sana ait bir key yok.")

        status = ks.key_status(row, now)
        if status == "revoked":
            raise BotError("Bu key iptal edilmiş.")
        if status == "expired":
            raise BotError("Bu key'in süresi dolmuş.")
        if row["hwid"] is None:
            raise BotError("Bu key zaten hiçbir bilgisayara bağlı değil, istediğin bilgisayarda girebilirsin.")
        last_reset = row["last_hwid_reset_at"]
        if last_reset is not None and cooldown_days > 0:
            allowed_at = last_reset + cooldown_days * ks.SECONDS_PER_DAY
            if now < allowed_at:
                raise BotError(f"HWID'yi tekrar sıfırlayabilmen için <t:{allowed_at}:R> beklemen lazım.")

        conn.execute("UPDATE keys SET hwid = NULL WHERE id = ?", (row["id"],))
        conn.execute(
            "UPDATE discord_links SET last_hwid_reset_at = ? WHERE key_id = ?", (now, row["id"])
        )
        return _info_by_id(conn, row["id"], now)


# --- Admin actions -------------------------------------------------------------


def revoke(conn: sqlite3.Connection, *, key_or_id: str, now: int) -> tuple[str, KeyInfo]:
    with ks.transaction(conn):
        row = _row_by_key_or_id(conn, key_or_id)
        if row["revoked_at"] is not None:
            raise BotError(f"{_label(row)} zaten iptal edilmiş.")
        ks.revoke_key(conn, row, now)
        return f"{_label(row)} iptal edildi.", _info_by_id(conn, row["id"], now)


def unrevoke(conn: sqlite3.Connection, *, key_or_id: str, now: int) -> tuple[str, KeyInfo]:
    with ks.transaction(conn):
        row = _row_by_key_or_id(conn, key_or_id)
        if row["revoked_at"] is None:
            raise BotError(f"{_label(row)} iptal edilmemiş.")
        ks.unrevoke_key(conn, row, now)
        return f"{_label(row)} tekrar açıldı.", _info_by_id(conn, row["id"], now)


def reset_hwid(conn: sqlite3.Connection, *, key_or_id: str, now: int) -> tuple[str, KeyInfo]:
    """Admin reset: no cooldown, and the user's own cooldown is left untouched."""
    with ks.transaction(conn):
        row = _row_by_key_or_id(conn, key_or_id)
        if row["hwid"] is None:
            raise BotError(f"{_label(row)} hiçbir bilgisayara bağlı değil.")
        ks.reset_key_hwid(conn, row, now)
        return (
            f"{_label(row)} bilgisayardan çözüldü; bir sonraki giren bilgisayara kilitlenecek.",
            _info_by_id(conn, row["id"], now),
        )


def extend(conn: sqlite3.Connection, *, key_or_id: str, days: int, now: int) -> tuple[str, KeyInfo]:
    with ks.transaction(conn):
        row = _row_by_key_or_id(conn, key_or_id)
        if row["duration_days"] == 0:
            raise BotError(f"{_label(row)} ömür boyu, uzatılacak bir şey yok.")
        ks.extend_key(conn, row, now, days=days)
        return f"{_label(row)} {days} gün uzatıldı.", _info_by_id(conn, row["id"], now)


def _label(row: sqlite3.Row) -> str:
    return f"`#{row['id']} · {row['prefix']}`"
