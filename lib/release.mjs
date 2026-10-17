import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_KEY_PEM } from "./license-public.mjs";

/**
 * Signed release manifests.
 *
 * manifest.json is the exact byte sequence that was signed. The companion
 * manifest.json.sig contains "SDR1.<base64url ed25519 signature>".
 * Both files are produced by tools/release-manifest.mjs and published next to
 * the release zip. A shop server only offers an update when the signature is
 * valid, so a compromised download mirror cannot push arbitrary code.
 */
export const MANIFEST_PREFIX = "SDR1";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base64url = buffer => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

export function loadReleasePrivateKey(path = process.env.SHOP_LICENSE_PRIVATE_KEY || join(root, "vendor", "license-private-key.pem")) {
  if (!existsSync(path)) throw new Error(`Release signing key not found at ${path}. Run: npm run license:keygen`);
  return createPrivateKey(readFileSync(path));
}

export function signManifest(bytes, privateKey = loadReleasePrivateKey()) {
  return `${MANIFEST_PREFIX}.${base64url(cryptoSign(null, Buffer.from(bytes), privateKey))}`;
}

export function verifyManifest(bytes, signature, { publicKey = createPublicKey(PUBLIC_KEY_PEM) } = {}) {
  const parts = String(signature || "").trim().split(".");
  if (parts.length !== 2 || parts[0] !== MANIFEST_PREFIX) return { valid: false, problem: "format" };
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return { valid: false, problem: "format" };
  }
  if (!signatureBytes.length) return { valid: false, problem: "format" };
  let ok = false;
  try { ok = cryptoVerify(null, Buffer.from(bytes), publicKey, signatureBytes); } catch { ok = false; }
  return ok ? { valid: true } : { valid: false, problem: "signature" };
}

/** Verify a manifest and validate the fields the updater relies on. */
export function parseManifest(bytes, signature, options) {
  const checked = verifyManifest(bytes, signature, options);
  if (!checked.valid) return checked;
  let manifest;
  try { manifest = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { return { valid: false, problem: "json" }; }
  if (!manifest || manifest.product !== "Shop Desk" || typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) return { valid: false, problem: "fields" };
  if (typeof manifest.url !== "string" || !/^https?:\/\//i.test(manifest.url)) return { valid: false, problem: "fields" };
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) return { valid: false, problem: "fields" };
  return { valid: true, manifest };
}

export function compareVersions(a, b) {
  const parse = value => String(value || "").replace(/^v/i, "").split("-")[0].split(".").map(part => Number(part) || 0);
  const left = parse(a), right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}
