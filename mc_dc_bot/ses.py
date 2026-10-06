# Sesli komut -> Yaren (yapay zeka beyni)
# Kurulum: pip install SpeechRecognition pyaudio pyttsx3
# Önce gorevbot.js'i başlat (/baslat), sonra: python ses.py
# Not: Ses tanıma için internet gerekir (Google tanıma servisi kullanılır).
#
# Kullanım:
#   "Yaren"                     -> "Efendim" der, sonraki cümleni bekler
#   "Yaren biraz odun lazım"    -> cümle yapay zekaya gider, cevabı sesli okunur
#   Cevaptan sonra 8 saniye boyunca "Yaren" demeden devam edebilirsin.
#
# Yapay zeka anahtarı girilmemişse eski anahtar kelime moduna döner
# (oduncu, farm, taş, gel, görev iptal ...).

import json
import urllib.error
import urllib.request

import pyttsx3
import speech_recognition as sr

URL_SOYLE = "http://127.0.0.1:3030/soyle"
URL_KOMUT = "http://127.0.0.1:3030/komut"
DIL = "tr-TR"
KOMUT_BEKLEME_SANIYE = 8

# Tanıma bazen "Yaren"i farklı yazabilir; yanlış duyulanları buraya ekle.
UYANDIRMA = ["yaren", "yeren", "yaran", "yarren", "yarem"]

# Yapay zeka kapalıyken kullanılan sabit komutlar
# (komut, anahtar kelimeler, söylenecek cevaplar, cevaptan sonra yeni komut beklensin mi)
# Sıra önemli: "durum", "dur"dan önce kontrol edilir.
KOMUTLAR = [
    ("durum", ["durum", "ne yapıyorsun"], ["Yaparım tamam"], False),
    ("dur", ["görev iptal", "iptal", "dur", "bekle", "yeter"], ["Tamam", "Emrin"], True),
    ("odun", ["oduncu", "odun", "ağaç"], ["Yaparım tamam"], False),
    ("farm", ["farm", "çiftçi", "ürün", "ekin", "hasat"], ["Yaparım tamam"], False),
    ("tas", ["taş", "madenci"], ["Yaparım tamam"], False),
    ("gel", ["gel"], ["Yaparım tamam"], False),
    ("otonom", ["otonom", "kendi başına"], ["Yaparım tamam"], False),
]

tts = pyttsx3.init()

# Türkçe bir Windows sesi kuruluysa onu seç (Ayarlar > Zaman ve dil > Konuşma)
for v in tts.getProperty("voices"):
    ad = (str(v.name) + " " + str(v.id)).lower()
    if any(k in ad for k in ["turkish", "türkçe", "tolga", "filiz", "tr-tr", "tr_tr"]):
        tts.setProperty("voice", v.id)
        break


def konus(metin):
    print("[yaren]", metin)
    tts.say(metin)
    tts.runAndWait()


def uyandirma_var(metin):
    kelimeler = metin.split()
    return any(k.startswith(u) for k in kelimeler for u in UYANDIRMA)


def uyandirma_sil(metin):
    kelimeler = metin.split()
    for i, k in enumerate(kelimeler):
        if any(k.startswith(u) for u in UYANDIRMA):
            return " ".join(kelimeler[:i] + kelimeler[i + 1:])
    return metin


def komut_bul(metin):
    kelimeler = metin.split()
    for komut, anahtarlar, cevaplar, devam in KOMUTLAR:
        for a in anahtarlar:
            if " " in a:
                eslesti = a in metin
            else:
                eslesti = any(k.startswith(a) for k in kelimeler)
            if eslesti:
                return komut, cevaplar, devam
    return None


def post(url, veri, zaman_asimi):
    istek = urllib.request.Request(
        url,
        data=json.dumps(veri).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(istek, timeout=zaman_asimi) as r:
        return r.read().decode("utf-8")


def anahtar_kelime_modu(metin):
    """Yapay zeka kapalıyken: eski sabit komutlar. Yeni komut beklensin mi döner."""
    sonuc = komut_bul(metin)
    if not sonuc:
        konus("Anlamadım")
        return False
    komut, cevaplar, devam = sonuc
    try:
        post(URL_KOMUT, {"komut": komut}, 5)
    except Exception:
        konus("Bota ulaşamadım")
        return False
    for c in cevaplar:
        konus(c)
    return devam


def cevapla(metin):
    """Cümleyi Yaren'e gönderir, cevabı okur. Dinlemeye devam edilsin mi döner."""
    try:
        yanit = json.loads(post(URL_SOYLE, {"metin": metin}, 60))
        konus(yanit.get("cevap") or "Tamam")
        return True  # sohbet sürsün, 8 saniye daha dinle
    except urllib.error.HTTPError as e:
        if e.code == 503:  # yapay zeka anahtarı yok
            return anahtar_kelime_modu(metin)
        konus("Bir sorun oldu")
        return False
    except Exception:
        konus("Bota ulaşamadım")
        return False


def main():
    r = sr.Recognizer()
    mik = sr.Microphone()
    with mik as kaynak:
        r.adjust_for_ambient_noise(kaynak, duration=1)
    print("Hazır. Seslenmek için: Yaren")

    komut_modu = False  # True iken uyandırma kelimesi gerekmez

    while True:
        with mik as kaynak:
            print("Dinliyorum..." + (" (devam edebilirsin)" if komut_modu else ""))
            try:
                ses = r.listen(
                    kaynak,
                    timeout=KOMUT_BEKLEME_SANIYE if komut_modu else None,
                    phrase_time_limit=8,
                )
            except sr.WaitTimeoutError:
                komut_modu = False
                continue

        try:
            metin = r.recognize_google(ses, language=DIL).lower()
        except sr.UnknownValueError:
            continue
        except sr.RequestError as e:
            print("Tanıma servisi hatası:", e)
            continue

        print("Duyduğum:", metin)

        if not komut_modu:
            if not uyandirma_var(metin):
                continue
            kalan = uyandirma_sil(metin).strip()
            if not kalan:
                konus("Efendim")
                komut_modu = True
                continue
        else:
            kalan = metin

        komut_modu = cevapla(kalan)


if __name__ == "__main__":
    main()
