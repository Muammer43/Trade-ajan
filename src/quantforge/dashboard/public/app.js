// QuantForge AI Pro dashboard (no build step, no external assets). Every figure shown comes from the API;
// a value the application does not have is shown as "—", never estimated.

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const num = (v, d = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? "—"
    : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 1) => (v === null || v === undefined ? "—" : `${num(Number(v) * 100, d)}%`);
const usd = (v) =>
  v === null || v === undefined ? "—" : `${Number(v) < 0 ? "−" : ""}$${num(Math.abs(Number(v)))}`;
const signCls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
const time = (ts) => (ts ? `${new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 16)}Z` : "—");
const ago = (ts) => {
  if (!ts) return "never";
  const s = Math.round((Date.now() - Number(ts)) / 1000);
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.round(s / 60)} min ago`
      : s < 86400
        ? `${Math.round(s / 3600)} h ago`
        : `${Math.round(s / 86400)} d ago`;
};
const pill = (t) => `<span class="pill ${esc(t)}">${esc(t)}</span>`;
const kpi = (label, value, sub = "", cls = "") =>
  `<div class="kpi"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
const table = (cols, rows) =>
  `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join("")}</tr></thead><tbody>${
    rows.length
      ? rows
          .map((r) => `<tr>${cols.map((c) => `<td class="${c[2] ?? ""}">${c[1](r)}</td>`).join("")}</tr>`)
          .join("")
      : `<tr><td colspan="${cols.length}" class="muted">No records yet.</td></tr>`
  }</tbody></table></div>`;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-QF-Request": "1", ...(opts.headers ?? {}) },
    credentials: "same-origin",
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("login required");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

// ------------------------------------------------------------------------------------ charts (canvas)

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function candleChart(canvas, bars) {
  if (!canvas || !bars.length) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 6, r: 58, t: 8, b: 18 };
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  const y = (p) => pad.t + ((hi - p) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const step = (w - pad.l - pad.r) / bars.length;
  ctx.font = "11px system-ui";
  ctx.fillStyle = "#8193a8";
  ctx.strokeStyle = "#233041";
  for (let k = 0; k <= 4; k++) {
    const p = lo + ((hi - lo) * k) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(p));
    ctx.lineTo(w - pad.r, y(p));
    ctx.stroke();
    ctx.fillText(p.toFixed(2), w - pad.r + 4, y(p) + 4);
  }
  bars.forEach((b, i) => {
    const x = pad.l + i * step + step / 2;
    const up = b.c >= b.o;
    ctx.strokeStyle = ctx.fillStyle = !b.open ? "#3a4656" : up ? "#2fbf71" : "#e5534b";
    ctx.beginPath();
    ctx.moveTo(x, y(b.h));
    ctx.lineTo(x, y(b.l));
    ctx.stroke();
    const bw = Math.max(1, step * 0.65);
    ctx.fillRect(x - bw / 2, Math.min(y(b.o), y(b.c)), bw, Math.max(1, Math.abs(y(b.o) - y(b.c))));
  });
  const last = bars[bars.length - 1];
  ctx.fillStyle = "#8193a8";
  ctx.fillText(time(bars[0].ts), pad.l, h - 4);
  const lt = time(last.ts);
  ctx.fillText(lt, w - pad.r - ctx.measureText(lt).width, h - 4);
}

function lineChart(canvas, points, color = "#e3b341") {
  if (!canvas || points.length < 2) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 6, r: 62, t: 8, b: 18 };
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + ((hi - v) / (hi - lo || 1)) * (h - pad.t - pad.b);
  ctx.font = "11px system-ui";
  ctx.strokeStyle = "#233041";
  ctx.fillStyle = "#8193a8";
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
    ctx.fillText(v.toFixed(2), w - pad.r + 4, y(v) + 4);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i) ctx.lineTo(x(p.t), y(p.v));
    else ctx.moveTo(x(p.t), y(p.v));
  });
  ctx.stroke();
  ctx.fillStyle = "#8193a8";
  ctx.fillText(time(t0), pad.l, h - 4);
}

// ------------------------------------------------------------------------------------ pages

const pages = {
  async overview() {
    const o = await api("/api/overview");
    const q = o.quote;
    const s = o.stats;
    const r = o.risk;
    const ld = o.lastDecision;
    const killed = r.controls.killSwitch.on;
    return {
      html: `
      ${killed ? `<div class="notice bad"><b>Kill switch engaged:</b> ${esc(r.controls.killSwitch.reason)}</div>` : ""}
      ${!o.activeStrategies.length ? `<div class="notice">No validated strategy is active. Discovery has not demonstrated a statistically robust edge, so every decision is NO TRADE. This is the intended behaviour.</div>` : ""}
      <div class="card"><div class="row"><div><div class="muted">XAUUSD ${q?.delayed ? "(last closed bar)" : "(live)"}</div><div class="price">${q ? num(q.price) : "—"}</div>
        <div class="muted">bid ${q ? num(q.bid) : "—"} · ask ${q ? num(q.ask) : "—"} · spread ${q ? num(q.spread) : "—"} (${esc(q?.spreadSource ?? "—")}) · ${o.marketOpen ? `market open, ${o.minutesToClose} min to close` : "market closed"}</div></div></div></div>
      <div class="grid">
        ${kpi("Trading mode", `<span class="${o.mode === "live" ? "down" : "gold"}">${esc(o.mode.toUpperCase())}</span>`, o.requestedMode !== o.mode ? `requested ${esc(o.requestedMode)}; live gate closed` : "")}
        ${kpi("Market regime", esc(o.regime ?? "—"), o.regimeTs ? ago(o.regimeTs) : "")}
        ${kpi("Active strategy", o.activeStrategies.length ? esc(o.activeStrategies.map((x) => x.id).join(", ")) : "none", `${o.activeStrategies.length} active`)}
        ${kpi("AI decision", ld ? pill(ld.action) : "—", ld ? `${time(ld.bar_ts)} · conf ${num(ld.confidence)}` : "")}
        ${kpi("Balance", usd(o.account.balance), `initial ${usd(o.account.initialBalance)}`)}
        ${kpi("Equity", usd(o.account.equity), `free margin ${usd(o.account.freeMargin)}`)}
        ${kpi("Realized PnL", usd(o.account.realizedPnl), "", signCls(o.account.realizedPnl))}
        ${kpi("Unrealized PnL", usd(o.account.unrealized), "", signCls(o.account.unrealized))}
        ${kpi("Win rate", pct(s.winRate), `${s.trades} closed trades`)}
        ${kpi("Profit factor", s.profitFactor === null ? "—" : num(s.profitFactor))}
        ${kpi("Expectancy", s.expectancyUsd === null ? "—" : usd(s.expectancyUsd), s.expectancyR === null ? "" : `${num(s.expectancyR, 3)} R`)}
        ${kpi("Max drawdown", `${num(s.maxDrawdownPct)}%`)}
        ${kpi("Open positions", String(o.openPositions), `open risk ${usd(r.openRiskUsd)}`)}
        ${kpi("Daily risk usage", `${num(r.dailyRiskUsedPct, 0)}%`, `loss today ${num(r.dayLossPct)}% of ${num(r.maxDailyLossPct, 1)}% limit`)}
        ${kpi("Data providers", o.providers.map((p) => `${pill(p.state)} ${esc(p.id)}`).join("<br>"))}
        ${kpi("Last successful update", o.lastSuccessfulUpdate ? ago(o.lastSuccessfulUpdate) : "never", `API ${o.apiBudget.usedToday}/${o.apiBudget.perDay} credits today`)}
      </div>
      ${ld ? `<div class="card"><h2>Latest decision reasons</h2><div class="list">${ld.reasons.map((x) => `<div class="item">${esc(x)}</div>`).join("")}</div></div>` : ""}
      ${o.lastError ? `<div class="notice bad">Last error: ${esc(o.lastError)}</div>` : ""}`,
    };
  },

  async market() {
    const tf = sessionStorage.getItem("qf.tf") || "15m";
    const m = await api(`/api/market?tf=${tf}&limit=160`);
    const qd = m.quality;
    return {
      html: `<div class="card"><div class="row"><h2>XAUUSD ${esc(tf)}</h2><span class="muted">${m.quote ? `${num(m.quote.price)} ${m.quote.delayed ? "(last closed bar)" : ""}` : ""}</span>
        <div class="row">${["5m", "15m", "1h", "4h"].map((x) => `<button class="btn ${x === tf ? "primary" : ""}" data-tf="${x}">${x}</button>`).join("")}</div></div>
        <canvas id="cc" class="chart"></canvas><p class="muted">Grey bars: provider quotes while the spot market is closed (excluded from analysis).</p></div>
        <div class="grid">${kpi("Bars checked", qd.bars)}${kpi("Missing bars", qd.missingBars, "inside market hours", qd.missingBars ? "warn" : "")}${kpi("Stale-quote bars", qd.staleQuoteBars)}${kpi("Data freshness", qd.fresh ? "fresh" : "stale", `${num(qd.ageBars, 1)} bars old`, qd.fresh ? "up" : "down")}</div>
        <div class="card"><h2>Recent bars</h2>${table(
          [
            ["Open time", (b) => time(b.ts)],
            ["Open", (b) => num(b.o)],
            ["High", (b) => num(b.h)],
            ["Low", (b) => num(b.l)],
            ["Close", (b) => num(b.c)],
            ["Quality", (b) => pill(b.q)],
          ],
          m.bars.slice(-25).reverse(),
        )}</div>`,
      after() {
        candleChart($("#cc"), m.bars);
        for (const b of view.querySelectorAll("[data-tf]")) {
          b.addEventListener("click", () => {
            sessionStorage.setItem("qf.tf", b.dataset.tf);
            render();
          });
        }
      },
    };
  },

  async agents() {
    const a = await api("/api/agents");
    const byId = Object.fromEntries(a.reports.map((r) => [r.agent, r]));
    return {
      html: `<div class="card"><h2>Agent assessments ${a.decisionId ? `(decision #${a.decisionId})` : ""}</h2><p class="muted">Agents analyze structured market data and can only argue for caution; the deterministic risk engine decides. LLM review: ${a.llm.enabled ? `enabled (${esc(a.llm.provider)}/${esc(a.llm.model)})` : "disabled"}.</p></div>
      <div class="grid wide">${a.catalogue
        .map((c) => {
          const r = byId[c.id];
          return `<div class="card"><h2>${esc(c.label)} ${r ? pill(r.status) : ""}</h2><p class="muted">${esc(c.responsibility)}</p>
          ${
            r
              ? `<div class="row"><span>bias <b class="${signCls(r.bias)}">${num(r.bias)}</b></span><span>confidence <b>${num(r.confidence)}</b></span><span class="muted">${num(r.duration_ms, 0)} ms</span></div>
          <p>${esc(r.summary)}</p>${r.veto ? `<div class="notice bad">Veto: ${esc(r.veto)}</div>` : ""}
          <details><summary>Evidence (${r.evidence.length})</summary>${table(
            [
              ["id", (e) => `<code>${esc(e.id)}</code>`],
              ["label", (e) => esc(e.label)],
              ["value", (e) => esc(typeof e.value === "number" ? num(e.value, 4) : e.value)],
            ],
            r.evidence,
          )}</details>`
              : `<p class="muted">No report yet.</p>`
          }
          <p class="muted">In: ${esc(c.inputs)}<br>Out: ${esc(c.outputs)}</p></div>`;
        })
        .join("")}</div>`,
    };
  },

  async discovery() {
    const d = await api("/api/discovery");
    const strategies = await api("/api/strategies?limit=60");
    const last = d.runs.find((r) => r.status === "finished");
    const sum = last?.summary;
    return {
      html: `<div class="card"><div class="row"><h2>Strategy discovery</h2><button class="btn primary" id="run-disc" ${d.running ? "disabled" : ""}>${d.running ? "Running…" : "Run discovery now"}</button></div>
        ${
          sum
            ? `<div class="notice ${sum.validated ? "good" : ""}">${esc(sum.conclusion)}</div>
        <div class="grid">${kpi("Candidates tested", sum.candidates, `${sum.signalConfigs} signal configurations`)}${kpi("Passed training screen", sum.passedTrain)}${kpi("Confirmed out-of-sample (FDR)", sum.passedValidation)}${kpi("Validated (all gates)", sum.validated)}${kpi("Data", `${sum.bars} bars`, `${time(sum.dataFrom)} → ${time(sum.dataTo)}`)}${kpi("Run time", `${num(sum.durationMs / 1000, 1)} s`)}</div>
        <h3>Segments</h3><p class="mono">train ${time(sum.segments.train[0])} → ${time(sum.segments.train[1])}<br>validation ${time(sum.segments.validation[0])} → ${time(sum.segments.validation[1])}<br>test (holdout) ${time(sum.segments.test[0])} → ${time(sum.segments.test[1])}</p>
        <h3>Rejection reasons</h3>${table(
          [
            ["reason", (x) => esc(x[0])],
            ["candidates", (x) => x[1]],
          ],
          Object.entries(sum.rejectionCounts).sort((a, b) => b[1] - a[1]),
        )}`
            : `<p class="muted">No finished discovery run yet. It needs at least 3000 clean decision bars; the history backfill runs at start-up.</p>`
        }
      </div>
      <div class="card"><h2>Runs</h2>${table(
        [
          ["#", (r) => r.id],
          ["started", (r) => time(r.started_at)],
          ["status", (r) => pill(r.status)],
          ["bars", (r) => r.bars ?? "—"],
          ["candidates", (r) => r.candidates ?? "—"],
          ["validated", (r) => r.validated ?? "—"],
          ["error", (r) => esc(r.error ?? ""), "wrap"],
        ],
        d.runs,
      )}</div>
      <div class="card"><h2>Candidates that passed the training screen</h2>${table(
        [
          ["strategy", (s) => `<a href="#strategy/${esc(s.id)}"><code>${esc(s.id)}</code></a>`],
          ["status", (s) => pill(s.status)],
          ["train E (R)", (s) => num(s.metrics?.expectancyR, 3)],
          ["train PF", (s) => num(s.metrics?.profitFactor)],
          ["valid E (R)", (s) => num(s.validation?.validation?.expectancyR, 3)],
          ["trades", (s) => s.metrics?.trades ?? "—"],
          ["rejected by", (s) => esc((s.rejection ?? []).join(", ")), "wrap"],
        ],
        strategies,
      )}</div>`,
      after() {
        $("#run-disc")?.addEventListener("click", async () => {
          const r = await post("/api/discovery/run");
          alert(r.started ? "Discovery started in the background." : r.reason);
          render();
        });
      },
    };
  },

  async strategy(id) {
    const s = await api(`/api/strategies/${encodeURIComponent(id)}`);
    const v = s.validation ?? {};
    return {
      html: `<div class="card"><div class="row"><h2><code>${esc(s.id)}</code> ${pill(s.status)}</h2>
        ${s.status === "active" ? `<button class="btn" id="deact">Deactivate</button>` : !s.rejection.length && (s.status === "validated" || s.status === "retired") ? `<button class="btn primary" id="act">Activate</button>` : ""}</div>
        ${s.rules ? `<div class="list"><div class="item"><b>Entry:</b> ${esc(s.rules.entry)}</div><div class="item"><b>Stop-loss:</b> ${esc(s.rules.stop)}</div><div class="item"><b>Take-profit:</b> ${esc(s.rules.takeProfit)}</div><div class="item"><b>Exit:</b> ${esc(s.rules.exit)}</div><div class="item"><b>Filters / regimes:</b> ${esc(s.rules.filters)}</div></div>` : ""}
        ${s.rejection.length ? `<div class="notice bad">Rejected: ${esc(s.rejection.join(", "))}</div>` : ""}</div>
      <div class="grid">${["train", "validation", "test"]
        .map((seg) => {
          const m = seg === "train" ? s.metrics : v[seg];
          return m
            ? kpi(
                seg,
                `${num(m.expectancyR, 3)} R`,
                `n=${m.trades} · PF ${num(m.profitFactor)} · WR ${pct(m.winRate)} · DD ${num(m.maxDrawdownPct)}% · Sharpe ${num(m.sharpe)} · Sortino ${num(m.sortino)} · avg ${num(m.avgBarsHeld, 1)} bars`,
              )
            : kpi(seg, "—", seg === "test" ? "holdout only evaluated for finalists" : "");
        })
        .join("")}</div>
      <div class="card"><h2>Validation gates</h2>${table(
        [
          ["gate", (g) => esc(g.gate)],
          ["result", (g) => pill(g.passed ? "ok" : "rejected")],
          ["detail", (g) => esc(g.detail), "wrap"],
        ],
        v.gates ?? [],
      )}</div>
      ${v.monteCarlo ? `<div class="grid">${kpi("Monte Carlo P(profit)", pct(v.monteCarlo.probProfit))}${kpi("MC 95th pct max DD", `${num(v.monteCarlo.p95MaxDrawdownPct)}%`)}${kpi("Expectancy 90% CI", v.expectancyCi ? `${num(v.expectancyCi.low, 3)} … ${num(v.expectancyCi.high, 3)} R` : "—")}${kpi("Deflated Sharpe", v.dsr ? num(v.dsr.dsr, 3) : "—", v.dsr ? `${v.dsr.trials} trials` : "")}</div>` : ""}
      ${
        v.combined?.byRegime
          ? `<div class="card"><h2>Regime-specific performance (train + validation)</h2>${table(
              [
                ["regime", (x) => esc(x[0])],
                ["trades", (x) => x[1].trades],
                ["expectancy (R)", (x) => num(x[1].expectancyR, 3)],
                ["win rate", (x) => pct(x[1].winRate)],
              ],
              Object.entries(v.combined.byRegime),
            )}</div>`
          : ""
      }
      <div class="card"><h2>Spec</h2><pre>${esc(JSON.stringify(s.spec, null, 2))}</pre></div>`,
      after() {
        $("#act")?.addEventListener("click", async () => {
          const r = await post(`/api/strategies/${encodeURIComponent(id)}/activate`);
          if (!r.ok) alert(r.reason);
          render();
        });
        $("#deact")?.addEventListener("click", async () => {
          await post(`/api/strategies/${encodeURIComponent(id)}/deactivate`);
          render();
        });
      },
    };
  },

  async lab() {
    const families = {
      disp_cont: { k: 1.5, clv: 0.5 },
      disp_fade: { k: 1.5, clv: 0.5 },
      sweep_reject: { n: 24, w: 0.5 },
      breakout_fail: { n: 48, m: 2 },
      squeeze_break: { c: 0.8, r: 1.5 },
      zrevert: { k: 2, e: 0.3 },
      momentum_persist: { e: 0.45 },
      session_drive: { session: 1, k: 1, fade: 0 },
      streak_fade: { n: 4 },
      streak_follow: { n: 4 },
    };
    return {
      html: `<div class="card"><h2>Strategy laboratory</h2><p class="muted">Backtest a hand-specified rule set over the stored history with realistic costs. Exploration only: lab results cannot activate a strategy.</p>
        <form id="lab" class="form">
          <label>Family<select name="family">${Object.keys(families)
            .map((f) => `<option>${f}</option>`)
            .join("")}</select></label>
          <label>Parameters (JSON)<input name="params" value='${esc(JSON.stringify(families.disp_cont))}'></label>
          <label>Session<select name="session"><option>all</option><option>london_ny</option><option>asia</option></select></label>
          <label>Regime<select name="regime"><option>any</option><option>trending</option><option>ranging</option><option>not_strong</option></select></label>
          <label>4h alignment<select name="htfAlign"><option value="false">no</option><option value="true">yes</option></select></label>
          <label>Stop (ATR)<input name="slAtr" type="number" step="0.25" value="1.5"></label>
          <label>Target (R)<input name="tpR" type="number" step="0.25" value="1.5"></label>
          <label>Max bars<input name="maxBars" type="number" value="16"></label>
          <label>Partial at R (blank = none)<input name="partialR" type="number" step="0.25"></label>
          <label>Trail ATR (blank = none)<input name="trailAtr" type="number" step="0.25"></label>
          <label>Cost multiplier<input name="costMultiplier" type="number" step="0.25" value="1"></label>
          <label>&nbsp;<button class="btn primary" type="submit">Run backtest</button></label>
        </form><p id="lab-err" class="error"></p></div><div id="lab-out"></div>`,
      after() {
        const form = $("#lab");
        form.family.addEventListener(
          "change",
          () => (form.params.value = JSON.stringify(families[form.family.value])),
        );
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          $("#lab-err").textContent = "";
          try {
            const n = (x) => (x === "" ? null : Number(x));
            const partialR = n(form.partialR.value);
            const body = {
              family: form.family.value,
              params: JSON.parse(form.params.value),
              session: form.session.value,
              regime: form.regime.value,
              htfAlign: form.htfAlign.value === "true",
              exit: {
                slAtr: Number(form.slAtr.value),
                tpR: Number(form.tpR.value),
                maxBars: Number(form.maxBars.value),
                breakEvenR: null,
                partialR,
                partialFrac: partialR ? 0.5 : 0,
                trailAtr: n(form.trailAtr.value),
              },
              costMultiplier: Number(form.costMultiplier.value),
            };
            $("#lab-out").innerHTML = `<div class="card muted">Running…</div>`;
            const r = await post("/api/lab/backtest", body);
            const m = r.metrics;
            $("#lab-out").innerHTML =
              `<div class="notice">${esc(r.caveat)}</div><div class="grid">${kpi("Trades", m.trades)}${kpi("Expectancy", `${num(m.expectancyR, 3)} R`)}${kpi("Profit factor", num(m.profitFactor))}${kpi("Win rate", pct(m.winRate))}${kpi("Max DD", `${num(m.maxDrawdownPct)}%`)}${kpi("Sharpe / Sortino", `${num(m.sharpe)} / ${num(m.sortino)}`)}${kpi("Avg R", num(m.avgR, 3), `cost ${num(m.costR, 3)} R/trade`)}${kpi("p-value", num(m.pValue, 4), "one test, no multiple-testing correction")}</div>
              <div class="card"><h2>Equity (1% risk per trade)</h2><canvas id="lab-eq" class="chart small"></canvas></div>
              <div class="card"><h2>Last trades</h2>${table(
                [
                  ["entry", (t) => time(t.entryTs)],
                  ["side", (t) => esc(t.side)],
                  ["exit", (t) => esc(t.reason)],
                  ["net R", (t) => `<span class="${signCls(t.netR)}">${num(t.netR, 2)}</span>`],
                  ["bars", (t) => t.barsHeld],
                  ["regime", (t) => esc(t.regime)],
                ],
                r.trades.slice().reverse(),
              )}</div>`;
            lineChart(
              $("#lab-eq"),
              r.equity.map((p) => ({ t: p.ts, v: p.equity })),
            );
          } catch (err) {
            $("#lab-out").innerHTML = "";
            $("#lab-err").textContent = err.message;
          }
        });
      },
    };
  },

  async backtests() {
    const b = await api("/api/backtests?limit=50");
    return {
      html: `<div class="card"><h2>Backtests</h2><p class="muted">Lab runs and stored strategy backtests. Every figure is net of spread, slippage, commission and swap.</p>${table(
        [
          ["#", (x) => x.id],
          ["strategy", (x) => `<code>${esc(x.strategy_id)}</code>`],
          ["segment", (x) => esc(x.segment)],
          ["when", (x) => time(x.created_at)],
          ["trades", (x) => x.metrics.trades],
          ["E (R)", (x) => num(x.metrics.expectancyR, 3)],
          ["PF", (x) => num(x.metrics.profitFactor)],
          ["WR", (x) => pct(x.metrics.winRate)],
          ["max DD", (x) => `${num(x.metrics.maxDrawdownPct)}%`],
        ],
        b,
      )}</div>`,
    };
  },

  async paper() {
    const p = await api("/api/paper?limit=60");
    return {
      html: `<div class="grid">${kpi("Balance", usd(p.account.balance))}${kpi("Equity", usd(p.account.equity))}${kpi("Realized PnL", usd(p.account.realizedPnl), "", signCls(p.account.realizedPnl))}${kpi("Ledger check", p.ledgerCheck.ok ? "consistent" : "MISMATCH", `balance ${usd(p.ledgerCheck.balance)} = Σ transactions ${usd(p.ledgerCheck.sum)}`, p.ledgerCheck.ok ? "up" : "down")}</div>
      <div class="notice">Paper trading fills against real XAU/USD prices. Twelve Data publishes no bid/ask for XAU/USD, so bid/ask are modelled from the configured spread; slippage, commission and swap are configured to match your broker. No order is ever sent to a broker.</div>
      <div class="card"><h2>Orders</h2>${table(
        [
          ["#", (o) => o.id],
          ["time", (o) => time(o.created_at)],
          ["side", (o) => esc(o.side)],
          ["lots", (o) => num(o.lots)],
          ["status", (o) => pill(o.status)],
          ["fill", (o) => num(o.fill_price)],
          ["reference", (o) => num(o.reference_price)],
          ["slippage", (o) => num(o.slippage)],
          ["reason", (o) => esc(o.reject_reason ?? ""), "wrap"],
        ],
        p.orders,
      )}</div>
      <div class="card"><h2>Transaction ledger</h2>${table(
        [
          ["#", (t) => t.id],
          ["time", (t) => time(t.ts)],
          ["type", (t) => esc(t.type)],
          ["amount", (t) => `<span class="${signCls(t.amount)}">${usd(t.amount)}</span>`],
          ["balance", (t) => usd(t.balance_after)],
          ["position", (t) => t.position_id ?? ""],
          ["note", (t) => esc(t.note ?? ""), "wrap"],
        ],
        p.transactions,
      )}</div>`,
    };
  },

  async history() {
    const t = await api("/api/trades?limit=200");
    return {
      html: `<div class="card"><h2>Closed trades</h2>${table(
        [
          ["#", (p) => p.id],
          ["opened", (p) => time(p.opened_at)],
          ["closed", (p) => time(p.closed_at)],
          ["strategy", (p) => `<code>${esc(p.strategy_id ?? "")}</code>`],
          ["side", (p) => esc(p.side)],
          ["lots", (p) => num(p.lots_initial)],
          ["entry", (p) => num(p.entry_price)],
          ["exit", (p) => num(p.exit_price)],
          ["reason", (p) => esc(p.exit_reason)],
          [
            "net",
            (p) =>
              `<span class="${signCls(p.realized_pnl - p.commission + p.swap)}">${usd(p.realized_pnl - p.commission + p.swap)}</span>`,
          ],
          ["R", (p) => num(p.r_multiple)],
        ],
        t,
      )}</div>`,
    };
  },

  async positions() {
    const ps = await api("/api/positions");
    return {
      html: `<div class="card"><div class="row"><h2>Open positions</h2>${ps.length ? `<button class="btn danger" id="close-all">Close all</button>` : ""}</div>${table(
        [
          ["#", (p) => p.id],
          ["opened", (p) => time(p.opened_at)],
          ["strategy", (p) => `<code>${esc(p.strategy_id ?? "")}</code>`],
          ["side", (p) => esc(p.side)],
          ["lots", (p) => num(p.lots_open)],
          ["entry", (p) => num(p.entry_price)],
          ["stop", (p) => num(p.sl)],
          ["target", (p) => num(p.tp)],
          ["unrealized", (p) => `<span class="${signCls(p.unrealized)}">${usd(p.unrealized)}</span>`],
          ["bars", (p) => p.bars_held],
          ["", (p) => `<button class="btn" data-close="${p.id}">Close</button>`],
        ],
        ps,
      )}</div>`,
      after() {
        $("#close-all")?.addEventListener("click", async () => {
          if (confirm("Close every paper position at the current price?")) {
            await post("/api/positions/close-all");
            render();
          }
        });
        for (const b of view.querySelectorAll("[data-close]")) {
          b.addEventListener("click", async () => {
            const r = await post(`/api/positions/${b.dataset.close}/close`);
            if (!r.ok) alert(r.reason);
            render();
          });
        }
      },
    };
  },

  async risk() {
    const r = await api("/api/risk?limit=40");
    const c = r.controls;
    const a = r.account;
    const dd = a.peakEquity > 0 ? (1 - a.equity / a.peakEquity) * 100 : 0;
    const day = a.dayStartEquity > 0 ? (1 - a.equity / a.dayStartEquity) * 100 : 0;
    const gauge = (label, v, lim) =>
      `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${num(v)}% <span class="muted">/ ${num(lim, 1)}%</span></div><div class="bar"><i data-w="${Math.min(100, Math.max(0, (v / lim) * 100))}"></i></div></div>`;
    return {
      html: `<div class="card"><div class="row"><h2>Global kill switch</h2>${c.killSwitch.on ? `<button class="btn" id="ks-off">Release</button>` : `<button class="btn danger" id="ks-on">Engage and flatten</button>`}</div>
        <p>${c.killSwitch.on ? `<span class="down">ENGAGED</span> — ${esc(c.killSwitch.reason)} (${time(c.killSwitch.ts)})` : "Off"}</p>
        <p class="muted">Circuit breaker: ${c.circuitBreaker.until && c.circuitBreaker.until > Date.now() ? `${esc(c.circuitBreaker.reason)} until ${time(c.circuitBreaker.until)}` : "clear"} · Cooldown: ${c.cooldownUntil && c.cooldownUntil > Date.now() ? `until ${time(c.cooldownUntil)}` : "clear"}</p></div>
      <div class="grid">${gauge("Drawdown from peak", dd, r.config.maxDrawdownPct)}${gauge("Loss today", day, r.config.maxDailyLossPct)}${kpi("Trades today", `${a.tradesToday} / ${r.config.maxTradesPerDay}`)}${kpi("Consecutive losses", `${a.consecutiveLosses} / ${r.config.maxConsecutiveLosses}`)}${kpi("Open positions", `${a.openPositions.length} / ${r.config.maxOpenPositions}`)}${kpi("Risk per trade", `${num(r.config.riskPerTradePct)}%`, `${esc(r.config.profile)} profile`)}</div>
      <div class="card"><h2>Limits</h2>${table(
        [
          ["rule", (x) => esc(x[0])],
          ["value", (x) => esc(String(x[1]))],
        ],
        Object.entries(r.config),
      )}</div>
      <div class="card"><h2>Contract specification & costs</h2>${table(
        [
          ["field", (x) => esc(x[0])],
          ["value", (x) => esc(String(x[1]))],
        ],
        [...Object.entries(r.instrument), ...Object.entries(r.costs)],
      )}</div>
      <div class="card"><h2>Risk events</h2>${table(
        [
          ["time", (e) => time(e.ts)],
          ["kind", (e) => esc(e.kind)],
          ["severity", (e) => pill(e.severity)],
          ["detail", (e) => `<code>${esc(e.detail_json ?? "")}</code>`, "wrap"],
        ],
        r.events,
      )}</div>`,
      after() {
        for (const i of view.querySelectorAll(".bar > i")) i.style.width = `${i.dataset.w}%`;
        $("#ks-on")?.addEventListener("click", async () => {
          if (confirm("Engage the kill switch and close all paper positions?")) {
            await post("/api/risk/kill-switch", { on: true, reason: "manual (dashboard)", flatten: true });
            render();
          }
        });
        $("#ks-off")?.addEventListener("click", async () => {
          await post("/api/risk/kill-switch", { on: false, reason: "released (dashboard)" });
          render();
        });
      },
    };
  },

  async performance() {
    const p = await api("/api/performance");
    const dr = p.dailyRisk;
    return {
      html: `<div class="grid">${kpi("Closed trades", p.trades)}${kpi("Win rate", pct(p.winRate))}${kpi("Profit factor", p.profitFactor === null ? "—" : num(p.profitFactor))}${kpi("Expectancy", p.expectancyUsd === null ? "—" : usd(p.expectancyUsd), p.expectancyR === null ? "" : `${num(p.expectancyR, 3)} R`)}${kpi("Realized PnL", usd(p.realizedPnl), "", signCls(p.realizedPnl))}${kpi("Max drawdown", `${num(p.maxDrawdownPct)}%`)}</div>
      <div class="card"><h2>Equity curve</h2>${p.equity.length > 1 ? `<canvas id="eq" class="chart small"></canvas>` : `<p class="muted">Not enough equity history yet.</p>`}</div>
      <div class="card"><h2>Daily risk (TradingAgents risk calculator on daily equity)</h2>${dr.error ? `<p class="muted">${esc(dr.error)}</p>` : `<pre>${esc(JSON.stringify(dr, null, 2))}</pre>`}</div>
      <div class="card"><h2>By strategy</h2>${table(
        [
          ["strategy", (x) => `<code>${esc(x.id)}</code>`],
          ["trades", (x) => x.trades],
          ["expectancy (R)", (x) => num(x.expectancyR, 3)],
        ],
        p.byStrategy,
      )}</div>
      <div class="card"><h2>Exit reasons</h2>${table(
        [
          ["exit", (x) => esc(x[0])],
          ["count", (x) => x[1]],
        ],
        Object.entries(p.byExit),
      )}</div>`,
      after() {
        lineChart(
          $("#eq"),
          p.equity.map((e) => ({ t: e.ts, v: e.equity })),
        );
      },
    };
  },

  async providers() {
    const p = await api("/api/providers");
    return {
      html: `<div class="grid">${kpi("API credits today", `${p.budget.usedToday} / ${p.budget.perDay}`)}${kpi("Last minute", `${p.budget.lastMinute} / ${p.budget.perMinute}`)}${kpi("Data quality", p.quality.fresh ? "fresh" : "stale", `${p.quality.missingBars} missing bars`, p.quality.fresh ? "up" : "down")}</div>
      <div class="card"><h2>Providers (priority order)</h2>${table(
        [
          ["provider", (x) => esc(x.id)],
          ["state", (x) => pill(x.state)],
          ["priority", (x) => x.priority],
          ["basis", (x) => esc(x.basis)],
          ["trading", (x) => (x.useForTrading ? "yes" : "no")],
          ["timeframes", (x) => esc(x.capabilities.timeframes.join(" "))],
          ["bid/ask", (x) => (x.capabilities.bidAsk ? "provider" : "modelled")],
          ["last ok", (x) => ago(x.lastOk)],
          ["latency", (x) => (x.lastLatencyMs ? `${num(x.lastLatencyMs, 0)} ms` : "—")],
          ["last error", (x) => esc(x.lastError ?? ""), "wrap"],
        ],
        p.providers,
      )}</div>
      <div class="card"><h2>Calls in the last 24 h</h2>${table(
        [
          ["provider", (x) => esc(x.provider)],
          ["calls", (x) => x.calls],
          ["ok", (x) => x.ok],
          ["avg latency", (x) => `${num(x.avg_latency_ms, 0)} ms`],
          ["credits", (x) => x.credits],
          ["last ok", (x) => ago(x.last_ok)],
          ["last failure", (x) => ago(x.last_fail)],
        ],
        p.calls24h,
      )}</div>`,
    };
  },

  async logs() {
    const level = sessionStorage.getItem("qf.level") || "";
    const l = await api(`/api/logs?limit=150${level ? `&level=${level}` : ""}`);
    const h = l.health;
    return {
      html: `<div class="grid">${kpi("Process", `PID ${h.pid}`, `${esc(h.node)} · ${esc(h.platform)}`)}${kpi("Uptime", `${num(h.uptimeSec / 3600, 1)} h`)}${kpi("Memory (RSS)", `${num(h.memoryMb.rss, 0)} MB`, `heap ${num(h.memoryMb.heapUsed, 0)} MB`)}${kpi("Event-loop lag p99", `${h.eventLoopLagMs.p99} ms`)}</div>
      <div class="card"><h2>Jobs</h2>${table(
        [
          ["job", (x) => esc(x[0])],
          ["last run", (x) => ago(x[1].ts)],
          ["ok", (x) => pill(x[1].ok ? "ok" : "error")],
          ["duration", (x) => `${x[1].durationMs} ms`],
          ["detail", (x) => esc(x[1].detail), "wrap"],
        ],
        Object.entries(h.jobs),
      )}</div>
      <div class="card"><div class="row"><h2>System events</h2><select id="lvl">${["", "info", "warn", "error", "critical"].map((x) => `<option ${x === level ? "selected" : ""} value="${x}">${x || "all levels"}</option>`).join("")}</select></div>${table(
        [
          ["time", (e) => time(e.ts)],
          ["level", (e) => pill(e.level)],
          ["source", (e) => esc(e.source)],
          ["message", (e) => esc(e.message), "wrap"],
        ],
        l.system,
      )}</div>`,
      after() {
        $("#lvl").addEventListener("change", (e) => {
          sessionStorage.setItem("qf.level", e.target.value);
          render();
        });
      },
    };
  },

  async settings() {
    const s = await api("/api/settings");
    const r = s.config.risk;
    const fields = [
      "riskPerTradePct",
      "maxDailyLossPct",
      "maxWeeklyLossPct",
      "maxDrawdownPct",
      "maxOpenPositions",
      "maxTradesPerDay",
      "maxConsecutiveLosses",
      "maxSpread",
    ];
    return {
      html: `<div class="card"><h2>Risk settings</h2><form id="rs" class="form">${fields.map((f) => `<label>${f}<input name="${f}" type="number" step="any" value="${esc(r[f])}"></label>`).join("")}<label>&nbsp;<button class="btn primary">Save (applies after restart)</button></label></form><p id="rs-msg" class="muted"></p></div>
      <div class="card"><h2>Live trading gate</h2><p>Effective mode: <b>${esc(s.live.effectiveMode.toUpperCase())}</b></p>${table(
        [
          ["check", (c) => esc(c.name)],
          ["passed", (c) => pill(c.passed ? "ok" : "rejected")],
          ["detail", (c) => esc(c.detail), "wrap"],
        ],
        s.live.checks,
      )}
        <p class="muted">Live trading cannot be enabled from here alone. See docs/quantforge/LIVE_TRADING_PREPARATION.md.</p></div>
      <div class="card"><div class="row"><h2>Backups</h2><button class="btn" id="bk">Back up now</button></div>${table(
        [
          ["file", (b) => `<code>${esc(b.file)}</code>`, "wrap"],
          ["size", (b) => `${num(b.bytes / 1024, 0)} KB`],
          ["when", (b) => time(b.mtime)],
          ["encrypted", (b) => (b.encrypted ? "yes" : "no")],
        ],
        s.backups,
      )}</div>
      <div class="card"><h2>Configuration versions</h2>${table(
        [
          ["#", (v) => v.id],
          ["time", (v) => time(v.ts)],
          ["hash", (v) => `<code>${esc(v.hash)}</code>`],
          ["source", (v) => esc(v.source)],
        ],
        s.versions,
      )}</div>
      <div class="card"><h2>Active configuration</h2><pre>${esc(JSON.stringify(s.config, null, 2))}</pre><p class="muted">Home: <code>${esc(s.paths.home)}</code> · database: <code>${esc(s.paths.db)}</code></p></div>`,
      after() {
        $("#rs").addEventListener("submit", async (e) => {
          e.preventDefault();
          const risk = Object.fromEntries(fields.map((f) => [f, Number(e.target[f].value)]));
          try {
            const out = await post("/api/settings", { risk });
            $("#rs-msg").textContent = out.note;
          } catch (err) {
            $("#rs-msg").textContent = err.message;
          }
        });
        $("#bk").addEventListener("click", async () => {
          const b = await post("/api/backup");
          alert(`Backup written: ${b.file}`);
          render();
        });
      },
    };
  },
};

// ------------------------------------------------------------------------------------ router & live updates

let rendering = false;
async function render() {
  if (rendering) return;
  rendering = true;
  const hash = location.hash.replace(/^#/, "") || "overview";
  if (hash === "logout") {
    await post("/api/logout").catch(() => {});
    location.hash = "overview";
    rendering = false;
    return showLogin();
  }
  const [page, arg] = hash.split("/");
  document.querySelectorAll("#nav a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === `#${page === "strategy" ? "discovery" : page}`);
  });
  $("#nav").classList.remove("open");
  try {
    const fn = pages[page] ?? pages.overview;
    const out = await fn(arg ? decodeURIComponent(arg) : undefined);
    view.innerHTML = out.html;
    out.after?.();
    $("#updated").textContent = `Updated ${new Date().toISOString().replace("T", " ").slice(0, 19)}Z`;
  } catch (err) {
    if (err.message !== "login required")
      view.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  } finally {
    rendering = false;
  }
}

async function refreshBadge() {
  try {
    const o = await api("/api/overview");
    const b = $("#mode-badge");
    b.textContent = o.mode.toUpperCase();
    b.classList.toggle("live", o.mode === "live");
  } catch {}
}

let es = null;
let pollTimer = null;
function connect() {
  const dot = $("#conn");
  const startPolling = () => {
    dot.className = "dot poll";
    dot.title = "polling every 15 s";
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      render();
      refreshBadge();
    }, 15000);
  };
  if (!("EventSource" in window)) return startPolling();
  es?.close();
  es = new EventSource("/api/stream");
  es.addEventListener("open", () => {
    dot.className = "dot ok";
    dot.title = "live (server-sent events)";
    clearInterval(pollTimer);
  });
  es.addEventListener("update", () => {
    render();
    refreshBadge();
  });
  es.addEventListener("error", () => {
    dot.className = "dot bad";
    startPolling();
  });
}

function showLogin() {
  $("#shell").classList.add("hidden");
  $("#login").classList.remove("hidden");
  es?.close();
}

async function boot() {
  try {
    await api("/api/overview");
    $("#login").classList.add("hidden");
    $("#shell").classList.remove("hidden");
    render();
    refreshBadge();
    connect();
  } catch {
    showLogin();
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await post("/api/login", { token: $("#token").value.trim() });
    $("#token").value = "";
    boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});
$("#menu").addEventListener("click", () => $("#nav").classList.toggle("open"));
window.addEventListener("hashchange", render);
window.addEventListener("resize", () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(render, 300);
});
boot();
