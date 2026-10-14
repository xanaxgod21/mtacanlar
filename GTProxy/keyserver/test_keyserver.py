"""Unit tests for keyserver.py: python3 -m unittest discover -s keyserver -v"""

from __future__ import annotations

import datetime
import hashlib
import http.client
import io
import ipaddress
import json
import os
import re
import sqlite3
import ssl
import tempfile
import threading
import unittest
from contextlib import closing, redirect_stderr, redirect_stdout
from pathlib import Path

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.x509.oid import NameOID

import keyserver as ks

NOW = 1_800_000_000
DAY = 86_400
HWID_A = "0123456789ABCDEF0123456789ABCDEF"
HWID_B = "FEDCBA9876543210FEDCBA9876543210"
NONCE = "00112233445566778899aabbccddeeff"
KEY_PATTERN = re.compile(r"SCAR-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}")


def request_body(key: str, hwid: str = HWID_A, nonce: str = NONCE, **overrides: object) -> bytes:
    fields: dict[str, object] = {
        "key": key,
        "hwid": hwid,
        "nonce": nonce,
        "client_version": "3.0.0",
    }
    fields.update(overrides)
    return json.dumps({k: v for k, v in fields.items() if v is not None}).encode()


def verify_response(public_hex: str, response: dict[str, str]) -> dict[str, object]:
    """What the client does: check the signature, then parse the payload."""
    payload = bytes.fromhex(response["payload"])
    public_key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_hex))
    public_key.verify(bytes.fromhex(response["signature"]), payload)
    return json.loads(payload)


class DatabaseTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.db = self.dir / "keys.db"
        self.signing_key_path = self.dir / "signing_key.pem"
        with closing(ks.open_db(self.db, create=True)) as conn:
            ks.init_schema(conn)

    def new_key(self, days: int = 30, note: str = "") -> str:
        with closing(ks.open_db(self.db)) as conn:
            return ks.create_keys(conn, days=days, count=1, note=note, now=NOW - DAY)[0]

    def activate(
        self, key: str, hwid: str = HWID_A, now: int = NOW, ip: str = "203.0.113.7"
    ) -> ks.ActivationResult:
        request = ks.parse_activation_request(request_body(key, hwid))
        with closing(ks.open_db(self.db)) as conn:
            return ks.activate(conn, request, now=now, ip=ip)

    def row(self, key: str) -> sqlite3.Row:
        with closing(ks.open_db(self.db)) as conn:
            return ks.find_key(conn, key)

    def set_column(self, key: str, column: str, value: object) -> None:
        assert column in {"expires_at", "revoked_at", "hwid"}
        with closing(ks.open_db(self.db)) as conn:
            conn.execute(
                f"UPDATE keys SET {column} = ? WHERE key_hash = ?",
                (value, ks.hash_key(ks.normalize_key(key))),
            )

    def cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = ks.main(
                ["--db", str(self.db), "--signing-key", str(self.signing_key_path), *argv]
            )
        return code, out.getvalue(), err.getvalue()


class KeyFormatTests(unittest.TestCase):
    def test_generated_keys_match_format(self) -> None:
        keys = {ks.generate_key() for _ in range(500)}
        self.assertEqual(len(keys), 500)
        for key in keys:
            self.assertRegex(key, KEY_PATTERN)
            self.assertEqual(len(key), len(ks.KEY_PREFIX) + 4 * 5 + 3)

    def test_generated_keys_use_whole_alphabet(self) -> None:
        symbols = set("".join(ks.generate_key()[4:].replace("-", "") for _ in range(500)))
        self.assertEqual(symbols, set(ks.KEY_ALPHABET))

    def test_normalize_removes_whitespace_and_uppercases(self) -> None:
        self.assertEqual(
            ks.normalize_key("  scar-7k3qf - m2x9a\t-pq4rt-\nzz81c "), "SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C"
        )

    def test_hash_and_prefix(self) -> None:
        key = "SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C"
        self.assertEqual(ks.hash_key(key), hashlib.sha256(key.encode("utf-8")).hexdigest())
        self.assertEqual(ks.display_prefix(key), "SCAR-7K3QF")


class RequestParsingTests(unittest.TestCase):
    KEY = "SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C"

    def assert_rejected(self, body: bytes, message_part: str) -> None:
        with self.assertRaises(ks.RequestError) as ctx:
            ks.parse_activation_request(body)
        self.assertIn(message_part, str(ctx.exception))

    def test_valid_request_is_normalized(self) -> None:
        request = ks.parse_activation_request(
            request_body(" scar-7k3qf-m2x9a-pq4rt-zz81c ", hwid=HWID_A.lower(), nonce=NONCE.upper())
        )
        self.assertEqual(request.key, self.KEY)
        self.assertEqual(request.hwid, HWID_A)
        self.assertEqual(request.nonce, NONCE.upper())  # echoed verbatim
        self.assertEqual(request.client_version, "3.0.0")

    def test_missing_fields(self) -> None:
        for field in ("key", "hwid", "nonce", "client_version"):
            with self.subTest(field=field):
                body = json.loads(request_body(self.KEY))
                del body[field]
                self.assert_rejected(json.dumps(body).encode(), f"missing field: {field}")

    def test_non_string_fields(self) -> None:
        for field, value in (("key", 123), ("hwid", ["x"]), ("nonce", {}), ("client_version", 3)):
            with self.subTest(field=field):
                body = json.loads(request_body(self.KEY))
                body[field] = value
                self.assert_rejected(json.dumps(body).encode(), f"field {field} must be a string")

    def test_bad_hwid(self) -> None:
        for hwid in (HWID_A[:-1], HWID_A + "0", "G" * 32, "", HWID_A[:-1] + "\n", "+" + HWID_A[1:]):
            with self.subTest(hwid=hwid):
                self.assert_rejected(request_body(self.KEY, hwid=hwid), "hwid")

    def test_bad_nonce(self) -> None:
        for nonce in (NONCE[:-2], NONCE + "00", "z" * 32, "", "١" * 32):
            with self.subTest(nonce=nonce):
                self.assert_rejected(request_body(self.KEY, nonce=nonce), "nonce")

    def test_key_length_limit(self) -> None:
        ks.parse_activation_request(request_body("A" * 64))
        self.assert_rejected(request_body("A" * 65), "longer than 64")

    def test_empty_key(self) -> None:
        self.assert_rejected(request_body(""), "key is empty")
        self.assert_rejected(request_body(" \t "), "key is empty")

    def test_client_version_limits(self) -> None:
        self.assert_rejected(request_body(self.KEY, client_version=""), "client_version")
        self.assert_rejected(request_body(self.KEY, client_version="9" * 65), "client_version")

    def test_body_not_json_object(self) -> None:
        self.assert_rejected(b"", "not valid JSON")
        self.assert_rejected(b"{", "not valid JSON")
        self.assert_rejected(b"\xff\xfe", "not valid JSON")
        # Deep nesting is rejected either by the decoder (RecursionError) or as a non-object.
        with self.assertRaises(ks.RequestError):
            ks.parse_activation_request(b"[" * 2048 + b"]" * 2048)
        self.assert_rejected(b"[]", "JSON object")
        self.assert_rejected(b'"key"', "JSON object")

    def test_body_too_large(self) -> None:
        body = request_body(self.KEY, client_version="x" * 4096)
        self.assert_rejected(body, "too large")


class ActivationTests(DatabaseTestCase):
    def test_unknown_key_is_invalid(self) -> None:
        result = self.activate("SCAR-00000-00000-00000-00000")
        self.assertEqual(result.status, ks.Status.INVALID_KEY)
        self.assertEqual(result.expires_at, 0)

    def test_first_activation_binds_hwid_and_starts_clock(self) -> None:
        key = self.new_key(days=30)
        result = self.activate(key, now=NOW)
        self.assertEqual(result.status, ks.Status.OK)
        self.assertEqual(result.expires_at, NOW + 30 * DAY)
        self.assertEqual(result.message, ks.ACTIVATED_MESSAGE)
        row = self.row(key)
        self.assertEqual(row["hwid"], HWID_A)
        self.assertEqual(row["activated_at"], NOW)
        self.assertEqual(row["expires_at"], NOW + 30 * DAY)

    def test_lifetime_key_never_expires(self) -> None:
        key = self.new_key(days=0)
        self.assertEqual(self.activate(key).expires_at, 0)
        result = self.activate(key, now=NOW + 100 * 365 * DAY)
        self.assertEqual((result.status, result.expires_at), (ks.Status.OK, 0))

    def test_same_hwid_any_case_and_key_spelling_is_ok(self) -> None:
        key = self.new_key(days=30)
        self.activate(key, now=NOW)
        result = self.activate(f"  {key.lower()} ", hwid=HWID_A.lower(), now=NOW + DAY)
        self.assertEqual(result.status, ks.Status.OK)
        self.assertEqual(result.message, ks.STATUS_MESSAGES[ks.Status.OK])
        self.assertEqual(result.expires_at, NOW + 30 * DAY)  # unchanged by later activations

    def test_other_hwid_is_rejected(self) -> None:
        key = self.new_key()
        self.activate(key, hwid=HWID_A)
        result = self.activate(key, hwid=HWID_B)
        self.assertEqual(result.status, ks.Status.HWID_MISMATCH)
        self.assertEqual(self.row(key)["hwid"], HWID_A)

    def test_expiry_boundary(self) -> None:
        key = self.new_key(days=1)
        self.activate(key, now=NOW)
        self.assertEqual(self.activate(key, now=NOW + DAY - 1).status, ks.Status.OK)
        result = self.activate(key, now=NOW + DAY)
        self.assertEqual((result.status, result.expires_at), (ks.Status.EXPIRED, NOW + DAY))

    def test_mismatch_is_checked_before_expiry(self) -> None:
        key = self.new_key(days=1)
        self.activate(key, now=NOW)
        self.assertEqual(
            self.activate(key, hwid=HWID_B, now=NOW + 2 * DAY).status, ks.Status.HWID_MISMATCH
        )

    def test_revoked_unused_key_is_not_bound(self) -> None:
        key = self.new_key()
        self.set_column(key, "revoked_at", NOW)
        result = self.activate(key)
        self.assertEqual((result.status, result.expires_at), (ks.Status.REVOKED, 0))
        self.assertIsNone(self.row(key)["hwid"])
        self.assertIsNone(self.row(key)["activated_at"])

    def test_revoked_beats_everything(self) -> None:
        key = self.new_key(days=1)
        self.activate(key, now=NOW)
        self.set_column(key, "revoked_at", NOW)
        self.assertEqual(self.activate(key, now=NOW).status, ks.Status.REVOKED)
        self.assertEqual(self.activate(key, hwid=HWID_B, now=NOW).status, ks.Status.REVOKED)
        self.assertEqual(self.activate(key, now=NOW + 5 * DAY).status, ks.Status.REVOKED)

    def test_rebind_after_hwid_reset_keeps_expiry(self) -> None:
        key = self.new_key(days=30)
        self.activate(key, hwid=HWID_A, now=NOW)
        self.set_column(key, "hwid", None)
        result = self.activate(key, hwid=HWID_B, now=NOW + 10 * DAY)
        self.assertEqual((result.status, result.expires_at), (ks.Status.OK, NOW + 30 * DAY))
        row = self.row(key)
        self.assertEqual((row["hwid"], row["activated_at"]), (HWID_B, NOW))
        self.assertEqual(self.activate(key, hwid=HWID_A).status, ks.Status.HWID_MISMATCH)

    def test_last_seen_is_updated_for_known_keys_only(self) -> None:
        key = self.new_key()
        self.assertIsNone(self.row(key)["last_seen_at"])
        self.activate(key, now=NOW, ip="198.51.100.1")
        self.activate(key, hwid=HWID_B, now=NOW + 60, ip="198.51.100.2")
        row = self.row(key)
        self.assertEqual((row["last_seen_at"], row["last_ip"]), (NOW + 60, "198.51.100.2"))

    def test_concurrent_first_activations_bind_once(self) -> None:
        key = self.new_key()
        barrier = threading.Barrier(2)
        results: dict[str, ks.Status] = {}

        def run(hwid: str) -> None:
            request = ks.parse_activation_request(request_body(key, hwid))
            with closing(ks.open_db(self.db)) as conn:
                barrier.wait()
                results[hwid] = ks.activate(conn, request, now=NOW, ip="127.0.0.1").status

        threads = [threading.Thread(target=run, args=(hwid,)) for hwid in (HWID_A, HWID_B)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(
            sorted(status.value for status in results.values()), ["hwid_mismatch", "ok"]
        )
        winner = next(hwid for hwid, status in results.items() if status is ks.Status.OK)
        self.assertEqual(self.row(key)["hwid"], winner)

    def test_full_key_is_never_stored(self) -> None:
        key = self.new_key(note="customer")
        self.activate(key)
        data = self.db.read_bytes()
        self.assertNotIn(key.encode(), data)
        self.assertNotIn(key[10:].encode(), data)
        self.assertNotIn(key[10:].replace("-", "").encode(), data)
        self.assertIn(ks.hash_key(key).encode(), data)


class PayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.request = ks.ActivationRequest("SCAR-X", HWID_A, NONCE, "3.0.0")

    def test_canonical_bytes(self) -> None:
        result = ks.ActivationResult(ks.Status.OK, 0, "hi")
        self.assertEqual(
            ks.build_payload(self.request, result, NOW),
            b'{"expires_at":0,"hwid":"0123456789ABCDEF0123456789ABCDEF","message":"hi",'
            b'"nonce":"00112233445566778899aabbccddeeff","server_time":1800000000,'
            b'"status":"ok","v":1}',
        )

    def test_non_ascii_is_escaped(self) -> None:
        result = ks.ActivationResult(ks.Status.OK, 0, "café")
        self.assertIn(b'"caf\\u00e9"', ks.build_payload(self.request, result, NOW))

    def test_signature_verifies_with_public_key(self) -> None:
        signing_key = Ed25519PrivateKey.generate()
        payload = ks.build_payload(self.request, ks.ActivationResult(ks.Status.EXPIRED, 5, "x"), NOW)
        response = ks.sign_payload(signing_key, payload)
        self.assertRegex(response["signature"], r"^[0-9a-f]{128}$")
        self.assertEqual(response["payload"], payload.hex())
        public_hex = ks.public_key_hex(signing_key)
        self.assertRegex(public_hex, r"^[0-9a-f]{64}$")
        self.assertEqual(verify_response(public_hex, response)["status"], "expired")

        tampered = payload.replace(b'"expired"', b'"ok"').hex()
        with self.assertRaises(InvalidSignature):
            verify_response(public_hex, {**response, "payload": tampered})
        other_hex = ks.public_key_hex(Ed25519PrivateKey.generate())
        with self.assertRaises(InvalidSignature):
            verify_response(other_hex, response)


class CliTests(DatabaseTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.db.unlink()  # let `init` create it

    def init(self) -> str:
        code, out, _ = self.cli("init", "--url", "https://keys.example.com")
        self.assertEqual(code, 0)
        return re.search(r"Public key:\s+([0-9a-f]{64})", out).group(1)

    def create(self, *args: str) -> list[str]:
        code, out, err = self.cli("create", *args)
        self.assertEqual(code, 0, err)
        return out.split()

    def test_init_creates_key_and_prints_build_flags(self) -> None:
        code, out, _ = self.cli("init", "--url", "https://keys.example.com")
        self.assertEqual(code, 0)
        public_hex = re.search(r"Public key:\s+([0-9a-f]{64})", out).group(1)
        self.assertIn(
            f"-DGTPROXY_LICENSE_SERVER=https://keys.example.com"
            f" -DGTPROXY_LICENSE_PUBLIC_KEY={public_hex}",
            out,
        )
        if os.name == "posix":
            self.assertEqual(self.signing_key_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.cli("pubkey")[1].strip(), public_hex)

    def test_init_refuses_to_overwrite_signing_key(self) -> None:
        public_hex = self.init()
        before = self.signing_key_path.read_bytes()
        code, _, err = self.cli("init")
        self.assertEqual(code, 1)
        self.assertIn("refusing to overwrite", err)
        self.assertEqual(self.signing_key_path.read_bytes(), before)
        self.assertEqual(self.cli("pubkey")[1].strip(), public_hex)

    def test_commands_need_init(self) -> None:
        code, _, err = self.cli("list")
        self.assertEqual(code, 1)
        self.assertIn("run 'init' first", err)
        self.assertFalse(self.db.exists())

    def test_global_options_after_subcommand(self) -> None:
        self.init()
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = ks.main(["create", "--days", "7", "--db", str(self.db)])
        self.assertEqual(code, 0)
        self.assertRegex(out.getvalue().strip(), KEY_PATTERN)

    def test_create_and_list(self) -> None:
        self.init()
        keys = self.create("--days", "30", "--count", "3", "--note", "alice")
        self.assertEqual(len(keys), 3)
        for key in keys:
            self.assertRegex(key, KEY_PATTERN)
        lifetime = self.create("--days", "0")[0]
        self.activate(keys[0])
        self.activate(lifetime)
        self.cli("revoke", keys[2])

        code, out, _ = self.cli("list")
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertTrue(lines[0].startswith("ID"))
        self.assertRegex(lines[1], rf"^1\s+{keys[0][:ks.KEY_DISPLAY_LENGTH]}\s+alice\s+30d\s+active\s+{HWID_A[:8]}\s")
        self.assertRegex(lines[2], rf"^2\s+{keys[1][:ks.KEY_DISPLAY_LENGTH]}\s+alice\s+30d\s+unused\s+-\s+-\s+-$")
        self.assertRegex(lines[3], r"^3\s.*\srevoked\s")
        self.assertRegex(lines[4], r"^4\s.*\slifetime\s+active\s.*\snever$")
        for key in keys:
            self.assertNotIn(key, out)

    def test_create_rejects_bad_arguments(self) -> None:
        self.init()
        for args in (["--days", "-1"], ["--days", "x"], ["--days", "1", "--count", "0"], []):
            with self.subTest(args=args), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    self.cli("create", *args)

    def test_revoke_and_unrevoke_by_id_or_key(self) -> None:
        self.init()
        key = self.create("--days", "30")[0]
        self.assertEqual(self.cli("revoke", "1")[0], 0)
        self.assertEqual(self.activate(key).status, ks.Status.REVOKED)
        self.assertIn("already revoked", self.cli("revoke", key.lower())[1])
        self.assertEqual(self.cli("unrevoke", key)[0], 0)
        self.assertEqual(self.activate(key).status, ks.Status.OK)

    def test_unknown_key_or_id(self) -> None:
        self.init()
        self.create("--days", "30")
        for target in ("99", "SCAR-00000-00000-00000-00000"):
            code, _, err = self.cli("revoke", target)
            self.assertEqual(code, 1)
            self.assertIn("no ", err)

    def test_reset_hwid_allows_new_computer(self) -> None:
        self.init()
        key = self.create("--days", "30")[0]
        self.activate(key, hwid=HWID_A, now=NOW)
        self.assertEqual(self.activate(key, hwid=HWID_B).status, ks.Status.HWID_MISMATCH)
        self.assertEqual(self.cli("reset-hwid", "1")[0], 0)
        result = self.activate(key, hwid=HWID_B, now=NOW + DAY)
        self.assertEqual((result.status, result.expires_at), (ks.Status.OK, NOW + 30 * DAY))

    def test_extend_unused_key_adds_to_duration(self) -> None:
        self.init()
        key = self.create("--days", "30")[0]
        self.assertEqual(self.cli("extend", "1", "--days", "5")[0], 0)
        self.assertEqual(self.activate(key, now=NOW).expires_at, NOW + 35 * DAY)

    def test_extend_active_key_adds_to_expiry(self) -> None:
        self.init()
        key = self.create("--days", "30")[0]
        far_future = 4_000_000_000
        self.activate(key, now=NOW)
        self.set_column(key, "expires_at", far_future)
        self.cli("extend", key, "--days", "10")
        self.assertEqual(self.row(key)["expires_at"], far_future + 10 * DAY)

    def test_extend_expired_key_renews_from_now(self) -> None:
        self.init()
        key = self.create("--days", "1")[0]
        self.activate(key, now=NOW)
        self.set_column(key, "expires_at", 1_000)
        self.assertEqual(self.activate(key).status, ks.Status.EXPIRED)
        self.cli("extend", "1", "--days", "10")
        expires_at = self.row(key)["expires_at"]
        self.assertGreater(expires_at, ks.now_unix() + 10 * DAY - 60)
        self.assertLessEqual(expires_at, ks.now_unix() + 10 * DAY)

    def test_extend_lifetime_key_is_noop(self) -> None:
        self.init()
        key = self.create("--days", "0")[0]
        code, out, _ = self.cli("extend", "1", "--days", "10")
        self.assertEqual(code, 0)
        self.assertIn("lifetime", out)
        self.assertEqual(self.activate(key).expires_at, 0)


class HttpTests(DatabaseTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.signing_key = ks.create_signing_key(self.signing_key_path)
        self.public_hex = ks.public_key_hex(self.signing_key)

    def start_server(self, tls_context: ssl.SSLContext | None = None) -> ks.LicenseServer:
        server = ks.LicenseServer(("127.0.0.1", 0), self.db, self.signing_key, tls_context)
        server.clock = lambda: NOW
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        return server

    def post(
        self,
        server: ks.LicenseServer,
        body: bytes,
        path: str = ks.ACTIVATE_PATH,
        method: str = "POST",
        context: ssl.SSLContext | None = None,
    ) -> tuple[int, dict[str, str]]:
        port = server.server_address[1]
        if context is None:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        else:
            conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=context)
        with closing(conn):
            conn.request(method, path, body=body, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            raw = response.read()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(raw) if raw else {}

    def test_round_trip_and_access_log(self) -> None:
        key = self.new_key(days=30)
        server = self.start_server()
        with self.assertLogs("keyserver", "INFO") as logs:
            status, response = self.post(server, request_body(key, HWID_A.lower()))
        self.assertEqual(status, 200)
        payload = verify_response(self.public_hex, response)
        self.assertEqual(
            payload,
            {
                "v": 1,
                "status": "ok",
                "nonce": NONCE,
                "hwid": HWID_A,
                "expires_at": NOW + 30 * DAY,
                "server_time": NOW,
                "message": ks.ACTIVATED_MESSAGE,
            },
        )
        self.assertEqual(self.row(key)["last_ip"], "127.0.0.1")

        log_text = "\n".join(logs.output)
        self.assertIn(f'"POST {ks.ACTIVATE_PATH}" 200 status=ok key={key[:ks.KEY_DISPLAY_LENGTH]} hwid=01234567', log_text)
        self.assertNotIn(key, log_text)
        self.assertNotIn(key[10:], log_text)

    def test_each_status_is_signed(self) -> None:
        key = self.new_key(days=30)
        server = self.start_server()
        cases = [
            (request_body("SCAR-00000-00000-00000-00000"), "invalid_key"),
            (request_body(key, HWID_A), "ok"),
            (request_body(key, HWID_B), "hwid_mismatch"),
        ]
        for body, expected in cases:
            status, response = self.post(server, body)
            self.assertEqual(status, 200)
            payload = verify_response(self.public_hex, response)
            self.assertEqual(payload["status"], expected)
            self.assertEqual(payload["nonce"], NONCE)

        server.clock = lambda: NOW + 31 * DAY
        payload = verify_response(self.public_hex, self.post(server, request_body(key))[1])
        self.assertEqual((payload["status"], payload["server_time"]), ("expired", NOW + 31 * DAY))
        self.set_column(key, "revoked_at", NOW)
        payload = verify_response(self.public_hex, self.post(server, request_body(key))[1])
        self.assertEqual(payload["status"], "revoked")

    def test_malformed_requests_get_400(self) -> None:
        server = self.start_server()
        for body in (b"not json", request_body("SCAR-1", hwid="xyz"), b"x" * 5000):
            with self.subTest(body=body[:20]):
                status, response = self.post(server, body)
                self.assertEqual(status, 400)
                self.assertEqual(list(response), ["error"])

    def test_other_paths_and_methods_get_404(self) -> None:
        server = self.start_server()
        self.assertEqual(self.post(server, request_body("k"), path="/api/v1/other")[0], 404)
        self.assertEqual(self.post(server, b"", method="GET")[0], 404)
        self.assertEqual(self.post(server, b"", method="GET", path="/")[0], 404)

    def test_database_error_gives_500(self) -> None:
        server = self.start_server()
        self.db.unlink()
        with self.assertLogs("keyserver", "ERROR"):
            status, response = self.post(server, request_body("SCAR-1"))
        self.assertEqual((status, response), (500, {"error": "internal server error"}))

    def test_tls_round_trip(self) -> None:
        cert_path, key_path = self.make_self_signed_cert()
        server = self.start_server(ks.make_tls_context(cert_path, key_path))
        client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        client_context.load_verify_locations(cert_path)
        key = self.new_key()
        status, response = self.post(server, request_body(key), context=client_context)
        self.assertEqual(status, 200)
        self.assertEqual(verify_response(self.public_hex, response)["status"], "ok")

    def make_self_signed_cert(self) -> tuple[Path, Path]:
        private_key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(private_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(
                x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
                critical=False,
            )
            .sign(private_key, hashes.SHA256())
        )
        cert_path, key_path = self.dir / "cert.pem", self.dir / "tls_key.pem"
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(
            private_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        return cert_path, key_path


if __name__ == "__main__":
    unittest.main()
