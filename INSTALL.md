# Shop Desk — install, update and operate

Shop Desk is a small shop server: one Windows PC or Linux box on the shop Wi-Fi runs
`server.mjs`, and phones, tablets and counter PCs open it in a browser. Data lives in a
single SQLite database, so it works without an internet connection.

This guide covers Windows, Linux and Docker installs, Google Drive offsite backups,
licence keys, HTTPS/PWA, updates and uninstall.

---

## 1. Requirements

| Item | Minimum |
| --- | --- |
| Node.js | **22.13 or newer** (the app uses the built-in `node:sqlite`) |
| Windows | Windows 10/11 (64-bit) |
| Linux | Ubuntu 22.04+, Debian 12+, or a comparable systemd distribution |
| Docker | Optional; the image uses `node:22-slim` |
| Server | 2 GB RAM, 300 MB free disk, a wired connection to the shop router is best |
| Network | Server and phones on the same private LAN/Wi-Fi |

Do **not** forward the Shop Desk port on the router. For remote access, use a VPN or a
properly secured HTTPS reverse proxy.

---

## 2. Windows installation

1. Install **Node.js 22.13+** using the MSI from <https://nodejs.org> and choose the
   option to install for **all users**. If Node.js lives inside `C:\Users\...`, the
   background task may not see it.
2. Copy the Shop Desk folder to the shop PC (for example `D:\ShopDesk-setup`).
3. Double-click **`1 - Install Shop Desk.bat`** in the Shop Desk folder. Windows asks for
   administrator permission — choose **Yes**.

The installer then:

- asks **where to install**. Press **Enter** for `C:\ShopDesk`, or type another folder
  such as `D:\ShopDesk`. It shows the program folder, data folder and port and asks you
  to confirm before copying anything;
- copies the app to `<install folder>\app` and keeps data in `<install folder>\data`;
- writes `run-shop.cmd` (port, data folder and any Google keys);
- registers the Scheduled Task **Shop Desk**, which starts at boot and at sign-in as
  `SYSTEM` and restarts after a failure;
- opens inbound TCP **8765** for the **Private** and **Domain** firewall profiles only;
- creates desktop shortcuts for **Shop Desk** and **Shop Desk – Connect a phone**;
- waits for `/healthz`, prints the LAN address and opens the browser.

The chosen folders are saved in `%ProgramData%\ShopDesk\install.json`, so updates and the
uninstaller always find the installation, even when it is not in `C:\ShopDesk`. The
installer also writes **`Uninstall Shop Desk.bat`** into the chosen folder, so the shop can
remove Shop Desk later without looking for the original download.

If Shop Desk is already installed in that folder, the installer offers to **update** it and
keeps the existing data.

Optional parameters (run from PowerShell in the repo folder):

```powershell
powershell -ExecutionPolicy Bypass -File .\install\windows\install-shopdesk.ps1 `
  -Port 8765 `
  -DataDir "D:\ShopDeskData" `
  -SetupCode "choose-a-long-one-time-code" `
  -GoogleClientId "…apps.googleusercontent.com" `
  -GoogleClientSecret "…" `
  -PublicUrl "https://shop.example.com"
```

Use `-SkipFirewall` if another firewall product manages the port. Add `-Yes` for an
unattended install (no prompts), or `-NoBrowser` to skip opening the browser.

**First run:** open the Shop Desk shortcut, read the one-time setup code from
`<install folder>\logs\server.log`, create the owner account (12+ character password),
then finish **Shop settings**. Delete the setup code from `run-shop.cmd` afterwards if you
passed `-SetupCode`.

**Phones:** connect them to the same Wi-Fi and open `http://SERVER-IP:8765`, or scan the
QR code from **Connect a phone** (`http://localhost:8765/join`) on the server PC.

### Repairing a broken installation

Every step of the installer is independent: if the Scheduled Task, the firewall rule or a
shortcut cannot be created, the installer says so, keeps going, and still starts Shop Desk.
A **Needs attention** list at the end names the failed step and the repair command. The
installer writes **`Repair Shop Desk.bat`** into the install folder next to the uninstaller.

Double-click **`Repair Shop Desk.bat`** in the install folder (for example
`E:\ShopDesk\Repair Shop Desk.bat`) to rebuild `run-shop.cmd`, the scheduled task, the
firewall rule, the shortcuts and `%ProgramData%\ShopDesk\install.json`, then start the app
and check `/healthz`. Data is never touched. From PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\windows\repair-shopdesk.ps1 -InstallDir "E:\ShopDesk"
```

The repair script finds the installation on its own — from the marker file, the
**Shop Desk** task, the licence file or a scan of `C:\ShopDesk` … `Z:\ShopDesk` — so no
parameters are needed in the usual case.

---

## 3. Linux installation (systemd)

```bash
sudo ./install/linux/install-shopdesk.sh
```

Defaults:

| Path / setting | Value |
| --- | --- |
| App | `/opt/shopdesk` |
| Data | `/var/lib/shopdesk` |
| Service user | `shopdesk` (system user, no login shell) |
| Environment file | `/etc/shopdesk.env` |
| Port | `8765` |

Override with environment variables:

```bash
sudo PORT=9000 INSTALL_DIR=/opt/shopdesk DATA_DIR=/srv/shopdesk-data \
  SHOP_GOOGLE_CLIENT_ID="…apps.googleusercontent.com" \
  SHOP_GOOGLE_CLIENT_SECRET="…" \
  ./install/linux/install-shopdesk.sh
```

The installer checks the Node.js version, creates the service user, copies the app
(never `data/`, `vendor/` or the Git history), writes `/etc/shopdesk.env`, installs
`/etc/systemd/system/shopdesk.service`, enables it at boot and starts it. When `ufw` is
present it allows the TCP port.

```bash
systemctl status shopdesk
journalctl -u shopdesk -f
journalctl -u shopdesk -n 80 | grep -A2 "setup code"
curl http://127.0.0.1:8765/healthz
```

`SHOP_PUBLIC_URL` also turns on `SHOP_TRUST_PROXY=1`, which is required behind Nginx,
Caddy or Apache. Edit `/etc/shopdesk.env`, then `sudo systemctl restart shopdesk`.

If you move the app under `/home`, set `ProtectHome=false` in the unit (the default unit
protects the home directory).

---

## 4. Docker

```bash
docker build -t shopdesk .
docker run -d --name shopdesk --restart unless-stopped \
  -p 8765:8765 \
  -v shopdesk-data:/data \
  -e SHOP_DATA_DIR=/data \
  -e SHOP_TRUST_PROXY=1 \
  -e SHOP_GOOGLE_CLIENT_ID="…apps.googleusercontent.com" \
  -e SHOP_GOOGLE_CLIENT_SECRET="…" \
  shopdesk
```

- `/data` holds `shop.sqlite3`, `offsite.key` and backups. Mount it on a real volume and
  include it in the host's backup policy.
- The image already sets `SHOP_DATA_DIR=/data` and `SHOP_TRUST_PROXY=1`.
- Pass `SHOP_PUBLIC_URL` when the container is behind an HTTPS proxy.
- Logs: `docker logs -f shopdesk`. Health: `curl http://127.0.0.1:8765/healthz`.

---

## 5. First-run checklist

1. Create the owner account with the one-time setup code.
2. **Shop settings**: shop name, location, currency, region, language (বাংলা/English),
   Bangla digits, tax mode, payment methods.
3. **Settings → Licence & plan**: paste the licence key from your supplier. New installs
   start a 30-day trial; existing databases also get 30 days.
4. **Backup and restore → Offsite backup**: connect Google Drive, run **Test connection**,
   then **Back up now**.
5. Copy **`data/offsite.key`** to a safe place. Without it, downloaded offsite backups
   cannot be decrypted.
6. Give the server PC a static/reserved IP in the router.
7. Add staff accounts under **Team access**; grant only the modules they need.

---

## 6. Google Drive offsite backups

### 6.1 Create the Google OAuth client

1. Open <https://console.cloud.google.com> and create (or select) a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - App name: `Shop Desk`, add your support email and developer contact.
   - Add the scope `.../auth/drive.file` (only files this app creates).
   - While the app is in **Testing**, add the Google account used by the shop as a
     **test user**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under **Authorised redirect URIs** add the exact address the server prints in
   **Backup and restore → Offsite backup**, normally:

   ```text
   http://localhost:8765/api/backups/offsite/oauth/callback
   ```

   With a domain, also add:

   ```text
   https://shop.example.com/api/backups/offsite/oauth/callback
   ```

6. Copy the client ID and client secret onto the server:
   - Windows: pass `-GoogleClientId`/`-GoogleClientSecret` to the installer, or add
     `set "SHOP_GOOGLE_CLIENT_ID=…"` lines to `C:\ShopDesk\run-shop.cmd`, then restart
     the **Shop Desk** scheduled task.
   - Linux: add them to `/etc/shopdesk.env`, then `sudo systemctl restart shopdesk`.
   - Docker: pass them with `-e`.
7. In the app: **Backup and restore → Offsite backup → Connect Google Drive**. Sign in
   with the shop's Google account and allow access. For a `localhost` redirect URI, do
   this on the server PC itself.

> **Publishing status:** while the OAuth consent screen is in **Testing**, Google expires
> refresh tokens after 7 days, so the shop must reconnect weekly. Publish the app
> (**Publish app** → In production) to keep the connection alive. Google may show an
> "unverified app" warning until verification is complete; the shop can continue past it.

### 6.2 How it works

- A consistent SQLite snapshot is encrypted with **AES-256-GCM** and a key derived with
  scrypt **before** it leaves the computer. Google only ever stores ciphertext.
- The key is `data/offsite.key` or `SHOP_BACKUP_KEY` (set one and keep a copy). Losing the
  key makes old backups unreadable.
- A backup runs daily while the server is running, plus whenever you press **Back up now**.
  Failed uploads retry on the next scheduled run.
- The app keeps 1–90 files on Drive (default 14) and deletes older ones it uploaded.
- The panel shows the Google account, the **last successful upload** and any error. A red
  banner appears on every screen when the last success is more than **48 hours** old.
- **Test connection** verifies the Google session and refreshes the account email.

### 6.3 Restoring

Download the `.enc` file from Drive, then decrypt it on a machine with the key:

```bash
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  import { decryptBuffer, loadBackupKeyMaterial } from "./lib/offsite.mjs";
  const key = loadBackupKeyMaterial(process.argv[1]);
  writeFileSync("restored.sqlite3", decryptBuffer(readFileSync(process.argv[2]), key));
' /path/to/data /path/to/shopdesk-….sqlite3.enc
```

Then use **Backup and restore → Restore** with the decrypted `restored.sqlite3`. Keep the
encrypted original until you have confirmed the restored database.

---

## 7. Licence keys and trial

- **Trial:** 30 days for every installation, including existing databases upgraded
  without a licence.
- **Warning:** a banner appears during the last 7 days.
- **Expired:** the app becomes **read-only**. Billing and other writes are blocked by the
  API (HTTP 402), but signing in, viewing data, reports, exports, local backups and
  offsite backups keep working.
- A licence is signed with **Ed25519** and can be checked offline. It is bound to the
  shop's **installation ID** shown in **Settings → Licence & plan**.

### Vendor: create the signing keys once

```bash
npm run license:keygen
# writes vendor/license-private-key.pem and lib/license-public.mjs
```

- Commit `lib/license-public.mjs` (public key) and ship it with every release.
- Keep `vendor/license-private-key.pem` offline. **Never** put it on a shop PC, in a
  release zip, or in Git. It is git-ignored.
- Back the private key up. Losing it means you cannot issue licences for existing
  installations; replacing the key pair invalidates all previously issued keys.

### Vendor: issue a licence

The quickest way at a shop is the portable USB kit:

```bash
npm run licence:kit          # builds releases/ShopDesk-Licence-Kit
```

Copy that folder to an encrypted USB stick, then double-click
**`Make Licence Key.bat`** on the shop PC. It finds the installation, reads the
Installation ID, signs a 365-day key, copies it to the clipboard and saves a receipt.
Unplug the stick when the app shows **Activated**. The full workflow, safety rules and
Bangla instructions are in [LICENSING.md](LICENSING.md).

For scripts and remote keys:

```bash
node tools/license-issue.mjs \
  --shop "Mohammad Hardware" \
  --plan pro \
  --days 365 \
  --install abcd-1234-5678 \
  --out licenses/mohammad-hardware.txt
```

Options: `--expires YYYY-MM-DD` (instead of `--days`), `--seats N`, `--out file`.
Send the one-line `SD1.…` key to the shop. They paste it into
**Settings → Licence & plan → Activate**.

The activation endpoint rejects keys for a different installation ID
(`code: "install"`) and tampered keys (`code: "signature"`).

---

## 8. HTTPS, PWA and the "Connect a phone" page

Browsers only allow service workers and **Install app** on a secure context: HTTPS or
`http://localhost`. A plain `http://192.168.x.x` address still works as a normal web app,
but it cannot cache offline or be installed.

### Caddy (automatic HTTPS)

```caddyfile
shop.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name shop.example.com;
    # ssl_certificate / ssl_certificate_key ...
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Then set on the server:

```text
SHOP_PUBLIC_URL=https://shop.example.com
SHOP_TRUST_PROXY=1
```

Restart Shop Desk. The Google redirect URI becomes
`https://shop.example.com/api/backups/offsite/oauth/callback`; add it in Google Cloud
Console.

**PWA:** open the HTTPS address on Android Chrome and choose **Install app** (or the
browser's Install/Add to Home screen). On iPhone/iPad use Safari → Share → **Add to Home
Screen**. The service worker caches the shell and shows `offline.html` when the LAN is
unreachable; API calls always go to the network.

**Connect a phone:** open `http://SERVER-IP:8765/join` and scan the QR code. The page is
served with the shop name and current LAN addresses, so it keeps working when the server
IP changes (as long as you open it from the current address).

---

## 9. Updates and rollback

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\windows\update-shopdesk.ps1 `
  -ZipPath "D:\ShopDesk-12.0.1.zip"
```

The updater finds the install folder automatically (it reads
`%ProgramData%\ShopDesk\install.json`), so it also works when Shop Desk was installed in a
custom folder such as `D:\ShopDesk`.

Or `-SourceDir "D:\new-files"`. The updater stops the task, copies the app to
`update-backup-<stamp>`, backs up the database, swaps in the new files, starts the task,
and waits 60 seconds for `/healthz`. If health fails it restores the previous app and
database automatically.

### Linux

```bash
sudo ./install/linux/install-shopdesk.sh
```

The installer copies the new files over `/opt/shopdesk` and preserves
`/var/lib/shopdesk`. Keep a copy of the previous release and database before a major
upgrade. `systemctl restart shopdesk` is enough after replacing files manually.

### Signed update notices

A release manifest lets shops see that a new version exists without trusting mirrors:

```bash
npm run release:manifest -- \
  --version 12.0.1 \
  --url https://downloads.example.com/ShopDesk-12.0.1.zip \
  --file releases/ShopDesk-12.0.1.zip \
  --notes "Bangla receipts, offsite backups, PWA"
```

Upload `releases/manifest.json` and `releases/manifest.json.sig` next to the zip and set:

```text
SHOP_UPDATE_MANIFEST_URL=https://downloads.example.com/manifest.json
```

The server fetches both files, verifies the Ed25519 signature, and only then reports the
version. **Settings → Check for updates** shows the result. HTTPS is required; for local
testing only, `SHOP_UPDATE_ALLOW_HTTP=1` permits a loopback `http://127.0.0.1` URL.

---

## 10. Uninstall

**Windows:** double-click **`2 - Uninstall Shop Desk.bat`** in the Shop Desk folder — or
**`Uninstall Shop Desk.bat`** in the folder where you installed Shop Desk — and choose
**Yes** on the administrator prompt.

The uninstaller finds the installation automatically (including custom folders), then asks:

```
What do you want to remove?
  [1] The program only - keep shop data and backups  (recommended)
  [2] Everything        - delete the program, shop data and backups
Choose 1 or 2 [1]:
```

Option 2 also asks you to type `DELETE`. When it finishes it prints exactly what was
removed and, if you kept the data, the database, `offsite.key` and backup files with their
sizes.

It can also be run from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install\windows\uninstall-shopdesk.ps1
powershell -ExecutionPolicy Bypass -File .\install\windows\uninstall-shopdesk.ps1 -RemoveData
```

**Linux:**

```bash
sudo ./install/linux/uninstall-shopdesk.sh
```

It stops and disables the service, removes the systemd unit and `/opt/shopdesk`, and asks
whether to keep the shop data. It then prints the same summary with the files that were
kept. Non-interactive use:

```bash
sudo ./install/linux/uninstall-shopdesk.sh --keep-data
sudo ./install/linux/uninstall-shopdesk.sh --remove-data --yes
```

Delete `/var/lib/shopdesk` and the service user only after you have copied the database and
`offsite.key` somewhere safe.

---

## 11. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Phone cannot open the page | Check both devices are on the same Wi-Fi; allow TCP 8765 on the Private profile (`ufw allow 8765/tcp`); check the server is running (`/healthz`). |
| Page opens but "Database unavailable" | Look at `server.log` / `journalctl -u shopdesk`. The data folder must be writable by the service user. |
| Google button says not configured | `SHOP_GOOGLE_CLIENT_ID`/`SECRET` are missing or the server was not restarted. |
| `redirect_uri_mismatch` | The URI in Google Cloud Console must match the one shown in the app exactly, including scheme, port and path. |
| Offsite reconnects every week | Publish the OAuth consent screen so refresh tokens do not expire after 7 days. |
| Red backup banner | The last successful upload is over 48 hours old. Open **Backup and restore** and check the error; press **Back up now**. |
| Licence expired | The app is read-only by design. Enter a key in **Settings → Licence & plan**; reports, exports and backups still work. |
| Install app button missing | PWA installation needs HTTPS (or `localhost`). Set up a reverse proxy and `SHOP_PUBLIC_URL`. |
| Cannot sign in after moving the PC | The browser session is tied to the address. Open the new LAN address; sign in again. |
| Forgot owner password | Use a configured recovery code/email, or another administrator. Keep the database file and `offsite.key` backed up. |

---

## 12. Security notes

- Shop Desk is designed for a **trusted private LAN**. Do not expose port 8765 to the
  internet without HTTPS and additional access controls.
- The data folder contains the database, encryption key and backups. Restrict OS
  permissions; never email `offsite.key` with the backups.
- The licence private key belongs only on the vendor's offline machine.
- Backups are only useful if you test a restore. Do one restore drill before launch.
