# Bolts & Boards Shop Desk

Small shop inventory, sales, expenses, and reports with a separate SQLite database.

## Install for a shop

See [INSTALL.md](INSTALL.md) for Windows, Linux and Docker installation, automatic start,
Google Drive backups, HTTPS and updates.

- **Windows:** double-click **`1 - Install Shop Desk.bat`** in the Shop Desk folder. It asks for administrator permission and for the install folder (press Enter for `C:\ShopDesk`), then starts Shop Desk at boot, opens the private-network firewall, creates desktop shortcuts and opens the browser. To remove it later, double-click **`2 - Uninstall Shop Desk.bat`**.
- **Linux:** `sudo ./install/linux/install-shopdesk.sh` installs a systemd service with data in `/var/lib/shopdesk`.
- **Docker:** `docker build -t shopdesk .` and run it with a volume mounted at `/data`.

## Offsite backups (Google Drive)

Local backups stay on the shop PC, so they do not help if the PC is lost, stolen or damaged.
**Backup and restore → Offsite backup** connects a Google Drive account and uploads an
AES-256-GCM encrypted copy after every successful local backup, plus **Back up now**.
Only ciphertext leaves the computer; the key stays in `data/offsite.key` (or
`SHOP_BACKUP_KEY`). The app keeps the newest 14 files by default (1–90 configurable) and
shows the Google account, the last successful upload and any error. A red banner appears
on every screen when the last success is more than 48 hours old.
**Test connection** verifies the Google session without uploading anything.
Read [INSTALL.md §6](INSTALL.md#6-google-drive-offsite-backups) to create the OAuth client.

## Pharmacy profile

Open **Shop settings** and choose **Pharmacy** to track medicine batches, expiry dates, eligible stock, earliest-expiry-first allocation, supplier receipts, alerts for expired/near-expiry stock, and quarantine customer returns. Existing product quantities are preserved during Pharmacy conversion; old quantities start with unknown expiry and must be verified before sale.

## Bangla interface and receipts

Choose **বাংলা** in **Shop settings → Language** (or on first run). The whole interface —
navigation, forms, tables, dialogs, toasts, reports and printed bills — switches to
Bangla, using the bundled UI font stack and `i18n/bn.json`. **Bangla digits** converts
amounts and dates to ০১২৩৪৫৬৭৮৯ independently of the receipt language. Printed receipts
and repair tickets follow the selected language. Switch back to English at any time.

## Install on phones (PWA)

When Shop Desk is served over HTTPS (or on `localhost`), browsers offer **Install app**.
The app has a web manifest, 192/512/maskable icons, an offline fallback page and a service
worker that caches the shell but never API responses. **Connect a phone** opens `/join`,
which shows a server-generated QR code for the current LAN address so staff can join
without typing a URL.

## Browser support

Shop Desk works in current versions of Chrome, Edge, Firefox, and Safari (2020 or newer). The product search in New bill, Record sale, and Online orders is built into the page instead of using the browser's datalist popup, so typing part of an item name or scanning a barcode gives the same results in every browser. Very old browsers show an update message instead of a blank page.

## Start on this PC only

Run `run-shop.bat`, then open `http://127.0.0.1:8765`. Node.js 22.13 or later is required.

## First-time owner setup

On the first run, the server prints a one-time setup code in its console. Keep it private. Enter it in the app and create the owner account with a password of at least 12 characters. The code expires when the first owner is created or when the server stops.

## Use over your private shop network

1. Complete the owner setup on the server PC first.
2. Run `run-shop-lan.bat` on the server PC.
3. In Windows Firewall, allow inbound TCP port 8765 on the **Private** network profile only. Limit the rule's remote IP scope to the shop devices where possible.
4. On the server PC, run `ipconfig` and note its IPv4 address.
5. On an approved shop device on the same private network, open `http://SERVER-IP:8765`, replacing `SERVER-IP` with the address from step 4.

Reserve the server PC's address in the router so it stays the same. Do not enable router port forwarding or use this HTTP setup over public/untrusted Wi-Fi. HTTP does not encrypt passwords or session cookies in transit; use only on a trusted LAN. For remote access, use a properly secured HTTPS/VPN deployment.

## Accounts and access

Sign in as the owner, then choose **Team access** in the sidebar:

- **Add team member** creates an individual username and password. Use a unique password of at least 12 characters and share it privately.
- Choose whether that staff account can access inventory, sales, expenses, and/or **Online orders**. Online orders access is separate from Sales; Jahangir and administrators can grant or remove it. The server checks these permissions; hiding a screen alone is not the security control.
- The `jahangir` owner remains the protected master account. When Jahangir creates an administrator, all powers are selected by default; review the access boxes before saving. A full-access administrator can use the shop and manage accounts but cannot take over or remove the protected Jahangir account.
- Each signed-in user can click their profile circle to set a display name and upload a profile photo. The dashboard greeting uses that display name.
- **Access** changes module permissions.
- Jahangir and administrators see live server load by default. In **Access**, administrators can grant or remove **View server load in the top bar** for individual staff accounts.
- **Manage backups and restore the database** is its own administrator permission; it is separate from managing staff or administrators. Only Jahangir can grant or remove this permission. Administrators who receive it can use backup and restore, but cannot pass that power on. **Fresh start** remains exclusive to Jahangir.
- **Password** sets a new password and signs out that account's existing sessions.
- **Account recovery**: only Jahangir and administrators can set up or change offline recovery codes and recovery email settings from a signed-in profile. Confirm the current password when setting up a recovery option, then store the one-time recovery code offline. If locked out, use **Forgot password? Recover account** on the sign-in screen with an already configured recovery option. A successful reset changes the password, signs out all sessions, and displays a replacement offline code; save it. Creating a new code replaces the previous one. If no recovery option was configured before losing access, an administrator can reset the account or use the server database.
- **Email recovery (optional)**: configure Gmail on the server. Only Jahangir and administrators can add or change a verified recovery email. The app sends a six-digit verification code; only verified addresses can be used for password reset. On the sign-in recovery screen, request an email code and enter it in the recovery-code field. Email reset codes expire after 10 minutes and work once. The password reset screen also creates a replacement offline recovery code.
- **Disable** blocks sign-in and ends active sessions; **Enable** restores access.
- **Remove** permanently deletes that account. The last active administrator cannot be disabled or removed.

An account with shop-settings access can change shop name, location, shop profile, currency, number/date region, checkout tax mode and rate, allowed payment methods, customer-name requirements, and discount availability. Choosing a shop profile adds starter categories without changing existing products. Sign out when finished. Sessions expire after 12 hours.

## Clothing shop profile
Open **Shop settings** and choose **Clothing** to add clothing categories and enable brand, color, size, and material fields on product forms. Create a separate inventory item for each size/color combination when those variants need separate stock counts; give each variant its own SKU or barcode. The inventory search, low-stock view, supplier purchase selector, checkout, sale records, receipts, print/download lists, and updated CSV template include the variant details. Older inventory CSV templates remain supported.

## Mobile phone sales and repair jobs
Open **Shop settings** from the workspace button and choose **Mobile phone sales & service** to add starter categories for phones, tablets, accessories, spare parts, and repair services. Existing inventory is retained. The **Repairs** and **Device sales & warranty** screens are available only with this profile, and only to users with sales access. On a phone or tablet product bill line, enter one IMEI/serial per unit and the warranty length in months. The printed receipt includes those device details, and the Device sales & warranty screen lets staff search the serial, customer, or phone number. Device returns require selecting the exact IMEI/serial and mark that unit returned.

Mark a completed job **Delivered** to record its final service charge in Sales and the existing sales/profit reports. Repair payments are included in daily Cash closing. Add stock items as repair parts on the job; their quantities are deducted when saved, their inventory buying costs are added to the repair cost, and removing parts or cancelling an unpaid job restores them. Product sales continue to use inventory and checkout as before. The quick **Record sale** option blocks phones/tablets so staff use **New bill**, where serial and warranty details are captured.

Repair jobs include a printable 80 mm customer intake ticket with the job number, contact details, device/IMEI, reported issue, intake condition/accessories, estimate, payments, and balance. The job editor can record up to 365 days of repair warranty; its expiry is calculated from the delivery date and shown on the repair list. Leave it at 0 for no repair warranty. Do not store customer PINs or passwords in intake notes.

Delivered repair jobs are locked against changes unless the user has **Edit and delete delivered repair jobs (mobile shop only)** access. Jahangir and administrators always have this access. In **Team access → Access**, they can grant it to or remove it from a staff account. Users without it can still work on jobs that have not been delivered. Staff granted this access can edit and delete delivered jobs, but cannot reopen delivered jobs or change job statuses; only Jahangir and administrators can reopen delivered or cancelled jobs and delete jobs in any status. Reopening a delivered job removes its repair sale from reports until the job is delivered again, while preserving its payment history. Deleting a job removes its repair payments and linked repair sale, restores its recorded parts to inventory, and writes an activity-log entry. These controls apply only while the shop profile is set to Mobile phone sales & service.

## Configure Gmail recovery on Windows

For account creation, code testing, and changing the sender or receiving Gmail later, see [GMAIL-RECOVERY-GUIDE.md](GMAIL-RECOVERY-GUIDE.md).

Use a Gmail account dedicated to the shop if possible. Enable Google's 2-Step Verification and create a **Google App Password** for this app; do not use your regular Gmail password. In a normal Command Prompt opened as the same Windows user who runs the shop, set the server environment values:

```bat
setx SHOP_GMAIL_USER "shop-account@gmail.com"
setx SHOP_GMAIL_APP_PASSWORD "your-16-character-app-password"
```

Close and reopen the shop server window so it receives those environment values. Both `run-shop.bat` and `run-shop-lan.bat` will then use Gmail over encrypted SMTP. Keep the app password private and remove or rotate it if exposed. Gmail recovery codes sent to browsers are still protected by the app's trusted-LAN requirement; do not use this HTTP app over public or untrusted Wi-Fi.

## Data and backups

The database is `data/shop.sqlite3` on the server PC. The app creates a daily SQLite backup at the scheduled time (default **11:00 PM server local time**) and keeps the newest 14. The default backup folder is `data/backups`; administrators with **Manage backups and restore the database** can use **Choose folder** in **Backup and restore** to select a folder on the server PC. The server must be running at the scheduled time; if it starts later that day, it catches up by creating that day's backup. Changing the schedule time or destination after a backup has run will trigger a backup for the updated schedule once its time is due. The same page lets authorized administrators enable or disable the schedule, change its time, create a backup and download it to a chosen location, restore a selected SQLite backup, or permanently delete any server-stored backup after confirmation. This power is separate from staff and administrator management. Before restore, the server creates a safety copy of the current database. Restoring replaces the current data, so confirm the selected file carefully. Jahangir can use **Fresh start** there to clear trial business records and team accounts, reset shop settings, and keep the Jahangir login; the app saves a backup first and asks for a typed confirmation. Keep an off-device copy on another secure device. Local backups are not encrypted. For protection when the PC is lost or damaged, connect Google Drive under **Offsite backup**: a compressed SQLite snapshot is encrypted on this server before upload, and the app keeps the newest files on Drive with a 48-hour staleness warning.

The top bar displays the current date and time on the device running the browser, plus live server CPU and system memory usage. Hover over the server status for the shop process memory and server uptime.

## Reports
Choose the report start and end dates to filter the dashboard totals and chart. Use **Download Excel** to save the filtered report as a CSV file that opens in Microsoft Excel, or **Print report** for a paper/PDF copy. Tax collected is shown separately from sales revenue. Staff exports contain only data allowed by their account permissions.


## Bulk inventory updates
An administrator with inventory and edit-record access can use bulk upload. In Inventory, download the CSV template, edit it in Excel, and save as **CSV UTF-8**. Keep the Product ID for items being updated; leave it blank for new items. Quantity is the replacement total stock count, not an amount to add. Categories named in the CSV are created automatically if missing. Upload is limited to 500 rows and applies all rows together only after validation succeeds.


## Units and inventory search
When creating an item, set its unit of measure (for example piece, box, kg, meter, or roll); price and cost are per unit. Inventory quantities and sales show the unit, and each sale saves a snapshot of the unit used at that time. Older inventory and sales receive the default unit piece; edit existing items or update the Unit column in jahangir's bulk template if they use another unit. Use separate product records for variants such as color and size, with their own SKU and stock. The optional barcode field is searchable and can be scanned into the sale or bill search. The inventory search filters by product name, SKU, barcode, unit, or category.


## Inventory item actions
An account with inventory and edit-record access can edit an item's name, SKU, category, unit, selling price, purchase cost, stock quantity, and low-stock alert. Editing quantity sets the new total stock. It can also delete an item from current inventory; deletion removes its remaining stock but keeps existing sales history.

## Sale prices and purchase-cost warning
When recording a sale, the suggested sale price starts at the item's inventory selling price and can be changed for that transaction. The form shows purchase cost and estimated gross profit/loss. It warns and asks for confirmation if the sale price is below purchase cost. Sale reports use the entered sale price and the stored purchase cost; changing a transaction's sale price does not change the item's regular inventory price. Payment methods are configured in Shop settings. Barcode scanners can enter a barcode in the SKU/item-code field and use the same search; in a bill, scan/type the code and press Enter.

## Sales returns and corrections
An account with sales and inventory access can select **Return** beside a linked sale. Enter the quantity and optional reason, then enter any refund paid immediately. A return first reduces the bill's outstanding due; if the customer has already paid more than the adjusted bill total, the excess can be refunded or left as customer credit. Stock is restored immediately, the movement and return are recorded with the user and date, and sales/profit reports use the remaining sale quantity. Use **Returns** to review the return history. Bills and sales with returns cannot be edited or deleted, preserving the audit trail. Older sales without a linked inventory item cannot be returned safely.

An account with sales and edit-record access can edit or delete records without returns. Editing the item or quantity reconciles inventory stock; deleting a sale returns its quantity to stock when the linked inventory item still exists. Some older sales cannot be safely matched to an item; for those, the app limits edits to date, payment, and sale price, and may block deletion rather than risk changing the wrong stock.

## Expense corrections
An account with expense and edit-record access can edit or delete records from Expense history. The page shows all recorded expenses in a scrollable list, and changes are reflected in reports and expense totals.


## Product categories and sale search
Inventory supports categories such as Hand tools, Paint tools, Power tools, Electrical, Plumbing, Fasteners, Building materials, and Safety. An account with inventory and edit-record access can add, rename, and delete categories from Inventory → Categories; deleting a category moves its products to Other. The sale form's item search matches product name, SKU, unit, and category. Category is included in the bulk CSV template; older templates without a category column remain accepted.

## Supplier purchases and balances
Open **Suppliers & purchases** from Inventory. Add each supplier and enter any opening balance still owed. Record a purchase with its date, products, quantity, and buying cost per unit; stock increases immediately, and each item's current cost is updated using a weighted average. Record any amount paid at purchase time. Use **Pay supplier** to record later payments against the supplier's outstanding balance. The screen shows recent purchases, payments, balances, and new stock movements for purchases, sales, corrections, and inventory quantity changes. Older stock activity is not reconstructed. Purchase records, payments, and movements are retained in the SQLite database and included in the JSON export.

The bill editor has a phone layout with a scrollable item list, larger inputs, and a visible total and save area while scrolling. Older bulk CSV templates without a barcode column remain accepted; uploading one leaves current barcode values unchanged.
