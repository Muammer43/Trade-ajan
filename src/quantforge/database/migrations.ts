// Ordered, append-only schema migrations. Never edit a released migration; add a new one.

export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE candles (
  symbol TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL,
  provider TEXT NOT NULL, market_open INTEGER NOT NULL, quality TEXT NOT NULL, inserted_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, tf, ts)
) WITHOUT ROWID;

CREATE TABLE market_snapshots (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL, price REAL NOT NULL,
  bid REAL NOT NULL, ask REAL NOT NULL, spread REAL NOT NULL, spread_source TEXT NOT NULL,
  provider TEXT NOT NULL, regime TEXT, features_json TEXT
);
CREATE INDEX idx_snapshots_ts ON market_snapshots(ts);

CREATE TABLE processed_candles (
  job TEXT NOT NULL, tf TEXT NOT NULL, ts INTEGER NOT NULL, processed_at INTEGER NOT NULL,
  PRIMARY KEY (job, tf, ts)
) WITHOUT ROWID;

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bar_ts INTEGER NOT NULL, tf TEXT NOT NULL, mode TEXT NOT NULL,
  action TEXT NOT NULL, strategy_id TEXT, regime TEXT, entry REAL, sl REAL, tp REAL, rr REAL, lots REAL,
  holding_bars INTEGER, confidence REAL, reasons_json TEXT NOT NULL, rejected_json TEXT NOT NULL,
  risk_json TEXT, judge_json TEXT
);
CREATE UNIQUE INDEX idx_decisions_bar ON decisions(tf, bar_ts);
CREATE INDEX idx_decisions_ts ON decisions(ts);

CREATE TABLE agent_reports (
  id INTEGER PRIMARY KEY, decision_id INTEGER REFERENCES decisions(id), ts INTEGER NOT NULL, agent TEXT NOT NULL,
  status TEXT NOT NULL, bias REAL NOT NULL, confidence REAL NOT NULL, summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL, veto TEXT, duration_ms INTEGER NOT NULL
);
CREATE INDEX idx_agent_reports_decision ON agent_reports(decision_id);
CREATE INDEX idx_agent_reports_ts ON agent_reports(ts);

CREATE TABLE discovery_runs (
  id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
  tf TEXT NOT NULL, bars INTEGER, data_from INTEGER, data_to INTEGER, candidates INTEGER, validated INTEGER,
  summary_json TEXT, error TEXT
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY, run_id INTEGER REFERENCES discovery_runs(id), family TEXT NOT NULL, spec_json TEXT NOT NULL,
  status TEXT NOT NULL, score REAL, metrics_json TEXT, validation_json TEXT, rejection_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, activated_at INTEGER, deactivated_at INTEGER
);
CREATE INDEX idx_strategies_status ON strategies(status);

CREATE TABLE backtests (
  id INTEGER PRIMARY KEY, strategy_id TEXT, run_id INTEGER, segment TEXT NOT NULL, created_at INTEGER NOT NULL,
  params_json TEXT NOT NULL, metrics_json TEXT NOT NULL, trades_json TEXT, equity_json TEXT
);
CREATE INDEX idx_backtests_strategy ON backtests(strategy_id);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY, decision_id INTEGER REFERENCES decisions(id), strategy_id TEXT NOT NULL,
  bar_ts INTEGER NOT NULL, side TEXT NOT NULL, ts INTEGER NOT NULL
);

CREATE TABLE accounts (
  name TEXT PRIMARY KEY, mode TEXT NOT NULL, currency TEXT NOT NULL, initial_balance REAL NOT NULL,
  balance REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY, client_order_id TEXT NOT NULL UNIQUE, account TEXT NOT NULL, broker TEXT NOT NULL,
  mode TEXT NOT NULL, decision_id INTEGER, strategy_id TEXT, side TEXT NOT NULL, type TEXT NOT NULL,
  lots REAL NOT NULL, requested_price REAL, sl REAL, tp REAL, status TEXT NOT NULL, broker_order_id TEXT,
  fill_price REAL, reference_price REAL, slippage REAL, reject_reason TEXT, intent TEXT NOT NULL DEFAULT 'open',
  position_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), ts INTEGER NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL, detail TEXT
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY, account TEXT NOT NULL, order_id INTEGER REFERENCES orders(id), broker TEXT NOT NULL,
  mode TEXT NOT NULL, strategy_id TEXT, side TEXT NOT NULL, lots_initial REAL NOT NULL, lots_open REAL NOT NULL,
  entry_price REAL NOT NULL, sl REAL NOT NULL, tp REAL, initial_sl REAL NOT NULL, opened_at INTEGER NOT NULL,
  closed_at INTEGER, status TEXT NOT NULL, exit_reason TEXT, exit_price REAL, realized_pnl REAL NOT NULL DEFAULT 0,
  commission REAL NOT NULL DEFAULT 0, swap REAL NOT NULL DEFAULT 0, r_multiple REAL, mfe REAL NOT NULL DEFAULT 0,
  mae REAL NOT NULL DEFAULT 0, partial_done INTEGER NOT NULL DEFAULT 0, be_done INTEGER NOT NULL DEFAULT 0,
  bars_held INTEGER NOT NULL DEFAULT 0, last_bar_ts INTEGER, last_swap_ts INTEGER, rules_json TEXT NOT NULL,
  atr_at_entry REAL NOT NULL, regime TEXT
);
CREATE INDEX idx_positions_status ON positions(account, status);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY, account TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL,
  balance_after REAL NOT NULL, position_id INTEGER, order_id INTEGER, note TEXT
);
CREATE INDEX idx_transactions_account ON transactions(account, id);

CREATE TABLE equity_history (
  account TEXT NOT NULL, ts INTEGER NOT NULL, balance REAL NOT NULL, equity REAL NOT NULL,
  unrealized REAL NOT NULL, open_positions INTEGER NOT NULL, PRIMARY KEY (account, ts)
) WITHOUT ROWID;

CREATE TABLE risk_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, detail_json TEXT
);
CREATE INDEX idx_risk_events_ts ON risk_events(ts);

CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE system_events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX idx_system_events_ts ON system_events(ts);

CREATE TABLE api_health (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, endpoint TEXT NOT NULL, ok INTEGER NOT NULL,
  latency_ms INTEGER, status_code INTEGER, credits INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX idx_api_health_ts ON api_health(ts);
CREATE INDEX idx_api_health_provider ON api_health(provider, ts);

CREATE TABLE config_versions (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, hash TEXT NOT NULL, config_json TEXT NOT NULL, source TEXT NOT NULL
);

CREATE TABLE regime_evaluations (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tf TEXT NOT NULL, bars INTEGER NOT NULL, metrics_json TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "trading strategy: model, score and risk on decisions",
    sql: `
ALTER TABLE decisions ADD COLUMN model TEXT;
ALTER TABLE decisions ADD COLUMN score REAL;
ALTER TABLE decisions ADD COLUMN risk_pct REAL;
ALTER TABLE decisions ADD COLUMN components_json TEXT;
CREATE INDEX idx_positions_model ON positions(strategy_id, status);
`,
  },
];
