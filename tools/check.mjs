#!/usr/bin/env node
// Fast sanity checks that run without any npm packages:
//   npm run check
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAL_DAYS, installIdMatches, signLicense, verifyLicense, licenseStatus } from "../lib/license.mjs";
import { encodeQr, qrSvg } from "../lib/qr.mjs";
import { decryptBuffer, encryptBuffer } from "../lib/offsite.mjs";
import { compareVersions, parseManifest, signManifest, verifyManifest } from "../lib/release.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = message => console.log(`  ok  ${message}`);
const fail = message => { failures++; console.error(` FAIL ${message}`); };

console.log("Syntax");
const files = ["server.mjs", "app.js", "sw.js", ...readdirSync(join(root, "lib")).filter(name => name.endsWith(".mjs")).map(name => join("lib", name)), ...readdirSync(join(root, "tools")).filter(name => name.endsWith(".mjs")).map(name => join("tools", name))];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status === 0) ok(file); else fail(`${file}: ${result.stderr.split("\n")[0]}`);
}

console.log("Translations");
try {
  const bn = JSON.parse(readFileSync(join(root, "i18n", "bn.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "i18n", "en.json"), "utf8"));
  const entries = Object.entries(bn.strings || {});
  const empty = entries.filter(([, value]) => !String(value || "").trim());
  if (empty.length) fail(`empty translations: ${empty.map(([key]) => key).join(", ")}`);
  for (const rule of bn.patterns || []) { try { new RegExp(rule.re); } catch { fail(`bad pattern: ${rule.re}`); } }
  if (!en.strings) fail("en.json needs a strings object");
  ok(`${entries.length} Bangla strings, ${(bn.patterns || []).length} patterns`);
} catch (error) { fail("i18n JSON: " + error.message); }

console.log("Manifest and icons");
try {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
  for (const field of ["name", "short_name", "start_url", "display", "icons"]) if (!manifest[field]) fail(`manifest missing ${field}`);
  for (const icon of manifest.icons) {
    const exists = readdirSync(join(root, "icons")).includes(icon.src.split("/").pop());
    if (!exists) fail(`missing icon file ${icon.src}`);
  }
  ok(`${manifest.icons.length} icons, display=${manifest.display}`);
} catch (error) { fail("manifest: " + error.message); }

console.log("Licensing");
try {
  // Self-contained check: use a throwaway key pair so no vendor key is needed.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const installId = "da7b5514ceb6404b48a27a78";
  const expires = new Date(Date.now() + 86400000 * 365);
  const token = signLicense({ id: "check", shop: "Check Shop", plan: "pro", seats: 2, issued: new Date(), expires, install: installId }, privateKey);
  const verified = verifyLicense(token, { installId, publicKey });
  if (!verified.valid || verified.expired) fail("licence roundtrip");
  const shortToken = signLicense({ id: "short", shop: "Check Shop", plan: "pro", issued: new Date(), expires, install: "da7b-5514-7a78" }, privateKey);
  if (!verifyLicense(shortToken, { installId, publicKey }).valid) fail("short installation ID rejected");
  const status = licenseStatus({ license: { token }, trialStartedAt: new Date(), installId, publicKey });
  if (status.state !== "active") fail("active licence state");
  if (TRIAL_DAYS !== 30) fail(`trial should be 30 days, found ${TRIAL_DAYS}`);
  const trial = licenseStatus({ license: null, trialStartedAt: new Date(), trialDays: TRIAL_DAYS, installId, publicKey });
  if (trial.state !== "trial" || trial.daysLeft !== 30) fail(`30-day trial status: ${trial.state} ${trial.daysLeft}`);
  if (!installIdMatches(installId, installId)) fail("full installation ID should match");
  if (!installIdMatches("da7b-5514-7a78", installId)) fail("short installation ID should match");
  if (installIdMatches("1111-2222-3333", installId)) fail("another installation ID should not match");
  // Change a signed field while keeping the original signature.
  const [prefix, encoded, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  payload.shop = "Tampered Shop";
  const changed = Buffer.from(JSON.stringify(payload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const tampered = verifyLicense([prefix, changed, signature].join("."), { installId, publicKey });
  if (tampered.valid) fail("tampered licence accepted");
  ok("Ed25519 sign/verify, 30-day trial, install IDs and tamper detection");
} catch (error) { fail("licensing: " + error.message); }

console.log("Release manifest");
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = {
    product: "Shop Desk", version: "12.0.1", released: new Date().toISOString(),
    url: "https://downloads.example.com/ShopDesk-12.0.1.zip",
    sha256: "a".repeat(64), size: 123, minVersion: "11.0.0", notes: "check"
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = signManifest(bytes, privateKey);
  const parsed = parseManifest(bytes, signature, { publicKey });
  if (!parsed.valid) fail("signed release manifest rejected");
  const changed = Buffer.from(bytes.toString("utf8").replace("12.0.1", "12.0.9"));
  if (verifyManifest(changed, signature, { publicKey }).valid) fail("tampered manifest accepted");
  if (compareVersions("12.0.10", "12.0.9") <= 0 || compareVersions("12.0.0", "12.0.1") >= 0) fail("version comparison");
  ok("Ed25519 release manifest, tamper detection and versions");
} catch (error) { fail("release manifest: " + error.message); }

console.log("Install files");
try {
  const required = [
    "INSTALL.md", "LICENSING.md", "Dockerfile", "docker-compose.yml", ".env.example",
    "1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat", "3 - Build Licence Kit.bat",
    "install/windows/install-shopdesk.ps1", "install/windows/install-shopdesk.bat",
    "install/windows/update-shopdesk.ps1", "install/windows/uninstall-shopdesk.ps1",
    "install/windows/uninstall-shopdesk.bat",
    "install/windows/repair-shopdesk.ps1", "install/windows/repair-shopdesk.bat",
    "install/linux/install-shopdesk.sh", "install/linux/uninstall-shopdesk.sh", "install/linux/shopdesk.service",
    "lib/license-public.mjs", "tools/licence-kit.mjs", "tools/make-licence-kit.mjs",
    "join.html", "offline.html"
  ];
  const missing = required.filter(file => !existsSync(join(root, file)));
  if (missing.length) fail("missing install files: " + missing.join(", "));
  else ok(`${required.length} install, licence and PWA files present`);
  // Batch files must keep Windows line endings; LF-only copies break cmd.exe blocks.
  for (const bat of ["1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat", "install/windows/install-shopdesk.bat", "install/windows/uninstall-shopdesk.bat", "install/windows/repair-shopdesk.bat"]) {
    const bytes = readFileSync(join(root, bat));
    if (!bytes.includes("\r\n") || bytes.toString("latin1").replace(/\r\n/g, "").includes("\n")) fail(`${bat} must use CRLF line endings`);
  }
  ok("batch files use CRLF line endings");
  // The installer must never copy the signing key or issued licences onto a shop PC.
  const installer = readFileSync(join(root, "install", "windows", "install-shopdesk.ps1"), "utf8");
  for (const token of ["vendor", "licences", "*.pem"]) if (!installer.includes(token)) fail(`installer should exclude ${token}`);
  ok("installer excludes the signing key, PEM files and licence receipts");
} catch (error) { fail("install files: " + error.message); }

console.log("QR code");
try {
  const matrix = encodeQr("http://192.168.0.10:8765/", { errorCorrectionLevel: "M" });
  if (matrix.length !== 25) fail(`unexpected QR size ${matrix.length}`);
  const svg = qrSvg("http://192.168.0.10:8765/");
  if (!svg.startsWith("<svg") || !svg.includes("<path")) fail("QR SVG output");
  ok(`version 2 QR (${matrix.length}x${matrix.length}) and SVG output`);
} catch (error) { fail("QR: " + error.message); }

console.log("Backup encryption");
try {
  const key = "check-key-0123456789";
  const source = Buffer.from("SQLite format 3\0payload");
  const sealed = encryptBuffer(source, key);
  if (!decryptBuffer(sealed, key).equals(source)) fail("encryption roundtrip");
  let rejected = false;
  try { decryptBuffer(sealed, "wrong-key-0123456789"); } catch { rejected = true; }
  if (!rejected) fail("wrong backup key was accepted");
  ok("AES-256-GCM roundtrip and wrong-key rejection");
} catch (error) { fail("backup encryption: " + error.message); }

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
