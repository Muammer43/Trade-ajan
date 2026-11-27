# İşlem Stratejisi ve Kuralları

Kaynak kod: `src/quantforge/strategy/` (`structure.ts`, `models.ts`, `engine.ts`). Kurallar backtest, paper ve
canlı işlemde **aynı koddan** çalışır.

## Zaman dilimleri

| Zaman dilimi  | Rol                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **1 saat**    | Yön. 1h EMA(50)'nin üstünde/altında kapanış, son 5 saatteki EMA eğimi (≥ 0,15 × 1h-ATR) ve ADX. |
| **15 dakika** | Kurulum ve sinyal. Her kapanmış mumda bir kez değerlendirilir.                                  |
| **5 dakika**  | Yürütme ve izleme. Stop-loss, take-profit ve kısmi kâr kontrolü.                                |

Göstergeler orijinal TradingAgents `compute/indicators.ts` modülünden gelir (TA-Lib uyumlu EMA, RSI, MACD,
ATR, ADX). Swing noktaları 2 mumla doğrulanır; doğrulayan mumlar kapanmadan bir swing kullanılmaz.
Destek/direnç bölgeleri, son 300 mumdaki swing'lerin 0,3 ATR içinde kümelenmesiyle oluşur ve en az 2
temas gerektirir.

## Rejim → model seçimi

| Rejim                                               | Çalışabilecek modeller (ilki öncelikli) |
| --------------------------------------------------- | --------------------------------------- |
| Güçlü trend, ya da 1h yönüyle uyumlu zayıf trend    | A Trend Pullback → B Breakout + Retest  |
| Yatay (range)                                       | C Failed Breakout → B Breakout + Retest |
| 1h yönü olmayan zayıf trend                         | B Breakout + Retest → C Failed Breakout |
| ATR yüzdeliği bandın dışında (aşırı/ölü volatilite) | hiçbiri (NO TRADE)                      |

Modeller rastgele ve aynı anda çalışmaz. Rejimin izin vermediği model değerlendirilmez. Aynı mumda zıt yönlü
iki kurulum çıkarsa sonuç NO TRADE olur.

## A — Trend Pullback (alış; satış simetriktir)

Zorunlu koşullar:

1. 1h trend yukarı.
2. 15m yapı aşağı değil (son iki swing tepe ve dip düşmüyor).
3. Son 14 mum içinde bir itki swing'i var; itki ≥ 1,5 ATR.
4. Geri çekilme itkinin %25–80'i kadar, ≥ 2 mum sürmüş ve itkinin başlangıcını kırmamış.
5. Tetik mumu yükselişle kapanmış (CLV ≥ 0,3) ve önceki mumun tepesinin üstünde.
6. ATR yüzdeliği bant içinde.
7. Yapısal stop, 0,4–2,5 ATR arasında.
8. Ödül/risk ≥ 1,5. Hedef, karşıdaki bölgenin önünde kesilir.

Puanlanan bileşenler: geri çekilme derinliği (%50'ye yakınlık), EMA20–EMA50 bandına temas, RSI'ın
sıfırlanıp dönmesi, MACD histogramının dönmesi, önceki dibin süpürülmesi.
Stop: geri çekilme dibi − 0,15 ATR. Hedef: 2,5R veya karşı bölgenin önü.

## B — Breakout + Retest

Zorunlu koşullar:

1. Son 8 mum içinde, en az 2 temaslı bir bölgenin üzerinde gövdeyle kapanış (≥ 0,2 ATR geçiş, gövde ≥ 0,5 ATR).
2. Gerçek kırılım: sonrasında hiçbir mum bölgenin içine (0,1 ATR'den fazla) geri kapanmamış. Geri kapanan
   kırılım sahte kırılım sayılır ve işlem açılmaz.
3. Retest: fiyat kırılan seviyeye 0,3 ATR mesafeye kadar dönmüş.
4. Retest'ten sonra tetik mumu. Onay olmadan kırılım işlemi açılmaz.
5. 1h trend kırılıma karşı değil.
6. Volatilite bandı, stop aralığı ve ödül/risk ≥ 1,5.

Hacim: XAU/USD için Twelve Data hacim yayınlamıyor. Bu yüzden vekil olarak kırılım mumunun aralığı
(≥ 1,2 ATR) kullanılır; gerçek hacim gelirse 20 mumluk ortalamanın 1,3 katı aranır.
Stop: retest dibi − 0,15 ATR.

## C — Failed Breakout / Reversal

Zorunlu koşullar:

1. Son 3 mum içinde önceki bir swing dibi (veya tepesi) 0,05 ATR'den fazla aşılmış.
2. Fiyat aralığın içine geri kapanmış ve fitil ≥ %35. Bu, likidite süpürmesine işaret eder.
3. Yapısal onay: sonraki bir mum, süpürme mumunun karşı ucunun ötesinde kapanmış.
   Onay olmadan ters pozisyon açılmaz.
4. Güçlü 1h trende karşı değil.
5. Volatilite bandı, stop aralığı ve ödül/risk ≥ 1,5.

Hedef: 48 mumluk aralığın karşı kenarı (veya 2,5R, hangisi yakınsa). Arada yalnızca güçlü (3+ temaslı)
bölgeler hedefi kısıtlar. Stop: süpürme uç noktası ± 0,15 ATR.

## Sinyal puanı

Puan, 9 bileşenin 0–1 arası skorlarının ağırlıklı ortalamasıdır (0–100):

| Bileşen                                               | Ağırlık |
| ----------------------------------------------------- | ------- |
| trend                                                 | 15      |
| structure                                             | 10      |
| momentum                                              | 10      |
| volatility                                            | 10      |
| support_resistance                                    | 10      |
| setup_quality (pullback / kırılım / süpürme kalitesi) | 20      |
| liquidity                                             | 5       |
| regime_fit                                            | 10      |
| reward_risk                                           | 10      |

Varsayılan eşik `strategy.minScore = 60`. Her bileşenin ölçümü panelde **Trading Signals → Detay**
bölümünde gösterilir.

## Ajanlar ve AI Judge

Quant, Macro, Market, Strategy ve Risk ajanları değerlendirme yapar. AI Judge bunları birleştirir:

- Güven = puan/100 + 0,1 × (Quant, Market ve Macro ajanlarının sinyal yönüyle uyumu) × veri kalitesi.
- Herhangi bir ajan veto ederse sinyal reddedilir.
- Ajanların uyumu ≤ −0,35 ise (sinyalle açıkça çelişiyorlarsa) sinyal reddedilir.
- Güven `decision.minConfidence` (0,55) altındaysa sinyal reddedilir.
- Strategy ajanı, bir modelin paper sonuçları 20 işlemden sonra −0,3R'den kötüyse o modeli durdurur.
- İsteğe bağlı LLM incelemesi yalnızca güveni düşürebilir veya veto edebilir; güveni asla artıramaz ve fiyat
  üretemez.

## Pozisyon yönetimi

- 1R'de pozisyonun %50'si kapatılır ve stop başa başa (break-even) çekilir.
- Ardından stop, kapanışın 1,5 ATR gerisinden takip eder (trailing).
- 32 mum (8 saat) sonra süre çıkışı yapılır.
- Hafta sonu kapanışından önce pozisyon kapatılır.
- 0,01 lot bölünemediği için küçük hesapta kısmi kâr atlanır; break-even yine uygulanır.

## Risk ve lot

`lot = taban(risk bütçesi / stopta lot başına zarar, lot adımı)`. Lot başına zarar; stop mesafesi + spread +
2 × kayma (× kontrat büyüklüğü) + komisyondan oluşur. Bütçe minimum lotu karşılamıyorsa lot yukarı
yuvarlanmaz, işlem reddedilir. 1.000 USD ve %0,5 riskte bütçe 5 USD'dir, yani 0,01 lotla stop en fazla
yaklaşık 4,4 USD olabilir. Altının 15 dakikalık ATR'si genellikle 6–9 USD olduğundan çoğu sinyal bu nedenle
reddedilir (bkz. backtest raporu).
