// Offsite backups: encrypt a Shop Desk SQLite copy, then upload it to Google
// Drive (scope drive.file). Everything here uses the built-in fetch, so there
// are no extra npm packages to install on the shop PC.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const BACKUP_MAGIC = "SDB1";
export const DEFAULT_FOLDER_NAME = "ShopDesk Backups";
export const DEFAULT_KEEP = 14;

const base64url = buffer => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

/** Load (or create) the local key used to encrypt offsite backups. */
export function loadBackupKeyMaterial(dataDir, envKey = process.env.SHOP_BACKUP_KEY) {
  if (envKey && String(envKey).trim().length >= 16) return String(envKey).trim();
  const keyFile = join(dataDir, "offsite.key");
  if (existsSync(keyFile)) {
    const saved = readFileSync(keyFile, "utf8").trim();
    if (saved.length >= 32) return saved;
  }
  mkdirSync(dataDir, { recursive: true });
  const generated = randomBytes(32).toString("hex");
  writeFileSync(keyFile, generated + "\n", { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* Windows may ignore POSIX modes */ }
  return generated;
}

export function encryptBuffer(plain, keyMaterial, magic = BACKUP_MAGIC) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(String(keyMaterial), salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(magic, "binary"), salt, iv, tag, encrypted]);
}

export function decryptBuffer(payload, keyMaterial, magic = BACKUP_MAGIC) {
  const buffer = Buffer.from(payload);
  if (buffer.length < 48 || buffer.subarray(0, 4).toString("binary") !== magic) {
    throw new Error("This is not a Shop Desk encrypted backup file.");
  }
  const salt = buffer.subarray(4, 20), iv = buffer.subarray(20, 32), tag = buffer.subarray(32, 48);
  const key = scryptSync(String(keyMaterial), salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buffer.subarray(48)), decipher.final()]);
}

export const isEncryptedBackup = buffer => Buffer.from(buffer).subarray(0, 4).toString("binary") === BACKUP_MAGIC;

export function encryptSecret(value, keyMaterial) {
  return base64url(encryptBuffer(Buffer.from(JSON.stringify(value)), keyMaterial, "SDK1"));
}

export function decryptSecret(value, keyMaterial) {
  return JSON.parse(decryptBuffer(fromBase64url(value), keyMaterial, "SDK1").toString("utf8"));
}

function fromBase64url(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function buildMultipartBody(metadata, file, boundary) {
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, file, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

export function safeBackupName(shopName, date = new Date()) {
  const slug = String(shopName || "shop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "shop";
  const stamp = date.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 23);
  return `shopdesk-${slug}-${stamp}.sqlite3.enc`;
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

const DEFAULT_ENDPOINTS = {
  auth: GOOGLE_AUTH_URL,
  token: GOOGLE_TOKEN_URL,
  files: GOOGLE_DRIVE_FILES_URL,
  upload: GOOGLE_DRIVE_UPLOAD_URL
};

export class GoogleDriveBackup {
  constructor({ clientId, clientSecret, redirectUri, keyMaterial, fetchImpl = globalThis.fetch, now = () => new Date(), endpoints = {} }) {
    this.clientId = clientId || "";
    this.clientSecret = clientSecret || "";
    this.redirectUri = redirectUri || "";
    this.keyMaterial = keyMaterial;
    this.fetch = fetchImpl;
    this.now = now;
    // Overridable for automated tests or a self-hosted proxy. Always defaults to Google.
    this.urls = { ...DEFAULT_ENDPOINTS };
    for (const [key, value] of Object.entries(endpoints)) if (value) this.urls[key] = value;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.keyMaterial);
  }

  authUrl(state) {
    const url = new URL(this.urls.auth);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async postForm(params) {
    const response = await this.fetch(this.urls.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString()
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(payload.error_description || payload.error || `Google sign-in failed (${response.status}).`);
    return payload;
  }

  async exchangeCode(code) {
    const tokens = await this.postForm({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code"
    });
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Remove Shop Desk from your Google account permissions and connect again.");
    return this.packTokens(tokens);
  }

  async refresh(tokens) {
    const fresh = await this.postForm({
      refresh_token: tokens.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token"
    });
    return this.packTokens({ ...tokens, ...fresh, refresh_token: fresh.refresh_token || tokens.refreshToken });
  }

  packTokens(tokens) {
    return {
      accessToken: tokens.access_token || tokens.accessToken || "",
      refreshToken: tokens.refresh_token || tokens.refreshToken || "",
      expiresAt: tokens.expires_in ? this.now().getTime() + Number(tokens.expires_in) * 1000 - 60_000 : tokens.expiresAt || 0,
      scope: tokens.scope || GOOGLE_SCOPE,
      tokenType: tokens.token_type || tokens.tokenType || "Bearer",
      email: tokens.email || ""
    };
  }

  async accessToken(tokens) {
    if (tokens.accessToken && tokens.expiresAt > this.now().getTime()) return tokens.accessToken;
    const fresh = await this.refresh(tokens);
    return fresh.accessToken;
  }

  async driveRequest(url, { token, method = "GET", body, headers = {} } = {}) {
    const response = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      ...(body !== undefined ? { body } : {})
    });
    if (response.status === 401) throw Object.assign(new Error("Google Drive access expired. Reconnect Google Drive."), { code: "reauth" });
    if (!response.ok && response.status !== 204) {
      const payload = await readJson(response);
      const message = payload.error?.message || payload.error_description || `Google Drive request failed (${response.status}).`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return response;
  }

  async folderId(tokens, folderName = DEFAULT_FOLDER_NAME) {
    const token = await this.accessToken(tokens);
    const query = `name = '${String(folderName).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`;
    const search = new URL(this.urls.files);
    search.searchParams.set("q", query);
    search.searchParams.set("fields", "files(id,name)");
    search.searchParams.set("spaces", "drive");
    const found = await readJson(await this.driveRequest(search.toString(), { token }));
    if (found.files?.length) return found.files[0].id;
    const created = await readJson(await this.driveRequest(this.urls.files, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: ["root"] })
    }));
    if (!created.id) throw new Error("Google Drive did not create the backup folder.");
    return created.id;
  }

  async upload(tokens, { name, buffer, folderId }) {
    const token = await this.accessToken(tokens);
    if (buffer.length < 4 * 1024 * 1024) {
      const boundary = `shopdesk_${randomBytes(9).toString("hex")}`;
      const { body, contentType } = buildMultipartBody({ name, parents: [folderId] }, buffer, boundary);
      const url = `${this.urls.upload}?uploadType=multipart&fields=id,name,size,createdTime`;
      const payload = await readJson(await this.driveRequest(url, {
        token, method: "POST", body, headers: { "Content-Type": contentType, "Content-Length": String(body.length) }
      }));
      return payload;
    }
    // Large database: start a resumable upload and send it in one request.
    const start = await this.driveRequest(`${this.urls.upload}?uploadType=resumable&fields=id,name,size,createdTime`, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(buffer.length) },
      body: JSON.stringify({ name, parents: [folderId] })
    });
    const location = start.headers.get("location");
    if (!location) throw new Error("Google Drive did not start the upload.");
    const response = await this.fetch(location, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buffer.length) }, body: buffer });
    if (!response.ok) throw new Error(`Google Drive upload failed (${response.status}).`);
    return readJson(response);
  }

  async list(tokens, folderId) {
    const token = await this.accessToken(tokens);
    const url = new URL(this.urls.files);
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("fields", "files(id,name,size,createdTime)");
    url.searchParams.set("orderBy", "createdTime");
    url.searchParams.set("pageSize", "200");
    const payload = await readJson(await this.driveRequest(url.toString(), { token }));
    return payload.files || [];
  }

  async remove(tokens, fileId) {
    const token = await this.accessToken(tokens);
    await this.driveRequest(`${this.urls.files}/${encodeURIComponent(fileId)}`, { token, method: "DELETE" });
  }

  async prune(tokens, folderId, keep) {
    const files = await this.list(tokens, folderId);
    const excess = files.slice(0, Math.max(0, files.length - Math.max(1, Number(keep) || DEFAULT_KEEP)));
    for (const file of excess) await this.remove(tokens, file.id);
    return excess.map(file => file.name);
  }

  async accountEmail(tokens) {
    try {
      const token = await this.accessToken(tokens);
      const payload = await readJson(await this.driveRequest(`${this.urls.files.replace(/\/files$/, "")}/about?fields=user(displayName,emailAddress)`, { token }));
      return payload.user?.emailAddress || "";
    } catch { return ""; }
  }
}

/** Build the encrypted backup upload payload for a local SQLite copy. */
export function prepareOffsitePayload({ dbBuffer, keyMaterial, shopName, now = new Date() }) {
  const encrypted = encryptBuffer(dbBuffer, keyMaterial);
  return {
    name: safeBackupName(shopName, now),
    buffer: encrypted,
    sha256: createHash("sha256").update(dbBuffer).digest("hex"),
    plainBytes: dbBuffer.length,
    encryptedBytes: encrypted.length
  };
}

export const secretsEqual = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
