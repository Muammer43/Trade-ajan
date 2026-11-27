# Backtest Raporu ve Test Sonuçları

Bu belgedeki tüm sonuçlar 27 Kasım 2026'da geliştirme ortamında (Linux x86-64, Node.js 22.23.5) gerçekten
çalıştırıldı. Android cihazda çalıştırılmadı.

## Gerçek veri backtest'i (XAU/USD, Twelve Data)

- **Dönem:** 27.11.2025 – 26.11.2026 (23.694 adet 15 dakikalık mum).
- **Çıkışlar:** 5 dakikalık veri yalnızca son ~40 gün için vardı; önceki dönemin çıkışları 15 dakikalık
  mumla simüle edildi. Bir mum hem stopa hem hedefe değdiyse işlem stop sayıldı (temkinli varsayım).
- **Maliyetler:** spread 0,35 USD (Asya seansında ×1,3, kapanıştan önceki 30 dakikada ×2), kayma
  0,05 USD/yön, komisyon lot başına 7 USD, swap uzun −45 / kısa −10 USD/lot/gece (Çarşamba ×3).
- **Kod:** canlıdaki strateji, ajanlar, risk motoru, emir yöneticisi ve paper broker'ın aynısı. Komut:
  `node dist/quantforge/cli/main.js backtest --days 365`.

Bulunan 679 sinyalin modellere dağılımı: Breakout + Retest 309, Trend Pullback 259, Failed Breakout 111.

| Hesap / işlem başı risk                 | İşlem | Net                     | Win rate | PF   | Expectancy | Maks. DD | Sharpe |
| --------------------------------------- | ----- | ----------------------- | -------- | ---- | ---------- | -------- | ------ |
| **1.000 USD / %0,5 (varsayılan)**       | 13    | −1,34 USD (−%0,13)      | %23,1    | 0,96 | −0,06R     | %1,6     | −0,07  |
| 1.000 USD / %1 (izin verilen en yüksek) | 144   | −30,77 USD (−%3,08)     | %30,6    | 0,95 | −0,005R    | %8,0     | −0,19  |
| 10.000 USD / %0,5                       | 244   | −1.032,87 USD (−%10,33) | %41,0    | 0,82 | −0,11R     | %12,2    | −1,42  |

Modele göre sonuçlar:

| Model             | 1.000 USD / %1            | 10.000 USD / %0,5           |
| ----------------- | ------------------------- | --------------------------- |
| Trend Pullback    | 26 işlem, +47 USD, +0,22R | 21 işlem, −297 USD, −0,30R  |
| Breakout + Retest | 87 işlem, −18 USD, −0,02R | 164 işlem, −775 USD, −0,12R |
| Failed Breakout   | 31 işlem, −59 USD, −0,16R | 59 işlem, +39 USD, +0,01R   |

Reddedilen sinyaller:

| Neden                                   | 1.000 USD / %0,5 | 1.000 USD / %1 | 10.000 USD / %0,5 |
| --------------------------------------- | ---------------- | -------------- | ----------------- |
| En küçük lot bile risk bütçesini aşıyor | **605**          | 413            | 6                 |
| Kapanışa yakın veya hafta sonu          | 41               | 40             | 16                |
| Ajan veya AI Judge reddi                | 19               | 79             | 377               |
| Diğer limitler                          | 1                | 3              | 36                |

Yorum:

1. **Strateji bu dönemde kârlı değil.** Net sonuç her senaryoda negatif ve profit factor 1'in altında.
   Kurallar bu veriye göre sonradan ayarlanmadı, çünkü bu geçmişe uydurma olur ve gerçek performansı gizler.
2. **1.000 USD ve %0,5 riskte bot neredeyse işlem yapamıyor.** 679 sinyalin 605'i reddedildi: risk bütçesi
   5 USD, altında 15 dakikalık yapısal stoplar ise genellikle 5–15 USD. Bu bir hata değil, kesin risk
   sınırının doğal sonucu.
3. 10.000 USD senaryosunda düşüş %12 limitine ulaştı ve kill switch devreye girdi. Sonraki sinyalleri Risk
   ajanı ile risk motoru reddetti; tablodaki 377 "ajan reddi"nin büyük kısmı budur. Bot, tasarlandığı gibi
   kendini durdurdu.

**Öneri:** Gerçek parayla işlem düşünülmeden önce strateji en az 2–3 ay paper modda izlenmelidir.

## Otomatik testler (gerçekten çalıştırıldı)

| Komut                                                         | Sonuç                                            |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `npm run typecheck` (sunucu, testler, React paneli, betikler) | geçti                                            |
| `npm run lint` (Biome, 300 dosya)                             | geçti                                            |
| `npm run build` (esbuild paneli + TypeScript)                 | geçti                                            |
| `npm test`: 99 test (birim, entegrasyon, uçtan uca)           | **99 geçti, 0 başarısız**                        |
| `QF_LIVE_TESTS=1` canlı Twelve Data testi                     | önceki sürümde 3/3 geçti; veri katmanı değişmedi |

İstenen test kapsamı:

- **BUY / SELL / NO TRADE:** üç model için alış ve aynalanmış satış senaryoları; yönsüz piyasa; düşük puan;
  devre dışı model.
- **Trend pullback, breakout retest, failed breakout:** ders kitabı fiyat dizileriyle; tetik mumundan bir
  mum önce sinyal çıkmadığı da doğrulandı.
- **Look-ahead:** geleceğe mum eklenince geçmiş sinyaller değişmiyor.
- **Stop-loss, take-profit:** paper broker ve pozisyon kurallarında; boşlukla stop aşımı, aynı mumda stop
  ve hedef, kısmi kapatma, break-even, trailing, süre çıkışı.
- **Lot hesabı:** farklı kontrat özellikleri, minimum lot reddi, maksimum lot; %0,25–1 risk sınırı.
- **Spread filtresi ve risk limitleri:** her limit ayrı ayrı; kill switch kalıcılığı; otomatik devre
  kesiciler.
- **Kayıp serisi beklemesi:** aynı seri beklemeyi yeniden başlatmıyor. Bu test, bu sürümde düzeltilen
  kalıcı kilitlenme hatası için eklendi.
- **Duplicate order:** mum başına tek emir.
- **Paper execution:** alış/satış fiyatıyla dolum, komisyon, swap, kısmi kapatma.
- **Veritabanı kurtarma:** WAL, migration, yedekleme ve geri yükleme.
- **API bağlantı kesilmesi:** yedek sağlayıcıya geçiş, kesinti sonrası eksik mumların alınması.
- **Restart recovery:** çökme sonrası yarım kalan emir mutabakatı; aynı mum ikinci kez işlenmiyor.
- **Termux betikleri:** `install.sh --check`, start, status, healthcheck, `kill -9` sonrası bekçiyle
  yeniden başlatma, yedekleme, durdurma ve geri yükleme.
- **Uçtan uca:** tam bot, simüle saat, 5 günlük paper işlem, çökme, ağ kesintisi.
- **Panel API'si:** giriş, CSRF, CSP, tüm sayfa uçları, SSE.

## Doğrulanmayanlar

- Fiziksel Android cihazda çalıştırma. Kod bilinen uyumsuzluklardan kaçınıyor; kilit dosyası düzeltmesi
  sizin telefonunuzdaki hata çıktısıyla yapıldı.
- Twelve Data WebSocket, gerçek bir LLM ile inceleme ve herhangi bir canlı aracı kurum. Canlı aracı kurum
  bağdaştırıcısı tasarım gereği yok.
