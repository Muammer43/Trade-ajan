// First-run setup wizard (interactive, or non-interactive with --yes and environment variables).

import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { type QfPaths, saveConfig, writeCredentialEntries } from "../config/load.js";
import { buildConfig, DEFAULT_CONFIG, type QuantForgeConfig } from "../config/schema.js";
import { TwelveDataProvider } from "../data/providers/twelvedata.js";
import { loadOrCreateToken } from "../security/auth.js";

export async function runSetup(
  paths: QfPaths,
  opts: { yes: boolean; env?: NodeJS.ProcessEnv },
): Promise<number> {
  const env = opts.env ?? process.env;
  const out = (s: string) => process.stdout.write(`${s}\n`);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.importDir, { recursive: true, mode: 0o700 });
  out("QuantForge AI Pro — first-run setup");
  out(`Home: ${paths.home}`);
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string) => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def;
  };
  try {
    let config: QuantForgeConfig = structuredClone(DEFAULT_CONFIG);
    if (existsSync(paths.config))
      out("An existing config.json was found; values you confirm here replace it.");
    const key =
      env.QF_TWELVEDATA_API_KEY ??
      env.TWELVEDATA_API_KEY ??
      (await ask("Twelve Data API key (leave empty to set it later via TWELVEDATA_API_KEY)", ""));
    const balance = Number(await ask("Paper starting balance (USD)", String(config.risk.initialBalance)));
    const profile = (await ask("Risk profile (conservative|balanced)", config.risk.profile)) as
      | "conservative"
      | "balanced";
    const port = Number(await ask("Dashboard port", String(config.dashboard.port)));
    const spread = Number(
      await ask("Typical XAUUSD spread at your broker (USD/oz)", String(config.costs.spread)),
    );
    const commission = Number(
      await ask("Commission per lot round trip (USD)", String(config.costs.commissionPerLotRoundTrip)),
    );
    const contract = Number(
      await ask("Contract size (oz per lot) at your broker", String(config.instrument.contractSize)),
    );
    const built = buildConfig({
      ...config,
      risk: { ...config.risk, initialBalance: balance, profile },
      dashboard: { ...config.dashboard, port },
      costs: { ...config.costs, spread, commissionPerLotRoundTrip: commission },
      instrument: { ...config.instrument, contractSize: contract },
    });
    if ("error" in built) {
      out(`Invalid answers: ${built.error}`);
      return 1;
    }
    config = built.config;
    await saveConfig(paths, config);
    out(`Saved ${paths.config} (mode: PAPER; live trading stays disabled).`);
    if (key && !env.QF_TWELVEDATA_API_KEY && !env.TWELVEDATA_API_KEY) {
      await writeCredentialEntries(paths, { TWELVEDATA_API_KEY: key });
      out(`Saved the API key to ${paths.credentials} (mode 0600).`);
    }
    const { token, created } = await loadOrCreateToken(paths.dashboardToken);
    out(
      created
        ? `Dashboard access token (also in ${paths.dashboardToken}):\n  ${token}`
        : `Dashboard access token unchanged (${paths.dashboardToken}).`,
    );
    out("Checking the Twelve Data connection…");
    try {
      const td = new TwelveDataProvider({ apiKey: key || undefined, timeoutMs: 15_000 });
      const q = await td.fetchQuote("XAU/USD");
      out(`  OK — XAU/USD ${q.quote.price.toFixed(2)}`);
      const u = await td.usage().catch(() => null);
      if (u)
        out(`  plan ${u.plan}: ${u.dailyUsage}/${u.planDailyLimit} credits used today, ${u.planLimit}/min`);
    } catch (error) {
      out(`  Could not reach Twelve Data: ${(error as Error).message}`);
      out("  Set TWELVEDATA_API_KEY (or re-run setup) before starting.");
    }
    out("Next: ./start.sh  (then open the dashboard URL in Chrome on this phone)");
    return 0;
  } finally {
    rl?.close();
  }
}
