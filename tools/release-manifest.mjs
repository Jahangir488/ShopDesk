#!/usr/bin/env node
/**
 * Create a signed release manifest for update notices.
 *
 *   node tools/release-manifest.mjs \
 *     --version 12.0.1 \
 *     --url https://downloads.example.com/ShopDesk-12.0.1.zip \
 *     --file releases/ShopDesk-12.0.1.zip \
 *     --notes "Bangla receipts and Google Drive backups" \
 *     --out-dir releases
 *
 * Writes <out-dir>/manifest.json and <out-dir>/manifest.json.sig. Publish both
 * next to the zip and point SHOP_UPDATE_MANIFEST_URL at manifest.json.
 * Never publish vendor/license-private-key.pem.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadReleasePrivateKey, signManifest } from "../lib/release.mjs";

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : "";
};

const version = value("version");
const url = value("url");
const file = value("file");
const outDir = value("out-dir") || "releases";
const notes = value("notes") || "";
const minVersion = value("min-version") || "11.0.0";
const released = value("released") || new Date().toISOString();

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node tools/release-manifest.mjs --version 12.0.1 --url https://…/ShopDesk-12.0.1.zip [--file path] [--notes text] [--out-dir releases]");
  process.exit(1);
}
if (!url || !/^https:\/\//i.test(url)) {
  console.error("--url must be the public HTTPS address of the release zip.");
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let sha256 = "";
let size = 0;
if (file) {
  const bytes = readFileSync(file);
  sha256 = createHash("sha256").update(bytes).digest("hex");
  size = bytes.length;
} else {
  sha256 = value("sha256");
  size = Number(value("size")) || 0;
}
if (!/^[a-f0-9]{64}$/i.test(sha256)) {
  console.error("Provide --file <release zip> (recommended) or --sha256 <64 hex characters>.");
  process.exit(1);
}

const manifest = {
  product: "Shop Desk",
  version,
  released,
  url,
  sha256: sha256.toLowerCase(),
  size,
  minVersion,
  notes,
  app: packageJson.name || "shop-desk"
};

const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "manifest.json"), bytes);
const signature = signManifest(bytes, loadReleasePrivateKey());
writeFileSync(join(outDir, "manifest.json.sig"), signature + "\n");
console.log(`Signed ${manifest.product} ${version}`);
console.log(`  manifest:  ${join(outDir, "manifest.json")}`);
console.log(`  signature: ${join(outDir, "manifest.json.sig")}`);
console.log(`  sha256:    ${manifest.sha256}`);
console.log(`  url:       ${manifest.url}`);
console.log(`\nPublish both files and set SHOP_UPDATE_MANIFEST_URL to the manifest.json URL.`);
