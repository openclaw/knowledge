#!/usr/bin/env node
// Run the openclaw CLI that belongs to the running gateway, not this package's
// own peer copy in node_modules/.bin. Plugin build/validate open the host state
// database, and an older peer copy refuses a newer schema. OPENCLAW_HOST_CLI overrides.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

const executable = (file) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };
const outsidePackage = (dir) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir);
const cli = process.env.OPENCLAW_HOST_CLI || (process.env.PATH ?? "").split(path.delimiter)
  .filter((dir) => dir && outsidePackage(dir))
  .map((dir) => path.join(dir, "openclaw"))
  .find(executable);
if (!cli) {
  console.error("openclaw CLI not found outside node_modules/.bin; set OPENCLAW_HOST_CLI to the running gateway's CLI.");
  process.exit(127);
}
const result = spawnSync(cli, process.argv.slice(2), { stdio: "inherit" });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);

