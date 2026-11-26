// Copies the dashboard's static assets next to the compiled server (dist/quantforge/dashboard/public).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] ?? "dist";
const from = join(root, "src", "quantforge", "dashboard", "public");
const to = join(root, outDir, "quantforge", "dashboard", "public");
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
process.stdout.write(`copied dashboard assets to ${to}\n`);
