# QuantForge AI Pro — Ayrıntılı Türkçe Kurulum Kılavuzu (Android Termux)

Bu kılavuz QuantForge AI Pro'yu bir Android telefonda, **Termux** içinde, root yetkisi ve Docker olmadan
kurmayı ve çalıştırmayı adım adım anlatır. Sistem varsayılan olarak **yalnızca PAPER (kâğıt üzerinde)
modda** çalışır: gerçek XAU/USD fiyatlarıyla 1.000 USD'lik sanal bir hesap işletir ve hiçbir aracı kuruma
emir göndermez.

## 1. Gereksinimler

| Gereksinim               | Açıklama                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Android 7+               | 64-bit (arm64) önerilir. En az 3 GB RAM ve 500 MB boş alan.                                                  |
| Termux                   | F-Droid, GitHub veya güncel Google Play sürümü (googleplay.2026.x ile denendi).                              |
| Node.js 22.13+           | `pkg install nodejs-lts` ile kurulur. `node:sqlite` modülü bu sürümle gelir.                                 |
| Twelve Data API anahtarı | <https://twelvedata.com> adresinden ücretsiz alınabilir. Ücretsiz/basic plan: 8 kredi/dakika, 800 kredi/gün. |
| Chrome                   | Panel (dashboard) telefonun tarayıcısında açılır.                                                            |

İsteğe bağlı: **Termux:Boot** (telefon açılınca otomatik başlatma) ve **termux-services**.

## 2. Termux'u hazırlama

```bash
termux-setup-storage          # (isteğe bağlı) Download klasörüne erişim
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts unzip git
node --version                # v22.13 veya daha yeni olmalı
node -e "require('node:sqlite'); console.log('sqlite OK')"
```

`nodejs-lts` 22.13'ten eskiyse `pkg install nodejs` ile güncel sürümü kurun (o da desteklenir).

## 3. Arşivi açma

ZIP dosyasını telefona indirdiyseniz (ör. Download klasörü):

```bash
cp /sdcard/Download/QUANTFORGE_AI_PRO_TERMUX.zip ~
cd ~ && unzip QUANTFORGE_AI_PRO_TERMUX.zip
cd ~/QUANTFORGE_AI_PRO
```

Uygulamayı Termux'un kendi ev dizininde (`~`) tutun. `/sdcard` üzerinde çalıştırmayın: orada dosya
izinleri ve kilit dosyaları (hard link) çalışmaz.

## 4. Kurulum

```bash
./install.sh
```

Betik şunları yapar:

1. Node.js ve `node:sqlite` kontrolü (yoksa Termux'ta `pkg install nodejs-lts` dener).
2. Yalnızca çalışma zamanı bağımlılıklarını kurar (`npm ci --omit=dev`). Hepsi saf JavaScript'tir, derleme
   gerekmez. ZIP içinde derlenmiş `dist/` klasörü hazır gelir.
3. `~/.quantforge` klasörünü 700 izniyle oluşturur.
4. **İlk kurulum sihirbazını** çalıştırır ve şunları sorar:
   - Twelve Data API anahtarı (`~/.quantforge/credentials.env` dosyasına 600 izniyle yazılır)
   - Başlangıç bakiyesi (varsayılan 1000 USD)
   - Risk profili (`balanced` = dengeli, `conservative` = temkinli)
   - Panel portu (varsayılan 8787)
   - Aracı kurumunuzdaki tipik spread, lot başına komisyon ve kontrat büyüklüğü
5. Panel erişim anahtarını (token) üretir ve ekrana yazar. Anahtar `~/.quantforge/dashboard-token`
   dosyasında da saklanır.
6. `doctor` ile bağlantı ve ortam kontrolü yapar.

Etkileşimsiz kurulum için:

```bash
export TWELVEDATA_API_KEY=anahtariniz
./install.sh --yes
```

Yalnızca ön koşulları kontrol etmek için: `./install.sh --check`

## 5. Çalıştırma ve durdurma

```bash
./start.sh      # arka planda başlatır, Termux wake-lock alır
./status.sh     # süreç, veri, hesap ve strateji durumu
./stop.sh       # düzgün kapatma (SIGTERM; 25 sn sonra SIGKILL)
./restart.sh
./healthcheck.sh            # 0 = sağlıklı, 1 = çalışmıyor, 3 = piyasa açık ama veri eski
./healthcheck.sh --restart  # çalışmıyorsa yeniden başlatır (bekçi/watchdog)
```

İlk çalıştırmada geçmiş veri indirilir: 15 dakikalık 1 yıl, 1 saatlik 3 yıl ve 5 dakikalık 15 gün. Bu,
API dakika sınırı nedeniyle 2–4 dakika sürer ve yaklaşık 15 kredi harcar. Ardından strateji keşfi arka
planda (ayrı bir süreçte) bir kez çalışır.

## 6. Paneli açma

Telefonda Chrome'u açın ve `http://127.0.0.1:8787/` adresine gidin. Erişim anahtarını görmek için:

```bash
cat ~/.quantforge/dashboard-token
```

Panelin 14 sayfası vardır: Genel Bakış, Canlı Piyasa, AI Ajanları, Strateji Keşfi, Strateji Laboratuvarı,
Backtest, Paper Trading, İşlem Geçmişi, Açık Pozisyonlar, Risk Yönetimi, Performans, Veri Sağlayıcıları,
Sistem Günlükleri ve Ayarlar. Güncellemeler Server-Sent Events ile anlık gelir; bağlantı koparsa 15
saniyelik yoklamaya geçer.

Güvenlik: Panel yalnızca `127.0.0.1` adresini dinler. Başka cihazdan erişim için `config.json` içinde
`dashboard.host` ve `dashboard.allowRemote: true` ayarlarını **bilerek** değiştirmeniz gerekir. Bunu
güvenilmeyen ağlarda yapmayın.

## 7. Android arka plan kısıtlamaları (ÖNEMLİ)

Android, arka plandaki uygulamaları uyutur. Sürekli çalışma için:

1. **Ayarlar → Uygulamalar → Termux → Pil → Kısıtlamasız** (pil optimizasyonunu kapatın).
2. Termux bildirimindeki **"Acquire wakelock"** seçeneğini kullanın. `start.sh` bunu
   `termux-wake-lock` ile otomatik yapar.
3. Xiaomi/MIUI, Huawei, Samsung gibi markalarda ek olarak "Otomatik başlatma"yı açın ve Termux'u
   "son uygulamalar" listesinde kilitleyin. Ayrıntı için <https://dontkillmyapp.com> sitesine bakın.
4. Telefon yeniden başlayınca otomatik başlatma (Termux:Boot uygulaması kurulu ve bir kez açılmış olmalı):

   ```bash
   mkdir -p ~/.termux/boot
   cp scripts/termux/boot/start-quantforge.sh ~/.termux/boot/
   nano ~/.termux/boot/start-quantforge.sh   # APP= satırını kurulum dizininize göre düzeltin
   ```

5. Alternatif olarak, süreç ölürse otomatik yeniden başlatma için termux-services kullanılabilir (bkz.
   `scripts/termux/service/run`).

Uygulama beklenmedik şekilde kapanırsa (pil, OOM killer, `kill -9`) veri kaybı olmaz. Tüm durum SQLite'ta
(WAL kipinde) tutulur. Yeniden başlatmada yarım kalan emirler mutabakattan geçer (asla yeniden
gönderilmez), bakiye ile işlem defteri karşılaştırılır ve aynı mum iki kez işlenmez.

## 8. Yedekleme ve geri yükleme

```bash
./backup.sh                          # çalışırken güvenle alınır (~/.quantforge/backups)
export QF_BACKUP_PASSPHRASE='uzun-parola'   # tanımlıysa yedek AES-256-GCM ile şifrelenir
./stop.sh && ./restore.sh ~/.quantforge/backups/quantforge-....db
```

Her gün `scheduler.backupHourUtc` saatinde (varsayılan 01:00 UTC) otomatik yedek alınır ve son 14 yedek
saklanır. Geri yüklemede SHA-256 sağlama toplamı ve SQLite bütünlüğü kontrol edilir; eski veritabanı
`.before-restore-*` adıyla korunur.

## 9. Güncelleme

```bash
./update.sh QUANTFORGE_AI_PRO_TERMUX.zip   # yeni sürüm ZIP'i ile
./update.sh                                # git ile kurduysanız (git pull)
```

Güncelleme önce yedek alır, uygulamayı durdurur, dosyaları değiştirir, bağımlılıkları kurar ve
çalışıyorsa yeniden başlatır. Veritabanı geçişleri (migration) açılışta otomatik uygulanır.

## 10. Depolama yolunu değiştirme

```bash
export QF_HOME=~/qf-data        # tüm ayar, günlük ve veriler
export QF_DATA_DIR=~/qf-db      # yalnızca veritabanı
export QF_BACKUP_DIR=~/qf-yedek # yalnızca yedekler
```

Bu değişkenleri `~/.bashrc` dosyasına ekleyin. Değişkenler Termux:Boot betiğinde de tanımlı olmalıdır.

## 11. İlk çalıştırmada ne beklemeli?

- Panelde **"No validated strategy is active"** uyarısı görmeniz normaldir. Sistem gerçek veride
  istatistiksel olarak sağlam bir avantaj bulamadıkça işlem açmaz. Şu ana kadarki gerçek veri testlerinde
  hiçbir strateji doğrulamayı geçemedi (bkz. VALIDATION_REPORT.md).
- Her 15 dakikada bir karar kaydı oluşur. Çoğu "NO_TRADE" olacaktır ve bu beklenen davranıştır.
- Keşif her 7 günde bir yenilenir. Panelden "Run discovery now" ile elle de başlatılabilir.

## 12. Komut satırı özeti

```bash
node dist/quantforge/cli/main.js help
#  setup | run | status | doctor | backfill | discover | regime-eval | import-csv | backup | restore
#  backups | health | kill-switch on|off | close-all | live-status | tick | research "<soru>"
```

Örnek: kendi CSV geçmişinizi içe aktarma (UTC zamanlı, `time,open,high,low,close`):

```bash
node dist/quantforge/cli/main.js import-csv ~/XAUUSD_15m.csv --tf 15m
```

Sorun giderme için bkz. [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
