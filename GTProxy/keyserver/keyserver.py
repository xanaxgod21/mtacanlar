#!/usr/bin/env python3
"""Scarface Proxy license key server.

Creates license keys, binds each key to the first computer (HWID) that
activates it, and answers activation requests with Ed25519-signed responses.

Only SHA-256 hashes of keys are stored. The full key is printed once, by
``create``, and is never logged.

Run ``python3 keyserver.py --help`` for the commands.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import ssl
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

log = logging.getLogger("keyserver")

PROTOCOL_VERSION = 1
ACTIVATE_PATH = "/api/v1/activate"
MAX_BODY_BYTES = 4096
MAX_DRAIN_BYTES = 64 * 1024
MAX_KEY_LENGTH = 64
MAX_CLIENT_VERSION_LENGTH = 64
SECONDS_PER_DAY = 86_400
MAX_DAYS = 36_500

KEY_PREFIX = "SCAR-"
KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32
KEY_GROUPS = 4
KEY_GROUP_LENGTH = 5
KEY_DISPLAY_LENGTH = len(KEY_PREFIX) + KEY_GROUP_LENGTH  # "SCAR-XXXXX"

SCHEMA_VERSION = 1
DEFAULT_DB = Path("keys.db")
DEFAULT_SIGNING_KEY = Path("signing_key.pem")

_HEX32 = re.compile(r"[0-9a-fA-F]{32}")
_DIGITS = re.compile(r"[0-9]+")


class KeyServerError(Exception):
    """An operator-facing error: the CLI prints it and exits with status 1."""


class RequestError(ValueError):
    """A malformed activation request, answered with HTTP 400."""


class Status(Enum):
    OK = "ok"
    INVALID_KEY = "invalid_key"
    REVOKED = "revoked"
    EXPIRED = "expired"
    HWID_MISMATCH = "hwid_mismatch"


STATUS_MESSAGES: dict[Status, str] = {
    Status.OK: "License is valid.",
    Status.INVALID_KEY: "License key not found.",
    Status.REVOKED: "This license key has been revoked.",
    Status.EXPIRED: "This license key has expired.",
    Status.HWID_MISMATCH: "This license key is already activated on another computer.",
}
ACTIVATED_MESSAGE = "License activated on this computer."


@dataclass(frozen=True)
class ActivationRequest:
    key: str  # normalized
    hwid: str  # uppercase
    nonce: str  # echoed back verbatim
    client_version: str


@dataclass(frozen=True)
class ActivationResult:
    status: Status
    expires_at: int  # unix seconds, 0 = never
    message: str


def now_unix() -> int:
    return int(time.time())


# --- Keys --------------------------------------------------------------------


def generate_key() -> str:
    """Return a new key: ``SCAR-`` plus 4 groups of 5 Crockford base32 symbols (100 random bits)."""
    symbol_count = KEY_GROUPS * KEY_GROUP_LENGTH
    bits = secrets.randbits(5 * symbol_count)
    symbols = "".join(KEY_ALPHABET[(bits >> (5 * i)) & 0x1F] for i in range(symbol_count))
    groups = [symbols[i : i + KEY_GROUP_LENGTH] for i in range(0, symbol_count, KEY_GROUP_LENGTH)]
    return KEY_PREFIX + "-".join(groups)


def normalize_key(raw: str) -> str:
    """Remove all whitespace and uppercase (client and server both do this)."""
    return "".join(raw.split()).upper()


def hash_key(normalized_key: str) -> str:
    return hashlib.sha256(normalized_key.encode("utf-8")).hexdigest()


def display_prefix(normalized_key: str) -> str:
    return normalized_key[:KEY_DISPLAY_LENGTH]


# --- Signing key -------------------------------------------------------------


def create_signing_key(path: Path) -> Ed25519PrivateKey:
    """Generate an Ed25519 key and write it as PEM PKCS8 with mode 0600. Never overwrites."""
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        raise KeyServerError(f"signing key {path} already exists; refusing to overwrite it") from None
    with os.fdopen(fd, "wb") as file:
        file.write(pem)
    return key


def load_signing_key(path: Path) -> Ed25519PrivateKey:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise KeyServerError(f"signing key {path} not found (run 'init' first)") from None
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except (ValueError, TypeError, UnsupportedAlgorithm) as exc:
        raise KeyServerError(f"cannot load signing key {path}: {exc}") from None
    if not isinstance(key, Ed25519PrivateKey):
        raise KeyServerError(f"signing key {path} is not an Ed25519 key")
    if os.name == "posix" and path.stat().st_mode & 0o077:
        log.warning("signing key %s is accessible by other users; run: chmod 600 %s", path, path)
    return key


def public_key_hex(signing_key: Ed25519PrivateKey) -> str:
    raw = signing_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return raw.hex()


# --- Database ----------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash      TEXT    NOT NULL UNIQUE,  -- SHA-256 hex of the normalized key
    prefix        TEXT    NOT NULL,         -- "SCAR-XXXXX", display only
    note          TEXT    NOT NULL DEFAULT '',
    duration_days INTEGER NOT NULL CHECK (duration_days >= 0),  -- 0 = lifetime
    created_at    INTEGER NOT NULL,
    hwid          TEXT,                     -- uppercase hex, NULL = not bound
    activated_at  INTEGER,                  -- first activation, NULL = unused
    expires_at    INTEGER,                  -- 0 = never, NULL until first activation
    revoked_at    INTEGER,                  -- NULL = not revoked
    last_seen_at  INTEGER,
    last_ip       TEXT
)
"""


def open_db(path: Path, *, create: bool = False) -> sqlite3.Connection:
    """Open the key database in autocommit mode; use ``transaction()`` for writes."""
    if not create and not path.exists():
        raise KeyServerError(f"database {path} not found (run 'init' first)")
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    if not create:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version != SCHEMA_VERSION:
            conn.close()
            raise KeyServerError(f"{path} is not a key database (schema version {version})")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Run the block in one write transaction, taking the write lock up front."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def init_schema(conn: sqlite3.Connection) -> None:
    with transaction(conn):
        conn.execute(SCHEMA)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def create_keys(
    conn: sqlite3.Connection, *, days: int, count: int, note: str, now: int
) -> list[str]:
    """Insert ``count`` new keys and return them; this is the only time full keys exist."""
    keys = [generate_key() for _ in range(count)]
    with transaction(conn):
        conn.executemany(
            "INSERT INTO keys (key_hash, prefix, note, duration_days, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            [(hash_key(key), display_prefix(key), note, days, now) for key in keys],
        )
    return keys


def find_key(conn: sqlite3.Connection, key_or_id: str) -> sqlite3.Row:
    """Look up a key by row id (all digits) or by the full key."""
    text = key_or_id.strip()
    if _DIGITS.fullmatch(text):
        row = conn.execute("SELECT * FROM keys WHERE id = ?", (int(text),)).fetchone()
        missing = f"no key with id {text}"
    else:
        row = conn.execute(
            "SELECT * FROM keys WHERE key_hash = ?", (hash_key(normalize_key(text)),)
        ).fetchone()
        missing = "no such key"
    if row is None:
        raise KeyServerError(missing)
    return row


def key_status(row: sqlite3.Row, now: int) -> str:
    """Admin view of a key: unused, active, expired or revoked."""
    if row["revoked_at"] is not None:
        return "revoked"
    if row["activated_at"] is None:
        return "unused"
    if row["expires_at"] != 0 and now >= row["expires_at"]:
        return "expired"
    return "active"


# --- Activation --------------------------------------------------------------


def parse_activation_request(body: bytes) -> ActivationRequest:
    """Validate a request body; raises RequestError for anything malformed."""
    if len(body) > MAX_BODY_BYTES:
        raise RequestError("request body too large")
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise RequestError("body is not valid JSON") from None
    if not isinstance(data, dict):
        raise RequestError("body must be a JSON object")

    key, hwid, nonce, client_version = (
        _require_string(data, name) for name in ("key", "hwid", "nonce", "client_version")
    )
    if len(key) > MAX_KEY_LENGTH:
        raise RequestError(f"key is longer than {MAX_KEY_LENGTH} characters")
    normalized_key = normalize_key(key)
    if not normalized_key:
        raise RequestError("key is empty")
    if not _HEX32.fullmatch(hwid):
        raise RequestError("hwid must be 32 hex characters")
    if not _HEX32.fullmatch(nonce):
        raise RequestError("nonce must be 32 hex characters")
    if not 0 < len(client_version) <= MAX_CLIENT_VERSION_LENGTH:
        raise RequestError(f"client_version must be 1-{MAX_CLIENT_VERSION_LENGTH} characters")
    return ActivationRequest(normalized_key, hwid.upper(), nonce, client_version)


def _require_string(data: dict[str, object], name: str) -> str:
    value = data.get(name)
    if value is None:
        raise RequestError(f"missing field: {name}")
    if not isinstance(value, str):
        raise RequestError(f"field {name} must be a string")
    return value


def activate(
    conn: sqlite3.Connection, request: ActivationRequest, *, now: int, ip: str
) -> ActivationResult:
    """Look up, bind and check a key in a single transaction."""
    with transaction(conn):
        row = conn.execute(
            "SELECT id, duration_days, hwid, activated_at, expires_at, revoked_at"
            " FROM keys WHERE key_hash = ?",
            (hash_key(request.key),),
        ).fetchone()
        if row is None:
            return _result(Status.INVALID_KEY, 0)

        key_id = row["id"]
        conn.execute(
            "UPDATE keys SET last_seen_at = ?, last_ip = ? WHERE id = ?", (now, ip, key_id)
        )
        expires_at = row["expires_at"] or 0
        if row["revoked_at"] is not None:
            return _result(Status.REVOKED, expires_at)

        bound_hwid = row["hwid"]
        newly_bound = bound_hwid is None
        if newly_bound:
            bound_hwid = request.hwid
            if row["activated_at"] is None:
                expires_at = _expiry(row["duration_days"], now)
                conn.execute(
                    "UPDATE keys SET hwid = ?, activated_at = ?, expires_at = ? WHERE id = ?",
                    (bound_hwid, now, expires_at, key_id),
                )
            else:
                # Re-bound after reset-hwid: the clock started at the first activation.
                conn.execute("UPDATE keys SET hwid = ? WHERE id = ?", (bound_hwid, key_id))

        if bound_hwid != request.hwid:
            return _result(Status.HWID_MISMATCH, expires_at)
        if expires_at != 0 and now >= expires_at:
            return _result(Status.EXPIRED, expires_at)
        return _result(Status.OK, expires_at, ACTIVATED_MESSAGE if newly_bound else None)


def _expiry(duration_days: int, start: int) -> int:
    return 0 if duration_days == 0 else start + duration_days * SECONDS_PER_DAY


def _result(status: Status, expires_at: int, message: str | None = None) -> ActivationResult:
    return ActivationResult(status, expires_at, message or STATUS_MESSAGES[status])


def encode_payload(fields: dict[str, object]) -> bytes:
    """Canonical payload bytes: compact, sorted keys, ASCII-only JSON."""
    return json.dumps(fields, separators=(",", ":"), sort_keys=True, ensure_ascii=True).encode(
        "utf-8"
    )


def build_payload(request: ActivationRequest, result: ActivationResult, server_time: int) -> bytes:
    return encode_payload(
        {
            "v": PROTOCOL_VERSION,
            "status": result.status.value,
            "nonce": request.nonce,
            "hwid": request.hwid,
            "expires_at": result.expires_at,
            "server_time": server_time,
            "message": result.message,
        }
    )


def sign_payload(signing_key: Ed25519PrivateKey, payload: bytes) -> dict[str, str]:
    return {"payload": payload.hex(), "signature": signing_key.sign(payload).hex()}


# --- HTTP server -------------------------------------------------------------


class LicenseServer(ThreadingHTTPServer):
    """Answers ``POST /api/v1/activate`` from one key database."""

    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        db_path: Path,
        signing_key: Ed25519PrivateKey,
        tls_context: ssl.SSLContext | None = None,
    ) -> None:
        super().__init__(address, ActivationHandler)
        self.db_path = db_path
        self.signing_key = signing_key
        self.clock: Callable[[], int] = now_unix
        if tls_context is not None:
            # The handshake runs in the handler thread (under its timeout), not in accept().
            self.socket = tls_context.wrap_socket(
                self.socket, server_side=True, do_handshake_on_connect=False
            )

    def process(
        self, request: ActivationRequest, ip: str
    ) -> tuple[ActivationResult, dict[str, str]]:
        now = self.clock()
        with closing(open_db(self.db_path)) as conn:
            result = activate(conn, request, now=now, ip=ip)
        return result, sign_payload(self.signing_key, build_payload(request, result, now))

    def handle_error(self, request: object, client_address: tuple[str, int]) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, OSError):
            log.warning("%s connection error: %s", client_address[0], exc)
        else:
            log.exception("%s unhandled error", client_address[0])


class ActivationHandler(BaseHTTPRequestHandler):
    server: LicenseServer
    server_version = "ScarfaceKeyServer/1"
    sys_version = ""
    timeout = 10  # seconds per socket operation, including the TLS handshake
    _log_detail = ""

    def handle(self) -> None:
        if isinstance(self.connection, ssl.SSLSocket):
            try:
                self.connection.do_handshake()
            except (ssl.SSLError, OSError) as exc:
                log.warning("%s TLS handshake failed: %s", self.client_address[0], exc)
                return
        super().handle()

    def do_POST(self) -> None:
        self._log_detail = ""
        if urlsplit(self.path).path != ACTIVATE_PATH:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            request = parse_activation_request(self._read_body())
        except RequestError as exc:
            self._log_detail = f'error="{exc}"'
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        try:
            result, response = self.server.process(request, self.client_address[0])
        except Exception:
            log.exception("activation failed")
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal server error"})
            return
        self._log_detail = (
            f"status={result.status.value} key={_printable(display_prefix(request.key))}"
            f" hwid={request.hwid[:8]} client={_printable(request.client_version)}"
        )
        self._send_json(HTTPStatus.OK, response)

    def _not_found(self) -> None:
        self._log_detail = ""
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    do_GET = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_found

    def _read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding"):
            raise RequestError("chunked request bodies are not supported")
        raw_length = (self.headers.get("Content-Length") or "").strip()
        if not _DIGITS.fullmatch(raw_length):
            raise RequestError("missing or invalid Content-Length")
        length = int(raw_length)
        if length > MAX_BODY_BYTES:
            if length <= MAX_DRAIN_BYTES:
                # Read it anyway so the client sees the 400 rather than a reset connection.
                self.rfile.read(length)
            raise RequestError("request body too large")
        body = self.rfile.read(length)
        if len(body) < length:
            raise RequestError("incomplete request body")
        return body

    def _send_json(self, status: HTTPStatus, body_obj: dict[str, str]) -> None:
        body = json.dumps(body_obj, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        """One access log line per response. Never contains the full key or the query string."""
        if isinstance(code, HTTPStatus):
            code = code.value
        method = getattr(self, "command", None) or "-"
        raw_path = getattr(self, "path", None)
        path = _printable(urlsplit(raw_path).path, 100) if raw_path else "-"
        detail = f" {self._log_detail}" if self._log_detail else ""
        log.info('%s "%s %s" %s%s', self.client_address[0], method, path, code, detail)

    def log_message(self, format: str, *args: object) -> None:
        log.warning("%s %s", self.client_address[0], _printable(format % args, 200))


def _printable(text: str, limit: int = 64) -> str:
    """Make client-supplied text safe for a single log line."""
    return "".join(ch if " " <= ch <= "~" and ch != '"' else "?" for ch in text[:limit])


def make_tls_context(cert_file: Path, key_file: Path) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.load_cert_chain(cert_file, key_file)
    except (OSError, ssl.SSLError) as exc:
        raise KeyServerError(f"cannot load TLS certificate/key: {exc}") from None
    return context


# --- CLI ---------------------------------------------------------------------


def cmd_init(args: argparse.Namespace) -> int:
    if args.signing_key.exists():
        raise KeyServerError(
            f"signing key {args.signing_key} already exists; refusing to overwrite it"
            " (use 'pubkey' to print its public key)"
        )
    with closing(open_db(args.db, create=True)) as conn:
        init_schema(conn)
    public_hex = public_key_hex(create_signing_key(args.signing_key))
    print(f"Database:    {args.db}")
    print(f"Signing key: {args.signing_key} (keep it secret and back it up)")
    print(f"Public key:  {public_hex}")
    print()
    print("Build Scarface Proxy with:")
    print(
        f"  -DGTPROXY_LICENSE_SERVER={args.url or '<url>'}"
        f" -DGTPROXY_LICENSE_PUBLIC_KEY={public_hex}"
    )
    return 0


def cmd_pubkey(args: argparse.Namespace) -> int:
    print(public_key_hex(load_signing_key(args.signing_key)))
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    with closing(open_db(args.db)) as conn:
        keys = create_keys(conn, days=args.days, count=args.count, note=args.note, now=now_unix())
    for key in keys:
        print(key)
    print(
        f"Created {len(keys)} key(s), duration {_format_duration(args.days)}."
        " Keys are shown only once; store them now.",
        file=sys.stderr,
    )
    return 0


LIST_HEADERS = (
    "ID", "PREFIX", "NOTE", "DURATION", "STATUS", "HWID", "ACTIVATED (UTC)", "EXPIRES (UTC)",
)


def cmd_list(args: argparse.Namespace) -> int:
    with closing(open_db(args.db)) as conn:
        rows = conn.execute("SELECT * FROM keys ORDER BY id").fetchall()
    if not rows:
        print("No keys.")
        return 0
    now = now_unix()
    table = [
        (
            str(row["id"]),
            row["prefix"],
            " ".join(row["note"].split()),
            _format_duration(row["duration_days"]),
            key_status(row, now),
            (row["hwid"] or "-")[:8],
            _format_time(row["activated_at"]),
            _format_expiry(row),
        )
        for row in rows
    ]
    print(_format_table(LIST_HEADERS, table))
    return 0


KeyAction = Callable[[sqlite3.Connection, sqlite3.Row, int], str]


def run_key_action(args: argparse.Namespace, action: KeyAction) -> int:
    """Find KEY_OR_ID and apply ``action`` to it in one transaction."""
    with closing(open_db(args.db)) as conn:
        with transaction(conn):
            row = find_key(conn, args.key_or_id)
            message = action(conn, row, now_unix())
    print(message)
    return 0


def revoke_key(conn: sqlite3.Connection, row: sqlite3.Row, now: int) -> str:
    if row["revoked_at"] is not None:
        return f"Key {_label(row)} is already revoked."
    conn.execute("UPDATE keys SET revoked_at = ? WHERE id = ?", (now, row["id"]))
    return f"Revoked key {_label(row)}."


def unrevoke_key(conn: sqlite3.Connection, row: sqlite3.Row, now: int) -> str:
    if row["revoked_at"] is None:
        return f"Key {_label(row)} is not revoked."
    conn.execute("UPDATE keys SET revoked_at = NULL WHERE id = ?", (row["id"],))
    return f"Unrevoked key {_label(row)}."


def reset_key_hwid(conn: sqlite3.Connection, row: sqlite3.Row, now: int) -> str:
    if row["hwid"] is None:
        return f"Key {_label(row)} is not bound to a computer."
    conn.execute("UPDATE keys SET hwid = NULL WHERE id = ?", (row["id"],))
    return (
        f"Cleared the HWID of key {_label(row)}; the next computer to activate it is bound."
        " The expiry date is unchanged."
    )


def extend_key(conn: sqlite3.Connection, row: sqlite3.Row, now: int, *, days: int) -> str:
    """Unused key: add to its duration. Activated key: push expires_at out by ``days``."""
    if row["duration_days"] == 0:
        return f"Key {_label(row)} is a lifetime key; nothing to extend."
    if row["activated_at"] is None:
        duration = row["duration_days"] + days
        conn.execute("UPDATE keys SET duration_days = ? WHERE id = ?", (duration, row["id"]))
        return f"Key {_label(row)} now lasts {duration} days from its first activation."
    # An expired key is renewed from now, so it gets the full extension.
    expires_at = max(row["expires_at"], now) + days * SECONDS_PER_DAY
    conn.execute("UPDATE keys SET expires_at = ? WHERE id = ?", (expires_at, row["id"]))
    return f"Key {_label(row)} now expires {_format_time(expires_at)} UTC."


def cmd_extend(args: argparse.Namespace) -> int:
    return run_key_action(args, partial(extend_key, days=args.days))


def cmd_serve(args: argparse.Namespace) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if (args.tls_cert is None) != (args.tls_key is None):
        raise KeyServerError("--tls-cert and --tls-key must be given together")
    signing_key = load_signing_key(args.signing_key)
    open_db(args.db).close()  # fail fast on a missing or foreign database
    tls_context = make_tls_context(args.tls_cert, args.tls_key) if args.tls_cert else None
    try:
        server = LicenseServer((args.host, args.port), args.db, signing_key, tls_context)
    except OSError as exc:
        raise KeyServerError(f"cannot listen on {args.host}:{args.port}: {exc}") from None

    host, port = server.server_address[:2]
    scheme = "https" if tls_context else "http"
    log.info("Serving %s://%s:%d%s", scheme, host, port, ACTIVATE_PATH)
    if tls_context is None and not ipaddress.ip_address(host).is_loopback:
        log.warning(
            "Serving plain HTTP on a public address: license keys travel unencrypted. "
            "Put the server behind HTTPS (e.g. Caddy) or pass --tls-cert/--tls-key."
        )
    log.info("Public key %s", public_key_hex(signing_key))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        server.server_close()
    return 0


def _label(row: sqlite3.Row) -> str:
    return f"#{row['id']} ({row['prefix']})"


def _format_duration(days: int) -> str:
    return "lifetime" if days == 0 else f"{days}d"


def _format_time(timestamp: int | None) -> str:
    if timestamp is None:
        return "-"
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def _format_expiry(row: sqlite3.Row) -> str:
    if row["activated_at"] is None:
        return "-"
    return "never" if row["expires_at"] == 0 else _format_time(row["expires_at"])


def _format_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    widths = [max([len(header), *(len(row[i]) for row in rows)]) for i, header in enumerate(headers)]
    lines = (headers, *rows)
    return "\n".join(
        "  ".join(cell.ljust(width) for cell, width in zip(line, widths)).rstrip()
        for line in lines
    )


def _int_in_range(low: int, high: int) -> Callable[[str], int]:
    def parse(text: str) -> int:
        try:
            value = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"invalid integer: {text!r}") from None
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(f"must be between {low} and {high}")
        return value

    return parse


def _add_global_options(parser: argparse.ArgumentParser, *, with_defaults: bool) -> None:
    """--db and --signing-key work both before and after the subcommand."""
    parser.add_argument(
        "--db",
        type=Path,
        metavar="FILE",
        default=DEFAULT_DB if with_defaults else argparse.SUPPRESS,
        help=f"SQLite key database (default: {DEFAULT_DB})",
    )
    parser.add_argument(
        "--signing-key",
        type=Path,
        metavar="FILE",
        default=DEFAULT_SIGNING_KEY if with_defaults else argparse.SUPPRESS,
        help=f"Ed25519 private key, PEM PKCS8 (default: {DEFAULT_SIGNING_KEY})",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="keyserver.py", description="Scarface Proxy license key server.")
    _add_global_options(parser, with_defaults=True)
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    def command(name: str, handler: Callable[[argparse.Namespace], int], help: str):
        sub = commands.add_parser(name, help=help, description=help)
        _add_global_options(sub, with_defaults=False)
        sub.set_defaults(handler=handler)
        return sub

    def key_command(name: str, action: KeyAction, help: str):
        sub = command(name, partial(run_key_action, action=action), help)
        sub.add_argument("key_or_id", metavar="KEY_OR_ID", help="row id (all digits) or full key")
        return sub

    days = _int_in_range(0, MAX_DAYS)

    init = command("init", cmd_init, "create the database and the signing key")
    init.add_argument("--url", help="server URL to show in the printed CMake flags")
    command("pubkey", cmd_pubkey, "print the public key (64 hex chars)")

    create = command("create", cmd_create, "create keys and print them (shown only once)")
    create.add_argument("--days", type=days, required=True, help="validity in days, 0 = lifetime")
    create.add_argument("--count", type=_int_in_range(1, 1000), default=1, help="default: 1")
    create.add_argument("--note", default="", help="free text, e.g. the customer")

    command("list", cmd_list, "list all keys")
    key_command("revoke", revoke_key, "revoke a key")
    key_command("unrevoke", unrevoke_key, "undo a revoke")
    key_command("reset-hwid", reset_key_hwid, "unbind a key from its computer")
    extend = command("extend", cmd_extend, "extend an active key, or the duration of an unused one")
    extend.add_argument("key_or_id", metavar="KEY_OR_ID", help="row id (all digits) or full key")
    extend.add_argument("--days", type=_int_in_range(1, MAX_DAYS), required=True)

    serve = command("serve", cmd_serve, f"serve POST {ACTIVATE_PATH}")
    serve.add_argument("--host", default="0.0.0.0", help="default: 0.0.0.0")
    serve.add_argument("--port", type=_int_in_range(0, 65535), default=8080, help="default: 8080")
    serve.add_argument("--tls-cert", type=Path, metavar="FILE", help="PEM certificate chain")
    serve.add_argument("--tls-key", type=Path, metavar="FILE", help="PEM private key")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.handler(args)
    except KeyServerError as exc:
        print(f"error: {exc}", file=sys.stderr)
    except sqlite3.Error as exc:
        print(f"error: database: {exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
