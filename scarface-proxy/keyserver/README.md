# Scarface Proxy key server

License server for Scarface Proxy. Each key is locked to the first computer (HWID) that
activates it and has its own duration (N days, or lifetime), which starts at that
first activation. Responses are signed with Ed25519; the proxy has the public key
compiled in, so it only trusts this server.

Requires Python 3.10+ and `cryptography`.

## Setup

```sh
cd keyserver
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python3 keyserver.py init --url https://keys.example.com
```

`init` creates `keys.db` and `signing_key.pem` (mode 0600) and prints the public key
plus the CMake flags for the proxy. It refuses to overwrite an existing signing key.
**Back up `signing_key.pem` and keep it secret.** If you lose it, every proxy build
must be rebuilt with a new key; if it leaks, anyone can sign "valid" responses.
`python3 keyserver.py pubkey` prints the public key again.

Use `--db FILE` / `--signing-key FILE` with any command to use other paths.

## Keys

```sh
python3 keyserver.py create --days 30 --count 5 --note "alice"   # 30-day keys
python3 keyserver.py create --days 0                              # lifetime key
python3 keyserver.py list
```

Keys look like `SCAR-7K3QF-M2X9A-PQ4RT-ZZ81C`. `create` is the only time a full key
is shown: the database stores only its SHA-256 hash and the `SCAR-XXXXX` prefix.

Managing keys (`KEY_OR_ID` is the id from `list` or the full key):

| Command | Effect |
| --- | --- |
| `revoke KEY_OR_ID` / `unrevoke KEY_OR_ID` | Block / unblock the key. |
| `reset-hwid KEY_OR_ID` | Unbind the key; the next computer that activates it is bound. The expiry date is kept. |
| `extend KEY_OR_ID --days N` | Unused key: adds N days to its duration. Activated key: moves the expiry N days later (an expired key gets N days from now). Lifetime keys are left alone. |

## Running

```sh
python3 keyserver.py serve --host 127.0.0.1 --port 8080
```

The only endpoint is `POST /api/v1/activate`; everything else is a 404. One access
log line is written per request, with the key prefix only.

Run it behind HTTPS. Easiest is a reverse proxy such as Caddy, which gets a
certificate automatically:

```
keys.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

(Behind a reverse proxy the stored `last_ip` is the proxy's address.)
Or let the server terminate TLS itself:

```sh
python3 keyserver.py serve --port 443 --tls-cert fullchain.pem --tls-key privkey.pem
```

The proxy verifies the server certificate, so it must be valid for the hostname
(a self-signed certificate will not work).

## Building the proxy

Pass the URL (no path) and the public key printed by `init`:

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release \
    -DGTPROXY_LICENSE_SERVER=https://keys.example.com \
    -DGTPROXY_LICENSE_PUBLIC_KEY=<64 hex chars>
cmake --build build --config Release
```

Without both flags the proxy is built with licensing disabled.

## Protocol

Request: `{"key", "hwid" (32 hex), "nonce" (32 hex), "client_version"}`, at most 4 KiB.
Malformed requests get HTTP 400 `{"error": "..."}`. Otherwise HTTP 200
`{"payload": hex, "signature": hex}`, where the signature is Ed25519 over the payload
bytes, the canonical JSON of
`{v, status, nonce, hwid, expires_at, server_time, message}` (sorted keys, no spaces).
`status` is `ok`, `invalid_key`, `revoked`, `expired` or `hwid_mismatch`;
`expires_at` is unix seconds, `0` = never.

## Tests

```sh
python3 -m unittest discover -s keyserver -v
```
