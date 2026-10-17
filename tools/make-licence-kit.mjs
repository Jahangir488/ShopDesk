#!/usr/bin/env node
/**
 * Build the portable licence kit.
 *
 *   npm run licence:kit                 -> releases/ShopDesk-Licence-Kit
 *   npm run licence:kit -- --usb E:\    -> copy straight to a USB stick
 *
 * The kit contains the scripts plus a copy of vendor/license-private-key.pem.
 * Treat the whole folder like a master key: keep it on an encrypted USB stick,
 * never email it, and never copy it into a shop's Shop Desk folder.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : "";
};

const privateKeyFile = process.env.SHOP_LICENSE_PRIVATE_KEY || join(root, "vendor", "license-private-key.pem");
const publicKeyFile = join(root, "lib", "license-public.mjs");
const defaultOut = join(root, "releases", "ShopDesk-Licence-Kit");
// "E:" alone would be a per-drive relative path, so make it "E:\\".
const driveRoot = text => (/^[A-Za-z]:$/.test(text) ? `${text}\\` : text);
const target = value("usb")
  ? join(driveRoot(value("usb")), "ShopDesk-Licence-Kit")
  : (value("out") || defaultOut);

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!existsSync(privateKeyFile)) {
  fail([
    "No signing key was found at:",
    `  ${privateKeyFile}`,
    "",
    "Run this once on your own PC, then build the kit again:",
    "  npm run license:keygen",
    "  npm run licence:kit",
    "",
    "After creating a new key you must give customers an installer built from",
    "this same folder, because the old installer trusts the old public key."
  ].join("\n"));
}
if (!existsSync(publicKeyFile)) fail(`Missing ${publicKeyFile}.`);

const { signLicense, verifyLicense, loadPrivateKey } = await import(pathToFileURL(join(root, "lib", "license.mjs")).href);
let pairOk = false;
try {
  const sample = signLicense({
    id: "kit-check", shop: "Kit Check", plan: "pro",
    issued: new Date().toISOString(), expires: new Date(Date.now() + 86400000).toISOString()
  }, loadPrivateKey(privateKeyFile));
  pairOk = verifyLicense(sample).valid;
} catch (error) {
  fail(`The signing key could not be used: ${error.message}`);
}
if (!pairOk) {
  fail([
    "The private key does not match lib/license-public.mjs.",
    "Keys made from this kit would be rejected by every Shop Desk installation.",
    "",
    "Create a new pair with 'npm run license:keygen' and build the customer",
    "installer from the same folder."
  ].join("\n"));
}

mkdirSync(join(target, "lib"), { recursive: true });
mkdirSync(join(target, "private"), { recursive: true });
mkdirSync(join(target, "licences"), { recursive: true });

for (const [from, to] of [
  [join(root, "lib", "license.mjs"), join(target, "lib", "license.mjs")],
  [join(root, "lib", "license-public.mjs"), join(target, "lib", "license-public.mjs")],
  [join(root, "tools", "licence-kit.mjs"), join(target, "licence-kit.mjs")],
  [privateKeyFile, join(target, "private", "license-private-key.pem")]
]) {
  copyFileSync(from, to);
}
try { (await import("node:fs")).chmodSync(join(target, "private", "license-private-key.pem"), 0o600); } catch { /* Windows ignores POSIX modes */ }

const batHeader = [
  "@echo off",
  "setlocal",
  "title Shop Desk - Licence Key",
  "where node >nul 2>&1",
  "if errorlevel 1 (",
  "  echo Node.js was not found on this PC.",
  "  echo Install Node.js 22.13 or newer from https://nodejs.org and try again.",
  "  pause",
  "  exit /b 1",
  ")"
];
const batBody = ['node --no-warnings "%~dp0licence-kit.mjs" %*', "echo.", "pause"];
writeFileSync(join(target, "Make Licence Key.bat"), [...batHeader, ...batBody].join("\r\n") + "\r\n");
writeFileSync(join(target, "Make License Key.bat"), [...batHeader, ...batBody].join("\r\n") + "\r\n");
writeFileSync(join(target, "Licence Kit Check.bat"), [...batHeader, 'node --no-warnings "%~dp0licence-kit.mjs" --check', "echo.", "pause"].join("\r\n") + "\r\n");

const readme = `Shop Desk - Licence Key kit
==========================

WHAT THIS IS
  A portable tool that creates a 1-year licence key for one shop.
  It runs from this folder (USB stick or your laptop). Nothing is installed
  on the shop PC and nothing is left behind.

HOW TO USE IT ON A SHOP PC
  1. Plug in this USB stick.
  2. Double-click  Make Licence Key.bat
  3. Type the shop name. Press Enter for 365 days.
     Keep "Lock this key to THIS PC only? [Y]" to tie the key to that PC.
  4. The key is copied to your clipboard automatically.
  5. Shop Desk opens. Paste with Ctrl+V into
     Shop settings -> Licence & plan -> Activate.
  6. When the app shows "Activated", close it and unplug the USB stick.

  The key and a receipt are also saved in the licences folder, and every key
  is added to licences.csv so you know which shop expires when.

RENEWAL
  Send a new key before the expiry date shown in the app. In Shop Desk, open
  Licence & plan and paste the new key; it replaces the old one.

USE IT FROM YOUR LAPTOP INSTEAD (no USB)
  Double-click Make Licence Key.bat, choose "no" when asked to lock the key,
  and send the key to the shop on WhatsApp. They paste it themselves.

SAFETY RULES - PLEASE READ
  * This folder contains your PRIVATE signing key. Anyone who copies it can
    make unlimited licence keys. Keep the USB stick with you or locked away.
  * Use an encrypted USB stick (BitLocker To Go) and keep a second backup.
  * Never put this folder inside a Shop Desk folder on a customer PC.
    The tool refuses to run if you do.
  * Never email or WhatsApp this folder. Send only the key text.
  * If the USB stick is lost, create a new key pair with
    "npm run license:keygen" (on your own PC) and expect to reissue keys.

CHECK THE KIT
  Double-click  Licence Kit Check.bat  to confirm the private key matches the
  Shop Desk installed on this PC.

বাংলা
------
১. এই ফোল্ডারটি ইউএসবি ড্রাইভে রাখুন (এনক্রিপ্ট করা ভালো)।
২. দোকানের পিসিতে "Make Licence Key.bat" চালান।
৩. দোকানের নাম দিন, ৩৬৫ দিনে এন্টার দিন, "Lock" এ Y দিন।
৪. কী স্বয়ংক্রিয়ভাবে কপি হবে; Shop Desk → Shop settings → Licence & plan
   এ পেস্ট করে Activate চাপুন।
৫. কাজ শেষে ইউএসবি খুলে ফেলুন। কোনো ফাইল দোকানের পিসিতে রাখবেন না।

কপিরাইট (c) Shop Desk
`;
writeFileSync(join(target, "README.txt"), readme);

const keyFingerprint = createHash("sha256").update(readFileSync(publicKeyFile)).digest("hex").slice(0, 12);
const size = ["licence-kit.mjs", "lib/license.mjs", "lib/license-public.mjs", "private/license-private-key.pem"]
  .reduce((total, file) => total + statSync(join(target, file)).size, 0);

console.log("");
console.log("Licence kit ready");
console.log("=================");
console.log(`  Folder      : ${resolve(target)}`);
console.log(`  Public key  : ${keyFingerprint}`);
console.log(`  Size        : ${(size / 1024).toFixed(1)} KB`);
console.log("");
console.log("Next:");
console.log("  1. Copy this whole folder to an encrypted USB stick.");
console.log("  2. On the shop PC double-click  Make Licence Key.bat");
console.log("  3. Paste the key into Shop Desk -> Shop settings -> Licence & plan.");
console.log("");
console.log("Keep the USB stick safe: it holds your private signing key.");
console.log("");
