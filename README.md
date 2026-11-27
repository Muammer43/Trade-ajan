# QuantForge AI — Otomatik XAUUSD İşlem Botu

QuantForge AI, TradingAgents kaynak kodu üzerine kurulmuş, **XAUUSD (spot altın)** için sinyal üreten,
pozisyon açan, yöneten ve kapatan otomatik bir işlem botudur. **Android Termux** üzerinde root ve Docker
olmadan çalışır.

- **Başlangıç modu: PAPER.** Gerçek Twelve Data fiyatlarıyla 1.000 USD'lik ayrı bir sanal hesapta işlem
  yapar; hiçbir aracı kuruma emir göndermez.
- **Canlı işlem varsayılan olarak kapalıdır.** Altı ayrı güvenlik kapısı vardır, yeniden başlatmada asla
  kendiliğinden açılmaz ve henüz doğrulanmış bir aracı kurum bağdaştırıcısı yoktur.

> **Dürüst performans notu:** Strateji gerçek XAU/USD verisinde (Kasım 2025 – Kasım 2026) backtest
> edildi ve **kârlı çıkmadı**. Örneğin 10.000 USD ve %0,5 riskle 244 işlemde −%10,3. 1.000 USD ve %0,5
> riskle sinyallerin %89'u en küçük lot (0,01) bile bütçeyi aştığı için işleme dönüşemedi. Ayrıntılar:
> [docs/quantforge/BACKTEST_RAPORU.md](docs/quantforge/BACKTEST_RAPORU.md). Sonuçlar güzel görünsün diye
> hiçbir kural geçmiş veriye göre ayarlanmadı.

## Nasıl çalışır?

Her **15 dakikalık mum kapanışında** (yalnızca kapanmış mumlarla) şu akış bir kez çalışır:

```
Twelve Data ─► kapanmış 5m / 15m mumlar ─► piyasa yapısı + rejim (1h yön, 15m kurulum)
   ─► Strateji motoru: rejim hangi modeli seçiyorsa onu değerlendirir
        A Trend Pullback │ B Breakout + Retest │ C Failed Breakout / Reversal
   ─► Sinyal puanı (0–100, 9 ölçülebilir bileşen) ─► 5 ajan + AI Judge (değerlendirme, veto, çelişki reddi)
   ─► Risk motoru (kesin otorite: limitler, spread, volatilite, lot hesabı)
   ─► BUY / SELL / NO TRADE ─► Emir yöneticisi (mum başına tek emir) ─► Paper broker ─► SQLite defter
5 dakikalık her mumda: stop-loss, take-profit, kısmi kâr; 15 dakikada bir: break-even, trailing, süre çıkışı
```

| Bileşen                  | Ne yapar                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Strateji motoru**      | 3 model, ölçülebilir zorunlu koşullar ve puanlanan bileşenler. Kurallar: [STRATEJI_TR.md](docs/quantforge/STRATEJI_TR.md)                                                                                                                                                                  |
| **Market Regime Engine** | Trend gücü (eğim t-istatistiği, verimlilik oranı), volatilite seviyesi ve dinamiği, kırılım ve likidite tuzağı. Hangi modelin çalışacağını seçer.                                                                                                                                          |
| **Ajanlar**              | Quant, Macro, Market, Strategy, Risk ve AI Judge. Fiyat değişiminde değil, yalnızca mum kapanışında çalışırlar. Sinyali yalnızca reddedebilir veya güvenini düşürebilirler. Yapay zekâ servisi çalışmasa da bot çalışır.                                                                   |
| **Risk motoru**          | İşlem başı risk %0,5 (kesin aralık %0,25–1), günlük/haftalık zarar, maksimum düşüş (kill switch), açık pozisyon, ardışık kayıp, günlük işlem sayısı, spread, kayma ve volatilite limitleri. Lot; kontrat büyüklüğü, tick ve minimum lot ile hesaplanır. Ajanlar bunu devre dışı bırakamaz. |
| **Yürütme**              | Aracı kurum bağdaştırıcı mimarisi, mükerrer emir koruması, mutabakat, paper broker (alış/satış, spread, kayma, komisyon, swap, kısmi kapatma), ayrı defter.                                                                                                                                |
| **Backtest**             | Canlıdaki kodun aynısını (strateji, ajanlar, risk, emir yöneticisi, paper broker) geçmiş veride çalıştırır. Strateji üretmez.                                                                                                                                                              |
| **Veri**                 | Twelve Data (birincil), bağdaştırıcı sistemi (Yahoo vadeli işlem vekili, CSV), yedek sağlayıcıya geçiş, istek limiti, eksik/tekrarlanan mum kontrolü. Eksik veri uydurulmaz; eski veriyle işlem açılmaz.                                                                                   |
| **Panel**                | React tabanlı, koyu, mobil uyumlu 12 sayfa. Tüm değerler veritabanından gelir.                                                                                                                                                                                                             |
| **Veritabanı**           | SQLite (`node:sqlite`, derleme gerektirmez). Migration'lar, WAL kipi, yedekleme.                                                                                                                                                                                                           |

## Hızlı kurulum (Termux)

```bash
pkg install -y nodejs-lts unzip
cp /sdcard/Download/QUANTFORGE_AI_TERMUX.zip ~ && cd ~ && unzip QUANTFORGE_AI_TERMUX.zip
cd ~/QUANTFORGE_AI
./install.sh          # bağımlılıklar + kurulum sihirbazı (Twelve Data anahtarı sorulur)
./start.sh            # Chrome: http://127.0.0.1:8787/   (anahtar: cat ~/.quantforge/dashboard-token)
```

Komutlar: `./start.sh` `./stop.sh` `./restart.sh` `./status.sh` `./backup.sh` `./restore.sh <dosya>`
`./healthcheck.sh [--restart]` `./update.sh <zip>`

Ayrıntılı rehber: **[docs/quantforge/KURULUM_TR.md](docs/quantforge/KURULUM_TR.md)**

Eski "QUANTFORGE_AI_PRO" kurulumundan geçiş: `cd ~/QUANTFORGE_AI_PRO && ./update.sh ~/QUANTFORGE_AI_TERMUX.zip`.
Eski `config.json` otomatik uyarlanır: kaldırılan keşif ayarları silinir, %1'in üzerindeki risk %1'e indirilir.

## Belgeler

- [Kurulum ve çalıştırma rehberi (TR)](docs/quantforge/KURULUM_TR.md)
- [İşlem stratejisi ve kuralları (TR)](docs/quantforge/STRATEJI_TR.md)
- [Backtest raporu ve test sonuçları (TR)](docs/quantforge/BACKTEST_RAPORU.md)
- [Sorun giderme](docs/quantforge/TROUBLESHOOTING.md)
- [Mimari ve kaynak kod analizi](docs/quantforge/ARCHITECTURE.md) · [API ve ayarlar](docs/quantforge/API_CONFIGURATION.md)
- [Paper trading](docs/quantforge/PAPER_TRADING.md) · [Kontrollü canlı işlem hazırlığı](docs/quantforge/LIVE_TRADING_PREPARATION.md)
- Orijinal TradingAgents: [docs/TRADINGAGENTS_README.md](docs/TRADINGAGENTS_README.md)

## Geliştirme

```bash
npm ci
npm run build        # panel paketi (esbuild) + TypeScript → dist/
npm run typecheck && npm run lint
npm test             # 99 test: birim, entegrasyon, uçtan uca (Termux betikleri dahil)
node dist/quantforge/cli/main.js backtest --days 365
```

## Uyarı

Bu yazılım yatırım tavsiyesi değildir. Geçmiş veya simüle edilmiş performans gelecekteki sonuçları
garanti etmez. Gerçek parayla işlem yapmadan önce stratejinin paper modda uzun süre izlenmesi gerekir.

Lisans: Apache-2.0 ([LICENSE](LICENSE)).
