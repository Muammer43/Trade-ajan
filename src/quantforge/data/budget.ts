// API credit budget: a per-minute sliding window and a per-day allowance, with priorities so that
// position monitoring is never starved by backfill. Day boundaries are UTC midnight (Twelve Data's).

export type Priority = "critical" | "high" | "normal" | "low";
const RESERVE_FOR: Record<Priority, number> = { critical: 0, high: 0.25, normal: 0.6, low: 1 };

export class ApiBudget {
  private window: number[] = [];
  private day = "";
  private usedToday = 0;

  constructor(
    private readonly perMinute: number,
    private readonly perDay: number,
    /** Credits kept back from non-critical work each day. */
    private readonly reserve: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seed today's usage (after a restart) from the health log. */
  seed(usedToday: number): void {
    this.rollDay();
    this.usedToday = Math.max(this.usedToday, usedToday);
  }

  private rollDay(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.usedToday = 0;
    }
  }

  /** Milliseconds to wait before `credits` may be spent at `priority`; Infinity when today's allowance is gone. */
  waitFor(credits: number, priority: Priority): number {
    this.rollDay();
    const allowance = this.perDay - this.reserve * RESERVE_FOR[priority];
    if (this.usedToday + credits > allowance) return Number.POSITIVE_INFINITY;
    const t = this.now();
    this.window = this.window.filter((x) => t - x < 60_000);
    if (this.window.length + credits <= this.perMinute) return 0;
    const oldest = this.window[this.window.length + credits - this.perMinute - 1] ?? t;
    return Math.max(0, 60_000 - (t - oldest)) + 50;
  }

  spend(credits: number): void {
    this.rollDay();
    const t = this.now();
    for (let i = 0; i < credits; i++) this.window.push(t);
    this.usedToday += credits;
  }

  status(): { usedToday: number; perDay: number; lastMinute: number; perMinute: number } {
    this.rollDay();
    const t = this.now();
    return {
      usedToday: this.usedToday,
      perDay: this.perDay,
      lastMinute: this.window.filter((x) => t - x < 60_000).length,
      perMinute: this.perMinute,
    };
  }
}
