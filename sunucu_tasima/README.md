# Discord Sunucu Taşıma Botu

Eski sunucudaki her şeyi (ayarlar, roller, emojiler, çıkartmalar, kategoriler,
kanallar, kanal izinleri, banlar, istersen mesajlar) yeni sunucuya kopyalar.

## 1) Botu oluştur
1. https://discord.com/developers/applications → **New Application**
2. **Bot** sekmesi → **Reset Token** → token'ı kopyala (kimseyle paylaşma!)
3. Mesajları da kopyalayacaksan aynı sayfada **Message Content Intent**'i aç.
4. **OAuth2 → URL Generator** → `bot` seç → yetki olarak **Administrator** seç.
5. Çıkan linkle botu **hem eski hem yeni** sunucuya ekle.
6. Yeni sunucuda **Sunucu Ayarları → Roller**'den botun rolünü en üste sürükle
   (bot kendi rolünün üstündeki rolleri düzenleyemez).

## 2) Sunucu ID'lerini al
Discord → Ayarlar → Gelişmiş → **Geliştirici Modu** aç.
Sunucu ikonuna sağ tık → **Sunucu ID'sini Kopyala** (eski ve yeni için ayrı ayrı).

## 3) Çalıştır
```
pip install -r requirements.txt
python sunucu_tasima.py
```
Program token'ı, sunucu ID'lerini ve neyin kopyalanacağını sorar,
cevapları `tasima_config.json` dosyasına kaydeder (token da burada durur, paylaşma).

Yeni sunucuyu temizleme seçeneği açıksa, güvenlik için yeni sunucunun adını
aynen yazmanı ister.

## Neler kopyalanır
| Ne | Not |
|---|---|
| Sunucu adı, ikon, açıklama, doğrulama/bildirim ayarları, AFK & sistem kanalı | Banner ve davet arka planı boost ister |
| Roller (isim, renk, yetki, sıra, ayrı gösterim) + @everyone yetkileri | Bot rolleri kopyalanmaz |
| Emojiler ve çıkartmalar | Yeni sunucunun boost limitine kadar |
| Kategoriler, yazı/ses/duyuru/sahne/forum kanalları + izinleri | Duyuru ve sahne kanalları için yeni sunucuda Topluluk açık olmalı, yoksa normal yazı/ses kanalı olur |
| Banlar | İsteğe bağlı |
| Mesajlar (kanal başına son N mesaj) | Webhook ile orijinal isim + avatarla gönderilir; tarih yeni olur |

## Neler kopyalanamaz (Discord izin vermiyor)
- **Üyeler**: Kimseyi zorla yeni sunucuya sokamazsın. Davet linki paylaşmalısın.
- Üyelerin rolleri (üyeler gelince tekrar verilmeli).
- Thread / forum gönderilerinin içerikleri, sesli kanal sohbetleri.
- Topluluk (Community) ayarı, vanity URL, boost'lar.

## Windows EXE
GitHub'da **Actions → Build Sunucu Tasima EXE → Run workflow** ile
`sunucu_tasima.exe` derlenir; Python kurmadan çalıştırabilirsin.
