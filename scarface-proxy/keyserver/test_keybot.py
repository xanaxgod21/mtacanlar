"""Unit tests for keybot.py: python3 -m unittest discover -s keyserver -v"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import keybot
import keyserver as ks

NOW = 1_800_000_000
DAY = 86_400
HWID_A = "0123456789ABCDEF0123456789ABCDEF"
HWID_B = "FEDCBA9876543210FEDCBA9876543210"
NONCE = "00112233445566778899aabbccddeeff"
ALICE = 111
BOB = 222


class KeyBotTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.conn = ks.open_db(Path(tmp.name) / "keys.db", create=True)
        self.addCleanup(self.conn.close)
        ks.init_schema(self.conn)
        keybot.init_links(self.conn)

    def activate(self, key: str, hwid: str = HWID_A, now: int = NOW) -> ks.Status:
        request = ks.ActivationRequest(ks.normalize_key(key), hwid, NONCE, "3.0.0")
        return ks.activate(self.conn, request, now=now, ip="127.0.0.1").status

    def give(self, user_id: int = ALICE, days: int = 30) -> tuple[str, keybot.KeyInfo]:
        return keybot.give_key(self.conn, user_id=user_id, days=days, note="", now=NOW)

    def self_reset(self, user_id: int = ALICE, key_id: int | None = None, now: int = NOW, cooldown_days: int = 7):
        return keybot.self_reset_hwid(
            self.conn, user_id=user_id, key_id=key_id, cooldown_days=cooldown_days, now=now
        )

    def test_init_links_is_idempotent_and_keeps_schema_version(self) -> None:
        keybot.init_links(self.conn)
        self.assertEqual(self.conn.execute("PRAGMA user_version").fetchone()[0], ks.SCHEMA_VERSION)

    def test_give_key_creates_linked_key_that_activates(self) -> None:
        key, info = self.give(days=30)
        self.assertEqual(info.discord_user_id, ALICE)
        self.assertEqual(info.status, "unused")
        self.assertEqual(info.prefix, key[: ks.KEY_DISPLAY_LENGTH])
        self.assertEqual(self.activate(key), ks.Status.OK)
        [mine] = keybot.user_keys(self.conn, user_id=ALICE, now=NOW)
        self.assertEqual((mine.status, mine.bound, mine.expires_at), ("active", True, NOW + 30 * DAY))

    def test_user_keys_only_returns_own_keys(self) -> None:
        self.give(ALICE)
        self.give(BOB)
        self.give(ALICE)
        self.assertEqual(len(keybot.user_keys(self.conn, user_id=ALICE, now=NOW)), 2)
        self.assertEqual(len(keybot.user_keys(self.conn, user_id=BOB, now=NOW)), 1)
        self.assertEqual(keybot.user_keys(self.conn, user_id=333, now=NOW), [])

    def test_link_key(self) -> None:
        [key] = keybot.create_keys(self.conn, days=7, count=1, note="", now=NOW)
        info = keybot.link_key(self.conn, user_id=BOB, key=f"  {key.lower()} ", now=NOW)
        self.assertEqual(info.discord_user_id, BOB)
        with self.assertRaisesRegex(keybot.BotError, "zaten hesabına"):
            keybot.link_key(self.conn, user_id=BOB, key=key, now=NOW)
        with self.assertRaisesRegex(keybot.BotError, "başka bir Discord"):
            keybot.link_key(self.conn, user_id=ALICE, key=key, now=NOW)

    def test_link_key_rejects_unknown_keys_and_row_ids(self) -> None:
        keybot.create_keys(self.conn, days=7, count=1, note="", now=NOW)
        for text in ("SCAR-AAAAA-AAAAA-AAAAA-AAAAA", "1", "#1"):
            with self.subTest(text=text), self.assertRaisesRegex(keybot.BotError, "Böyle bir key yok"):
                keybot.link_key(self.conn, user_id=ALICE, key=text, now=NOW)

    def test_link_key_rejects_revoked_key(self) -> None:
        [key] = keybot.create_keys(self.conn, days=7, count=1, note="", now=NOW)
        keybot.revoke(self.conn, key_or_id=key, now=NOW)
        with self.assertRaisesRegex(keybot.BotError, "iptal"):
            keybot.link_key(self.conn, user_id=ALICE, key=key, now=NOW)

    def test_self_reset_moves_key_to_another_computer(self) -> None:
        key, info = self.give()
        self.activate(key, HWID_A)
        self.assertEqual(self.activate(key, HWID_B), ks.Status.HWID_MISMATCH)
        reset = self.self_reset()
        self.assertEqual((reset.id, reset.bound, reset.last_hwid_reset_at), (info.id, False, NOW))
        self.assertEqual(self.activate(key, HWID_B, now=NOW + 1), ks.Status.OK)
        self.assertEqual(self.activate(key, HWID_A, now=NOW + 2), ks.Status.HWID_MISMATCH)

    def test_self_reset_cooldown(self) -> None:
        key, _ = self.give()
        self.activate(key)
        self.self_reset()
        self.activate(key, HWID_B, now=NOW + DAY)
        with self.assertRaisesRegex(keybot.BotError, f"<t:{NOW + 7 * DAY}:R>"):
            self.self_reset(now=NOW + 7 * DAY - 1)
        self.self_reset(now=NOW + 7 * DAY)

    def test_self_reset_without_cooldown(self) -> None:
        key, _ = self.give()
        for i in range(3):
            self.activate(key, now=NOW + i)
            self.self_reset(now=NOW + i, cooldown_days=0)

    def test_admin_reset_ignores_and_keeps_user_cooldown(self) -> None:
        key, info = self.give()
        self.activate(key)
        self.self_reset()
        self.activate(key, HWID_B, now=NOW + 1)
        keybot.reset_hwid(self.conn, key_or_id=str(info.id), now=NOW + 2)
        self.activate(key, HWID_A, now=NOW + 3)
        with self.assertRaisesRegex(keybot.BotError, "beklemen"):
            self.self_reset(now=NOW + 4)

    def test_self_reset_only_own_keys(self) -> None:
        key, info = self.give(BOB)
        self.activate(key)
        with self.assertRaisesRegex(keybot.BotError, "sana ait"):
            self.self_reset(ALICE, key_id=info.id)
        with self.assertRaisesRegex(keybot.BotError, "sana ait"):
            self.self_reset(ALICE, key_id=999)
        with self.assertRaisesRegex(keybot.BotError, "bağlı key yok"):
            self.self_reset(ALICE)

    def test_self_reset_picks_the_only_key_or_asks(self) -> None:
        first, first_info = self.give()
        self.activate(first)
        self.assertEqual(self.self_reset().id, first_info.id)

        second, second_info = self.give()
        self.activate(second, now=NOW + 1)
        with self.assertRaisesRegex(keybot.BotError, "Birden fazla"):
            self.self_reset(now=NOW + 1)
        self.assertEqual(self.self_reset(key_id=second_info.id, now=NOW + 1).id, second_info.id)

    def test_self_reset_refuses_unbound_revoked_and_expired_keys(self) -> None:
        key, info = self.give(days=1)
        with self.assertRaisesRegex(keybot.BotError, "bağlı değil"):
            self.self_reset()
        self.activate(key)
        with self.assertRaisesRegex(keybot.BotError, "süresi dolmuş"):
            self.self_reset(now=NOW + DAY)
        keybot.revoke(self.conn, key_or_id=str(info.id), now=NOW)
        with self.assertRaisesRegex(keybot.BotError, "iptal"):
            self.self_reset()

    def test_revoke_and_unrevoke(self) -> None:
        key, info = self.give()
        message, revoked = keybot.revoke(self.conn, key_or_id=str(info.id), now=NOW)
        self.assertIn(f"#{info.id}", message)
        self.assertEqual(revoked.status, "revoked")
        self.assertEqual(self.activate(key), ks.Status.REVOKED)
        with self.assertRaisesRegex(keybot.BotError, "zaten iptal"):
            keybot.revoke(self.conn, key_or_id=key, now=NOW)

        _, restored = keybot.unrevoke(self.conn, key_or_id=key, now=NOW)
        self.assertEqual(restored.status, "unused")
        with self.assertRaisesRegex(keybot.BotError, "iptal edilmemiş"):
            keybot.unrevoke(self.conn, key_or_id=key, now=NOW)

    def test_extend(self) -> None:
        key, info = self.give(days=30)
        _, unused = keybot.extend(self.conn, key_or_id=str(info.id), days=5, now=NOW)
        self.assertEqual(unused.duration_days, 35)
        self.activate(key)
        _, active = keybot.extend(self.conn, key_or_id=key, days=10, now=NOW)
        self.assertEqual(active.expires_at, NOW + 45 * DAY)

        _, lifetime = self.give(days=0)
        with self.assertRaisesRegex(keybot.BotError, "ömür boyu"):
            keybot.extend(self.conn, key_or_id=str(lifetime.id), days=10, now=NOW)

    def test_admin_lookup_errors(self) -> None:
        for text in ("999", "SCAR-AAAAA-AAAAA-AAAAA-AAAAA"):
            with self.subTest(text=text), self.assertRaisesRegex(keybot.BotError, "bulunamadı"):
                keybot.key_info(self.conn, key_or_id=text, now=NOW)

    def make_one_key_per_status(self) -> dict[str, int]:
        """Keys whose status at NOW + DAY is unused, active (twice), expired and revoked."""
        ids = {"unused": self.give()[1].id}
        for name, days in (("active", 30), ("lifetime", 0), ("expired", 1), ("revoked", 30)):
            key, info = self.give(days=days)
            self.activate(key)
            ids[name] = info.id
        keybot.revoke(self.conn, key_or_id=str(ids["revoked"]), now=NOW)
        return ids

    def test_key_stats_and_list_filters_match_key_status(self) -> None:
        ids = self.make_one_key_per_status()
        now = NOW + DAY
        self.assertEqual(
            keybot.key_stats(self.conn, now=now),
            {"active": 2, "unused": 1, "expired": 1, "revoked": 1},
        )
        everything = keybot.list_keys(self.conn, status=None, offset=0, limit=100, now=now)
        self.assertEqual([info.id for info in everything], sorted(ids.values(), reverse=True))
        for status in keybot.STATUSES:
            with self.subTest(status=status):
                listed = keybot.list_keys(self.conn, status=status, offset=0, limit=100, now=now)
                expected = [info.id for info in everything if info.status == status]
                self.assertEqual([info.id for info in listed], expected)

    def test_list_keys_pages_newest_first(self) -> None:
        ids = [self.give()[1].id for _ in range(5)]
        pages = [
            [info.id for info in keybot.list_keys(self.conn, status=None, offset=offset, limit=2, now=NOW)]
            for offset in (0, 2, 4, 6)
        ]
        self.assertEqual(pages, [ids[4:2:-1], ids[2:0:-1], ids[:1], []])


if __name__ == "__main__":
    unittest.main()
