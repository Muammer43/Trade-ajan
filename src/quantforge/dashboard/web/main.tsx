// QuantForge AI dashboard: login, navigation, live updates (Server-Sent Events with a polling fallback).

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, emitLiveUpdate, LoginRequired, post } from "./lib.js";
import {
  AgentsPage,
  BacktestPage,
  DashboardPage,
  HistoryPage,
  LiveMarketPage,
  LogsPage,
  PerformancePage,
  PositionsPage,
  ProvidersPage,
  RiskPage,
  SettingsPage,
  SignalsPage,
} from "./pages.js";

const PAGES: { id: string; label: string; Page: (p: { onAuth: () => void }) => React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", Page: DashboardPage },
  { id: "market", label: "Live Market", Page: LiveMarketPage },
  { id: "signals", label: "Trading Signals", Page: SignalsPage },
  { id: "positions", label: "Active Positions", Page: PositionsPage },
  { id: "history", label: "Trade History", Page: HistoryPage },
  { id: "performance", label: "Strategy Performance", Page: PerformancePage },
  { id: "agents", label: "AI Agents", Page: AgentsPage },
  { id: "risk", label: "Risk Management", Page: RiskPage },
  { id: "backtest", label: "Backtest", Page: BacktestPage },
  { id: "providers", label: "Data Providers", Page: ProvidersPage },
  { id: "logs", label: "System Logs", Page: LogsPage },
  { id: "settings", label: "Settings", Page: SettingsPage },
];

const route = () => location.hash.replace(/^#/, "") || "dashboard";

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await post("/api/login", { token: token.trim() });
      setToken("");
      onDone();
    } catch (error) {
      setErr((error as Error).message);
    }
  };
  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">
          <span className="logo">◆</span> QuantForge <b>AI</b>
        </div>
        <p className="muted">
          Panel erişim anahtarını girin. Anahtar <code>~/.quantforge/dashboard-token</code> dosyasındadır:{" "}
          <code>cat ~/.quantforge/dashboard-token</code>
        </p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Erişim anahtarı"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <button type="submit" className="btn primary">
          Giriş
        </button>
        <p className="error">{err}</p>
      </form>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [page, setPage] = useState(route());
  const [menu, setMenu] = useState(false);
  const [conn, setConn] = useState<"ok" | "poll" | "bad">("bad");
  const [mode, setMode] = useState("PAPER");
  const onAuth = useCallback(() => setAuthed(false), []);

  useEffect(() => {
    api<{ mode: string }>("/api/overview")
      .then((o) => {
        setMode(o.mode.toUpperCase());
        setAuthed(true);
      })
      .catch((e) => setAuthed(!(e instanceof LoginRequired)));
  }, []);

  useEffect(() => {
    const onHash = () => {
      setPage(route());
      setMenu(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!authed) return;
    let poll: number | undefined;
    const startPolling = () => {
      setConn("poll");
      window.clearInterval(poll);
      poll = window.setInterval(emitLiveUpdate, 15_000);
    };
    if (!("EventSource" in window)) {
      startPolling();
      return () => window.clearInterval(poll);
    }
    const es = new EventSource("/api/stream");
    es.addEventListener("open", () => {
      setConn("ok");
      window.clearInterval(poll);
    });
    es.addEventListener("update", () => {
      emitLiveUpdate();
      api<{ mode: string }>("/api/overview")
        .then((o) => setMode(o.mode.toUpperCase()))
        .catch(() => {});
    });
    es.addEventListener("error", () => {
      setConn("bad");
      startPolling();
    });
    return () => {
      es.close();
      window.clearInterval(poll);
    };
  }, [authed]);

  if (authed === null) return <div className="login muted">Yükleniyor…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  const current = PAGES.find((p) => p.id === page) ?? (PAGES[0] as (typeof PAGES)[number]);
  return (
    <div className="shell">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Menü" onClick={() => setMenu(!menu)}>
          ☰
        </button>
        <div className="brand">
          <span className="logo">◆</span> QuantForge <b>AI</b>
        </div>
        <div className="top-right">
          <span className={`badge ${mode === "LIVE" ? "live" : ""}`}>{mode}</span>
          <span
            className={`dot ${conn}`}
            title={conn === "ok" ? "canlı (SSE)" : conn === "poll" ? "15 sn yoklama" : "bağlantı yok"}
          />
        </div>
      </header>
      <nav className={`nav ${menu ? "open" : ""}`}>
        {PAGES.map((p) => (
          <a key={p.id} href={`#${p.id}`} className={p.id === current.id ? "active" : ""}>
            {p.label}
          </a>
        ))}
        <button
          type="button"
          className="link muted"
          onClick={async () => {
            await post("/api/logout").catch(() => {});
            setAuthed(false);
          }}
        >
          Çıkış
        </button>
      </nav>
      <main className="view">
        <current.Page onAuth={onAuth} />
      </main>
      <footer className="foot muted">
        QuantForge AI · PAPER mod varsayılandır · tüm değerler veritabanından
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
