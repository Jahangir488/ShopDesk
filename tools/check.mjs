#!/usr/bin/env node
// Fast sanity checks that run without any npm packages:
//   npm run check
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeQr, qrSvg } from "../lib/qr.mjs";
import { buildMedexSearchUrl, getMedexCatalogStats, normalizeMedexUrl, parseMedexDetailsHtml, parseMedexSearchHtml, searchLocalMedexCatalog } from "../lib/medex.mjs";
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

console.log("Pharmacy workflow and no licensing gates");
try {
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const app = readFileSync(join(root, "app.js"), "utf8");
  for (const removed of ["lib/license.mjs", "lib/license-public.mjs", "LICENSING.md", "3 - Build Licence Kit.bat", "4 - Issue Customer Licence.bat", "tools/license-issue.mjs", "tools/license-keygen.mjs", "tools/supplier-licence.mjs", "tools/licence-kit.mjs", "tools/make-licence-kit.mjs"]) {
    if (existsSync(join(root, removed))) fail(`removed licensing file still exists: ${removed}`);
  }
  for (const forbidden of ["/api/license", "licenseStatus", "verifyLicense", "signLicense", "licensedFeatureEnabled", "shopTypeLocked"]) {
    if (server.includes(forbidden) || app.includes(forbidden)) fail(`licensing token still present: ${forbidden}`);
  }
  for (const token of ["medicine_batches", "medicine_batch_sales", "pharmacyAvailableQty", "allocatePharmacyBatchStock", "quarantinePharmacyReturn", "/api/pharmacy/medex", "/api/restaurant/packages", "can_food_packages"]) {
    if (!server.includes(token)) fail(`server is missing Pharmacy/Restaurant safeguard: ${token}`);
  }
  for (const token of ["openPharmacyBatchManager", "openPharmacyMedicineLookup", "mountMedexLookupBox", "bulkInventoryTemplateConfig", "pharmacy-inventory-template.csv", "restaurant-inventory-template.csv", "Food & restaurant", "openFoodPackageManager", "openFoodPackageEditor", "purchase-batch", "genericName", "expiryDate", "productSellableQty"]) {
    if (!app.includes(token)) fail(`Pharmacy/Restaurant interface is missing ${token}`);
  }
  if (buildMedexSearchUrl("Napa 500") !== "https://medex.com.bd/search?search=Napa+500") fail("MedEx search URL builder failed");
  if (normalizeMedexUrl("https://evil.example.com/brands/1") !== "") fail("MedEx URL validation accepted non-MedEx host");
  const sampleSearch = parseMedexSearchHtml(`<a href="https://medex.com.bd/brands/1019/napa-500-mg-tablet" class="hoverable-block"><div class="col-xs-12 data-row-top">Napa <span class="inline-dosage-form">Tablet</span></div><div class="col-xs-12 data-row-strength"><span class="grey-ligten">500 mg</span></div><div class="col-xs-12">Paracetamol</div><div class="col-xs-12 data-row-company">Beximco Pharmaceuticals Ltd.</div></a>`);
  if (sampleSearch.length !== 1 || sampleSearch[0].name !== "Napa" || sampleSearch[0].dosageForm !== "Tablet" || sampleSearch[0].strength !== "500 mg" || sampleSearch[0].genericName !== "Paracetamol") {
    fail("MedEx search HTML parser failed");
  }
  const sampleDetails = parseMedexDetailsHtml(`<h1>Napa <small class="h1-subtitle">Tablet</small></h1><div title="Generic Name">Paracetamol</div><div title="Strength">500 mg</div><div title="Manufactured by">Beximco Pharmaceuticals Ltd.</div><div class="package-container">Unit Price: ৳ 1.20</div><h3 class="ac-header">Indications</h3><div class="ac-body">Fever and mild to moderate pain.</div>`, "https://medex.com.bd/brands/1019/napa-500-mg-tablet");
  if (!sampleDetails || sampleDetails.unitPrice !== 1.2 || sampleDetails.sections.length !== 1 || sampleDetails.sections[0].title !== "Indications") {
    fail("MedEx details HTML parser failed");
  }
  const catalogStats = getMedexCatalogStats();
  if (catalogStats.totalMedicines < 19000 || catalogStats.totalMonographs < 100) {
    fail(`bundled MedEx catalog incomplete: ${JSON.stringify(catalogStats)}`);
  }
  const napaResults = searchLocalMedexCatalog("Napa");
  if (!napaResults.some(item => item.name === "Napa" && item.genericName === "Paracetamol")) {
    fail("bundled MedEx catalog search for Napa failed");
  }
  ok(`licensing removed, shop types unlocked, Pharmacy batch flows and MedEx catalog (${catalogStats.totalMedicines} medicines) intact`);
} catch (error) { fail("Pharmacy workflow: " + error.message); }

console.log("Install files");
try {
  const required = [
    "INSTALL.md", "Dockerfile", "docker-compose.yml", ".env.example",
    "1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat",
    "install/windows/install-shopdesk.ps1", "install/windows/install-shopdesk.bat",
    "install/windows/update-shopdesk.ps1", "install/windows/uninstall-shopdesk.ps1",
    "install/windows/uninstall-shopdesk.bat",
    "install/windows/repair-shopdesk.ps1", "install/windows/repair-shopdesk.bat",
    "install/linux/install-shopdesk.sh", "install/linux/uninstall-shopdesk.sh", "install/linux/shopdesk.service",
    "join.html", "offline.html", "icons/shopdesk.ico", "tools/make-icons.mjs"
  ];
  const missing = required.filter(file => !existsSync(join(root, file)));
  if (missing.length) fail("missing install files: " + missing.join(", "));
  else ok(`${required.length} install and PWA files present`);
  // Batch files must keep Windows line endings; LF-only copies break cmd.exe blocks.
  for (const bat of ["1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat", "install/windows/install-shopdesk.bat", "install/windows/uninstall-shopdesk.bat", "install/windows/repair-shopdesk.bat"]) {
    const bytes = readFileSync(join(root, bat));
    if (!bytes.includes("\r\n") || bytes.toString("latin1").replace(/\r\n/g, "").includes("\n")) fail(`${bat} must use CRLF line endings`);
  }
  ok("batch files use CRLF line endings");
  const installer = readFileSync(join(root, "install", "windows", "install-shopdesk.ps1"), "utf8");
  for (const token of ["vendor", "*.pem"]) if (!installer.includes(token)) fail(`installer should exclude ${token}`);
  const updater = readFileSync(join(root, "install", "windows", "update-shopdesk.ps1"), "utf8");
  const linuxInstaller = readFileSync(join(root, "install", "linux", "install-shopdesk.sh"), "utf8");
  if (!installer.includes('"tools"')) fail("Windows installer must exclude tools");
  if (!updater.includes("tools")) fail("Windows updater must exclude tools");
  if (!linuxInstaller.includes("--exclude 'tools'")) fail("Linux installer must exclude tools");
  ok("customer installers exclude tools, vendor keys and PEM files");
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
  ok(`${scripts.length} Windows scripts probe drives, set the desktop icon and use IPv4 loopback`);
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
