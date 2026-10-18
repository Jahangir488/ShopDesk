import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_KEY_PEM } from "./license-public.mjs";

export const LICENSE_PREFIX = "SD1";
export const TRIAL_DAYS = 30;
export const UPGRADE_TRIAL_DAYS = 30;
export const TRIAL_WARNING_DAYS = 7;
export const LICENSE_SHOP_TYPES = ["hardware", "grocery", "clothing", "pharmacy", "mobile", "general"];
export const LICENSE_FEATURES = ["online_orders", "pharmacy", "clothing", "repairs", "devices"];

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const base64url = buffer => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const fromBase64url = value => Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysUntil(target, now = new Date()) {
  const date = normalizeDate(target);
  if (!date) return 0;
  return Math.ceil((date.getTime() - now.getTime()) / 86400000);
}

/** Read the vendor private key. Never commit this file. */
export function loadPrivateKey(path = process.env.SHOP_LICENSE_PRIVATE_KEY || join(root, "vendor", "license-private-key.pem")) {
  if (!existsSync(path)) {
    throw new Error(
      `License private key not found at ${path}. Restore the original key from your secure backup. ` +
      `Run npm run license:keygen only if you have never issued licences and have not distributed a build using the current public key.`
    );
  }
  const privateKey = createPrivateKey(readFileSync(path));
  const derivedPublicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const configuredPublicKey = createPublicKey(PUBLIC_KEY_PEM).export({ type: "spki", format: "pem" }).toString();
  if (derivedPublicKey !== configuredPublicKey) {
    throw new Error(
      "The private licence key does not match lib/license-public.mjs. Do not issue this key. " +
      "Restore the matching private key, or intentionally rotate the key only if no existing licences/builds need to remain valid."
    );
  }
  return privateKey;
}

export function loadPublicKey(pem = PUBLIC_KEY_PEM) {
  return createPublicKey(pem);
}

/** Sign a license payload into the token format SD1.<payload>.<signature>. */
export function signLicense(payload, privateKey = loadPrivateKey()) {
  const body = { v: 1, ...payload };
  const encoded = base64url(Buffer.from(JSON.stringify(body)));
  const signature = cryptoSign(null, Buffer.from(encoded), privateKey);
  return `${LICENSE_PREFIX}.${encoded}.${base64url(signature)}`;
}

const normalizeInstallId = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Compare the installation ID inside a licence with this server's ID.
 * Accepts the full ID, the short display form (abcd-1234-5678) and any
 * hyphen/space/case variation, so support can read the ID over the phone.
 */
export function installIdMatches(claimedId, actualId) {
  const claimed = normalizeInstallId(claimedId);
  if (!claimed) return true; // a licence without an install ID works anywhere
  const actual = normalizeInstallId(actualId);
  if (!actual) return false;
  return claimed === actual || claimed === normalizeInstallId(shortInstallId(actualId));
}

/**
 * Verify a license token. Returns { valid, payload, problem }.
 * `problem` is a short machine-readable code; the UI turns it into a message.
 */
export function verifyLicense(token, { publicKey = loadPublicKey(), installId = "", now = new Date() } = {}) {
  const clean = String(token || "").trim().replace(/\s+/g, "");
  if (!clean) return { valid: false, problem: "empty" };
  const parts = clean.split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return { valid: false, problem: "format" };
  let payload;
  try {
    payload = JSON.parse(fromBase64url(parts[1]).toString("utf8"));
  } catch {
    return { valid: false, problem: "format" };
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1) return { valid: false, problem: "format" };
  // Legacy v1 licences omit both package fields. New seller-issued packages must
  // carry a recognised shop type and an explicit module list; never infer extra entitlements.
  if ((payload.shopType === undefined) !== (payload.features === undefined)) return { valid: false, problem: "payload", payload };
  if (payload.shopType !== undefined && !LICENSE_SHOP_TYPES.includes(payload.shopType)) return { valid: false, problem: "payload", payload };
  if (payload.features !== undefined && (!Array.isArray(payload.features) ||
      payload.features.some(feature => !LICENSE_FEATURES.includes(feature)) ||
      new Set(payload.features).size !== payload.features.length)) return { valid: false, problem: "payload", payload };
  if (payload.shopType !== undefined) {
    const features = payload.features;
    const incompatible = features.some(feature =>
      (feature === "pharmacy" && payload.shopType !== "pharmacy") ||
      (feature === "clothing" && payload.shopType !== "clothing") ||
      (["repairs", "devices"].includes(feature) && payload.shopType !== "mobile") ||
      (feature === "online_orders" && payload.shopType === "pharmacy")
    );
    if (incompatible || (payload.shopType === "pharmacy" && !features.includes("pharmacy"))) {
      return { valid: false, problem: "payload", payload };
    }
  }
  let validSignature = false;
  try {
    validSignature = cryptoVerify(null, Buffer.from(parts[1]), publicKey, fromBase64url(parts[2]));
  } catch {
    validSignature = false;
  }
  if (!validSignature) return { valid: false, problem: "signature" };
  if (!payload.shop || String(payload.shop).trim().length < 2) return { valid: false, problem: "payload", payload };
  const expires = normalizeDate(payload.expires);
  if (!expires) return { valid: false, problem: "payload", payload };
  if (payload.install && !installIdMatches(payload.install, installId)) {
    return { valid: false, problem: "install", payload };
  }
  if (expires.getTime() <= now.getTime()) return { valid: true, expired: true, payload, expires };
  return { valid: true, expired: false, payload, expires };
}

/** Mask the middle of an install id so it can be read aloud to support. */
export function shortInstallId(installId) {
  const text = String(installId || "");
  if (text.length <= 10) return text;
  return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(-4)}`;
}

/**
 * Work out what the licence allows right now.
 * `license` is the stored row { token, activatedAt } (or null).
 */
export function licenseStatus({ license = null, trialStartedAt = null, trialDays = TRIAL_DAYS, installId = "", now = new Date(), publicKey } = {}) {
  const trialStart = normalizeDate(trialStartedAt) || new Date(now.getTime());
  const trialEndsAt = new Date(trialStart.getTime() + Math.max(0, Number(trialDays) || 0) * 86400000);
  const trialDaysLeft = daysUntil(trialEndsAt, now);

  let verified = null;
  let problem = "";
  if (license?.token) {
    verified = verifyLicense(license.token, { installId, now, ...(publicKey ? { publicKey } : {}) });
    if (!verified.valid) problem = verified.problem || "invalid";
    else if (verified.expired) problem = "expired";
  }

  const trialActive = trialEndsAt.getTime() > now.getTime();
  const trial = {
    startedAt: trialStart.toISOString(),
    endsAt: trialEndsAt.toISOString(),
    daysLeft: Math.max(0, trialDaysLeft),
    active: trialActive
  };

  if (verified?.valid && !verified.expired) {
    const daysLeft = Math.max(0, daysUntil(verified.expires, now));
    return {
      state: "active",
      readOnly: false,
      plan: verified.payload.plan || "standard",
      shopType: verified.payload.shopType || null,
      features: Array.isArray(verified.payload.features) ? verified.payload.features : null,
      packageLocked: Boolean(verified.payload.shopType),
      licensedTo: verified.payload.shop || "",
      seats: Number(verified.payload.seats) || 0,
      expiresAt: verified.expires.toISOString(),
      daysLeft,
      warningDays: TRIAL_WARNING_DAYS,
      warning: daysLeft <= TRIAL_WARNING_DAYS,
      installId,
      trial,
      activatedAt: license.activatedAt || "",
      problem: ""
    };
  }

  if (trialActive) {
    return {
      state: "trial",
      readOnly: false,
      plan: "trial",
      shopType: null,
      features: null,
      packageLocked: false,
      licensedTo: "",
      seats: 0,
      expiresAt: trial.endsAt,
      daysLeft: trial.daysLeft,
      warningDays: TRIAL_WARNING_DAYS,
      warning: trial.daysLeft <= TRIAL_WARNING_DAYS,
      installId,
      trial,
      activatedAt: "",
      problem
    };
  }

  return {
    state: "expired",
    readOnly: true,
    plan: verified?.payload?.plan || "trial",
    shopType: verified?.payload?.shopType || null,
    features: Array.isArray(verified?.payload?.features) ? verified.payload.features : null,
    packageLocked: Boolean(verified?.payload?.shopType),
    licensedTo: verified?.payload?.shop || "",
    seats: Number(verified?.payload?.seats) || 0,
    expiresAt: verified?.expires ? verified.expires.toISOString() : trial.endsAt,
    daysLeft: 0,
    warningDays: TRIAL_WARNING_DAYS,
    warning: true,
    installId,
    trial,
    activatedAt: license?.activatedAt || "",
    problem: problem || "trial-expired"
  };
}

/** Routes that must keep working when the licence has expired (data is never held hostage). */
export const LICENSE_ALLOWED_MUTATIONS = [
  /^\/api\/license(\/|$)/,
  /^\/api\/logout$/,
  /^\/api\/login$/,
  /^\/api\/recover-account$/,
  /^\/api\/profile(\/|$)/,
  /^\/api\/recovery-code$/,
  /^\/api\/email-recovery-request$/,
  /^\/api\/backups(\/|$)/,
  /^\/api\/export$/,
  /^\/api\/connect(\/|$)/
];

export const licenseAllowsMutation = route => LICENSE_ALLOWED_MUTATIONS.some(pattern => pattern.test(route));

export function generateLicenseKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}
