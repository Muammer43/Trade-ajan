// Structured logger: JSON lines to a size-rotated file and a readable line to stderr. Every message and
// detail is passed through the redactor so registered secrets never reach a log.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "critical";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };

const secrets = new Set<string>();

/** Register a secret value (API key, token) that must never be written to a log. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

const KEY_PATTERNS: RegExp[] = [
  /(apikey=)[^&\s"]+/gi,
  /(api_key=)[^&\s"]+/gi,
  /(authorization:\s*)(bearer\s+)?[^\s"]+/gi,
  /(token=)[^&\s"]+/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  for (const p of KEY_PATTERNS) out = out.replace(p, "$1***");
  return out;
}

export type LogSink = (entry: {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  detail?: unknown;
}) => void;

export class Logger {
  private sinks: LogSink[] = [];
  constructor(
    private readonly opts: {
      file?: string | undefined;
      level?: LogLevel | undefined;
      maxBytes?: number | undefined;
      stderr?: boolean | undefined;
    } = {},
  ) {
    if (opts.file) mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  child(source: string): SourceLogger {
    return new SourceLogger(this, source);
  }

  log(level: LogLevel, source: string, message: string, detail?: unknown): void {
    if (ORDER[level] < ORDER[this.opts.level ?? "info"]) return;
    const ts = Date.now();
    const safeMessage = redact(message);
    let safeDetail: unknown;
    if (detail !== undefined) {
      try {
        safeDetail = JSON.parse(redact(JSON.stringify(detail, errorReplacer)));
      } catch {
        safeDetail = redact(String(detail));
      }
    }
    const line = JSON.stringify({
      ts: new Date(ts).toISOString(),
      level,
      source,
      message: safeMessage,
      detail: safeDetail,
    });
    if (this.opts.file) {
      try {
        this.rotate();
        appendFileSync(this.opts.file, `${line}\n`, { mode: 0o600 });
      } catch {
        // Logging must never take the process down.
      }
    }
    if (this.opts.stderr !== false)
      process.stderr.write(
        `${new Date(ts).toISOString()} ${level.toUpperCase()} [${source}] ${safeMessage}\n`,
      );
    for (const sink of this.sinks) {
      try {
        sink({ ts, level, source, message: safeMessage, detail: safeDetail });
      } catch {
        // A failing sink is ignored.
      }
    }
  }

  private rotate(): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      if (statSync(file).size > (this.opts.maxBytes ?? 5_000_000)) renameSync(file, `${file}.1`);
    } catch {
      // No file yet.
    }
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export class SourceLogger {
  constructor(
    private readonly root: Logger,
    readonly source: string,
  ) {}
  debug(message: string, detail?: unknown): void {
    this.root.log("debug", this.source, message, detail);
  }
  info(message: string, detail?: unknown): void {
    this.root.log("info", this.source, message, detail);
  }
  warn(message: string, detail?: unknown): void {
    this.root.log("warn", this.source, message, detail);
  }
  error(message: string, detail?: unknown): void {
    this.root.log("error", this.source, message, detail);
  }
  critical(message: string, detail?: unknown): void {
    this.root.log("critical", this.source, message, detail);
  }
}

/** A logger that writes nowhere (tests). */
export function silentLogger(): Logger {
  return new Logger({ stderr: false, level: "critical" });
}
