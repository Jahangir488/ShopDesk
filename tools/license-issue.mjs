#!/usr/bin/env node
// Issue a signed Shop Desk licence key.
//   node tools/license-issue.mjs --shop "Mohammad Hardware" --plan pro --days 365
//   node tools/license-issue.mjs --shop "Karim Store" --days 30 --install 1a2b3c4d...
//   node tools/license-issue.mjs --shop "X" --days 365 --out license.txt
// Options: --plan <name> --seats <n> --install <install-id> --expires <YYYY-MM-DD>
import { writeFileSync } from "node:fs";
import { signLicense, loadPrivateKey } from "../lib/license.mjs";

const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const shop = value("--shop");
const plan = value("--plan") || "standard";
const seats = Number(value("--seats") || 0);
const install = value("--install") || "";
const days = Number(value("--days") || 365);
const expiresFlag = value("--expires");

if (!shop || shop.trim().length < 2) {
  console.error('Usage: node tools/license-issue.mjs --shop "Shop name" [--plan pro] [--days 365] [--install <id>]');
  process.exit(1);
}
if (!Number.isFinite(days) || days <= 0) {
  console.error("--days must be a positive number.");
  process.exit(1);
}
const issued = new Date();
const expires = expiresFlag ? new Date(`${expiresFlag}T23:59:59Z`) : new Date(issued.getTime() + days * 86400000);
if (Number.isNaN(expires.getTime()) || expires <= issued) {
  console.error("--expires must be a future date in YYYY-MM-DD form.");
  process.exit(1);
}

const payload = {
  id: `lic-${issued.toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
  shop: shop.trim(),
  plan,
  seats: Number.isFinite(seats) ? seats : 0,
  issued: issued.toISOString(),
  expires: expires.toISOString()
};
if (install) payload.install = install;

const token = signLicense(payload, loadPrivateKey());
const out = value("--out");
if (out) {
  writeFileSync(out, token + "\n");
  console.log(`Licence written to ${out}`);
} else {
  console.log(token);
}
console.error(`\nShop: ${payload.shop}\nPlan: ${payload.plan}\nExpires: ${payload.expires.slice(0, 10)}${install ? `\nInstall: ${install}` : ""}`);
