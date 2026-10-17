#!/usr/bin/env node
/**
 * Portable Shop Desk licence key generator.
 *
 * Copy this folder to an encrypted USB stick and run "Make Licence Key.bat" on
 * the shop PC. It finds the installation, reads its Installation ID, creates a
 * signed key for this PC only, copies the key to the clipboard, opens Shop Desk
 * and saves a receipt on the USB stick.
 *
 * Nothing is installed on the shop PC and the private key is never copied into
 * the Shop Desk folder.
 *
 *   node licence-kit.mjs --check                 Show whether this kit is ready
 *   node licence-kit.mjs                          Ask for shop name, days, lock
 *   node licence-kit.mjs --shop "Karim Hardware" --days 365 --yes
 *   node licence-kit.mjs --shop "Karim Hardware" --no-lock --install-id <id>
 *   node licence-kit.mjs --list                   Show licences.csv
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const kitRoot = [scriptDir, dirname(scriptDir)].find(dir => existsSync(join(dir, "lib", "license.mjs"))) || scriptDir;
const { signLicense, verifyLicense, loadPrivateKey } = await import(pathToFileURL(join(kitRoot, "lib", "license.mjs")).href);

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : "";
};

const isWindows = process.platform === "win32";
const lower = text => isWindows ? String(text).toLowerCase() : String(text);
const say = (text = "") => console.log(text);
const ok = text => console.log(`  \u2713 ${text}`);
const warn = text => console.log(`  ! ${text}`);
const fail = (text, code = 1) => { console.error(`\n${text}\n`); process.exit(code); };

function isInside(child, parent) {
  const rel = relative(lower(resolve(parent)), lower(resolve(child)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---- Where is the kit's private key? -----------------------------------
function privateKeyPath() {
  const explicit = value("key") || process.env.SHOP_LICENSE_PRIVATE_KEY || "";
  if (explicit) return existsSync(explicit) ? explicit : "";
  for (const candidate of [join(kitRoot, "private", "license-private-key.pem"), join(kitRoot, "vendor", "license-private-key.pem")]) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function readPublicKeyPem(file) {
  try {
    const match = readFileSync(file, "utf8").match(/PUBLIC_KEY_PEM\s*=\s*("(?:[^"\\]|\\.)*")/);
    return match ? JSON.parse(match[1]).trim() : "";
  } catch { return ""; }
}

const keyFile = privateKeyPath();
const kitPublicKey = readPublicKeyPem(join(kitRoot, "lib", "license-public.mjs"));
const fingerprint = text => createHash("sha256").update(text).digest("hex").slice(0, 12);

// ---- Find the Shop Desk installation -----------------------------------
function markerInfo() {
  if (!isWindows) return null;
  const dir = process.env.ProgramData || "C:\\ProgramData";
  const file = join(dir, "ShopDesk", "install.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function looksLikeInstall(folder) {
  return Boolean(folder) && existsSync(join(folder, "app", "server.mjs"));
}

function findInstall(override) {
  if (override) {
    if (looksLikeInstall(override)) return override;
    if (basename(override).toLowerCase() === "app" && existsSync(join(override, "server.mjs"))) return dirname(override);
    return "";
  }
  const marker = markerInfo();
  if (marker && looksLikeInstall(marker.installDir)) return marker.installDir;
  if (process.env.SHOP_INSTALL_DIR && looksLikeInstall(process.env.SHOP_INSTALL_DIR)) return process.env.SHOP_INSTALL_DIR;
  if (isWindows) {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const candidate = `${letter}:\\ShopDesk`;
      if (looksLikeInstall(candidate)) return candidate;
    }
  } else {
    for (const candidate of ["/opt/shopdesk", "/usr/local/shopdesk", "/srv/shopdesk"]) {
      if (looksLikeInstall(candidate)) return candidate;
    }
  }
  return "";
}

function portFor(install, marker) {
  if (marker && Number(marker.port)) return Number(marker.port);
  const runFile = install ? join(install, "run-shop.cmd") : "";
  if (runFile && existsSync(runFile)) {
    const match = readFileSync(runFile, "utf8").match(/set\s+"?PORT=(\d+)"?/i);
    if (match) return Number(match[1]);
  }
  return 8765;
}

// ---- Read the installation ID from the database ------------------------
async function installIdFromDb(dbFile) {
  if (!existsSync(dbFile)) return "";
  let database = null;
  for (const options of [{ readOnly: true }, { readOnly: true, timeout: 5000 }, {}]) {
    try { database = new (await import("node:sqlite")).DatabaseSync(dbFile, options); break; }
    catch { database = null; }
  }
  if (!database) return "";
  try {
    const row = database.prepare("SELECT value FROM app_meta WHERE key='install_id'").get();
    return (row && row.value) || "";
  } catch { return ""; }
  finally { try { database.close(); } catch { /* already closed */ } }
}

// ---- Small helpers -----------------------------------------------------
function slug(text) {
  const clean = String(text).normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return clean || "shop";
}
function csvCell(text) {
  const value = String(text ?? "");
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function copyToClipboard(text) {
  try {
    if (isWindows) return spawnSync("cmd", ["/c", "clip"], { input: text, encoding: "utf8" }).status === 0;
    if (process.platform === "darwin") return spawnSync("pbcopy", [], { input: text }).status === 0;
    return spawnSync("xclip", ["-selection", "clipboard"], { input: text }).status === 0;
  } catch { return false; }
}
function openBrowser(url) {
  if (!url) return;
  try {
    if (isWindows) spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
    else spawnSync("xdg-open", [url], { stdio: "ignore" });
  } catch { /* opening the browser is optional */ }
}

// ---- Modes -------------------------------------------------------------
if (flag("help")) {
  say(`Shop Desk licence kit

  Make Licence Key.bat                     Ask for the shop name and create a 1-year key
  Make Licence Key.bat --no-lock           Key that works on any PC
  Make Licence Key.bat --list              Show the licences you have issued
  Make Licence Key.bat --check             Check that this kit is ready to use

Options for automatic use:
  --shop "Name" --days 365 --no-lock --install-id <id> --yes
  --expires 2027-10-17     Renewal to a fixed date
  --install "E:\\ShopDesk"  Shop Desk folder if it is not found automatically`);
  process.exit(0);
}

if (flag("list")) {
  const file = join(kitRoot, "licences.csv");
  if (!existsSync(file)) fail("No licences have been issued from this kit yet.", 0);
  say(readFileSync(file, "utf8").trim());
  process.exit(0);
}

if (flag("check")) {
  say("");
  say("==============================================");
  say("  Shop Desk - licence kit check");
  say("==============================================");
  say(`  Kit folder   : ${kitRoot}`);
  say(`  Public key   : ${kitPublicKey ? fingerprint(kitPublicKey) : "missing"}`);
  if (!keyFile) fail("  No private key found. Copy private/license-private-key.pem into this folder,\nor create the kit again on the supplier PC with: npm run licence:kit", 1);
  ok("Private key found");
  try {
    const sample = signLicense({ id: "self-check", shop: "Check Shop", plan: "pro", issued: new Date().toISOString(), expires: new Date(Date.now() + 86400000).toISOString() }, loadPrivateKey(keyFile));
    if (verifyLicense(sample).valid) ok("Private key matches the public key in this kit");
    else warn("The private key does not match lib/license-public.mjs. Rebuild the kit.");
  } catch (error) {
    warn(`The private key could not sign a test key: ${error.message}`);
  }
  const install = findInstall(value("install"));
  if (install) {
    say(`  Shop Desk    : ${install}`);
    const shopKey = readPublicKeyPem(join(install, "app", "lib", "license-public.mjs"));
    if (!shopKey) warn("The installed app has no readable public key.");
    else if (shopKey === kitPublicKey) ok("Private key matches this Shop Desk installation");
    else warn("MISMATCH: this kit cannot activate the Shop Desk installed here.");
  } else {
    warn("Shop Desk was not found on this PC (that is fine when using this kit on your own laptop).");
  }
  say("");
  process.exit(0);
}

// ---- Normal run --------------------------------------------------------
const lockRequested = !flag("no-lock");
const assumeYes = flag("yes");
let installDir = findInstall(value("install"));
const marker = markerInfo();

if (!keyFile) {
  fail([
    "This kit has no private licence key, so it cannot create a key.",
    "",
    "On your own PC open the Shop Desk folder and run:",
    "    npm run licence:kit",
    "",
    "Then copy the folder releases\\ShopDesk-Licence-Kit to your USB stick.",
    "Never put the private key inside a customer's Shop Desk folder."
  ].join("\n"), 1);
}

if (!kitPublicKey) fail("lib\\license-public.mjs is missing from this kit. Create the kit again with: npm run licence:kit", 1);

// Safety: the kit must not be sitting inside a Shop Desk installation.
if (installDir && isInside(kitRoot, installDir)) {
  fail([
    "STOP: this licence kit is inside the Shop Desk installation folder.",
    `Kit:   ${kitRoot}`,
    `Shop:  ${installDir}`,
    "",
    "The private signing key must never stay on a shop PC.",
    "Move the kit to a USB stick and run it from there."
  ].join("\n"), 2);
}

// Safety: the private key must actually match the public key shipped in the kit.
if (!flag("check") && !flag("list") && !flag("help")) {
  if (!keyFile) {
    fail([
      "The signing key is missing from this kit.",
      `Expected: ${join(kitRoot, "private", "license-private-key.pem")}`,
      "",
      "Copy the private key back into the private folder, or build the kit again",
      "on your own PC with: npm run licence:kit"
    ].join("\n"), 1);
  }
  let keyOk = false;
  try {
    keyOk = verifyLicense(signLicense({
      id: "kit-check", shop: "Kit Check", plan: "pro",
      issued: new Date().toISOString(), expires: new Date(Date.now() + 86400000).toISOString()
    }, loadPrivateKey(keyFile))).valid;
  } catch (error) {
    fail([
      "The signing key in this kit cannot be read.",
      `File:  ${keyFile}`,
      `Error: ${error.message}`,
      "",
      "Copy private/license-private-key.pem from your backup, or build the kit",
      "again with: npm run licence:kit"
    ].join("\n"), 1);
  }
  if (!keyOk) {
    fail([
      "STOP: the private key does not match lib/license-public.mjs in this kit.",
      `Key file:   ${keyFile}`,
      `Kit key:    ${fingerprint(kitPublicKey)}`,
      "",
      "Any key made here would be rejected by Shop Desk, so nothing was created.",
      "Build the kit again on your own PC with: npm run licence:kit"
    ].join("\n"), 2);
  }
}

// Safety: the key must match the app installed on this PC.
if (installDir) {
  const shopKey = readPublicKeyPem(join(installDir, "app", "lib", "license-public.mjs"));
  if (shopKey && shopKey !== kitPublicKey && !flag("force")) {
    fail([
      "STOP: this kit's key does not match Shop Desk on this PC.",
      `Kit key:       ${fingerprint(kitPublicKey)}`,
      `Installed app: ${fingerprint(shopKey)}`,
      "",
      "Keys made with this kit would be rejected. Rebuild the licence kit with",
      "npm run licence:kit from the same Shop Desk version you installed."
    ].join("\n"), 2);
  }
}

say("");
say("==============================================");
say("  Shop Desk - Licence Key");
say("==============================================");
say("");

let close = () => {};
let ask = async (prompt, fallback = "") => fallback;
if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  close = () => rl.close();
  ask = async (prompt, fallback = "") => {
    const answer = (await rl.question(fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `)).trim();
    return answer || fallback;
  };
}

try {
  if (!installDir) {
    say("Shop Desk was not found automatically.");
    const typed = await ask("Shop Desk install folder (for example E:\\ShopDesk)");
    installDir = findInstall(typed);
    if (!installDir) fail("That folder does not contain Shop Desk (app\\server.mjs).", 1);
  }
  say(`  Shop Desk      : ${installDir}`);
  const sameInstall = Boolean(marker && marker.installDir && lower(marker.installDir) === lower(installDir));
  const port = portFor(installDir, sameInstall ? marker : null);
  const dataDir = (sameInstall && marker.dataDir) ? marker.dataDir : join(installDir, "data");
  say(`  Data folder    : ${dataDir}`);

  let installId = value("install-id");
  if (!installId) {
    const serverId = await installIdFromDb(join(dataDir, "shop.sqlite3"));
    if (serverId) installId = serverId;
  }
  if (installId) {
    say(`  Installation ID: ${installId}`);
  } else {
    warn("No Installation ID found yet.");
    say("  Open Shop Desk once (Shop Desk shortcut), then run this kit again.");
    say("  Or copy the ID from Shop Desk > Shop settings > Licence & plan.");
    const typed = await ask("Installation ID (leave empty for a key that works on any PC)");
    installId = typed.trim();
  }

  // Short display form (da7b-5514-7a78) is accepted by the app, but store the full ID when we have it.
  const shopName = value("shop") || await ask("Shop name");
  if (!shopName || shopName.trim().length < 2) fail("Enter the shop name that will appear on the licence.", 1);

  const daysInput = value("days") || await ask("Days", "365");
  const days = Number(daysInput);
  const expiresFlag = value("expires");
  if (!expiresFlag && (!Number.isFinite(days) || days <= 0)) fail("Days must be a positive number.", 1);

  let lock = lockRequested;
  if (!assumeYes && !flag("no-lock")) {
    const answer = await ask("Lock this key to THIS PC only? (Y/n)", "Y");
    lock = !/^n/i.test(answer);
  }
  const plan = value("plan") || "pro";

  const issued = new Date();
  const expires = expiresFlag ? new Date(`${expiresFlag}T23:59:59Z`) : new Date(issued.getTime() + days * 86400000);
  if (Number.isNaN(expires.getTime()) || expires <= issued) fail("The expiry date must be in the future (YYYY-MM-DD).", 1);

  const payload = {
    id: `lic-${issued.toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
    shop: shopName.trim(),
    plan,
    seats: Number(value("seats")) || 0,
    issued: issued.toISOString(),
    expires: expires.toISOString()
  };
  if (lock && installId) payload.install = installId;
  if (lock && !installId) warn("No Installation ID, so this key will work on any PC.");

  const key = signLicense(payload, loadPrivateKey(keyFile));
  const expiryDay = expires.toISOString().slice(0, 10);
  const shopSlug = slug(shopName);
  const receiptDir = join(kitRoot, "licences");
  const receiptFile = join(receiptDir, `${shopSlug}_${expiryDay}.txt`);
  const csvFile = join(kitRoot, "licences.csv");

  const shortId = (text) => {
    const clean = String(text || "").replace(/[^a-z0-9]/gi, "");
    return clean.length > 10 ? `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(-4)}` : clean;
  };
  const locked = Boolean(payload.install);

  const receipt = [
    "Shop Desk licence key",
    "=====================",
    "",
    `Shop       : ${payload.shop}`,
    `Plan       : ${payload.plan}`,
    `Issued     : ${payload.issued.slice(0, 10)}`,
    `Expires    : ${expiryDay}`,
    `Locked to  : ${locked ? `${shortId(payload.install)} (this PC only)` : "not locked (any PC)"}`,
    "",
    "Key (keep this whole line):",
    key,
    "",
    "How to activate / কিভাবে চালু করবেন:",
    "1. Open Shop Desk.",
    "2. Shop settings -> Licence & plan.",
    "3. Paste the key and press Activate.",
    "4. The screen shows Activated and the days left.",
    "",
    "Renewal: 7 days before expiry a banner appears. Create a new key and paste it the same way.",
    ""
  ].join("\n");

  try {
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(receiptFile, receipt);
    if (!existsSync(csvFile)) writeFileSync(csvFile, "date,shop,plan,days,expires,locked_to,key_file\n");
    appendFileSync(csvFile, [
      issued.toISOString().slice(0, 10),
      csvCell(payload.shop),
      csvCell(payload.plan),
      expiresFlag ? "" : String(days),
      expiryDay,
      locked ? shortId(payload.install) : "any",
      csvCell(`licences/${basename(receiptFile)}`)
    ].join(",") + "\n");
    ok(`Receipt saved: licences\\${basename(receiptFile)}`);
    ok("Added to licences.csv");
  } catch (error) {
    warn(`Could not write the receipt (is the USB write-protected?): ${error.message}`);
  }

  const copied = copyToClipboard(key);
  const url = `http://localhost:${port}/`;
  say("");
  say("----------------------------------------------");
  say(`  Shop      : ${payload.shop}`);
  say(`  Plan      : ${payload.plan}`);
  say(`  Expires   : ${expiryDay}`);
  say(`  Locked to : ${locked ? shortId(payload.install) : "any PC"}`);
  say("----------------------------------------------");
  say("");
  if (copied) {
    ok("Key copied to the clipboard");
    say("");
    say("  In Shop Desk: Shop settings -> Licence & plan");
    say("  Paste with Ctrl+V, then press Activate.");
  } else {
    say("  Copy the key below and paste it into Shop Desk:");
    say("  Shop settings -> Licence & plan -> Activate.");
    say("");
    say(key);
  }
  say("");
  if (process.stdout.isTTY) say(`  Opening ${url} ...`);
  say("  You can unplug the USB stick when the app shows Activated.");
  say("==============================================");
  say("");

  openBrowser(url);
} finally {
  close();
}
