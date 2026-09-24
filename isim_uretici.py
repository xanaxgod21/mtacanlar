#!/usr/bin/env python3
"""
2 haneli isim uretici + Discord webhook gonderici.

NE YAPAR:
  - Belirledigin karakter kumesinden tum 2 haneli kombinasyonlari uretir.
  - Bunlari senin webhook'una mesaj olarak (Discord mesaj limitine gore
    parcalayip) gonderir. Sen listeye elinle bakarsin.

NE YAPMAZ:
  - Discord'a "bu isim bos mu / alinabilir mi" diye SORMAZ (musaitlik kontrolu YOK).
  - Arka planda calismaz; tek sefer calisir ve biter.
  - Hicbir seyi otomatik almaz / snipe etmez.
"""

import json
import string
import time
import itertools
import urllib.request
import urllib.error

# ----------------- AYARLAR -----------------
WEBHOOK_URL = "BURAYA_WEBHOOK_URL"                  # kendi Discord webhook adresin
LENGTH      = 2                                     # hane sayisi
CHARSET     = string.ascii_lowercase + string.digits  # a-z + 0-9 (istersen degistir)
PER_MESSAGE = 50                                    # her mesajda kac isim olsun
DELAY       = 1.0                                   # mesajlar arasi bekleme (sn)
# -------------------------------------------


def generate(charset, length):
    for combo in itertools.product(charset, repeat=length):
        yield "".join(combo)


def send(webhook_url, content):
    data = json.dumps({"content": content}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        # 429 = rate limit -> retry_after kadar bekleyip tekrar dene
        if e.code == 429:
            try:
                info = json.loads(e.read().decode("utf-8"))
                wait = float(info.get("retry_after", 2))
            except Exception:
                wait = 2.0
            time.sleep(wait)
            return send(webhook_url, content)
        raise


def main():
    if "BURAYA" in WEBHOOK_URL:
        print("Once WEBHOOK_URL'i kendi webhook adresinle degistir.")
        return

    names = list(generate(CHARSET, LENGTH))
    print(f"{len(names)} adet {LENGTH} haneli isim uretildi, webhook'a gonderiliyor...")

    for i in range(0, len(names), PER_MESSAGE):
        chunk = names[i:i + PER_MESSAGE]
        content = " ".join(f"`{n}`" for n in chunk)
        send(WEBHOOK_URL, content)
        print(f"  {i + len(chunk)}/{len(names)} gonderildi")
        time.sleep(DELAY)

    print("Bitti.")


if __name__ == "__main__":
    main()
