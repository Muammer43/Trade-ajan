// Controlled live-trading gate. Live execution is prepared but cannot activate by accident:
//   1. config.mode = "live" AND config.live.enabled = true
//   2. environment QF_LIVE_TRADING=I_UNDERSTAND_REAL_MONEY_RISK for this process
//   3. a separate, private (0600) live-credentials.env file
//   4. a registered broker adapter whose id equals config.live.broker, whose API has been verified
//   5. a successful connection check and position reconciliation
//   6. a manual arm in this process (dashboard or CLI) with the confirmation phrase; arming is held in
//      memory only, expires after 8 hours, and is lost on every restart
// QuantForge ships no live broker adapter: no broker's execution API has been verified for this project, so
// gate 4 always fails and the effective mode stays paper. See docs/quantforge/LIVE_TRADING_PREPARATION.md.

import { statSync } from "node:fs";
import type { QfPaths } from "../config/load.js";
import type { QuantForgeConfig } from "../config/schema.js";
import type { BrokerAdapter } from "./broker.js";

export const LIVE_ENV_PHRASE = "I_UNDERSTAND_REAL_MONEY_RISK";
export const ARM_PHRASE = "ARM LIVE TRADING WITH REAL MONEY";
const ARM_MS = 8 * 3_600_000;

/** Live adapters known to this build. Empty on purpose: none has been verified. */
export const LIVE_ADAPTERS: Record<string, (creds: Record<string, string>) => BrokerAdapter> = {};

export type LiveGateStatus = {
  effectiveMode: "paper" | "live";
  allowed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
};

export class LiveGate {
  private armedUntil = 0;
  private verified = false;

  constructor(
    private readonly config: QuantForgeConfig,
    private readonly paths: QfPaths,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {}

  arm(phrase: string): { ok: boolean; reason?: string } {
    if (phrase !== ARM_PHRASE) return { ok: false, reason: "confirmation phrase does not match" };
    const status = this.status({ ignoreArm: true });
    if (!status.checks.every((c) => c.passed))
      return {
        ok: false,
        reason: `live prerequisites not met: ${status.checks
          .filter((c) => !c.passed)
          .map((c) => c.name)
          .join(", ")}`,
      };
    this.armedUntil = this.now() + ARM_MS;
    return { ok: true };
  }

  disarm(): void {
    this.armedUntil = 0;
  }

  markVerified(ok: boolean): void {
    this.verified = ok;
  }

  status(opts: { ignoreArm?: boolean } = {}): LiveGateStatus {
    const c = this.config;
    let credsPrivate = false;
    let credsDetail = "missing";
    try {
      const st = statSync(this.paths.liveCredentials);
      credsPrivate = st.isFile() && (st.mode & 0o077) === 0;
      credsDetail = credsPrivate ? "present, private" : "present but readable by others (chmod 600 required)";
    } catch {
      credsDetail = `missing (${this.paths.liveCredentials})`;
    }
    const broker = c.live.broker;
    const adapterKnown = broker !== null && broker in LIVE_ADAPTERS;
    const checks = [
      { name: "config_mode_live", passed: c.mode === "live", detail: `config.mode=${c.mode}` },
      {
        name: "config_live_enabled",
        passed: c.live.enabled,
        detail: `config.live.enabled=${c.live.enabled}`,
      },
      {
        name: "environment_acknowledgement",
        passed: this.env.QF_LIVE_TRADING === LIVE_ENV_PHRASE,
        detail: "QF_LIVE_TRADING must equal the acknowledgement phrase",
      },
      { name: "separate_live_credentials", passed: credsPrivate, detail: credsDetail },
      {
        name: "verified_broker_adapter",
        passed: adapterKnown,
        detail: adapterKnown
          ? `adapter ${broker}`
          : `no verified live broker adapter is available in this build${broker ? ` (configured: ${broker})` : ""}`,
      },
      {
        name: "broker_connection_verified",
        passed: this.verified,
        detail: this.verified ? "connected and reconciled" : "not verified in this process",
      },
    ];
    if (!opts.ignoreArm)
      checks.push({
        name: "manual_arm",
        passed: this.armedUntil > this.now(),
        detail:
          this.armedUntil > this.now()
            ? `armed until ${new Date(this.armedUntil).toISOString()}`
            : "not armed in this process",
      });
    const allowed = checks.every((x) => x.passed);
    return { effectiveMode: allowed ? "live" : "paper", allowed, checks };
  }
}
