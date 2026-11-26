// Process health: memory, event-loop lag, uptime, and the job heartbeat.

import { monitorEventLoopDelay } from "node:perf_hooks";

export class HealthMonitor {
  private readonly loop = monitorEventLoopDelay({ resolution: 10 });
  private readonly startedAt = Date.now();
  private readonly heartbeats = new Map<
    string,
    { ts: number; ok: boolean; detail: string; durationMs: number }
  >();

  constructor() {
    this.loop.enable();
  }

  beat(job: string, ok: boolean, detail: string, durationMs: number): void {
    this.heartbeats.set(job, { ts: Date.now(), ok, detail, durationMs: Math.round(durationMs) });
  }

  report() {
    const m = process.memoryUsage();
    const mb = (x: number) => Math.round((x / 1024 / 1024) * 10) / 10;
    return {
      pid: process.pid,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      memoryMb: { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal) },
      eventLoopLagMs: {
        p50: Math.round(this.loop.percentile(50) / 1e6),
        p99: Math.round(this.loop.percentile(99) / 1e6),
        max: Math.round(this.loop.max / 1e6),
      },
      jobs: Object.fromEntries(this.heartbeats),
    };
  }

  stop(): void {
    this.loop.disable();
  }
}
