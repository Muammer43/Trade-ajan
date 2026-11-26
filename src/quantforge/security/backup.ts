// Database backups: a consistent online copy (SQLite VACUUM INTO), a SHA-256 checksum, owner-only file
// permissions, and optional AES-256-GCM encryption with a key derived (scrypt) from QF_BACKUP_PASSPHRASE.
// Restore verifies the checksum, decrypts, checks SQLite integrity, and keeps the replaced database aside.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { QfPaths } from "../config/load.js";
import { Database } from "../database/db.js";

const MAGIC = Buffer.from("QFBK1");

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function encrypt(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(data: Buffer, passphrase: string): Buffer {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an encrypted QuantForge backup");
  const o = MAGIC.length;
  const salt = data.subarray(o, o + 16);
  const iv = data.subarray(o + 16, o + 28);
  const tag = data.subarray(o + 28, o + 44);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(o + 44)), decipher.final()]);
}

/** Create a backup in the backups directory; returns its path. Old backups beyond `keep` are removed. */
export function createBackup(db: Database, paths: QfPaths, keep: number, passphrase?: string): string {
  mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const raw = join(paths.backups, `quantforge-${stamp}.db`);
  db.backupTo(raw);
  let final = raw;
  if (passphrase) {
    const enc = encrypt(readFileSync(raw), passphrase);
    final = `${raw}.enc`;
    writeFileSync(final, enc, { mode: 0o600 });
    rmSync(raw, { force: true });
  }
  chmodSync(final, 0o600);
  writeFileSync(`${final}.sha256`, `${sha256(readFileSync(final))}  ${basename(final)}\n`, { mode: 0o600 });
  const all = readdirSync(paths.backups)
    .filter((n) => /^quantforge-.*\.db(\.enc)?$/.test(n))
    .map((n) => ({ n, t: statSync(join(paths.backups, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of all.slice(keep)) {
    rmSync(join(paths.backups, old.n), { force: true });
    rmSync(join(paths.backups, `${old.n}.sha256`), { force: true });
  }
  return final;
}

/** Restore a backup over the live database (the application must be stopped). */
export function restoreBackup(
  file: string,
  paths: QfPaths,
  passphrase?: string,
): { restored: string; previous: string | null } {
  if (!existsSync(file)) throw new Error(`no such backup: ${file}`);
  const data = readFileSync(file);
  const sumFile = `${file}.sha256`;
  if (existsSync(sumFile)) {
    const expected = readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
    if (expected !== sha256(data))
      throw new Error("backup checksum mismatch: the file is corrupt or was modified");
  }
  const plain = file.endsWith(".enc")
    ? decrypt(
        data,
        passphrase ??
          (() => {
            throw new Error("encrypted backup: set QF_BACKUP_PASSPHRASE");
          })(),
      )
    : data;
  const staging = `${paths.db}.restore-staging`;
  writeFileSync(staging, plain, { mode: 0o600 });
  const check = new Database(staging);
  const integrity = check.integrityCheck();
  check.close();
  if (integrity !== "ok") {
    rmSync(staging, { force: true });
    throw new Error(`backup failed the integrity check: ${integrity}`);
  }
  let previous: string | null = null;
  if (existsSync(paths.db)) {
    previous = `${paths.db}.before-restore-${Date.now()}`;
    copyFileSync(paths.db, previous);
    chmodSync(previous, 0o600);
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${paths.db}${suffix}`, { force: true });
  renameSync(staging, paths.db);
  return { restored: paths.db, previous };
}

export function listBackups(
  paths: QfPaths,
): { file: string; bytes: number; mtime: number; encrypted: boolean }[] {
  if (!existsSync(paths.backups)) return [];
  return readdirSync(paths.backups)
    .filter((n) => /^quantforge-.*\.db(\.enc)?$/.test(n))
    .map((n) => {
      const st = statSync(join(paths.backups, n));
      return {
        file: join(paths.backups, n),
        bytes: st.size,
        mtime: st.mtimeMs,
        encrypted: n.endsWith(".enc"),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}
