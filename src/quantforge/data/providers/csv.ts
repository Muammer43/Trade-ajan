// Historical CSV import as a provider. Files are named <SYMBOL>_<tf>.csv (e.g. XAUUSD_15m.csv) in the import
// directory, with a header row containing time/datetime/date, open, high, low, close and optional volume.
// Timestamps must be UTC (ISO strings or epoch seconds/ms). The provider never serves quotes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Timeframe } from "../../core/types.js";
import type { RawBar } from "../normalize.js";
import { parseUtc } from "../normalize.js";
import {
  type BarsRequest,
  type CallMeta,
  type MarketDataProvider,
  ProviderError,
  type ProviderQuote,
} from "./types.js";

export function parseCsv(text: string): RawBar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const sep = (lines[0] as string).includes(";") && !(lines[0] as string).includes(",") ? ";" : ",";
  const header = (lines[0] as string).split(sep).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const t = col("time", "datetime", "date", "timestamp", "ts");
  const o = col("open", "o");
  const h = col("high", "h");
  const l = col("low", "l");
  const c = col("close", "c");
  const v = col("volume", "vol", "v", "tick_volume");
  if ([t, o, h, l, c].some((i) => i < 0))
    throw new Error("CSV needs time/datetime, open, high, low and close columns");
  const out: RawBar[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map((x) => x.trim().replace(/^"|"$/g, ""));
    const time = cells[t] ?? "";
    out.push({
      datetime: /^\d+$/.test(time) ? Number(time) : time,
      open: cells[o],
      high: cells[h],
      low: cells[l],
      close: cells[c],
      volume: v >= 0 ? cells[v] : undefined,
    });
  }
  return out;
}

export class CsvProvider implements MarketDataProvider {
  readonly id = "csv";
  readonly capabilities = {
    timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"] as const,
    maxBarsPerRequest: 1_000_000,
    pagination: true,
    quotes: false,
    bidAsk: false,
    websocket: false,
    volume: true,
  };
  private cache = new Map<string, RawBar[]>();

  constructor(private readonly dir: string) {}

  mapSymbol(canonical: string): string | undefined {
    return canonical.replace("/", "").toUpperCase();
  }

  private file(symbol: string, tf: Timeframe): string {
    return join(this.dir, `${symbol}_${tf}.csv`);
  }

  async fetchBars(req: BarsRequest): Promise<{ bars: RawBar[]; meta: CallMeta }> {
    const path = this.file(req.symbol, req.tf);
    if (!existsSync(path)) throw new ProviderError(`csv: no file ${path}`, "no_data", false);
    let rows = this.cache.get(path);
    if (!rows) {
      rows = parseCsv(readFileSync(path, "utf8"));
      this.cache.set(path, rows);
    }
    let selected = rows;
    if (req.end !== undefined || req.start !== undefined) {
      selected = rows.filter((r) => {
        const ts = parseUtc(r.datetime);
        if (ts === undefined) return true; // normalization reports it
        return (req.start === undefined || ts >= req.start) && (req.end === undefined || ts <= req.end);
      });
    }
    return { bars: selected.slice(-req.limit), meta: { credits: 0, latencyMs: 0, endpoint: "file" } };
  }

  async fetchQuote(): Promise<{ quote: ProviderQuote; meta: CallMeta }> {
    throw new ProviderError("csv provider serves no live quotes", "not_supported", false);
  }
}
