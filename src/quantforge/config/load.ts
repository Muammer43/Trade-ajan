// Where QuantForge keeps its files, and how configuration and credentials are loaded.
//
// Home: $QF_HOME, else ~/.quantforge. Credentials come from the environment first, then from
// <home>/credentials.env, a file that must be private to its owner (0600); it is never logged.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readPrivate, writeAtomic, writePrivate } from "../../store/private-file.js";
import { registerSecret } from "../core/logger.js";
import { buildConfig, DEFAULT_CONFIG, type QuantForgeConfig } from "./schema.js";

export type QfPaths = {
  home: string;
  config: string;
  credentials: string;
  liveCredentials: string;
  db: string;
  logs: string;
  logFile: string;
  backups: string;
  pidFile: string;
  lockFile: string;
  dashboardToken: string;
  importDir: string;
};

export function resolveQfPaths(env: NodeJS.ProcessEnv = process.env): QfPaths {
  const home = resolve(env.QF_HOME?.trim() || join(homedir(), ".quantforge"));
  const dataDir = env.QF_DATA_DIR?.trim() ? resolve(env.QF_DATA_DIR) : home;
  return {
    home,
    config: join(home, "config.json"),
    credentials: join(home, "credentials.env"),
    liveCredentials: join(home, "live-credentials.env"),
    db: join(dataDir, "quantforge.db"),
    logs: join(home, "logs"),
    logFile: join(home, "logs", "quantforge.log"),
    backups: env.QF_BACKUP_DIR?.trim() ? resolve(env.QF_BACKUP_DIR) : join(home, "backups"),
    pidFile: join(home, "quantforge.pid"),
    lockFile: join(home, "quantforge.lock"),
    dashboardToken: join(home, "dashboard-token"),
    importDir: join(home, "import"),
  };
}

export function loadConfig(paths: QfPaths): QuantForgeConfig {
  if (!existsSync(paths.config)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8"));
  } catch (error) {
    throw new Error(`config.json is not valid JSON: ${(error as Error).message}`);
  }
  const built = buildConfig(raw);
  if ("error" in built) throw new Error(`config.json is invalid: ${built.error}`);
  return built.config;
}

export async function saveConfig(paths: QfPaths, config: QuantForgeConfig): Promise<void> {
  const built = buildConfig(config);
  if ("error" in built) throw new Error(built.error);
  await writeAtomic(paths.config, `${JSON.stringify(built.config, null, 2)}\n`, { mode: 0o600 });
}

/** Parse KEY=VALUE lines (comments with #, optional quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = value;
  }
  return out;
}

export type Credentials = {
  twelveData?: string | undefined;
  llmApiKey?: string | undefined;
  backupPassphrase?: string | undefined;
};

const LLM_KEY_VARS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "openai-compatible": ["QF_LLM_API_KEY"],
};

/** Credentials from the environment, then the private credentials file. Each value is registered for redaction. */
export async function loadCredentials(
  paths: QfPaths,
  config: QuantForgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Credentials> {
  let file: Record<string, string> = {};
  const text = await readPrivate(paths.credentials);
  if (text !== undefined) file = parseEnvFile(text);
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = env[n]?.trim() || file[n]?.trim();
      if (v) return v;
    }
    return undefined;
  };
  const creds: Credentials = {
    twelveData: pick("QF_TWELVEDATA_API_KEY", "TWELVEDATA_API_KEY", "TWELVE_DATA_API_KEY"),
    llmApiKey: pick(...(LLM_KEY_VARS[config.agents.llm.provider] ?? []), "QF_LLM_API_KEY"),
    backupPassphrase: pick("QF_BACKUP_PASSPHRASE"),
  };
  for (const v of Object.values(creds)) registerSecret(v);
  return creds;
}

/** Write (or update) entries in the private credentials file. */
export async function writeCredentialEntries(paths: QfPaths, entries: Record<string, string>): Promise<void> {
  const existing = parseEnvFile((await readPrivate(paths.credentials)) ?? "");
  const merged = { ...existing, ...entries };
  const body = Object.entries(merged)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await writePrivate(paths.credentials, `# QuantForge credentials — keep private (0600)\n${body}\n`);
}
