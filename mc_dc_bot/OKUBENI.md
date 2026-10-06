# MC DC BOT (Yaren)

Minecraft'ta odun kesen, taş kıran, tarla toplayan bir NPC (Yaren) ve onu
yöneten Discord botu. Yapay zeka (Claude) ile Türkçe konuşur, istersen kendi
kararını kendisi verir, mikrofondan sesli komut alır.

## Kurulum

1. Node.js 18 veya üstü kur. Bu klasörde: `npm install`
2. `ayarlar.ornek.json` dosyasını **`ayarlar.json`** adıyla kopyala ve doldur:
   - `discord_token`: Developer Portal > Bot > Reset Token
   - `anthropic_api_key`: console.anthropic.com'dan aldığın anahtar
     (boş bırakırsan yapay zeka kapalı çalışır, `!komutlar` yine çalışır)
   - Kanal ve kullanıcı ID'leri zaten dolu, değiştiysen düzelt.
3. `node discordbot.js` (ya da `npm start`)
4. Discord kontrol kanalında: `/baslat host:sunucu.adresi`

`ayarlar.json`, `anahtar.txt` ve `deneyim.json` git'e girmez. **Token ve
anahtarı asla kodun içine yazma**; kodu paylaşınca onlar da gider.

Sesli komut için (isteğe bağlı): `pip install -r requirements.txt`, sonra
bot oyundayken `python ses.py`.

## Komutlar

| Nerede | Komut |
|---|---|
| Discord | `/baslat` `/durdur` `/durum` `/gorev` |
| Oyun (sadece sahip, fısıltı da olur) | `!farm` `!odun` `!tas` `!topla` `!gel` `!dur` `!durum` `!otonom` |
| Oyun / ses | `Yaren <cümle>`, örn. "Yaren biraz odun lazım" |

## Bilmen gerekenler

- **odun:** sadece doğal yaprağı olan kütükleri ağaç sayar. Kütükten yapılmış
  evlere dokunmaz.
- **tas:** sadece doğal taşı (`stone`) kırar. Cobblestone'a dokunmaz, çünkü o
  genelde oyuncunun yaptığı bir yapıdır.
- Kazma kırılırsa, envanter dolarsa ya da bot ölürse görev durur. Nedeni
  deneyim defterine yazılır, yapay zeka da bundan ders çıkarır.
- Otonom modda her görev en fazla 8 dakika sürer. Süre dolunca bot elindeki
  ağacı bitirir, iskeleyi toplar, fidanı diker ve öyle durur.
- Crack (offline) sunucularda sahip kontrolü sadece kullanıcı adına bakar.
  Biri senin adınla girerse botu yönetebilir.
