#!/usr/bin/env node
// Issue a signed Shop Desk licence key.
//   node tools/license-issue.mjs --shop "Mohammad Hardware" --plan pro --days 365
//   node tools/license-issue.mjs --shop "Karim Store" --days 30 --install 1a2b3c4d...
//   node tools/license-issue.mjs --shop "X" --days 365 --out license.txt
// Options: --plan <name> --seats <n> --install <install-id> --expires <YYYY-MM-DD>
// Package options: --shop-type general|hardware|grocery|clothing|pharmacy|mobile --features online_orders,pharmacy,clothing,repairs,devices
import { writeFileSync } from "node:fs";
import { signLicense, loadPrivateKey, LICENSE_SHOP_TYPES, LICENSE_FEATURES } from "../lib/license.mjs";

const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const shop = value("--shop");
const plan = value("--plan") || "standard";
const seats = Number(value("--seats") || 0);
const install = value("--install") || "";
const shopType = value("--shop-type") || "";
const defaultFeatures = shopType === "pharmacy" ? ["pharmacy"] : shopType === "clothing" ? ["clothing"] : shopType === "mobile" ? ["repairs", "devices"] : [];
const rawFeatures = value("--features");
const features = rawFeatures === undefined ? defaultFeatures : rawFeatures.split(",").map(feature => feature.trim()).filter(Boolean);
const days = Number(value("--days") || 365);
if (!shopType || !LICENSE_SHOP_TYPES.includes(shopType)) {
  console.error(`--shop-type is required and must be one of: ${LICENSE_SHOP_TYPES.join(", ")}.`);
  process.exit(1);
}
const normalizedInstall = install.replace(/[^a-z0-9]/gi, "");
if (!/^[a-f0-9]{24}$/i.test(normalizedInstall)) {
  console.error("--install must be the customer's full 24-character Installation ID from ShopDesk → Settings → Licence & plan.");
  process.exit(1);
}
if (features.some(feature => !LICENSE_FEATURES.includes(feature)) || new Set(features).size !== features.length) {
  console.error(`--features may contain unique values from: ${LICENSE_FEATURES.join(", ")}.`);
  process.exit(1);
}
const incompatibleFeatures = features.filter(feature =>
  (feature === "pharmacy" && shopType !== "pharmacy") ||
  (feature === "clothing" && shopType !== "clothing") ||
  (["repairs", "devices"].includes(feature) && shopType !== "mobile") ||
  (feature === "online_orders" && shopType === "pharmacy")
);
if (incompatibleFeatures.length) {
  console.error(`These modules do not apply to the selected shop type: ${incompatibleFeatures.join(", ")}.`);
  process.exit(1);
}
if (shopType === "pharmacy" && !features.includes("pharmacy")) {
  console.error("A Pharmacy package must include the pharmacy feature.");
  process.exit(1);
}
const expiresFlag = value("--expires");

if (!shop || shop.trim().length < 2) {
  console.error('Usage: node tools/license-issue.mjs --shop "Shop name" [--plan pro] [--days 365] [--install <id>]');
  process.exit(1);
}
if (!Number.isInteger(days) || days < 1 || days > 9999) {
  console.error("--days must be a whole number between 1 and 9999.");
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
  expires: expires.toISOString(),
  install: normalizedInstall,
  shopType,
  features
};

const token = signLicense(payload, loadPrivateKey());
const out = value("--out");
if (out) {
  writeFileSync(out, token + "\n");
  console.log(`Licence written to ${out}`);
} else {
  console.log(token);
}
console.error(`\nShop: ${payload.shop}\nPlan: ${payload.plan}\nShop type: ${shopType}\nModules: ${features.join(", ") || "core only"}\nExpires: ${payload.expires.slice(0, 10)}\nInstall: ${normalizedInstall}`);
