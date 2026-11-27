// Shared dashboard helpers: API access, live-update hook, formatting and small UI components.
// Every value shown comes from the API; an unknown value is shown as "—", never estimated.

import { useCallback, useEffect, useRef, useState } from "react";

export class LoginRequired extends Error {}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-QF-Request": "1", ...(init.headers ?? {}) },
  });
  if (res.status === 401 && path !== "/api/login") throw new LoginRequired("login required");
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Live-update bus: the SSE stream (or the polling fallback) bumps a counter all pages listen to. */
type Listener = () => void;
const listeners = new Set<Listener>();
export function onLiveUpdate(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function emitLiveUpdate(): void {
  for (const l of listeners) l();
}

/** Fetch a resource, re-fetching on every live update. */
export function useApi<T>(
  path: string,
  onAuth: () => void,
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(() => {
    api<T>(path)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof LoginRequired) onAuth();
        else if (alive.current) setError((e as Error).message);
      });
  }, [path, onAuth]);
  useEffect(() => {
    alive.current = true;
    load();
    const off = onLiveUpdate(load);
    return () => {
      alive.current = false;
      off();
    };
  }, [load]);
  return { data, error, reload: load };
}

export const num = (v: unknown, d = 2): string => {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const pct = (v: unknown, d = 1): string =>
  v === null || v === undefined ? "—" : `${num(Number(v) * 100, d)}%`;
export const usd = (v: unknown): string => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n < 0 ? "−" : ""}$${num(Math.abs(n))}`;
};
export const tone = (v: unknown): string => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
export const time = (ts: unknown): string =>
  ts ? `${new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 16)}Z` : "—";
export const ago = (ts: unknown): string => {
  if (!ts) return "hiç";
  const s = Math.round((Date.now() - Number(ts)) / 1000);
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  return `${Math.round(s / 86400)} gün önce`;
};

export function Pill({ v }: { v: unknown }) {
  const t = String(v ?? "—");
  return <span className={`pill ${t}`}>{t}</span>;
}

export function Kpi({
  label,
  value,
  sub,
  cls,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  cls?: string;
}) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className={`value ${cls ?? ""}`}>{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export type Col<T> = [string, (row: T) => React.ReactNode, string?];

export function Table<T>({ cols, rows, empty }: { cols: Col<T>[]; rows: T[]; empty?: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c[0]}>{c[0]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id in every table
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c[0]} className={c[2] ?? ""}>
                    {c[1](r)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={cols.length} className="muted">
                {empty ?? "Henüz kayıt yok."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="card">
      {title || actions ? (
        <div className="row card-head">
          {title ? <h2>{title}</h2> : null}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Notice({ kind, children }: { kind?: "bad" | "good"; children: React.ReactNode }) {
  return <div className={`notice ${kind ?? ""}`}>{children}</div>;
}

export function Loading({ error }: { error: string | null }) {
  return error ? <Notice kind="bad">{error}</Notice> : <div className="card muted">Yükleniyor…</div>;
}

// ------------------------------------------------------------------------------------------------ charts

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, data: unknown) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever the chart data changes
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      drawRef.current(ctx, w, h);
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [data]);
  return ref;
}

export type Bar = { ts: number; o: number; h: number; l: number; c: number; open: boolean };

export function CandleChart({
  bars,
  levels,
}: {
  bars: Bar[];
  levels?: { price: number; color: string; label: string }[];
}) {
  const ref = useCanvas((ctx, w, h) => {
    if (!bars.length) return;
    const pad = { l: 6, r: 60, t: 8, b: 18 };
    const prices = [...bars.flatMap((b) => [b.h, b.l]), ...(levels ?? []).map((x) => x.price)];
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const y = (p: number) => pad.t + ((hi - p) / (hi - lo || 1)) * (h - pad.t - pad.b);
    const step = (w - pad.l - pad.r) / bars.length;
    ctx.font = "11px system-ui";
    ctx.strokeStyle = "#233041";
    ctx.fillStyle = "#8193a8";
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
      const color = !b.open ? "#3a4656" : b.c >= b.o ? "#2fbf71" : "#e5534b";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y(b.h));
      ctx.lineTo(x, y(b.l));
      ctx.stroke();
      const bw = Math.max(1, step * 0.65);
      ctx.fillRect(x - bw / 2, Math.min(y(b.o), y(b.c)), bw, Math.max(1, Math.abs(y(b.o) - y(b.c))));
    });
    for (const lv of levels ?? []) {
      ctx.strokeStyle = lv.color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.l, y(lv.price));
      ctx.lineTo(w - pad.r, y(lv.price));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lv.color;
      ctx.fillText(lv.label, pad.l + 2, y(lv.price) - 3);
    }
    ctx.fillStyle = "#8193a8";
    ctx.fillText(time((bars[0] as Bar).ts), pad.l, h - 4);
    const lt = time((bars[bars.length - 1] as Bar).ts);
    ctx.fillText(lt, w - pad.r - ctx.measureText(lt).width, h - 4);
  }, bars);
  return <canvas ref={ref} className="chart" />;
}

export function LineChart({ points, small }: { points: { t: number; v: number }[]; small?: boolean }) {
  const ref = useCanvas((ctx, w, h) => {
    if (points.length < 2) return;
    const pad = { l: 6, r: 66, t: 8, b: 18 };
    const vs = points.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const t0 = (points[0] as { t: number }).t;
    const t1 = (points[points.length - 1] as { t: number }).t;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + ((hi - v) / (hi - lo || 1)) * (h - pad.t - pad.b);
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
    ctx.strokeStyle = "#e3b341";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    points.forEach((p, i) => {
      if (i) ctx.lineTo(x(p.t), y(p.v));
      else ctx.moveTo(x(p.t), y(p.v));
    });
    ctx.stroke();
    ctx.fillStyle = "#8193a8";
    ctx.fillText(time(t0), pad.l, h - 4);
  }, points);
  return <canvas ref={ref} className={small ? "chart small" : "chart"} />;
}
