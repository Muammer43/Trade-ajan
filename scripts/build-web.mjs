// Bundles the React dashboard (src/quantforge/dashboard/web) into one static file the server serves:
// src/quantforge/dashboard/public/app.js. No CDN, no runtime build step on the phone.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(root, "src/quantforge/dashboard/web/main.tsx")],
  outfile: join(root, "src/quantforge/dashboard/public/app.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: ["chrome90", "firefox90", "safari14"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
process.stdout.write("built dashboard bundle src/quantforge/dashboard/public/app.js\n");
