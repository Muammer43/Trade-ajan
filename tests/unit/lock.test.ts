// The process lock must work where hard links are forbidden (Android/Termux app storage).
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Lock } from "../../src/store/lock.js";
import { tempHome } from "../helpers.js";

describe("process lock", () => {
  it("falls back to an exclusive create when hard links are refused (EACCES)", async () => {
    const { paths, cleanup } = tempHome();
    const original = fs.link;
    fs.link = (async () => {
      throw Object.assign(new Error("permission denied, link"), { code: "EACCES" });
    }) as typeof fs.link;
    try {
      const path = join(paths.home, "test.lock");
      const a = await Lock.acquire(path);
      assert.ok(a instanceof Lock, "first acquire succeeds without link()");
      const b = await Lock.acquire(path);
      assert.ok(!(b instanceof Lock), "a second holder is refused");
      assert.equal(JSON.parse(await fs.readFile(path, "utf8")).pid, process.pid);
      await a.release();
      const c = await Lock.acquire(path);
      assert.ok(c instanceof Lock, "acquirable again after release");
      await c.release();
    } finally {
      fs.link = original;
      cleanup();
    }
  });
});
