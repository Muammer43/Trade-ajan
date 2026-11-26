// Drives the Termux shell scripts against the built application in a temporary home: install prerequisite
// check, start, status, health, a kill -9 crash, restart over the stale lock, backup, stop and restore.
// The daemon runs with its scheduler disabled, so no market-data request is made.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tempHome } from "../helpers.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const built = existsSync(join(ROOT, "dist", "quantforge", "cli", "main.js"));

describe("Termux shell scripts", { skip: built ? false : "run `npm run build` first" }, () => {
  const home = tempHome();
  after(() => {
    spawnSync("bash", [join(ROOT, "stop.sh")], { env: { ...process.env, QF_HOME: home.paths.home } });
    home.cleanup();
  });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  writeFileSync(home.paths.config, JSON.stringify({ scheduler: { enabled: false }, dashboard: { port } }));
  const env = { ...process.env, QF_HOME: home.paths.home, TWELVEDATA_API_KEY: "" };
  const sh = (script: string, ...args: string[]) =>
    spawnSync("bash", [join(ROOT, script), ...args], { env, encoding: "utf8", timeout: 60_000 });
  const pid = () => Number(readFileSync(home.paths.pidFile, "utf8").trim());

  it("install.sh --check verifies Node.js and node:sqlite", () => {
    const r = sh("install.sh", "--check");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK {2}node:sqlite/);
  });

  it("start.sh starts one instance; status and health report it", async () => {
    const r = sh("start.sh");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /started \(PID \d+\)/);
    assert.match(sh("start.sh").stdout, /already running/);
    await new Promise((res) => setTimeout(res, 1500));
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.match(sh("status.sh").stdout, /daemon: running/);
    // 0 = healthy, 3 = running but degraded (no market data: the scheduler is off in this test).
    assert.ok([0, 3].includes(sh("healthcheck.sh").status ?? -1));
  });

  it("recovers after kill -9 (stale PID and lock) and restarts cleanly", async () => {
    process.kill(pid(), "SIGKILL");
    // Wait until the killed process is gone (or a zombie) rather than for a fixed time.
    let status = "";
    for (let k = 0; k < 40; k++) {
      await new Promise((res) => setTimeout(res, 250));
      status = sh("status.sh").stdout;
      if (/daemon: not running/.test(status)) break;
    }
    assert.match(status, /daemon: not running/);
    assert.equal(sh("healthcheck.sh").status, 1);
    const r = sh("healthcheck.sh", "--restart");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  });

  it("backup.sh works while running; stop.sh stops; restore.sh restores", () => {
    const b = sh("backup.sh");
    assert.equal(b.status, 0, b.stderr);
    const files = readdirSync(home.paths.backups).filter((f) => f.endsWith(".db"));
    assert.equal(files.length, 1);
    assert.equal(
      sh("restore.sh", join(home.paths.backups, files[0] as string)).status,
      1,
      "restore refuses while running",
    );
    const s = sh("stop.sh");
    assert.equal(s.status, 0);
    assert.match(s.stdout, /stopped/);
    assert.ok(!existsSync(home.paths.pidFile));
    const r = sh("restore.sh", join(home.paths.backups, files[0] as string));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /restored/);
  });
});
