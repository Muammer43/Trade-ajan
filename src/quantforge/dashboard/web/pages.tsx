// The twelve dashboard pages.

import { useState } from "react";
import {
  ago,
  type Bar,
  CandleChart,
  Card,
  type Col,
  Kpi,
  LineChart,
  Loading,
  Notice,
  num,
  Pill,
  pct,
  post,
  Table,
  time,
  tone,
  usd,
  useApi,
} from "./lib.js";

type Auth = { onAuth: () => void };
type AnyRec = Record<string, unknown>;
type GroupStats = {
  trades: number;
  wins: number;
  winRate: number;
  netProfit: number;
  profitFactor: number | null;
  expectancyR: number | null;
};

const MODEL_TR: Record<string, string> = {
  trend_pullback: "Trend Pullback",
  breakout_retest: "Breakout + Retest",
  failed_breakout: "Failed Breakout / Reversal",
};
const modelName = (m: unknown) => (typeof m === "string" ? (MODEL_TR[m] ?? m) : "—");

// ------------------------------------------------------------------------------------------- Dashboard

type Overview = {
  quote: {
    price: number;
    bid: number;
    ask: number;
    spread: number;
    spreadSource: string;
    delayed: boolean;
  } | null;
  marketOpen: boolean;
  minutesToClose: number;
  regime: string | null;
  regimeTs: number | null;
  activeModel: { id: string; label: string } | null;
  allowedModels: { id: string; label: string }[];
  lastDecision: {
    action: string;
    bar_ts: number;
    model: string | null;
    score: number | null;
    confidence: number;
    reasons: string[];
  } | null;
  lastSignal: { bar_ts: number; action: string; model: string | null } | null;
  mode: string;
  account: {
    initialBalance: number;
    balance: number;
    equity: number;
    unrealized: number;
    dailyPnl: number;
    totalPnl: number;
    realizedPnl: number;
    freeMargin: number;
  };
  stats: {
    trades: number;
    winRate: number | null;
    profitFactor: number | null;
    expectancyUsd: number | null;
    expectancyR: number | null;
    maxDrawdownPct: number;
  };
  openPositions: number;
  recentTrades: {
    side: string;
    model: string;
    closedAt: number;
    pnl: number;
    r: number;
    exitReason: string;
  }[];
  risk: {
    dayLossPct: number;
    maxDailyLossPct: number;
    dailyRiskUsedPct: number;
    openRiskUsd: number;
    riskPerTradePct: number;
    controls: { killSwitch: { on: boolean; reason: string | null } };
  };
  providers: { id: string; state: string; lastOk: number | null }[];
  apiBudget: { usedToday: number; perDay: number };
  lastSuccessfulUpdate: number | null;
  lastError: string | null;
  bot: {
    running: boolean;
    startedAt: number;
    lastJobAt: number | null;
    schedulerEnabled: boolean;
    killSwitch: boolean;
    backtestRunning: boolean;
  };
};

export function DashboardPage({ onAuth }: Auth) {
  const { data: o, error } = useApi<Overview>("/api/overview", onAuth);
  if (!o) return <Loading error={error} />;
  const d = o.lastDecision;
  const q = o.quote;
  return (
    <>
      {o.risk.controls.killSwitch.on ? (
        <Notice kind="bad">Acil durdurma (kill switch) aktif: {o.risk.controls.killSwitch.reason}</Notice>
      ) : null}
      <Card>
        <div className="row spread">
          <div>
            <div className="muted">XAUUSD {q?.delayed ? "(son kapanan mum)" : "(canlı)"}</div>
            <div className="price">{q ? num(q.price) : "—"}</div>
            <div className="muted">
              alış {q ? num(q.bid) : "—"} · satış {q ? num(q.ask) : "—"} · spread {q ? num(q.spread) : "—"} (
              {q?.spreadSource ?? "—"}) ·{" "}
              {o.marketOpen ? `piyasa açık, kapanışa ${o.minutesToClose} dk` : "piyasa kapalı"}
            </div>
          </div>
          <div className="decision">
            <div className="muted">Son karar</div>
            <div className={`big ${d?.action === "BUY" ? "up" : d?.action === "SELL" ? "down" : ""}`}>
              {d?.action ?? "—"}
            </div>
            <div className="muted">
              {d ? `${time(d.bar_ts)}${d.score ? ` · puan ${num(d.score, 0)}` : ""}` : ""}
            </div>
          </div>
        </div>
      </Card>
      <div className="grid">
        <Kpi
          label="Bot"
          value={o.bot.running ? (o.bot.killSwitch ? "DURDURULDU" : "ÇALIŞIYOR") : "—"}
          cls={o.bot.killSwitch ? "down" : "up"}
          sub={`mod ${o.mode.toUpperCase()} · son iş ${ago(o.bot.lastJobAt)}`}
        />
        <Kpi
          label="Aktif strateji modeli"
          value={o.activeModel?.label ?? "—"}
          sub={
            o.allowedModels.length
              ? `rejim izin veriyor: ${o.allowedModels.map((m) => m.label).join(", ")}`
              : "rejim hiçbir modele izin vermiyor"
          }
        />
        <Kpi label="Market regime" value={o.regime ?? "—"} sub={o.regimeTs ? ago(o.regimeTs) : ""} />
        <Kpi
          label="Bakiye"
          value={usd(o.account.balance)}
          sub={`başlangıç ${usd(o.account.initialBalance)}`}
        />
        <Kpi label="Equity" value={usd(o.account.equity)} sub={`açık K/Z ${usd(o.account.unrealized)}`} />
        <Kpi label="Günlük PnL" value={usd(o.account.dailyPnl)} cls={tone(o.account.dailyPnl)} />
        <Kpi label="Toplam PnL" value={usd(o.account.totalPnl)} cls={tone(o.account.totalPnl)} />
        <Kpi
          label="Win rate"
          value={o.stats.winRate === null ? "—" : pct(o.stats.winRate)}
          sub={`${o.stats.trades} kapanan işlem`}
        />
        <Kpi label="Profit factor" value={o.stats.profitFactor === null ? "—" : num(o.stats.profitFactor)} />
        <Kpi
          label="Expectancy"
          value={o.stats.expectancyUsd === null ? "—" : usd(o.stats.expectancyUsd)}
          sub={o.stats.expectancyR === null ? "" : `${num(o.stats.expectancyR, 3)} R`}
        />
        <Kpi label="Max drawdown" value={`${num(o.stats.maxDrawdownPct)}%`} />
        <Kpi
          label="Açık pozisyon"
          value={String(o.openPositions)}
          sub={`açık risk ${usd(o.risk.openRiskUsd)}`}
        />
        <Kpi
          label="Günlük risk kullanımı"
          value={`${num(o.risk.dailyRiskUsedPct, 0)}%`}
          sub={`bugünkü zarar %${num(o.risk.dayLossPct)} / limit %${num(o.risk.maxDailyLossPct, 1)} · işlem başı risk %${num(o.risk.riskPerTradePct)}`}
        />
        <Kpi
          label="Veri bağlantısı"
          value={
            <span>
              {o.providers.map((p) => (
                <span key={p.id} className="block">
                  <Pill v={p.state} /> {p.id}
                </span>
              ))}
            </span>
          }
          sub={`son güncelleme ${ago(o.lastSuccessfulUpdate)} · API ${o.apiBudget.usedToday}/${o.apiBudget.perDay}`}
        />
      </div>
      <Card title="Son işlemler">
        <Table
          rows={o.recentTrades}
          empty="Henüz kapanmış işlem yok."
          cols={[
            ["Kapanış", (t) => time(t.closedAt)],
            ["Yön", (t) => t.side],
            ["Model", (t) => modelName(t.model)],
            ["Çıkış", (t) => t.exitReason],
            ["Net", (t) => <span className={tone(t.pnl)}>{usd(t.pnl)}</span>],
            ["R", (t) => num(t.r)],
          ]}
        />
      </Card>
      {d ? (
        <Card title="Son kararın gerekçeleri">
          <div className="list">
            {d.reasons.map((r) => (
              <div key={r} className="item">
                {r}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {o.lastError ? <Notice kind="bad">Son hata: {o.lastError}</Notice> : null}
    </>
  );
}

// ------------------------------------------------------------------------------------------- Live Market

export function LiveMarketPage({ onAuth }: Auth) {
  const [tf, setTf] = useState(() => sessionStorage.getItem("qf.tf") ?? "15m");
  const { data: m, error } = useApi<{
    quote: Overview["quote"];
    quality: { bars: number; missingBars: number; staleQuoteBars: number; fresh: boolean; ageBars: number };
    bars: (Bar & { q: string })[];
  }>(`/api/market?tf=${tf}&limit=160`, onAuth);
  const choose = (x: string) => {
    sessionStorage.setItem("qf.tf", x);
    setTf(x);
  };
  return (
    <>
      <Card
        title={`XAUUSD ${tf}`}
        actions={["5m", "15m", "1h", "4h"].map((x) => (
          <button
            key={x}
            type="button"
            className={`btn ${x === tf ? "primary" : ""}`}
            onClick={() => choose(x)}
          >
            {x}
          </button>
        ))}
      >
        {m ? <CandleChart bars={m.bars} /> : <Loading error={error} />}
        <p className="muted">
          Gri mumlar: spot piyasa kapalıyken sağlayıcının yayınladığı fiyatlar (analizde kullanılmaz).
        </p>
      </Card>
      {m ? (
        <div className="grid">
          <Kpi
            label="Fiyat"
            value={m.quote ? num(m.quote.price) : "—"}
            sub={m.quote?.delayed ? "son kapanan mum" : "canlı"}
          />
          <Kpi label="Kontrol edilen mum" value={m.quality.bars} />
          <Kpi
            label="Eksik mum"
            value={m.quality.missingBars}
            cls={m.quality.missingBars ? "warn" : ""}
            sub="piyasa saatleri içinde"
          />
          <Kpi
            label="Veri tazeliği"
            value={m.quality.fresh ? "taze" : "eski"}
            cls={m.quality.fresh ? "up" : "down"}
            sub={`${num(m.quality.ageBars, 1)} mum önce`}
          />
        </div>
      ) : null}
      {m ? (
        <Card title="Son mumlar">
          <Table
            rows={m.bars.slice(-25).reverse()}
            cols={[
              ["Açılış zamanı", (b) => time(b.ts)],
              ["Open", (b) => num(b.o)],
              ["High", (b) => num(b.h)],
              ["Low", (b) => num(b.l)],
              ["Close", (b) => num(b.c)],
              ["Kalite", (b) => <Pill v={b.q} />],
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------------------------------- Signals

type SignalRow = {
  id: number;
  bar_ts: number;
  action: string;
  model: string | null;
  modelLabel: string | null;
  regime: string;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  lots: number | null;
  risk_pct: number | null;
  score: number | null;
  confidence: number;
  reasons: string[];
  rejected: { action: string; reason: string }[];
  evaluations: {
    model: string;
    triggered: boolean;
    side: string | null;
    score: number;
    rejection: string | null;
    components: Record<string, { score: number; detail: string }>;
  }[];
};

export function SignalsPage({ onAuth }: Auth) {
  const [all, setAll] = useState(false);
  const { data, error } = useApi<SignalRow[]>(`/api/signals?limit=150${all ? "" : "&only=trades"}`, onAuth);
  const [open, setOpen] = useState<number | null>(null);
  if (!data) return <Loading error={error} />;
  const sel = data.find((d) => d.id === open);
  return (
    <>
      <Card
        title="Trading Signals"
        actions={
          <button type="button" className="btn" onClick={() => setAll(!all)}>
            {all ? "Yalnızca kurulumlar" : "Tüm kararlar (NO TRADE dahil)"}
          </button>
        }
      >
        <p className="muted">
          Her 15 dakikalık mum kapanışında karar verilir. Bir kuruluma ait karar, risk veya ajanlar tarafından
          reddedilirse NO_TRADE olarak kaydedilir.
        </p>
        <Table
          rows={data}
          cols={[
            ["Mum", (d) => time(d.bar_ts)],
            ["Karar", (d) => <Pill v={d.action} />],
            ["Model", (d) => d.modelLabel ?? "—"],
            ["Puan", (d) => num(d.score, 0)],
            ["Giriş", (d) => num(d.entry)],
            ["SL", (d) => num(d.sl)],
            ["TP", (d) => num(d.tp)],
            ["R:R", (d) => num(d.rr)],
            ["Lot", (d) => num(d.lots)],
            ["Risk", (d) => (d.risk_pct ? `%${num(d.risk_pct)}` : "—")],
            ["Rejim", (d) => d.regime, "wrap"],
            [
              "",
              (d) => (
                <button type="button" className="btn" onClick={() => setOpen(open === d.id ? null : d.id)}>
                  Detay
                </button>
              ),
            ],
          ]}
        />
      </Card>
      {sel ? (
        <Card title={`Karar #${sel.id} — ${time(sel.bar_ts)}`}>
          <h3>Gerekçe</h3>
          <div className="list">
            {sel.reasons.map((r) => (
              <div key={r} className="item">
                {r}
              </div>
            ))}
          </div>
          <h3>Reddedilen alternatifler</h3>
          <Table
            rows={sel.rejected}
            cols={[
              ["Alternatif", (r) => r.action],
              ["Neden", (r) => r.reason, "wrap"],
            ]}
          />
          {sel.evaluations.map((e) => (
            <div key={e.model}>
              <h3>
                {modelName(e.model)} —{" "}
                {e.triggered ? `${e.side} kurulum, puan ${num(e.score, 1)}` : `tetiklenmedi: ${e.rejection}`}
              </h3>
              <Table
                rows={Object.entries(e.components)}
                cols={[
                  ["Bileşen", (c) => c[0]],
                  ["Puan", (c) => num(c[1].score)],
                  ["Ölçüm", (c) => c[1].detail, "wrap"],
                ]}
              />
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------------------------------- Positions

type PositionRow = {
  id: number;
  opened_at: number;
  closed_at: number | null;
  strategy_id: string | null;
  side: string;
  lots_open: number;
  lots_initial: number;
  entry_price: number;
  sl: number;
  tp: number | null;
  initial_sl: number;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number;
  commission: number;
  swap: number;
  r_multiple: number | null;
  bars_held: number;
  unrealized: number | null;
  regime: string | null;
};

export function PositionsPage({ onAuth }: Auth) {
  const { data, error, reload } = useApi<PositionRow[]>("/api/positions", onAuth);
  if (!data) return <Loading error={error} />;
  return (
    <Card
      title="Active Positions"
      actions={
        data.length ? (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (confirm("Tüm paper pozisyonlar güncel fiyattan kapatılsın mı?")) {
                await post("/api/positions/close-all");
                reload();
              }
            }}
          >
            Hepsini kapat
          </button>
        ) : null
      }
    >
      <Table
        rows={data}
        empty="Açık pozisyon yok."
        cols={[
          ["#", (p) => p.id],
          ["Açılış", (p) => time(p.opened_at)],
          ["Model", (p) => modelName(p.strategy_id)],
          ["Yön", (p) => p.side],
          ["Lot", (p) => num(p.lots_open)],
          ["Giriş", (p) => num(p.entry_price)],
          ["Stop", (p) => num(p.sl)],
          ["Hedef", (p) => num(p.tp)],
          ["Açık K/Z", (p) => <span className={tone(p.unrealized)}>{usd(p.unrealized)}</span>],
          ["Mum", (p) => p.bars_held],
          [
            "",
            (p) => (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const r = await post<{ ok: boolean; reason?: string }>(`/api/positions/${p.id}/close`);
                  if (!r.ok) alert(r.reason);
                  reload();
                }}
              >
                Kapat
              </button>
            ),
          ],
        ]}
      />
    </Card>
  );
}

export function HistoryPage({ onAuth }: Auth) {
  const { data, error } = useApi<PositionRow[]>("/api/trades?limit=300", onAuth);
  if (!data) return <Loading error={error} />;
  return (
    <Card title="Trade History">
      <Table
        rows={data}
        empty="Henüz kapanmış işlem yok."
        cols={[
          ["#", (p) => p.id],
          ["Açılış", (p) => time(p.opened_at)],
          ["Kapanış", (p) => time(p.closed_at)],
          ["Model", (p) => modelName(p.strategy_id)],
          ["Yön", (p) => p.side],
          ["Lot", (p) => num(p.lots_initial)],
          ["Giriş", (p) => num(p.entry_price)],
          ["Çıkış", (p) => num(p.exit_price)],
          ["Neden", (p) => p.exit_reason],
          [
            "Net",
            (p) => (
              <span className={tone(p.realized_pnl - p.commission + p.swap)}>
                {usd(p.realized_pnl - p.commission + p.swap)}
              </span>
            ),
          ],
          ["R", (p) => num(p.r_multiple)],
        ]}
      />
    </Card>
  );
}

// ------------------------------------------------------------------------------------------- Performance

function GroupTable({ groups, label }: { groups: Record<string, GroupStats>; label: string }) {
  return (
    <Table
      rows={Object.entries(groups)}
      cols={[
        [label, (g) => modelName(g[0])],
        ["İşlem", (g) => g[1].trades],
        ["Win rate", (g) => pct(g[1].winRate)],
        ["Net", (g) => <span className={tone(g[1].netProfit)}>{usd(g[1].netProfit)}</span>],
        ["PF", (g) => (g[1].profitFactor === null ? "—" : num(g[1].profitFactor))],
        ["Expectancy", (g) => (g[1].expectancyR === null ? "—" : `${num(g[1].expectancyR, 3)} R`)],
      ]}
    />
  );
}

type Stats = GroupStats & {
  expectancyUsd: number | null;
  avgR: number | null;
  long: GroupStats;
  short: GroupStats;
  byModel: Record<string, GroupStats>;
  byRegime: Record<string, GroupStats>;
  byExit: Record<string, number>;
  monthly: { month: string; trades: number; netProfit: number; returnPct: number | null }[];
};

function StatsBlock({
  stats,
  eq,
}: {
  stats: Stats;
  eq: { maxDrawdownPct: number; sharpe: number | null; sortino: number | null };
}) {
  return (
    <>
      <div className="grid">
        <Kpi label="Net kâr" value={usd(stats.netProfit)} cls={tone(stats.netProfit)} />
        <Kpi
          label="İşlem"
          value={stats.trades}
          sub={`uzun ${stats.long.trades} · kısa ${stats.short.trades}`}
        />
        <Kpi label="Win rate" value={stats.trades ? pct(stats.winRate) : "—"} />
        <Kpi label="Profit factor" value={stats.profitFactor === null ? "—" : num(stats.profitFactor)} />
        <Kpi
          label="Expectancy"
          value={stats.expectancyUsd === null ? "—" : usd(stats.expectancyUsd)}
          sub={stats.expectancyR === null ? "" : `${num(stats.expectancyR, 3)} R`}
        />
        <Kpi label="Ortalama R" value={stats.avgR === null ? "—" : num(stats.avgR, 3)} />
        <Kpi label="Max drawdown" value={`${num(eq.maxDrawdownPct)}%`} />
        <Kpi
          label="Sharpe / Sortino"
          value={`${eq.sharpe === null ? "—" : num(eq.sharpe)} / ${eq.sortino === null ? "—" : num(eq.sortino)}`}
          sub="günlük equity, yıllıklandırılmış"
        />
      </div>
      <Card title="Uzun / kısa">
        <GroupTable groups={{ long: stats.long, short: stats.short }} label="Yön" />
      </Card>
      <Card title="Strateji modeline göre">
        <GroupTable groups={stats.byModel} label="Model" />
      </Card>
      <Card title="Market regime'e göre">
        <GroupTable groups={stats.byRegime} label="Rejim" />
      </Card>
      <Card title="Aylık">
        <Table
          rows={stats.monthly}
          cols={[
            ["Ay", (m) => m.month],
            ["İşlem", (m) => m.trades],
            ["Net", (m) => <span className={tone(m.netProfit)}>{usd(m.netProfit)}</span>],
            ["Getiri", (m) => (m.returnPct === null ? "—" : `${num(m.returnPct)}%`)],
          ]}
        />
      </Card>
    </>
  );
}

export function PerformancePage({ onAuth }: Auth) {
  const { data, error } = useApi<{
    stats: Stats;
    equityStats: { maxDrawdownPct: number; sharpe: number | null; sortino: number | null };
    equity: { ts: number; equity: number }[];
  }>("/api/performance", onAuth);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <Card title="Strategy Performance (paper)">
        {data.equity.length > 1 ? (
          <LineChart small points={data.equity.map((e) => ({ t: e.ts, v: e.equity }))} />
        ) : (
          <p className="muted">Yeterli equity geçmişi yok.</p>
        )}
      </Card>
      <StatsBlock stats={data.stats} eq={data.equityStats} />
    </>
  );
}

// ------------------------------------------------------------------------------------------- Agents

export function AgentsPage({ onAuth }: Auth) {
  const { data, error } = useApi<{
    catalogue: { id: string; label: string; responsibility: string; inputs: string; outputs: string }[];
    decisionId: number | null;
    reports: {
      agent: string;
      status: string;
      bias: number;
      confidence: number;
      summary: string;
      veto: string | null;
      duration_ms: number;
      evidence: { id: string; label: string; value: unknown }[];
    }[];
    llm: { enabled: boolean; provider: string; model: string };
  }>("/api/agents", onAuth);
  if (!data) return <Loading error={error} />;
  const by = Object.fromEntries(data.reports.map((r) => [r.agent, r]));
  return (
    <>
      <Notice>
        Ajanlar her fiyat değişiminde değil, yalnızca mum kapanışında çalışır. Kararı deterministik kod verir;
        ajanlar sinyal kalitesini değerlendirir ve sinyali yalnızca reddedebilir. Risk motoru ajanlardan
        bağımsızdır. LLM incelemesi:{" "}
        {data.llm.enabled ? `açık (${data.llm.provider}/${data.llm.model})` : "kapalı"}.
      </Notice>
      <div className="grid wide">
        {data.catalogue.map((c) => {
          const r = by[c.id];
          return (
            <Card key={c.id} title={c.label}>
              <p className="muted">{c.responsibility}</p>
              {r ? (
                <>
                  <div className="row">
                    <Pill v={r.status} />
                    <span>
                      eğilim <b className={tone(r.bias)}>{num(r.bias)}</b>
                    </span>
                    <span>
                      güven <b>{num(r.confidence)}</b>
                    </span>
                    <span className="muted">{num(r.duration_ms, 0)} ms</span>
                  </div>
                  <p>{r.summary}</p>
                  {r.veto ? <Notice kind="bad">Veto: {r.veto}</Notice> : null}
                  <details>
                    <summary>Kanıtlar ({r.evidence.length})</summary>
                    <Table
                      rows={r.evidence}
                      cols={[
                        ["id", (e) => <code>{e.id}</code>],
                        ["ölçüm", (e) => e.label],
                        [
                          "değer",
                          (e) => (typeof e.value === "number" ? num(e.value, 4) : String(e.value ?? "—")),
                          "wrap",
                        ],
                      ]}
                    />
                  </details>
                </>
              ) : (
                <p className="muted">Henüz rapor yok.</p>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------- Risk

export function RiskPage({ onAuth }: Auth) {
  const { data, error, reload } = useApi<{
    config: AnyRec & {
      maxDrawdownPct: number;
      maxDailyLossPct: number;
      maxTradesPerDay: number;
      maxConsecutiveLosses: number;
      maxOpenPositions: number;
      riskPerTradePct: number;
      profile: string;
    };
    controls: {
      killSwitch: { on: boolean; reason: string | null; ts: number | null };
      circuitBreaker: { until: number | null; reason: string | null };
      cooldownUntil: number | null;
    };
    events: AnyRec[];
    account: {
      equity: number;
      peakEquity: number;
      dayStartEquity: number;
      tradesToday: number;
      consecutiveLosses: number;
      openPositions: unknown[];
    };
    instrument: AnyRec;
    costs: AnyRec;
  }>("/api/risk?limit=40", onAuth);
  if (!data) return <Loading error={error} />;
  const c = data.controls;
  const a = data.account;
  const dd = a.peakEquity > 0 ? (1 - a.equity / a.peakEquity) * 100 : 0;
  const day = a.dayStartEquity > 0 ? (1 - a.equity / a.dayStartEquity) * 100 : 0;
  const gauge = (label: string, v: number, lim: number) => (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">
        {num(v)}% <span className="muted">/ {num(lim, 1)}%</span>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.min(100, Math.max(0, (v / lim) * 100))}%` }} />
      </div>
    </div>
  );
  return (
    <>
      <Card
        title="Acil durdurma (kill switch)"
        actions={
          c.killSwitch.on ? (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await post("/api/risk/kill-switch", { on: false, reason: "panelden kaldırıldı" });
                reload();
              }}
            >
              Kaldır
            </button>
          ) : (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (confirm("Bot durdurulsun ve tüm paper pozisyonlar kapatılsın mı?")) {
                  await post("/api/risk/kill-switch", {
                    on: true,
                    reason: "panelden acil durdurma",
                    flatten: true,
                  });
                  reload();
                }
              }}
            >
              Durdur ve kapat
            </button>
          )
        }
      >
        <p>
          {c.killSwitch.on ? (
            <span className="down">
              AKTİF — {c.killSwitch.reason} ({time(c.killSwitch.ts)})
            </span>
          ) : (
            "Kapalı"
          )}
        </p>
        <p className="muted">
          Devre kesici:{" "}
          {c.circuitBreaker.until && c.circuitBreaker.until > Date.now()
            ? `${c.circuitBreaker.reason}, ${time(c.circuitBreaker.until)} tarihine kadar`
            : "yok"}{" "}
          · Kayıp serisi beklemesi:{" "}
          {c.cooldownUntil && c.cooldownUntil > Date.now()
            ? `${time(c.cooldownUntil)} tarihine kadar`
            : "yok"}
        </p>
      </Card>
      <div className="grid">
        {gauge("Zirveden düşüş", dd, data.config.maxDrawdownPct)}
        {gauge("Bugünkü zarar", day, data.config.maxDailyLossPct)}
        <Kpi label="Bugünkü işlem" value={`${a.tradesToday} / ${data.config.maxTradesPerDay}`} />
        <Kpi label="Ardışık kayıp" value={`${a.consecutiveLosses} / ${data.config.maxConsecutiveLosses}`} />
        <Kpi label="Açık pozisyon" value={`${a.openPositions.length} / ${data.config.maxOpenPositions}`} />
        <Kpi
          label="İşlem başı risk"
          value={`%${num(data.config.riskPerTradePct)}`}
          sub={`${data.config.profile} profil · izin verilen %0,25–1`}
        />
      </div>
      <Card title="Limitler">
        <Table
          rows={Object.entries(data.config)}
          cols={[
            ["Kural", (x) => x[0]],
            ["Değer", (x) => String(x[1])],
          ]}
        />
      </Card>
      <Card title="Kontrat özellikleri ve maliyetler">
        <Table
          rows={[...Object.entries(data.instrument), ...Object.entries(data.costs)]}
          cols={[
            ["Alan", (x) => x[0]],
            ["Değer", (x) => String(x[1])],
          ]}
        />
      </Card>
      <Card title="Risk olayları">
        <Table
          rows={data.events}
          cols={[
            ["Zaman", (e) => time(e.ts)],
            ["Olay", (e) => String(e.kind)],
            ["Önem", (e) => <Pill v={e.severity} />],
            ["Detay", (e) => <code>{String(e.detail_json ?? "")}</code>, "wrap"],
          ]}
        />
      </Card>
    </>
  );
}

// ------------------------------------------------------------------------------------------- Backtest

type BtReport = {
  period: { from: number; to: number };
  candles: number;
  initialBalance: number;
  finalBalance: number;
  netProfit: number;
  returnPct: number;
  stats: Stats;
  equityStats: { maxDrawdownPct: number; sharpe: number | null; sortino: number | null };
  signals: {
    generated: number;
    executed: number;
    byModel: Record<string, number>;
    refused: Record<string, number>;
  };
  exitsOn5mPct: number;
  durationMs: number;
  notes: string[];
};

export function BacktestPage({ onAuth }: Auth) {
  const { data, error, reload } = useApi<{
    running: boolean;
    runs: { id: number; segment: string; created_at: number; report: BtReport }[];
  }>("/api/backtests?limit=20", onAuth);
  const [days, setDays] = useState(365);
  const [sel, setSel] = useState<number | null>(null);
  const detail = useApi<{
    report: BtReport;
    equity: { ts: number; equity: number }[];
    trades: {
      side: string;
      model: string;
      openedAt: number;
      closedAt: number;
      pnl: number;
      r: number;
      exitReason: string;
    }[];
  } | null>(sel ? `/api/backtests/${sel}` : "/api/health", onAuth);
  if (!data) return <Loading error={error} />;
  const d = sel && detail.data && "report" in (detail.data as object) ? detail.data : null;
  return (
    <>
      <Card title="Backtest">
        <p className="muted">
          Backtest, botun canlıda kullandığı kuralların aynısını çalıştırır: strateji motoru, ajanlar, risk
          motoru, lot hesabı ve paper broker. Spread, kayma, komisyon ve swap dahildir. Strateji üretmez;
          mevcut stratejinin geçmiş performansını ölçer.
        </p>
        <div className="row">
          <label>
            Gün
            <input
              type="number"
              min={7}
              max={3000}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={data.running}
            onClick={async () => {
              const r = await post<{ started: boolean; reason?: string }>("/api/backtests/run", { days });
              if (!r.started) alert(r.reason);
              reload();
            }}
          >
            {data.running ? "Çalışıyor…" : "Backtest çalıştır"}
          </button>
        </div>
      </Card>
      <Card title="Çalıştırmalar">
        <Table
          rows={data.runs}
          cols={[
            ["#", (r) => r.id],
            ["Zaman", (r) => time(r.created_at)],
            [
              "Dönem",
              (r) =>
                `${time(r.report.period?.from).slice(0, 10)} → ${time(r.report.period?.to).slice(0, 10)}`,
            ],
            ["İşlem", (r) => r.report.stats?.trades],
            ["Net", (r) => <span className={tone(r.report.netProfit)}>{usd(r.report.netProfit)}</span>],
            ["PF", (r) => (r.report.stats?.profitFactor === null ? "—" : num(r.report.stats?.profitFactor))],
            ["Max DD", (r) => `${num(r.report.equityStats?.maxDrawdownPct)}%`],
            [
              "",
              (r) => (
                <button type="button" className="btn" onClick={() => setSel(r.id)}>
                  Rapor
                </button>
              ),
            ],
          ]}
        />
      </Card>
      {d ? (
        <>
          <Card title={`Backtest #${sel} raporu`}>
            <div className="grid">
              <Kpi
                label="Başlangıç → bitiş"
                value={`${usd(d.report.initialBalance)} → ${usd(d.report.finalBalance)}`}
                sub={`${num(d.report.returnPct)}%`}
              />
              <Kpi
                label="Sinyal"
                value={d.report.signals.generated}
                sub={`uygulanan ${d.report.signals.executed}`}
              />
              <Kpi
                label="5m ile simüle edilen çıkışlar"
                value={`${num(d.report.exitsOn5mPct, 0)}%`}
                sub="kalanı 15m mumla"
              />
              <Kpi
                label="Süre"
                value={`${num(d.report.durationMs / 1000, 1)} sn`}
                sub={`${d.report.candles} mum`}
              />
            </div>
            <LineChart points={d.equity.map((e) => ({ t: e.ts, v: e.equity }))} />
            <h3>Reddedilen sinyaller</h3>
            <Table
              rows={Object.entries(d.report.signals.refused)}
              cols={[
                ["Neden", (x) => x[0]],
                ["Adet", (x) => x[1]],
              ]}
            />
            <div className="list">
              {d.report.notes.map((n) => (
                <div key={n} className="item muted">
                  {n}
                </div>
              ))}
            </div>
          </Card>
          <StatsBlock stats={d.report.stats} eq={d.report.equityStats} />
          <Card title="Son işlemler">
            <Table
              rows={d.trades.slice(-100).reverse()}
              cols={[
                ["Kapanış", (t) => time(t.closedAt)],
                ["Model", (t) => modelName(t.model)],
                ["Yön", (t) => t.side],
                ["Çıkış", (t) => t.exitReason],
                ["Net", (t) => <span className={tone(t.pnl)}>{usd(t.pnl)}</span>],
                ["R", (t) => num(t.r)],
              ]}
            />
          </Card>
        </>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------------------------------- Providers, Logs, Settings

export function ProvidersPage({ onAuth }: Auth) {
  const { data, error } = useApi<{
    providers: {
      id: string;
      state: string;
      priority: number;
      basis: string;
      useForTrading: boolean;
      capabilities: { timeframes: string[]; bidAsk: boolean };
      lastOk: number | null;
      lastLatencyMs: number | null;
      lastError: string | null;
    }[];
    budget: { usedToday: number; perDay: number; lastMinute: number; perMinute: number };
    calls24h: AnyRec[];
    quality: { fresh: boolean; missingBars: number };
  }>("/api/providers", onAuth);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="grid">
        <Kpi label="Bugünkü API kredisi" value={`${data.budget.usedToday} / ${data.budget.perDay}`} />
        <Kpi label="Son dakika" value={`${data.budget.lastMinute} / ${data.budget.perMinute}`} />
        <Kpi
          label="Veri kalitesi"
          value={data.quality.fresh ? "taze" : "eski"}
          cls={data.quality.fresh ? "up" : "down"}
          sub={`${data.quality.missingBars} eksik mum`}
        />
      </div>
      <Card title="Data Providers (öncelik sırası)">
        <Table
          rows={data.providers}
          cols={[
            ["Sağlayıcı", (p) => p.id],
            ["Durum", (p) => <Pill v={p.state} />],
            ["Öncelik", (p) => p.priority],
            ["Tür", (p) => p.basis],
            ["İşlemde", (p) => (p.useForTrading ? "evet" : "hayır")],
            ["Zaman dilimleri", (p) => p.capabilities.timeframes.join(" ")],
            ["Bid/ask", (p) => (p.capabilities.bidAsk ? "sağlayıcı" : "modellenmiş")],
            ["Son başarı", (p) => ago(p.lastOk)],
            ["Gecikme", (p) => (p.lastLatencyMs ? `${num(p.lastLatencyMs, 0)} ms` : "—")],
            ["Son hata", (p) => p.lastError ?? "", "wrap"],
          ]}
        />
      </Card>
      <Card title="Son 24 saatteki çağrılar">
        <Table
          rows={data.calls24h}
          cols={[
            ["Sağlayıcı", (x) => String(x.provider)],
            ["Çağrı", (x) => String(x.calls)],
            ["Başarılı", (x) => String(x.ok)],
            ["Ort. gecikme", (x) => `${num(x.avg_latency_ms, 0)} ms`],
            ["Kredi", (x) => String(x.credits)],
            ["Son başarı", (x) => ago(x.last_ok)],
            ["Son hata", (x) => ago(x.last_fail)],
          ]}
        />
      </Card>
    </>
  );
}

export function LogsPage({ onAuth }: Auth) {
  const [level, setLevel] = useState(() => sessionStorage.getItem("qf.level") ?? "");
  const { data, error } = useApi<{
    system: AnyRec[];
    health: {
      pid: number;
      node: string;
      platform: string;
      uptimeSec: number;
      memoryMb: { rss: number; heapUsed: number };
      eventLoopLagMs: { p99: number };
      jobs: Record<string, { ts: number; ok: boolean; durationMs: number; detail: string }>;
    };
  }>(`/api/logs?limit=150${level ? `&level=${level}` : ""}`, onAuth);
  if (!data) return <Loading error={error} />;
  const h = data.health;
  return (
    <>
      <div className="grid">
        <Kpi label="Süreç" value={`PID ${h.pid}`} sub={`${h.node} · ${h.platform}`} />
        <Kpi label="Çalışma süresi" value={`${num(h.uptimeSec / 3600, 1)} sa`} />
        <Kpi
          label="Bellek (RSS)"
          value={`${num(h.memoryMb.rss, 0)} MB`}
          sub={`heap ${num(h.memoryMb.heapUsed, 0)} MB`}
        />
        <Kpi label="Event-loop gecikmesi p99" value={`${h.eventLoopLagMs.p99} ms`} />
      </div>
      <Card title="Görevler">
        <Table
          rows={Object.entries(h.jobs)}
          cols={[
            ["Görev", (x) => x[0]],
            ["Son çalışma", (x) => ago(x[1].ts)],
            ["Durum", (x) => <Pill v={x[1].ok ? "ok" : "error"} />],
            ["Süre", (x) => `${x[1].durationMs} ms`],
            ["Detay", (x) => x[1].detail, "wrap"],
          ]}
        />
      </Card>
      <Card
        title="System Logs"
        actions={
          <select
            value={level}
            onChange={(e) => {
              sessionStorage.setItem("qf.level", e.target.value);
              setLevel(e.target.value);
            }}
          >
            {["", "info", "warn", "error", "critical"].map((x) => (
              <option key={x} value={x}>
                {x || "tüm seviyeler"}
              </option>
            ))}
          </select>
        }
      >
        <Table
          rows={data.system}
          cols={[
            ["Zaman", (e) => time(e.ts)],
            ["Seviye", (e) => <Pill v={e.level} />],
            ["Kaynak", (e) => String(e.source)],
            ["Mesaj", (e) => String(e.message), "wrap"],
          ]}
        />
      </Card>
    </>
  );
}

const RISK_FIELDS = [
  "riskPerTradePct",
  "maxDailyLossPct",
  "maxWeeklyLossPct",
  "maxDrawdownPct",
  "maxOpenPositions",
  "maxTradesPerDay",
  "maxConsecutiveLosses",
  "maxSpread",
] as const;

export function SettingsPage({ onAuth }: Auth) {
  const { data, error, reload } = useApi<{
    config: { risk: Record<string, number>; strategy: { minScore: number; models: Record<string, boolean> } };
    versions: AnyRec[];
    live: { effectiveMode: string; checks: { name: string; passed: boolean; detail: string }[] };
    backups: { file: string; bytes: number; mtime: number; encrypted: boolean }[];
    paths: { home: string; db: string };
  }>("/api/settings", onAuth);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});
  if (!data) return <Loading error={error} />;
  const value = (k: string) => form[k] ?? String(data.config.risk[k] ?? "");
  return (
    <>
      <Card title="Risk ayarları">
        <div className="form">
          {RISK_FIELDS.map((f) => (
            <label key={f}>
              {f}
              <input
                type="number"
                step="any"
                value={value(f)}
                onChange={(e) => setForm({ ...form, [f]: e.target.value })}
              />
            </label>
          ))}
          <label>
            minScore (sinyal puanı)
            <input
              type="number"
              step="1"
              value={form.minScore ?? String(data.config.strategy.minScore)}
              onChange={(e) => setForm({ ...form, minScore: e.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              try {
                const risk = Object.fromEntries(RISK_FIELDS.map((f) => [f, Number(value(f))]));
                const out = await post<{ note: string }>("/api/settings", {
                  risk,
                  strategy: { minScore: Number(form.minScore ?? data.config.strategy.minScore) },
                });
                setMsg(out.note);
                reload();
              } catch (e) {
                setMsg((e as Error).message);
              }
            }}
          >
            Kaydet
          </button>
          <span className="muted">
            {msg ||
              "İşlem başı risk %0,25–1 aralığıyla sınırlıdır. Değişiklikler ./restart.sh sonrası geçerli olur."}
          </span>
        </div>
      </Card>
      <Card title="Canlı işlem kilidi">
        <p>
          Etkin mod: <b>{data.live.effectiveMode.toUpperCase()}</b>
        </p>
        <Table
          rows={data.live.checks}
          cols={[
            ["Kontrol", (c) => c.name],
            ["Durum", (c) => <Pill v={c.passed ? "ok" : "rejected"} />],
            ["Detay", (c) => c.detail, "wrap"],
          ]}
        />
        <p className="muted">
          Canlı işlem buradan açılamaz; bkz. docs/quantforge/LIVE_TRADING_PREPARATION.md.
        </p>
      </Card>
      <Card
        title="Yedekler"
        actions={
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const b = await post<{ file: string }>("/api/backup");
              alert(`Yedek: ${b.file}`);
              reload();
            }}
          >
            Şimdi yedekle
          </button>
        }
      >
        <Table
          rows={data.backups}
          cols={[
            ["Dosya", (b) => <code>{b.file}</code>, "wrap"],
            ["Boyut", (b) => `${num(b.bytes / 1024, 0)} KB`],
            ["Zaman", (b) => time(b.mtime)],
            ["Şifreli", (b) => (b.encrypted ? "evet" : "hayır")],
          ]}
        />
      </Card>
      <Card title="Ayar sürümleri">
        <Table
          rows={data.versions}
          cols={[
            ["#", (v) => String(v.id)],
            ["Zaman", (v) => time(v.ts)],
            ["Hash", (v) => <code>{String(v.hash)}</code>],
            ["Kaynak", (v) => String(v.source)],
          ]}
        />
      </Card>
      <Card title="Etkin yapılandırma">
        <pre>{JSON.stringify(data.config, null, 2)}</pre>
        <p className="muted">
          Ana klasör: <code>{data.paths.home}</code> · veritabanı: <code>{data.paths.db}</code>
        </p>
      </Card>
    </>
  );
}

export type { Col };
