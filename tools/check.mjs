#!/usr/bin/env node
// Fast sanity checks that run without any npm packages:
//   npm run check
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAL_DAYS, installIdMatches, signLicense, verifyLicense, licenseStatus, loadPublicKey } from "../lib/license.mjs";
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

console.log("Responsive header");
try {
  const css = readFileSync(join(root, "styles.css"), "utf8");
  const topbar = css.match(/\.topbar\{([^}]+)\}/)?.[1] || "";
  if (!topbar.includes("height:auto") || !topbar.includes("min-height:58px") || !topbar.includes("flex-wrap:wrap")) fail("topbar must grow when browser zoom or narrow width wraps its controls");
  ok("header can grow instead of clipping wrapped controls");
} catch (error) { fail("responsive header: " + error.message); }

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
  const deployedPublicKey = loadPublicKey();
  if (deployedPublicKey.asymmetricKeyType !== "ed25519") fail("declared licence public key must be a valid Ed25519 key");
  // Self-contained check: use a throwaway key pair so no vendor key is needed.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const installId = "da7b5514ceb6404b48a27a78";
  const expires = new Date(Date.now() + 86400000 * 365);
  const token = signLicense({ id: "check", shop: "Check Shop", plan: "pro", seats: 2, issued: new Date(), expires, install: installId }, privateKey);
  const verified = verifyLicense(token, { installId, publicKey });
  if (!verified.valid || verified.expired) fail("licence roundtrip");
  const pharmacyToken = signLicense({
    id: "pharmacy-check", shop: "Check Pharmacy", plan: "pro", issued: new Date(), expires, install: installId,
    shopType: "pharmacy", features: ["pharmacy"]
  }, privateKey);
  const pharmacyLicence = verifyLicense(pharmacyToken, { installId, publicKey });
  if (!pharmacyLicence.valid || pharmacyLicence.payload.shopType !== "pharmacy" ||
      !Array.isArray(pharmacyLicence.payload.features) || !pharmacyLicence.payload.features.includes("pharmacy")) {
    fail("signed Pharmacy package should preserve its shop type and feature entitlement");
  }
  const invalidPackageToken = signLicense({
    id: "invalid-package", shop: "Check Shop", plan: "pro", issued: new Date(), expires, install: installId,
    shopType: "not-a-shop-type", features: ["pharmacy"]
  }, privateKey);
  if (verifyLicense(invalidPackageToken, { installId, publicKey }).valid) fail("unknown shop type must be rejected");
  const missingFeaturesToken = signLicense({
    id: "missing-features", shop: "Check Shop", plan: "pro", issued: new Date(), expires, install: installId,
    shopType: "general"
  }, privateKey);
  if (verifyLicense(missingFeaturesToken, { installId, publicKey }).valid) fail("new package keys must include an explicit feature list");
  const featuresOnlyToken = signLicense({
    id: "features-only", shop: "Check Shop", plan: "pro", issued: new Date(), expires, install: installId,
    features: ["online_orders"]
  }, privateKey);
  if (verifyLicense(featuresOnlyToken, { installId, publicKey }).valid) fail("module entitlements without a shop type must be rejected");
  const incompatibleFeatureToken = signLicense({
    id: "incompatible-features", shop: "Check Shop", plan: "pro", issued: new Date(), expires, install: installId,
    shopType: "general", features: ["pharmacy"]
  }, privateKey);
  if (verifyLicense(incompatibleFeatureToken, { installId, publicKey }).valid) fail("a Pharmacy module must not be assigned to a non-Pharmacy shop");
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
  ok("Ed25519 sign/verify, strict package entitlements, 30-day trial, install IDs and tamper detection");
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

console.log("Commercial seller licensing and Pharmacy workflow");
try {
  const licenser = readFileSync(join(root, "tools", "supplier-licence.mjs"), "utf8");
  const cliIssuer = readFileSync(join(root, "tools", "license-issue.mjs"), "utf8");
  const licenseCore = readFileSync(join(root, "lib", "license.mjs"), "utf8");
  if (!licenser.includes("days > 9999") || !cliIssuer.includes("days > 9999")) fail("licence durations must be limited to whole days from 1 to 9999");
  if (!licenseCore.includes("does not match lib/license-public.mjs")) fail("supplier signing must reject a private key that does not match the deployed public key");
  const oldKit = readFileSync(join(root, "tools", "make-licence-kit.mjs"), "utf8");
  const oldIssuer = readFileSync(join(root, "tools", "licence-kit.mjs"), "utf8");
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const app = readFileSync(join(root, "app.js"), "utf8");
  for (const token of ["shopType", "features", "install: normalizedInstall", "signLicense"]) {
    if (!licenser.includes(token)) fail(`supplier issuer is missing ${token}`);
  }
  if (!oldKit.includes("has been retired") || !oldIssuer.includes("disabled")) fail("legacy USB licence kit must be disabled");
  if (oldKit.includes("privateKeyFile") || oldKit.includes("private/license-private-key.pem")) fail("legacy kit builder must not copy a private key");
  for (const token of ["medicine_batches", "medicine_batch_sales", "pharmacyAvailableQty", "allocatePharmacyBatchStock", "quarantinePharmacyReturn", "shop_type=?"]) {
    if (!server.includes(token)) fail(`server is missing Pharmacy/package safeguard: ${token}`);
  }
  for (const token of ["openPharmacyBatchManager", "purchase-batch", "genericName", "expiryDate", "productSellableQty"]) {
    if (!app.includes(token)) fail(`Pharmacy interface is missing ${token}`);
  }
  ok("supplier-only key issuing, customer key isolation, package enforcement and Pharmacy batch flows");
} catch (error) { fail("commercial licensing / Pharmacy workflow: " + error.message); }

console.log("Install files");
try {
  const required = [
    "INSTALL.md", "LICENSING.md", "Dockerfile", "docker-compose.yml", ".env.example",
    "1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat", "3 - Build Licence Kit.bat", "4 - Issue Customer Licence.bat",
    "tools/supplier-licence.mjs", "install/windows/install-shopdesk.ps1", "install/windows/install-shopdesk.bat",
    "install/windows/update-shopdesk.ps1", "install/windows/uninstall-shopdesk.ps1",
    "install/windows/uninstall-shopdesk.bat",
    "install/windows/repair-shopdesk.ps1", "install/windows/repair-shopdesk.bat",
    "install/linux/install-shopdesk.sh", "install/linux/uninstall-shopdesk.sh", "install/linux/shopdesk.service",
    "lib/license-public.mjs", "tools/licence-kit.mjs", "tools/make-licence-kit.mjs",
    "join.html", "offline.html", "icons/shopdesk.ico", "tools/make-icons.mjs"
  ];
  const missing = required.filter(file => !existsSync(join(root, file)));
  if (missing.length) fail("missing install files: " + missing.join(", "));
  else ok(`${required.length} install, licence and PWA files present`);
  // Batch files must keep Windows line endings; LF-only copies break cmd.exe blocks.
  for (const bat of ["1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat", "3 - Build Licence Kit.bat", "4 - Issue Customer Licence.bat", "install/windows/install-shopdesk.bat", "install/windows/uninstall-shopdesk.bat", "install/windows/repair-shopdesk.bat"]) {
    const bytes = readFileSync(join(root, bat));
    if (!bytes.includes("\r\n") || bytes.toString("latin1").replace(/\r\n/g, "").includes("\n")) fail(`${bat} must use CRLF line endings`);
  }
  ok("batch files use CRLF line endings");
  // The installer must never copy the signing key or issued licences onto a shop PC.
  const installer = readFileSync(join(root, "install", "windows", "install-shopdesk.ps1"), "utf8");
  for (const token of ["vendor", "licences", "*.pem"]) if (!installer.includes(token)) fail(`installer should exclude ${token}`);
  const updater = readFileSync(join(root, "install", "windows", "update-shopdesk.ps1"), "utf8");
  const linuxInstaller = readFileSync(join(root, "install", "linux", "install-shopdesk.sh"), "utf8");
  if (!installer.includes('"tools"') || !installer.includes("4 - Issue Customer Licence.bat")) fail("Windows installer must exclude supplier-only licence tools");
  if (!updater.includes("tools") || !updater.includes("4 - Issue Customer Licence.bat")) fail("Windows updater must exclude supplier-only licence tools");
  if (!linuxInstaller.includes("--exclude 'tools'") || !linuxInstaller.includes("4 - Issue Customer Licence.bat")) fail("Linux installer must exclude supplier-only licence tools");
  ok("customer installers exclude supplier tools, the signing key, PEM files and licence receipts");
  const licenceBuilder = readFileSync(join(root, "3 - Build Licence Kit.bat"), "utf8");
  for (const token of ["license-keygen.mjs", "license-key-sync-pending.txt", "lib\\license-public.mjs", "NEVER send vendor\\license-private-key.pem"]) {
    if (!licenceBuilder.includes(token)) fail(`licence builder must provide the safe one-click setup (${token})`);
  }
  const ico = readFileSync(join(root, "icons", "shopdesk.ico"));
  const imageOffset = ico.readUInt32LE(18);
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 1 || ico[6] !== 0 || ico[7] !== 0) fail("Shop Desk Windows icon must be a single 256px ICO image");
  if (ico.subarray(imageOffset, imageOffset + 8).toString("hex") !== "89504e470d0a1a0a") fail("Shop Desk ICO image must contain a PNG payload");
  const offline = readFileSync(join(root, "offline.html"), "utf8");
  if (!offline.includes('src="/icons/icon-192.png"') || offline.includes("🏪")) fail("offline page must use the branded icon instead of an emoji");
  ok("custom PWA, offline and Windows shortcut icons");
} catch (error) { fail("install files: " + error.message); }

console.log("Windows scripts");
try {
  // Join-Path and Test-Path throw for a drive letter that does not exist (F: on a
  // PC without that drive), which stopped the installer before it did anything.
  const scripts = ["install-shopdesk.ps1", "repair-shopdesk.ps1", "uninstall-shopdesk.ps1", "update-shopdesk.ps1"];
  for (const name of scripts) {
    const text = readFileSync(join(root, "install", "windows", name), "utf8");
    if (/\bJoin-Path\s/.test(text)) fail(`${name} must use Join-SafePath; Join-Path throws when a drive letter is missing`);
    if (!text.includes("function Join-SafePath")) fail(`${name} is missing the Join-SafePath helper`);
    if (!text.includes("[System.IO.File]::Exists")) fail(`${name} is missing the .NET file checks`);
    if (/Test-Path\s+\(Join-/.test(text)) fail(`${name} checks a path with Test-Path`);
  }
  const installer = readFileSync(join(root, "install", "windows", "install-shopdesk.ps1"), "utf8");
  if (!installer.includes("if (Test-AppFile $candidate) { return $candidate }")) fail("the drive scan must use Test-AppFile");
  // Start-Process joins ArgumentList into one command-line string; quote this
  // filename explicitly or Robocopy sees its spaces as separate parameters.
  if (!installer.includes("'\"3 - Build Licence Kit.bat\"'")) fail("the installer must quote the licence-kit filename passed to Robocopy");
  const updater = readFileSync(join(root, "install", "windows", "update-shopdesk.ps1"), "utf8");
  if (!updater.includes('"3 - Build Licence Kit.bat"')) fail("the updater must quote the licence-kit filename passed to Robocopy");
  for (const name of ["install-shopdesk.ps1", "repair-shopdesk.ps1"]) {
    const text = readFileSync(join(root, "install", "windows", name), "utf8");
    if (!text.includes("function Write-UrlShortcut") || !text.includes("IconFile=$iconPath")) fail(`${name} must give the desktop shortcuts the Shop Desk icon`);
    if (!text.includes("http://127.0.0.1:$Port/")) fail(`${name} must use IPv4 loopback for the local desktop URL`);
  }
  if (!installer.includes('cd /d `"%~dp0app`"')) fail("the install launcher must run from the app directory containing server.mjs");
  const repair = readFileSync(join(root, "install", "windows", "repair-shopdesk.ps1"), "utf8");
  if (!repair.includes("$oldWorkingDir = 'cd /d \"%~dp0\"'") || !repair.includes("$runContents.Replace($oldWorkingDir, 'cd /d \"%~dp0app\"')")) fail("repair must migrate an existing run-shop.cmd to the app directory");
  if (!installer.includes("Waiting for the local server") || !installer.includes("timed out")) fail("the installer should show progress while checking server startup");
  if (!installer.includes("[System.IO.DriveInfo]::new") || !installer.includes("$drive.IsReady")) fail("the installer must reject a drive that is not ready");
  if (!installer.includes('"/R:2", "/W:2"')) fail("Robocopy must not retry a failed copy for hours");
  ok(`${scripts.length} Windows scripts probe drives, quote Robocopy exclusions, set the desktop icon and use IPv4 loopback`);
} catch (error) { fail("Windows scripts: " + error.message); }

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
