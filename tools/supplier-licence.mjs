#!/usr/bin/env node
// Guided supplier-only offline licence issuance.
// Run this on the supplier PC; never copy vendor/license-private-key.pem to a customer PC.
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { signLicense, loadPrivateKey, LICENSE_SHOP_TYPES, LICENSE_FEATURES } from "../lib/license.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rl = createInterface({ input: stdin, output: stdout });
const ask = async (label, fallback = "") => {
  const answer = (await rl.question(fallback ? `${label} [${fallback}]: ` : `${label}: `)).trim();
  return answer || fallback;
};
const yesNo = async (label, fallback = false) => {
  const answer = (await rl.question(`${label} (${fallback ? "Y/n" : "y/N"}): `)).trim().toLowerCase();
  if (!answer) return fallback;
  return ["y", "yes"].includes(answer);
};

try {
  console.log("\nShopDesk · Issue customer licence\n");
  console.log("Run this guided wizard on your supplier PC. The customer only needs the signed key.");
  console.log("Do not share your private signing key or source folder.\n");
  const shop = await ask("Customer/shop name");
  if (shop.length < 2 || shop.length > 120) throw new Error("Enter a shop name of 2 to 120 characters.");
  console.log("\nShop type:");
  LICENSE_SHOP_TYPES.forEach((type, i) => console.log(`  ${i + 1}. ${type}`));
  const typeChoice = Number(await ask("Choose shop type number"));
  const shopType = LICENSE_SHOP_TYPES[typeChoice - 1];
  if (!shopType) throw new Error("Choose a valid shop type number.");
  const install = await ask("Customer full Installation ID (copy from ShopDesk → Settings → Licence & plan)");
  const normalizedInstall = install.replace(/[^a-z0-9]/gi, "");
  if (!/^[a-f0-9]{24}$/i.test(normalizedInstall)) throw new Error("Paste the full 24-character Installation ID, not the short display ID, so this key is locked to the intended installation.");
  const plan = await ask("Plan name", "standard");
  const rawDays = await ask("Licence duration in days", "365");
  const days = Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 9999) throw new Error("Duration must be a whole number between 1 and 9999 days.");
  const issued = new Date();
  const expires = new Date(issued.getTime() + days * 86400000);

  const defaults = new Set([
    ...(shopType === "pharmacy" ? ["pharmacy"] : []),
    ...(shopType === "clothing" ? ["clothing"] : []),
    ...(shopType === "mobile" ? ["repairs", "devices"] : [])
  ]);
  const availableFeatures = LICENSE_FEATURES.filter(feature =>
    feature === "online_orders" ? shopType !== "pharmacy" :
    feature === "pharmacy" ? shopType === "pharmacy" :
    feature === "clothing" ? shopType === "clothing" :
    ["repairs", "devices"].includes(feature) ? shopType === "mobile" : false
  );
  const features = [];
  for (const feature of availableFeatures) {
    const baseline = defaults.has(feature);
    if (await yesNo(`Enable module: ${feature}`, baseline)) features.push(feature);
  }
  if (shopType === "pharmacy" && !features.includes("pharmacy")) throw new Error("A Pharmacy package must include the pharmacy module.");

  const payload = {
    id: `lic-${issued.toISOString().slice(0,10)}-${randomUUID().slice(0,8)}`,
    shop, plan, seats: 0, issued: issued.toISOString(), expires: expires.toISOString(),
    install: normalizedInstall, shopType, features
  };
  const token = signLicense(payload, loadPrivateKey());
  const outDir = join(root, "releases", "licences");
  mkdirSync(outDir, { recursive: true });
  const safeName = shop.normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0,40) || "shop";
  const output = join(outDir, `ShopDesk-${safeName}-${issued.toISOString().slice(0,10)}-${payload.id.slice(-8)}.txt`);
  writeFileSync(output, `${token}\n`, { flag: "wx" });
  let copied = false;
  if (process.platform === "win32") {
    const clip = spawnSync("clip.exe", [], { input: token, encoding: "utf8", windowsHide: true });
    copied = clip.status === 0;
  }
  console.log("\nLicence created successfully.");
  console.log(`  Shop:       ${shop}`);
  console.log(`  Shop type:  ${shopType}`);
  console.log(`  Modules:    ${features.join(", ") || "core only"}`);
  console.log(`  Expires:    ${expires.toISOString().slice(0,10)}`);
  console.log(`  Saved to:   ${output}`);
  console.log(copied ? "\nThe key has also been copied to the supplier PC clipboard." : "\nOpen the saved .txt file to copy the signed key.");
  console.log("\nSend only the SD1 licence key to the customer. Never send the private signing key.");
} finally {
  rl.close();
}
