# Deploying Shop Desk to a domain

Shop Desk is a **Node.js app with a SQLite file database**, so the host must run Node.js **22.13 or newer**
and keep a **persistent disk** for the `data` folder. Plain PHP/static hosting (and many cheap shared plans) cannot run it.

Always serve it over **HTTPS**. It contains passwords, sessions and business data.

For shop-PC installs (Windows service, systemd, backups and licence keys), see [INSTALL.md](INSTALL.md).

## Environment variables

| Variable | Meaning |
|---|---|
| `PORT` | Port to listen on (most hosts set this for you). Default 8765 |
| `SHOP_TRUST_PROXY=1` | **Required behind HTTPS proxy.** Makes cookies `Secure`, fixes login rate-limiting per visitor |
| `SHOP_PUBLIC_URL` | Your site address, e.g. `https://shop.yourdomain.com` |
| `SHOP_DATA_DIR` | Folder for `shop.sqlite3` and `backups/`. Use a persistent path outside the code folder |
| `SHOP_SETUP_CODE` | Optional 16+ char first-run code. Otherwise read it from the app's logs. Remove after owner is created |
| `SHOP_GMAIL_USER`, `SHOP_GMAIL_APP_PASSWORD` | Optional Gmail recovery |
| `SHOP_GOOGLE_CLIENT_ID`, `SHOP_GOOGLE_CLIENT_SECRET` | Google Drive offsite backups (see INSTALL.md §6) |
| `SHOP_OAUTH_REDIRECT` | Override the Google callback URI if it differs from `SHOP_PUBLIC_URL` |
| `SHOP_BACKUP_KEY` | 16+ char backup encryption key. Empty = generated in `DATA_DIR/offsite.key` |
| `SHOP_UPDATE_MANIFEST_URL` | HTTPS URL of the signed release manifest for update notices |
| `SHOP_UPDATE_ALLOW_HTTP=1` | Testing only: allow a loopback `http://` manifest |

A health check is available at `/healthz`.

## Option A - VPS with Docker (recommended: automatic HTTPS)

1. Create a VPS (Ubuntu), install Docker, and point your domain's **A record** to the VPS IP.
2. Upload this folder. Edit `Caddyfile` to your domain.
3. Create `.env` next to `docker-compose.yml`:
   ```
   SHOP_PUBLIC_URL=https://shop.yourdomain.com
   SHOP_SETUP_CODE=choose-a-long-random-code-here
   ```
4. `docker compose up -d --build`
5. Open your domain, enter the setup code, create the owner account.
6. Remove `SHOP_SETUP_CODE` from `.env` and run `docker compose up -d`.

## Option B - VPS without Docker (PM2 + Nginx)

1. Install Node 22, `npm i -g pm2`, Nginx and certbot.
2. Copy the app to `/opt/shop-desk`, `mkdir -p /var/lib/shop-desk`.
3. Edit `ecosystem.config.cjs`, then `pm2 start ecosystem.config.cjs && pm2 save && pm2 startup`.
4. Use `nginx-example.conf`, then `certbot --nginx -d shop.yourdomain.com`.
5. First-run code: `pm2 logs shop-desk`.

## Option C - cPanel "Setup Node.js App" (only if Node 22+ is offered)

1. Create the app: Node version 22+, application root = this folder, startup file = `passenger.cjs`.
2. Add the environment variables above (`SHOP_TRUST_PROXY=1`, `SHOP_PUBLIC_URL`, `SHOP_DATA_DIR` pointing to a folder **outside** `public_html`, `SHOP_SETUP_CODE`).
3. Enable SSL (AutoSSL) for the domain, then restart the app.
If the dropdown only offers Node 18/20, use a VPS instead - `node:sqlite` will not work there.

## Moving your existing data

1. On the PC, **stop the server** (Ctrl+C) so the database is fully saved.
2. Copy `data/shop.sqlite3` only (not `-wal`/`-shm`) to `SHOP_DATA_DIR` on the server **before first start**
   (for Docker: `docker compose cp shop.sqlite3 shop:/data/` then `docker compose restart shop`).
   Or use **Backup and restore -> Restore** inside the app after creating the owner.
3. Your existing logins then work; no setup code is needed.

## Security checklist

- HTTPS only; never expose port 8765 publicly (bind `SHOP_HOST=127.0.0.1` when using a proxy).
- Use long unique passwords (12+ chars). Consider a separate subdomain.
- Back up `SHOP_DATA_DIR` off the server regularly (the in-app backups are on the same disk).
- Do not leave `SHOP_SETUP_CODE` set after setup.
