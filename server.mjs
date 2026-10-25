import { createServer } from "node:http";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { cpus as systemCpus, freemem, networkInterfaces, totalmem } from "node:os";
import { DEFAULT_FOLDER_NAME, DEFAULT_KEEP, GoogleDriveBackup, decryptSecret, encryptSecret, loadBackupKeyMaterial, prepareOffsitePayload } from "./lib/offsite.mjs";
import { buildMedexSearchUrl, fetchMedexDetails, fetchMedexSearch, normalizeMedexUrl } from "./lib/medex.mjs";
import { qrSvg } from "./lib/qr.mjs";
import { compareVersions, parseManifest } from "./lib/release.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const appVersion = (() => {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "12.0.0"; }
  catch { return "12.0.0"; }
})();
const dataDir = process.env.SHOP_DATA_DIR || join(root, "data");
// Hosting settings. PORT is what most hosts (cPanel Node.js App, Render, Railway, etc.) provide.
const rawPort = String(process.env.PORT || process.env.SHOP_PORT || 8765);
const port = /^\d+$/.test(rawPort) ? Number(rawPort) : rawPort; // Passenger may pass a socket path
const host = process.env.SHOP_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
// Set SHOP_TRUST_PROXY=1 when running behind HTTPS reverse proxy (Nginx, Caddy, Apache, Cloudflare, Passenger).
const trustProxy = /^(1|true|yes)$/i.test(process.env.SHOP_TRUST_PROXY || "");
const publicBaseUrl = String(process.env.SHOP_PUBLIC_URL || "").split(",")[0].trim().replace(/\/+$/, "");
const lastHeaderValue = value => String(value || "").split(",").map(part => part.trim()).filter(Boolean).pop() || "";
const firstHeaderValue = value => String(value || "").split(",")[0].trim();
function isSecureRequest(request) {
  return Boolean(request.socket.encrypted) || (trustProxy && firstHeaderValue(request.headers["x-forwarded-proto"]).toLowerCase() === "https");
}
function clientIp(request) {
  if (trustProxy) { const forwarded = lastHeaderValue(request.headers["x-forwarded-for"]); if (forwarded) return forwarded; }
  return request.socket.remoteAddress || "unknown";
}
function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const hostName = trustProxy ? (firstHeaderValue(request.headers["x-forwarded-host"]) || request.headers.host) : request.headers.host;
  const allowed = new Set([`${isSecureRequest(request) ? "https" : "http"}://${hostName}`]);
  for (const extra of String(process.env.SHOP_PUBLIC_URL || "").split(",")) {
    try { if (extra.trim()) allowed.add(new URL(extra.trim()).origin); } catch {}
  }
  return allowed.has(origin);
}
let previousCpuTimes = null;
let systemCpuPercent = null;
function serverLoadStatus() {
  const current = systemCpus().map(cpu => cpu.times);
  if (previousCpuTimes && previousCpuTimes.length === current.length) {
    let totalDelta = 0, idleDelta = 0;
    for (let i = 0; i < current.length; i++) {
      const before = previousCpuTimes[i], after = current[i];
      const totalBefore = Object.values(before).reduce((sum, value) => sum + value, 0);
      const totalAfter = Object.values(after).reduce((sum, value) => sum + value, 0);
      totalDelta += totalAfter - totalBefore;
      idleDelta += after.idle - before.idle;
    }
    if (totalDelta > 0) systemCpuPercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  }
  previousCpuTimes = current;
  const total = totalmem(), used = total - freemem();
  return {
    cpuPercent: systemCpuPercent,
    memoryPercent: total ? Math.round(used / total * 100) : null,
    appMemoryMb: Math.round(process.memoryUsage().rss / 1048576),
    uptimeSeconds: Math.floor(process.uptime())
  };
}
mkdirSync(dataDir, { recursive: true });
const dbFile = join(dataDir, "shop.sqlite3");
let db = new DatabaseSync(dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), shop_name TEXT NOT NULL, workspace TEXT NOT NULL, contact_number TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', facebook_page TEXT NOT NULL DEFAULT '', whatsapp_number TEXT NOT NULL DEFAULT '', contact_address TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL, price REAL NOT NULL CHECK(price>=0),
    cost REAL NOT NULL CHECK(cost>=0), qty INTEGER NOT NULL CHECK(qty>=0), min INTEGER NOT NULL CHECK(min>=0), icon TEXT NOT NULL DEFAULT '📦'
  );
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, product TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0),
    total REAL NOT NULL CHECK(total>=0), payment TEXT NOT NULL, cost REAL NOT NULL CHECK(cost>=0), service_job_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', amount REAL NOT NULL CHECK(amount>=0)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','staff')),
    can_inventory INTEGER NOT NULL DEFAULT 0, can_sales INTEGER NOT NULL DEFAULT 0, can_expenses INTEGER NOT NULL DEFAULT 0, can_online_orders INTEGER NOT NULL DEFAULT 0, can_delete_online_orders INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS email_verifications (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS email_recovery_codes (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS backup_schedule (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 1,
    time TEXT NOT NULL DEFAULT '23:00',
    directory TEXT NOT NULL DEFAULT '',
    last_run_date TEXT NOT NULL DEFAULT '',
    last_run_time TEXT NOT NULL DEFAULT '',
    last_run_directory TEXT NOT NULL DEFAULT '',
    last_backup_at TEXT NOT NULL DEFAULT ''
  );
  INSERT OR IGNORE INTO backup_schedule(id,enabled,time) VALUES(1,1,'23:00');
`);
const backupScheduleColumns = new Set(db.prepare("PRAGMA table_info(backup_schedule)").all().map(column => column.name));
if (!backupScheduleColumns.has("directory")) db.exec("ALTER TABLE backup_schedule ADD COLUMN directory TEXT NOT NULL DEFAULT ''");
if (!backupScheduleColumns.has("last_run_time")) db.exec("ALTER TABLE backup_schedule ADD COLUMN last_run_time TEXT NOT NULL DEFAULT ''");
if (!backupScheduleColumns.has("last_run_directory")) db.exec("ALTER TABLE backup_schedule ADD COLUMN last_run_directory TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS offsite_backup (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
    folder_name TEXT NOT NULL DEFAULT 'ShopDesk Backups', keep INTEGER NOT NULL DEFAULT 14,
    connection TEXT NOT NULL DEFAULT '', connected_email TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT NOT NULL DEFAULT '', last_success_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '', last_file TEXT NOT NULL DEFAULT ''
  );
  INSERT OR IGNORE INTO offsite_backup(id) VALUES(1);`);
const settingColumns = new Set(db.prepare("PRAGMA table_info(settings)").all().map(column => column.name));
const hadLanguageColumn = settingColumns.has("language");
if (!hadLanguageColumn) db.exec("ALTER TABLE settings ADD COLUMN language TEXT NOT NULL DEFAULT 'bn'");
if (!settingColumns.has("bangla_digits")) db.exec("ALTER TABLE settings ADD COLUMN bangla_digits INTEGER NOT NULL DEFAULT 1");
// Existing shops keep English until they choose Bangla; new installs start in Bangla.
if (!hadLanguageColumn && db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0) db.exec("UPDATE settings SET language='en' WHERE id=1");
for (const [name, definition] of Object.entries({
  shop_type: "TEXT NOT NULL DEFAULT 'general'",
  currency_code: "TEXT NOT NULL DEFAULT 'BDT'",
  locale: "TEXT NOT NULL DEFAULT 'en-BD'",
  tax_rate: "REAL NOT NULL DEFAULT 0",
  tax_mode: "TEXT NOT NULL DEFAULT 'none'",
  require_customer: "INTEGER NOT NULL DEFAULT 0",
  allow_discounts: "INTEGER NOT NULL DEFAULT 1",
  payment_methods: "TEXT NOT NULL DEFAULT 'Cash,bKash,Nagad,Card,Due'",
  contact_number: "TEXT NOT NULL DEFAULT ''",
  website: "TEXT NOT NULL DEFAULT ''",
  email: "TEXT NOT NULL DEFAULT ''",
  facebook_page: "TEXT NOT NULL DEFAULT ''",
  whatsapp_number: "TEXT NOT NULL DEFAULT ''",
  contact_address: "TEXT NOT NULL DEFAULT ''"
})) if (!settingColumns.has(name)) db.exec(`ALTER TABLE settings ADD COLUMN ${name} ${definition}`);
const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map(column => column.name));
if (!userColumns.has("display_name")) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
if (!userColumns.has("avatar_data")) db.exec("ALTER TABLE users ADD COLUMN avatar_data TEXT");
if (!userColumns.has("email")) db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
if (!userColumns.has("email_verified")) db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
const productColumns = new Set(db.prepare("PRAGMA table_info(products)").all().map(column => column.name));
if (!productColumns.has("unit")) db.exec("ALTER TABLE products ADD COLUMN unit TEXT NOT NULL DEFAULT 'piece'");
if (!productColumns.has("pack_size")) db.exec("ALTER TABLE products ADD COLUMN pack_size REAL NOT NULL DEFAULT 0");
if (!productColumns.has("pack_name")) db.exec("ALTER TABLE products ADD COLUMN pack_name TEXT NOT NULL DEFAULT ''");
if (!productColumns.has("category")) db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'Other'");
if (!productColumns.has("barcode")) db.exec("ALTER TABLE products ADD COLUMN barcode TEXT NOT NULL DEFAULT ''");
for (const [name, definition] of Object.entries({
  brand: "TEXT NOT NULL DEFAULT ''",
  color: "TEXT NOT NULL DEFAULT ''",
  size: "TEXT NOT NULL DEFAULT ''",
  material: "TEXT NOT NULL DEFAULT ''"
})) if (!productColumns.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
db.exec("CREATE INDEX IF NOT EXISTS products_barcode_idx ON products(barcode)");
const salesColumns = new Set(db.prepare("PRAGMA table_info(sales)").all().map(column => column.name));
if (!salesColumns.has("unit")) db.exec("ALTER TABLE sales ADD COLUMN unit TEXT NOT NULL DEFAULT 'piece'");
if (!salesColumns.has("product_id")) db.exec("ALTER TABLE sales ADD COLUMN product_id INTEGER");
if (!salesColumns.has("tax_amount")) db.exec("ALTER TABLE sales ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0");
if (!salesColumns.has("service_job_id")) db.exec("ALTER TABLE sales ADD COLUMN service_job_id INTEGER");
db.exec(`UPDATE sales
  SET product_id=(SELECT MIN(p.id) FROM products p WHERE p.name=sales.product COLLATE NOCASE)
  WHERE product_id IS NULL
    AND (SELECT COUNT(*) FROM products p WHERE p.name=sales.product COLLATE NOCASE)=1;
  CREATE INDEX IF NOT EXISTS sales_product_id_idx ON sales(product_id);`);
db.exec(`CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
)`);
db.exec(`CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  balance REAL NOT NULL DEFAULT 0 CHECK(balance>=0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const supplierColumns = new Set(db.prepare("PRAGMA table_info(suppliers)").all().map(column => column.name));
if (!supplierColumns.has("opening_balance")) db.exec("ALTER TABLE suppliers ADD COLUMN opening_balance REAL NOT NULL DEFAULT 0");
db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, date TEXT NOT NULL, total REAL NOT NULL CHECK(total>=0),
    reference TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchase_lines (
    id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL, product_id INTEGER, product_name TEXT NOT NULL,
    qty REAL NOT NULL CHECK(qty>0), unit TEXT NOT NULL, unit_cost REAL NOT NULL CHECK(unit_cost>=0),
    line_total REAL NOT NULL CHECK(line_total>=0)
  );
  CREATE TABLE IF NOT EXISTS supplier_payments (
    id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0),
    method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', received_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, product_id INTEGER, product_name TEXT NOT NULL,
    kind TEXT NOT NULL, quantity_change REAL NOT NULL, quantity_after REAL NOT NULL, unit TEXT NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0, reference TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS purchases_supplier_date_idx ON purchases(supplier_id,date);
  CREATE INDEX IF NOT EXISTS supplier_payments_supplier_date_idx ON supplier_payments(supplier_id,date);
  CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements(product_id, id DESC);
`);
const purchaseLineColumns = new Set(db.prepare("PRAGMA table_info(purchase_lines)").all().map(column => column.name));
if (!purchaseLineColumns.has("batch_number")) db.exec("ALTER TABLE purchase_lines ADD COLUMN batch_number TEXT NOT NULL DEFAULT ''");
if (!purchaseLineColumns.has("expiry_date")) db.exec("ALTER TABLE purchase_lines ADD COLUMN expiry_date TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS sales_returns (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  product TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>0),
  total REAL NOT NULL CHECK(total>=0),
  payment TEXT NOT NULL,
  cost REAL NOT NULL CHECK(cost>=0),
  unit TEXT NOT NULL DEFAULT 'piece',
  product_id INTEGER,
  reason TEXT NOT NULL DEFAULT '', online_order_id INTEGER, order_line_index INTEGER NOT NULL DEFAULT -1
)`);
// Upgrade the early placeholder returns table into an auditable transaction ledger.
// Rebuild it so weighed goods can be returned in fractional quantities as well.
function upgradeSalesReturnsSchema() {
  const info = db.prepare("PRAGMA table_info(sales_returns)").all();
  const columns = new Set(info.map(column => column.name));
  const required = ["sale_id", "bill_id", "refund_amount", "refund_method", "actor", "created_at"];
  if (required.some(column => !columns.has(column)) || info.find(column => column.name === "qty")?.type?.toUpperCase() !== "REAL") {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE sales_returns RENAME TO sales_returns_legacy");
      db.exec(`CREATE TABLE sales_returns (
        id INTEGER PRIMARY KEY, date TEXT NOT NULL, product TEXT NOT NULL,
        qty REAL NOT NULL CHECK(qty>0), total REAL NOT NULL CHECK(total>=0),
        payment TEXT NOT NULL DEFAULT 'Return', cost REAL NOT NULL CHECK(cost>=0),
        unit TEXT NOT NULL DEFAULT 'piece', product_id INTEGER, reason TEXT NOT NULL DEFAULT '',
        sale_id INTEGER, bill_id INTEGER, online_order_id INTEGER, order_line_index INTEGER NOT NULL DEFAULT -1,
        refund_amount REAL NOT NULL DEFAULT 0 CHECK(refund_amount>=0), refund_method TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`INSERT INTO sales_returns(id,date,product,qty,total,payment,cost,unit,product_id,reason)
        SELECT id,date,product,qty,total,payment,cost,unit,product_id,reason FROM sales_returns_legacy;
        DROP TABLE sales_returns_legacy;
        CREATE INDEX IF NOT EXISTS sales_returns_sale_idx ON sales_returns(sale_id,id);
        CREATE INDEX IF NOT EXISTS sales_returns_bill_idx ON sales_returns(bill_id,id);
        CREATE INDEX IF NOT EXISTS sales_returns_online_order_idx ON sales_returns(online_order_id,id);`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
upgradeSalesReturnsSchema();
const salesReturnColumns = new Set(db.prepare("PRAGMA table_info(sales_returns)").all().map(column => column.name));
if (!salesReturnColumns.has("online_order_id")) db.exec("ALTER TABLE sales_returns ADD COLUMN online_order_id INTEGER");
if (!salesReturnColumns.has("order_line_index")) db.exec("ALTER TABLE sales_returns ADD COLUMN order_line_index INTEGER NOT NULL DEFAULT -1");
db.exec("CREATE INDEX IF NOT EXISTS sales_returns_online_order_idx ON sales_returns(online_order_id,id)");
db.exec(`CREATE TABLE IF NOT EXISTS medicine_batches (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL,
  batch_number TEXT NOT NULL,
  expiry_date TEXT NOT NULL DEFAULT '',
  quantity_received REAL NOT NULL DEFAULT 0 CHECK(quantity_received>=0),
  quantity_remaining REAL NOT NULL DEFAULT 0 CHECK(quantity_remaining>=0),
  quantity_quarantined REAL NOT NULL DEFAULT 0 CHECK(quantity_quarantined>=0),
  unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost>=0),
  supplier_id INTEGER,
  purchase_id INTEGER,
  received_date TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS medicine_batch_product_number_idx ON medicine_batches(product_id,batch_number COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS medicine_batches_expiry_idx ON medicine_batches(expiry_date,product_id);
CREATE TABLE IF NOT EXISTS medicine_batch_sales (
  sale_id INTEGER NOT NULL,
  batch_id INTEGER NOT NULL,
  quantity REAL NOT NULL CHECK(quantity>0),
  PRIMARY KEY(sale_id,batch_id)
);
CREATE TABLE IF NOT EXISTS medicine_batch_returns (
  return_id INTEGER NOT NULL,
  batch_id INTEGER NOT NULL,
  quantity REAL NOT NULL CHECK(quantity>0),
  PRIMARY KEY(return_id,batch_id)
);
CREATE TABLE IF NOT EXISTS medicine_details (
  product_id INTEGER PRIMARY KEY,
  generic_name TEXT NOT NULL DEFAULT '',
  strength TEXT NOT NULL DEFAULT '',
  dosage_form TEXT NOT NULL DEFAULT '',
  manufacturer TEXT NOT NULL DEFAULT ''
);`);
db.exec(`CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, customer TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  payment TEXT NOT NULL, discount REAL NOT NULL DEFAULT 0 CHECK(discount>=0), total REAL NOT NULL CHECK(total>=0),
  cashier TEXT NOT NULL DEFAULT '', lines TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_charge REAL NOT NULL DEFAULT 0 CHECK(delivery_charge>=0)
)`);
if (!salesColumns.has("bill_id")) db.exec("ALTER TABLE sales ADD COLUMN bill_id INTEGER");
const billColumns = new Set(db.prepare("PRAGMA table_info(bills)").all().map(column => column.name));
if (!billColumns.has("tax_amount")) db.exec("ALTER TABLE bills ADD COLUMN tax_amount REAL NOT NULL DEFAULT 0");
if (!billColumns.has("delivery_charge")) db.exec("ALTER TABLE bills ADD COLUMN delivery_charge REAL NOT NULL DEFAULT 0");
if (!billColumns.has("tax_rate")) db.exec("ALTER TABLE bills ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0");
if (!billColumns.has("tax_mode")) db.exec("ALTER TABLE bills ADD COLUMN tax_mode TEXT NOT NULL DEFAULT 'none'");
const teamColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map(column => column.name));
if (!teamColumns.has("can_team")) {
  for (const column of ["can_team", "can_admins", "can_records"]) db.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  db.exec("UPDATE users SET can_inventory=1,can_sales=1,can_expenses=1,can_team=1,can_admins=1,can_records=1 WHERE role='admin'");
}
for (const column of ["can_settings", "can_supplier_purchases", "can_backups", "can_server_load", "can_online_orders", "can_delete_online_orders"]) {
  if (!teamColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
}
if (!teamColumns.has("can_repair_records")) {
  db.exec("ALTER TABLE users ADD COLUMN can_repair_records INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE users SET can_repair_records=1 WHERE role='admin'");
}
// jahangir is always an active administrator with every power, even if the database was edited by hand.
db.exec("UPDATE users SET role='admin',active=1,can_inventory=1,can_sales=1,can_expenses=1,can_team=1,can_admins=1,can_records=1,can_repair_records=1,can_settings=1,can_supplier_purchases=1,can_backups=1,can_server_load=1,can_online_orders=1,can_delete_online_orders=1 WHERE username='jahangir' COLLATE NOCASE");
db.exec(`CREATE TABLE IF NOT EXISTS bill_payments (id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL, date TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount>0), method TEXT NOT NULL, received_by TEXT NOT NULL DEFAULT '')`);
db.exec(`CREATE TABLE IF NOT EXISTS service_jobs (
  id INTEGER PRIMARY KEY, received_date TEXT NOT NULL, promised_date TEXT NOT NULL DEFAULT '', delivered_date TEXT NOT NULL DEFAULT '',
  customer TEXT NOT NULL, phone TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
  device_serial TEXT NOT NULL DEFAULT '', issue TEXT NOT NULL, diagnosis TEXT NOT NULL DEFAULT '',
  parts_used TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Received',
  estimate REAL NOT NULL DEFAULT 0 CHECK(estimate>=0), final_charge REAL NOT NULL DEFAULT 0 CHECK(final_charge>=0),
  parts_cost REAL NOT NULL DEFAULT 0 CHECK(parts_cost>=0), repair_warranty_days INTEGER NOT NULL DEFAULT 0,
  repair_warranty_expires TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', sale_id INTEGER
);
CREATE TABLE IF NOT EXISTS service_job_payments (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
  date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0), method TEXT NOT NULL, received_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS service_jobs_status_date_idx ON service_jobs(status, received_date DESC);
CREATE INDEX IF NOT EXISTS service_job_payments_job_idx ON service_job_payments(job_id,id);`);
{
  const serviceJobColumns = new Set(db.prepare("PRAGMA table_info(service_jobs)").all().map(column => column.name));
  if (!serviceJobColumns.has("repair_warranty_days")) db.exec("ALTER TABLE service_jobs ADD COLUMN repair_warranty_days INTEGER NOT NULL DEFAULT 0");
  if (!serviceJobColumns.has("repair_warranty_expires")) db.exec("ALTER TABLE service_jobs ADD COLUMN repair_warranty_expires TEXT NOT NULL DEFAULT ''");
}
db.exec("CREATE TABLE IF NOT EXISTS sold_devices (id INTEGER PRIMARY KEY, serial TEXT NOT NULL COLLATE NOCASE, product_id INTEGER, product_name TEXT NOT NULL, bill_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, sold_date TEXT NOT NULL, warranty_months INTEGER NOT NULL DEFAULT 0, warranty_expires TEXT NOT NULL DEFAULT '', customer TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Sold')");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sold_devices_active_serial_idx ON sold_devices(serial COLLATE NOCASE) WHERE status='Sold'; CREATE INDEX IF NOT EXISTS sold_devices_bill_idx ON sold_devices(bill_id)");
db.exec("CREATE INDEX IF NOT EXISTS sold_devices_customer_idx ON sold_devices(customer,phone)");
db.exec("CREATE TABLE IF NOT EXISTS service_job_parts (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE, product_id INTEGER NOT NULL, product_name TEXT NOT NULL, qty REAL NOT NULL CHECK(qty>0), unit TEXT NOT NULL, unit_cost REAL NOT NULL CHECK(unit_cost>=0))");
db.exec("CREATE INDEX IF NOT EXISTS service_job_parts_job_idx ON service_job_parts(job_id,id)");
db.exec(`CREATE TABLE IF NOT EXISTS online_orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  city_area TEXT NOT NULL DEFAULT '',
  courier TEXT NOT NULL DEFAULT '',
  tracking_id TEXT NOT NULL DEFAULT '',
  delivery_charge REAL NOT NULL DEFAULT 0 CHECK(delivery_charge>=0),
  discount REAL NOT NULL DEFAULT 0 CHECK(discount>=0),
  subtotal REAL NOT NULL DEFAULT 0 CHECK(subtotal>=0),
  total REAL NOT NULL DEFAULT 0 CHECK(total>=0),
  advance_paid REAL NOT NULL DEFAULT 0 CHECK(advance_paid>=0),
  due_cod REAL NOT NULL DEFAULT 0 CHECK(due_cod>=0),
  payment_method TEXT NOT NULL DEFAULT 'Cash on Delivery',
  payment_status TEXT NOT NULL DEFAULT 'Pending',
  order_status TEXT NOT NULL DEFAULT 'Pending',
  notes TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL DEFAULT '[]',
  stock_deducted INTEGER NOT NULL DEFAULT 0,
  bill_id INTEGER,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS online_orders_status_date_idx ON online_orders(order_status, date DESC);
CREATE INDEX IF NOT EXISTS online_orders_phone_idx ON online_orders(customer_phone);`);
db.exec("INSERT INTO bill_payments(bill_id,date,amount,method) SELECT id,date,total,payment FROM bills WHERE payment<>'Due' AND total>0 AND id NOT IN (SELECT bill_id FROM bill_payments)");
const seedCategory = name => db.prepare("INSERT OR IGNORE INTO categories(name) VALUES(?)").run(name);
for (const name of ["General merchandise", "Accessories", "Services", "Other"]) {
  seedCategory(name);
}
const profileCategories = {
  hardware: ["Hand tools", "Power tools", "Electrical", "Plumbing", "Building materials", "Safety", "Other"],
  mobile: ["Smartphones", "Feature phones", "Tablets", "Accessories", "Spare parts", "Repair services", "Other"],
  grocery: ["Produce", "Dairy", "Bakery", "Pantry", "Beverages", "Household", "Other"],
  clothing: ["Men's Wear", "Women's Wear", "Kids & Babywear", "Panjabi & Traditional", "Shirts & T-Shirts", "Pants & Jeans", "Sarees & Kurtis", "Fabrics & Unstitched", "Footwear", "Accessories", "Other"],
  pharmacy: ["Medicines", "First aid", "Personal care", "Medical supplies", "Other"],
  restaurant: ["Starters & Snacks", "Rice & Biryani", "Main Course", "Fast Food & Burgers", "Kebab & Grill", "Desserts & Sweets", "Beverages & Drinks", "Combo Meals", "Raw Ingredients", "Other"],
  general: ["General merchandise", "Accessories", "Services", "Other"]
};
const addProfileCategories = type => { for (const name of profileCategories[type] || profileCategories.general) seedCategory(name); };
function upgradeRestoredDatabase() {
  const ensure = (table, name, definition) => {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  for (const [name, definition] of Object.entries({ contact_number: "TEXT NOT NULL DEFAULT ''", website: "TEXT NOT NULL DEFAULT ''", email: "TEXT NOT NULL DEFAULT ''", facebook_page: "TEXT NOT NULL DEFAULT ''", whatsapp_number: "TEXT NOT NULL DEFAULT ''", contact_address: "TEXT NOT NULL DEFAULT ''" })) ensure("settings", name, definition);
  ensure("products", "barcode", "TEXT NOT NULL DEFAULT ''");
  for (const [name, definition] of Object.entries({ brand: "TEXT NOT NULL DEFAULT ''", color: "TEXT NOT NULL DEFAULT ''", size: "TEXT NOT NULL DEFAULT ''", material: "TEXT NOT NULL DEFAULT ''" })) ensure("products", name, definition);
  db.exec("CREATE INDEX IF NOT EXISTS products_barcode_idx ON products(barcode)");
  for (const [name, definition] of Object.entries({ shop_type: "TEXT NOT NULL DEFAULT 'general'", currency_code: "TEXT NOT NULL DEFAULT 'BDT'", locale: "TEXT NOT NULL DEFAULT 'en-BD'", tax_rate: "REAL NOT NULL DEFAULT 0", tax_mode: "TEXT NOT NULL DEFAULT 'none'", require_customer: "INTEGER NOT NULL DEFAULT 0", allow_discounts: "INTEGER NOT NULL DEFAULT 1", payment_methods: "TEXT NOT NULL DEFAULT 'Cash,bKash,Nagad,Card,Due'" })) ensure("settings", name, definition);
  ensure("sales", "tax_amount", "REAL NOT NULL DEFAULT 0");
  ensure("sales", "service_job_id", "INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS service_jobs (
    id INTEGER PRIMARY KEY, received_date TEXT NOT NULL, promised_date TEXT NOT NULL DEFAULT '', delivered_date TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL, phone TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL,
    device_serial TEXT NOT NULL DEFAULT '', issue TEXT NOT NULL, diagnosis TEXT NOT NULL DEFAULT '',
    parts_used TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Received', estimate REAL NOT NULL DEFAULT 0 CHECK(estimate>=0),
    final_charge REAL NOT NULL DEFAULT 0 CHECK(final_charge>=0), parts_cost REAL NOT NULL DEFAULT 0 CHECK(parts_cost>=0),
    repair_warranty_days INTEGER NOT NULL DEFAULT 0, repair_warranty_expires TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', sale_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS service_job_payments (
    id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE,
    date TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0), method TEXT NOT NULL, received_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS service_jobs_status_date_idx ON service_jobs(status, received_date DESC);
  CREATE INDEX IF NOT EXISTS service_job_payments_job_idx ON service_job_payments(job_id,id);`);
  ensure("service_jobs", "repair_warranty_days", "INTEGER NOT NULL DEFAULT 0");
  ensure("service_jobs", "repair_warranty_expires", "TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE TABLE IF NOT EXISTS sold_devices (id INTEGER PRIMARY KEY, serial TEXT NOT NULL COLLATE NOCASE, product_id INTEGER, product_name TEXT NOT NULL, bill_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, sold_date TEXT NOT NULL, warranty_months INTEGER NOT NULL DEFAULT 0, warranty_expires TEXT NOT NULL DEFAULT '', customer TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Sold')");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sold_devices_active_serial_idx ON sold_devices(serial COLLATE NOCASE) WHERE status='Sold'; CREATE INDEX IF NOT EXISTS sold_devices_bill_idx ON sold_devices(bill_id)");
  db.exec("CREATE INDEX IF NOT EXISTS sold_devices_customer_idx ON sold_devices(customer,phone)");
  db.exec("CREATE TABLE IF NOT EXISTS service_job_parts (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES service_jobs(id) ON DELETE CASCADE, product_id INTEGER NOT NULL, product_name TEXT NOT NULL, qty REAL NOT NULL CHECK(qty>0), unit TEXT NOT NULL, unit_cost REAL NOT NULL CHECK(unit_cost>=0))");
  db.exec("CREATE INDEX IF NOT EXISTS service_job_parts_job_idx ON service_job_parts(job_id,id)");
  db.exec(`CREATE TABLE IF NOT EXISTS online_orders (
    id INTEGER PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, date TEXT NOT NULL, customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL, shipping_address TEXT NOT NULL, city_area TEXT NOT NULL DEFAULT '',
    courier TEXT NOT NULL DEFAULT '', tracking_id TEXT NOT NULL DEFAULT '', delivery_charge REAL NOT NULL DEFAULT 0 CHECK(delivery_charge>=0),
    discount REAL NOT NULL DEFAULT 0 CHECK(discount>=0), subtotal REAL NOT NULL DEFAULT 0 CHECK(subtotal>=0),
    total REAL NOT NULL DEFAULT 0 CHECK(total>=0), advance_paid REAL NOT NULL DEFAULT 0 CHECK(advance_paid>=0),
    due_cod REAL NOT NULL DEFAULT 0 CHECK(due_cod>=0), payment_method TEXT NOT NULL DEFAULT 'Cash on Delivery',
    payment_status TEXT NOT NULL DEFAULT 'Pending', order_status TEXT NOT NULL DEFAULT 'Pending',
    notes TEXT NOT NULL DEFAULT '', lines TEXT NOT NULL DEFAULT '[]', stock_deducted INTEGER NOT NULL DEFAULT 0,
    bill_id INTEGER, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS online_orders_status_date_idx ON online_orders(order_status, date DESC);
  CREATE INDEX IF NOT EXISTS online_orders_phone_idx ON online_orders(customer_phone);`);
  db.exec(`CREATE TABLE IF NOT EXISTS medicine_batches (
    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, batch_number TEXT NOT NULL,
    expiry_date TEXT NOT NULL DEFAULT '', quantity_received REAL NOT NULL DEFAULT 0 CHECK(quantity_received>=0),
    quantity_remaining REAL NOT NULL DEFAULT 0 CHECK(quantity_remaining>=0), quantity_quarantined REAL NOT NULL DEFAULT 0 CHECK(quantity_quarantined>=0),
    unit_cost REAL NOT NULL DEFAULT 0 CHECK(unit_cost>=0), supplier_id INTEGER, purchase_id INTEGER,
    received_date TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX IF NOT EXISTS medicine_batch_product_number_idx ON medicine_batches(product_id,batch_number COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS medicine_batches_expiry_idx ON medicine_batches(expiry_date,product_id);
  CREATE TABLE IF NOT EXISTS medicine_batch_sales (
    sale_id INTEGER NOT NULL, batch_id INTEGER NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), PRIMARY KEY(sale_id,batch_id)
  );
  CREATE TABLE IF NOT EXISTS medicine_batch_returns (
    return_id INTEGER NOT NULL, batch_id INTEGER NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), PRIMARY KEY(return_id,batch_id)
  );
  CREATE TABLE IF NOT EXISTS medicine_details (
    product_id INTEGER PRIMARY KEY, generic_name TEXT NOT NULL DEFAULT '', strength TEXT NOT NULL DEFAULT '',
    dosage_form TEXT NOT NULL DEFAULT '', manufacturer TEXT NOT NULL DEFAULT ''
  );
  `);
  upgradeSalesReturnsSchema();
  ensure("purchase_lines", "batch_number", "TEXT NOT NULL DEFAULT ''");
  ensure("purchase_lines", "expiry_date", "TEXT NOT NULL DEFAULT ''");
  ensure("bills", "tax_amount", "REAL NOT NULL DEFAULT 0");
  ensure("bills", "tax_rate", "REAL NOT NULL DEFAULT 0");
  ensure("bills", "tax_mode", "TEXT NOT NULL DEFAULT 'none'");
  ensure("users", "email", "TEXT NOT NULL DEFAULT ''");
  ensure("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map(column => column.name));
  for (const column of ["can_team", "can_admins", "can_records", "can_settings", "can_supplier_purchases", "can_backups", "can_repair_records", "can_server_load", "can_online_orders", "can_delete_online_orders"]) ensure("users", column, "INTEGER NOT NULL DEFAULT 0");
  if (!userColumns.has("can_repair_records")) db.exec("UPDATE users SET can_repair_records=1 WHERE role='admin'");
  db.exec("UPDATE users SET role='admin',active=1,can_inventory=1,can_sales=1,can_expenses=1,can_team=1,can_admins=1,can_records=1,can_repair_records=1,can_settings=1,can_supplier_purchases=1,can_backups=1,can_server_load=1,can_online_orders=1,can_delete_online_orders=1 WHERE username='jahangir' COLLATE NOCASE");
  db.exec("CREATE TABLE IF NOT EXISTS recovery_codes (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.exec("CREATE TABLE IF NOT EXISTS email_verifications (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE IF NOT EXISTS email_recovery_codes (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, username TEXT NOT NULL, action TEXT NOT NULL)");
  ensure("settings", "language", "TEXT NOT NULL DEFAULT 'en'");
  ensure("settings", "bangla_digits", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS offsite_backup (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
    folder_name TEXT NOT NULL DEFAULT 'ShopDesk Backups', keep INTEGER NOT NULL DEFAULT 14, connection TEXT NOT NULL DEFAULT '',
    connected_email TEXT NOT NULL DEFAULT '', last_attempt_at TEXT NOT NULL DEFAULT '', last_success_at TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '', last_file TEXT NOT NULL DEFAULT '');
    INSERT OR IGNORE INTO offsite_backup(id) VALUES(1);`);
  // A backup from an older Shop Desk version may not contain Pharmacy tables.
  // Recreate compatible empty tables and preserve its existing product data.
  ensurePharmacyDetails();
}

const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2"
};

const metaValue = key => db.prepare("SELECT value FROM app_meta WHERE key=?").get(key)?.value || "";
const setMetaValue = (key, value) => db.prepare("INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
function connectInfo() {
  const settings = db.prepare("SELECT shop_name FROM settings WHERE id=1").get();
  const lanPort = typeof port === "number" ? port : 8765;
  const urls = [];
  if (publicBaseUrl) urls.push(publicBaseUrl);
  else if (typeof port === "number") {
    const found = [];
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal) found.push(`http://${entry.address}:${lanPort}`);
      }
    }
    found.sort((a, b) => (a.includes("192.168.") ? -1 : 0) - (b.includes("192.168.") ? -1 : 0));
    urls.push(...found);
    if (!found.length) urls.push(`http://localhost:${lanPort}`);
  }
  const unique = [...new Set(urls)];
  return { shopName: settings?.shop_name || "Shop Desk", urls: unique, primary: unique[0] || `http://localhost:${lanPort}`, port: lanPort };
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}
function htmlPage(title, message, ok = true) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Shop Desk</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f4f6;color:#1f2328;font:16px/1.6 system-ui,"Segoe UI",sans-serif}main{background:#fff;border:1px solid #dfe3e6;border-radius:14px;padding:32px;max-width:520px;margin:24px;box-shadow:0 18px 50px #1f23281a}h1{margin:0 0 10px;font-size:22px}p{color:#5b6670}a{display:inline-block;margin-top:10px;background:#1f6f5c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}</style></head><body><main><h1>${ok ? "&#10003;" : "&#9888;"} ${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="/#backup-tools">Return to Shop Desk</a></main></body></html>`;
}
const tokenHash = token => createHash("sha256").update(token).digest("hex");
const validText = value => typeof value === "string" && value.trim().length > 0 && value.length <= 500;
const validAmount = value => Number.isFinite(Number(value)) && Number(value) >= 0;
// On a hosted server you can set SHOP_SETUP_CODE (16+ characters) instead of reading the console. Remove it after the owner is created.
const envSetupCode = String(process.env.SHOP_SETUP_CODE || "").trim();
let setupToken = db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0 ? (envSetupCode.length >= 16 ? envSetupCode : randomBytes(24).toString("base64url")) : null;
const loginAttempts = new Map();
const recoveryAttempts = new Map();
const emailRecoverySendAttempts = new Map();
const emailVerificationSendTimes = new Map();

if (setupToken && envSetupCode.length >= 16) {
  console.log("\nFirst-time setup required. Use the setup code from your SHOP_SETUP_CODE environment variable. Remove that variable after the owner account is created.\n");
} else if (setupToken) {
  console.log("\nFirst-time setup required. Use this one-time setup code in the app:");
  console.log(`  ${setupToken}\nKeep this code private. It is valid only until the first admin is created or this server stops.\n`);
}
if (envSetupCode && envSetupCode.length < 16) console.log("SHOP_SETUP_CODE is ignored because it is shorter than 16 characters.");

const FRACTIONAL_UNIT = /^(kgs?|kilos?|kilograms?|gm?s?|grams?|l|ltrs?|lit(re|er)s?|ml|m|meters?|metres?|ft|feet|foot|yards?|yd|inch(es)?|cm|mm)$/i;
const validQty = (value, unit, min = 0, packed = false) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return false;
  if (packed) return Math.abs(n * 1e6 - Math.round(n * 1e6)) < 1e-4;
  return FRACTIONAL_UNIT.test(String(unit || "").trim()) ? Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6 : Number.isInteger(n);
};
const today = () => { const c = new Date(); return new Date(c.getTime() - c.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const addDaysToDate = (date, days) => {
  if (!date || !Number.isInteger(days) || days <= 0) return "";
  const result = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(result.getTime())) return "";
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};

const currentShopType = () => db.prepare("SELECT shop_type FROM settings WHERE id=1").get()?.shop_type || "general";
const pharmacyMode = () => currentShopType() === "pharmacy";

function ensurePharmacyBatches() {
  if (currentShopType() !== "pharmacy") return;
  // Never guess an expiry date. Legacy stock remains recorded but cannot be sold
  // until the supplier/owner verifies the date and corrects the legacy batch.
  const legacy = db.prepare(`SELECT p.id,p.name,p.qty,p.cost FROM products p
    WHERE p.qty>0 AND NOT EXISTS (SELECT 1 FROM medicine_batches b WHERE b.product_id=p.id)`).all();
  for (const product of legacy) {
    const qty = Number(product.qty || 0);
    if (qty <= 0) continue;
    db.prepare(`INSERT OR IGNORE INTO medicine_batches
      (product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,received_date,created_by)
      VALUES(?,?, '',?,?,0,?,?,?)`)
      .run(product.id,`LEGACY-${product.id}`,qty,qty,Number(product.cost||0),today(),"migration - expiry review required");
  }
}

function pharmacyAvailableQty(productId, asOf = today()) {
  const result = db.prepare(`SELECT COALESCE(SUM(MAX(0,quantity_remaining-quantity_quarantined)),0) AS qty
    FROM medicine_batches
    WHERE product_id=? AND expiry_date<>'' AND expiry_date>=? AND quantity_remaining>quantity_quarantined`).get(Number(productId),asOf);
  return Number(result?.qty || 0);
}

function allocatePharmacyBatchStock(productId, quantity, saleId) {
  let remaining = Number(quantity);
  const batches = db.prepare(`SELECT id,quantity_remaining,quantity_quarantined
    FROM medicine_batches
    WHERE product_id=? AND expiry_date<>'' AND expiry_date>=? AND quantity_remaining>quantity_quarantined
    ORDER BY expiry_date ASC,id ASC`).all(Number(productId),today());
  for (const batch of batches) {
    if (remaining <= 0.000001) break;
    const sellable = Math.max(0,Number(batch.quantity_remaining)-Number(batch.quantity_quarantined));
    const take = Math.min(sellable,remaining);
    if (take <= 0) continue;
    db.prepare("UPDATE medicine_batches SET quantity_remaining=quantity_remaining-? WHERE id=?").run(take,batch.id);
    db.prepare("INSERT INTO medicine_batch_sales(sale_id,batch_id,quantity) VALUES(?,?,?)").run(Number(saleId),batch.id,take);
    remaining = Math.max(0,Number((remaining-take).toFixed(6)));
  }
  if (remaining > 0.000001) throw httpError(409,"Available unexpired medicine stock changed. Refresh the bill and try again.");
}

function quarantinePharmacyReturn(saleId, quantity, returnId, product, actor) {
  let remaining = Number(quantity);
  const allocations = db.prepare("SELECT batch_id,quantity FROM medicine_batch_sales WHERE sale_id=? ORDER BY batch_id").all(Number(saleId));
  for (const allocation of allocations) {
    if (remaining <= 0.000001) break;
    const already = Number(db.prepare(`SELECT COALESCE(SUM(mbr.quantity),0) AS qty
      FROM medicine_batch_returns mbr JOIN sales_returns sr ON sr.id=mbr.return_id
      WHERE sr.sale_id=? AND mbr.batch_id=?`).get(Number(saleId),Number(allocation.batch_id)).qty || 0);
    const eligible = Math.max(0,Number(allocation.quantity)-already);
    const take = Math.min(eligible,remaining);
    if (take <= 0) continue;
    db.prepare("UPDATE medicine_batches SET quantity_remaining=quantity_remaining+?,quantity_quarantined=quantity_quarantined+? WHERE id=?").run(take,take,allocation.batch_id);
    db.prepare("INSERT INTO medicine_batch_returns(return_id,batch_id,quantity) VALUES(?,?,?)").run(Number(returnId),Number(allocation.batch_id),take);
    remaining = Math.max(0,Number((remaining-take).toFixed(6)));
  }
  if (remaining > 0.000001) {
    const batchNumber = `RETURN-${returnId}`;
    const created = db.prepare(`INSERT INTO medicine_batches
      (product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,received_date,created_by)
      VALUES(?,?, '',?,?,?, ?,?,?)`).run(product.id,batchNumber,remaining,remaining,remaining,Number(product.cost||0),today(),actor||"");
    db.prepare("INSERT INTO medicine_batch_returns(return_id,batch_id,quantity) VALUES(?,?,?)").run(Number(returnId),Number(created.lastInsertRowid),remaining);
  }
}

function ensurePharmacyDetails() {
  if (currentShopType() !== "pharmacy") return;
  db.prepare(`INSERT OR IGNORE INTO medicine_details(product_id) SELECT id FROM products`).run();
  ensurePharmacyBatches();
}
ensurePharmacyDetails();
function recordStockMovement(product, kind, quantityChange, quantityAfter, actor, reference = "", note = "", unitCost = product.cost || 0) {
  db.prepare(`INSERT INTO stock_movements(product_id,product_name,kind,quantity_change,quantity_after,unit,unit_cost,reference,note,actor)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(product.id || null, product.name, kind, quantityChange, quantityAfter, product.unit || "piece", unitCost, reference, note, actor || "");
}
const billById = id => {
  const bill = db.prepare("SELECT * FROM bills WHERE id=?").get(id);
  if (!bill) return null;
  const payments = db.prepare("SELECT date,amount,method FROM bill_payments WHERE bill_id=? ORDER BY id").all(id);
  const returns = db.prepare("SELECT COALESCE(SUM(total),0) AS amount, COALESCE(SUM(refund_amount),0) AS refunded FROM sales_returns WHERE bill_id=?").get(id);
  const saleRows = db.prepare("SELECT id FROM sales WHERE bill_id=? ORDER BY id").all(id);
  const saleReturns = new Map(db.prepare("SELECT sale_id,SUM(qty) qty,SUM(total) amount FROM sales_returns WHERE bill_id=? AND sale_id IS NOT NULL GROUP BY sale_id").all(id).map(row => [Number(row.sale_id), row]));
  const paid = payments.reduce((n, p) => n + p.amount, 0);
  const returned = Number(returns.amount || 0), refunded = Number(returns.refunded || 0);
  const netTotal = Math.max(0, Math.round((bill.total - returned) * 100) / 100);
  const lines = JSON.parse(bill.lines).map((line, index) => {
    const returnedLine = saleRows[index] ? saleReturns.get(Number(saleRows[index].id)) : null;
    return { ...line, returnedQty: Number(returnedLine?.qty || 0), returnedValue: Number(returnedLine?.amount || 0) };
  });
  return { ...bill, lines, payments, paid, returned, refunded, netTotal,
    due: Math.max(0, Math.round((netTotal - paid) * 100) / 100),
    customerCredit: Math.max(0, Math.round((paid - netTotal - refunded) * 100) / 100) };
};
const httpError = (status, message) => Object.assign(new Error(message), { status });
const duesSummary = () => {
  const due = "b.total - COALESCE((SELECT SUM(total) FROM sales_returns r WHERE r.bill_id=b.id),0) - COALESCE((SELECT SUM(amount) FROM bill_payments p WHERE p.bill_id=b.id),0)";
  const row = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(${due}),0) amount FROM bills b WHERE ${due} > 0.001`).get();
  return { count: row.n, amount: row.amount };
};
function syncSales(billId) {
  const bill = billById(billId);
  const label = bill.due <= 0.001 ? (bill.payments.at(-1)?.method || bill.payment) : bill.paid > 0 ? "Partial" : "Due";
  db.prepare("UPDATE sales SET payment=? WHERE bill_id=?").run(label, billId);
}
function restoreBillStock(id, actor = "") {
  for (const row of db.prepare("SELECT product_id, product, qty FROM sales WHERE bill_id=?").all(id)) if (row.product_id) {
    const product = db.prepare("SELECT id,name,qty,unit,cost FROM products WHERE id=?").get(row.product_id);
    if (product) {
      const after = Number((product.qty + row.qty).toFixed(6));
      db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, product.id);
      recordStockMovement(product, "bill reversal", row.qty, after, actor, "B-" + String(id).padStart(8, "0"), "Stock restored while correcting or deleting a bill.");
    }
  }
  db.prepare("DELETE FROM sales WHERE bill_id=?").run(id);
}
function removeBill(id, actor = "") {
  if (db.prepare("SELECT 1 FROM online_orders WHERE bill_id=? LIMIT 1").get(id)) throw httpError(409, "This bill is linked to an online order. Manage the order from Online Orders so stock and billing stay in sync.");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!billById(id)) throw httpError(404, "Bill not found.");
    if (db.prepare("SELECT 1 FROM sales_returns WHERE bill_id=? LIMIT 1").get(id)) throw httpError(409, "This bill has recorded returns and cannot be edited or deleted. Keep the return audit trail intact.");
    restoreBillStock(id, actor);
    db.prepare("DELETE FROM sold_devices WHERE bill_id=?").run(id);
    db.prepare("DELETE FROM bill_payments WHERE bill_id=?").run(id);
    db.prepare("DELETE FROM bills WHERE id=?").run(id);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function warrantyExpiry(date, months) {
  const value = new Date(`${date}T12:00:00`), day = value.getDate();
  value.setDate(1); value.setMonth(value.getMonth() + months);
  const lastDay = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate();
  value.setDate(Math.min(day, lastDay));
  return value.toISOString().slice(0, 10);
}
function productLabel(product) {
  const shopType = currentShopType();
  const pairs = shopType === "restaurant"
    ? [["Portion", product.size], ["Type", product.material], ["Prep", product.color], ["Kitchen", product.brand]]
    : shopType === "mobile"
      ? [["Brand", product.brand], ["Color", product.color], ["Storage", product.size]]
      : shopType === "hardware"
        ? [["Brand", product.brand], ["Spec", product.size]]
        : shopType === "grocery"
          ? [["Brand", product.brand], ["Pack", product.size]]
          : [["Brand", product.brand], ["Color", product.color], ["Size", product.size], ["Material", product.material]];
  const details = pairs.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  return details.length ? `${product.name} (${details.join(" · ")})` : product.name;
}
function saveBill(body, user, editId = 0) {
  const items = Array.isArray(body.items) ? body.items : [];
  const discount = Number(body.discount || 0);
  const settings = db.prepare("SELECT tax_rate,tax_mode,require_customer,allow_discounts,payment_methods,shop_type FROM settings WHERE id=1").get() || {};
  const allowedPayments = String(settings.payment_methods || "Cash,bKash,Nagad,Card,Due").split(",").map(value => value.trim()).filter(Boolean);
  if (editId && settings.shop_type === "pharmacy") throw httpError(409,"Pharmacy bills cannot be edited or deleted because the original medicine batches must remain traceable. Process a return and create a corrected bill instead.");
  const method = String(body.payment || "Cash").slice(0, 40);
  const customer = String(body.customer || "").trim().slice(0, 80), phone = String(body.phone || "").trim().slice(0, 30);
  if (!items.length) throw httpError(400, "Please add at least one product item to the bill.");
  if (items.length > 100) throw httpError(400, "A bill can contain at most 100 items.");
  if (!validText(method)) throw httpError(400, "Please specify a valid payment method.");
  if (!validAmount(discount)) throw httpError(400, "Discount must be a valid non-negative number.");
  if (!editId && allowedPayments.length && !allowedPayments.includes(method)) throw httpError(400, `Payment method "${method}" is not enabled. Choose from: ${allowedPayments.join(", ")}.`);
  if (settings.require_customer && !editId && !customer) throw httpError(400, "A customer name is required on every bill by your shop settings.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const old = editId ? billById(editId) : null;
    if (editId && db.prepare("SELECT 1 FROM online_orders WHERE bill_id=? LIMIT 1").get(editId)) throw httpError(409, "This bill is linked to an online order and cannot be edited here.");
    if (!settings.allow_discounts && discount > Number(old?.discount || 0)) throw httpError(400, "Discounts are disabled in your shop settings.");
    if (editId) { if (!old) throw httpError(404, "Bill not found."); restoreBillStock(editId, user.username); }
    const used = new Map(), lines = [];
    for (const item of items) {
      const id = Number(item.productId), qty = Number(item.qty), price = Number(item.price);
      const product = db.prepare("SELECT * FROM products WHERE id=?").get(id);
      if (!product) throw httpError(404, `Product ID #${id} was not found in inventory.`);
      if (!validQty(qty, product.unit, product.pack_size > 0 ? 0.000001 : 0.001, product.pack_size > 0)) throw httpError(400, `Enter a valid quantity for "${product.name}" in unit "${product.unit}".`);
      if (!validAmount(item.price)) throw httpError(400, `Enter a valid price for "${product.name}".`);
      used.set(id, (used.get(id) || 0) + qty);
      const availableStock = settings.shop_type === "pharmacy" ? pharmacyAvailableQty(id) : Number(product.qty);
      if (used.get(id) > availableStock + 0.000001) throw httpError(409, `Not enough ${settings.shop_type === "pharmacy" ? "unexpired, non-quarantined " : ""}stock for "${product.name}". Available: ${availableStock} ${product.unit || "piece"}, requested on bill: ${used.get(id)}.`);
      const serials = Array.isArray(item.serials) ? item.serials.map(value => String(value || "").trim()) : [];
      const warrantyMonths = Number(item.warrantyMonths || 0);
      const deviceTracked = settings.shop_type === "mobile" && /smartphone|feature phone|tablet|mobile phone/i.test(String(product.category || ""));
      if (!Number.isInteger(warrantyMonths) || warrantyMonths < 0 || warrantyMonths > 120 ||
          (deviceTracked && (!Number.isInteger(qty) || serials.length !== qty || serials.some(value => value.length < 4 || value.length > 60))) ||
          serials.some(value => value.length > 60)) throw httpError(400, `${product.name} needs one valid IMEI/serial for each whole device sold. Warranty must be 0 to 120 months.`);
      lines.push({ product, qty, price, serials, warrantyMonths });
    }
    const allSerials = lines.flatMap(line => line.serials).map(value => value.toLocaleUpperCase());
    if (new Set(allSerials).size !== allSerials.length) throw httpError(400, "The same IMEI/serial was entered more than once on this bill.");
    for (const serial of allSerials) {
      const existingDevice = db.prepare("SELECT bill_id FROM sold_devices WHERE serial=? COLLATE NOCASE AND status='Sold'").get(serial);
      if (existingDevice && Number(existingDevice.bill_id) !== Number(editId)) throw httpError(409, `IMEI/serial ${serial} is already registered to another sale.`);
    }
    const subtotal = lines.reduce((sum, line) => sum + Math.round(line.qty * line.price * 100) / 100, 0);
    if (discount > subtotal) throw httpError(400, `Discount (${discount}) cannot be more than the bill subtotal (${subtotal}).`);
    const taxMode = ["none", "inclusive", "exclusive"].includes(settings.tax_mode) ? settings.tax_mode : "none";
    const taxRate = taxMode === "none" ? 0 : Math.max(0, Math.min(100, Number(settings.tax_rate) || 0));
    const taxable = Math.max(0, subtotal - discount);
    const taxAmount = taxMode === "exclusive" ? Math.round(taxable * taxRate) / 100
      : taxMode === "inclusive" ? Math.round((taxable - taxable / (1 + taxRate / 100)) * 100) / 100 : 0;
    const total = taxMode === "exclusive" ? taxable + taxAmount : taxable;
    // Allow bill edits even if payments exceed new total (will show negative due/credit to customer)
    // if (old && total + 0.001 < old.paid) throw httpError(400, "Payments already received are more than the new total.");
    const raw = body.paid;
    const paidNow = editId ? 0 : (raw === undefined || raw === null || raw === "" ? total : Number(raw));
    if (!(paidNow >= 0) || paidNow > total + 0.001) throw httpError(400, `Paid amount (${paidNow}) cannot be more than the bill total (${total}).`);
    const date = old ? old.date : today();
    const snapshot = JSON.stringify(lines.map(({ product, qty, price, serials, warrantyMonths }) => ({ productId: product.id, name: productLabel(product), category: product.category, brand: product.brand || "", color: product.color || "", size: product.size || "", material: product.material || "", unit: product.unit, packName: product.pack_name, packSize: product.pack_size, qty, price, serials, warrantyMonths })));
    let billId = editId;
    if (editId) {
      db.prepare("UPDATE bills SET customer=?,phone=?,discount=?,total=?,lines=?,tax_amount=?,tax_rate=?,tax_mode=? WHERE id=?").run(customer, phone, discount, total, snapshot, taxAmount, taxRate, taxMode, editId);
      db.prepare("DELETE FROM sold_devices WHERE bill_id=?").run(editId);
      // Handle overpayment based on refund checkbox
      if (old && old.paid > total + 0.001) {
        const overpayment = Math.round((old.paid - total) * 100) / 100;
        if (!body.processRefund) {
          // Checkbox unchecked: Remove excess payment by adding negative adjustment
          // Delete all existing payments and recreate with the new total amount
          db.prepare("DELETE FROM bill_payments WHERE bill_id=?").run(billId);
          // Re-add payment matching the new total
          if (total > 0) {
            db.prepare("INSERT INTO bill_payments(bill_id,date,amount,method,received_by) VALUES(?,?,?,?,?)")
              .run(billId, old.date, total, old.payment || "Cash", user.username);
          }
        } else {
          // Checkbox checked: the overpayment stays owed to the customer and shows as REFUND DUE on the printed bill.
          // A lower refund amount means the rest is left as store credit.
          const refundAmount = Number(body.refundAmount);
          if (Number.isFinite(refundAmount) && refundAmount >= 0 && refundAmount < overpayment - 0.001) {
            const keep = Math.round((total + refundAmount) * 100) / 100;
            db.prepare("DELETE FROM bill_payments WHERE bill_id=?").run(billId);
            if (keep > 0) {
              db.prepare("INSERT INTO bill_payments(bill_id,date,amount,method,received_by) VALUES(?,?,?,?,?)")
                .run(billId, old.date, keep, old.payment || "Cash", user.username);
            }
          }
          // Otherwise keep the original payments; the full overpayment shows as refund due
        }
      }
    }
    else {
      billId = Number(db.prepare("INSERT INTO bills(date,customer,phone,payment,discount,total,cashier,lines,tax_amount,tax_rate,tax_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(date, customer, phone, paidNow > 0 ? method : "Due", discount, total, user.username, snapshot, taxAmount, taxRate, taxMode).lastInsertRowid);
      if (paidNow > 0) db.prepare("INSERT INTO bill_payments(bill_id,date,amount,method,received_by) VALUES(?,?,?,?,?)").run(billId, date, paidNow, method, user.username);
    }
    let left = discount, taxLeft = taxAmount;
    lines.forEach(({ product, qty, price, serials, warrantyMonths }, index) => {
      const gross = Math.round(qty * price * 100) / 100;
      const proportional = subtotal > 0 ? Math.round(discount * gross / subtotal * 100) / 100 : 0;
      const share = Math.min(gross, Math.max(0, index === lines.length - 1 ? left : Math.min(left, proportional)));
      left = Math.round((left - share) * 100) / 100;
      const proportionalTax = taxable > 0 ? Math.round(taxAmount * (gross - share) / taxable * 100) / 100 : 0;
      const lineTax = taxable > 0 ? Math.min(Math.max(0, gross - share), Math.max(0, index === lines.length - 1 ? taxLeft : Math.min(taxLeft, proportionalTax))) : 0;
      taxLeft = Math.round((taxLeft - lineTax) * 100) / 100;
      db.prepare("UPDATE products SET qty=MAX(0,ROUND(qty-?,6)) WHERE id=?").run(qty, product.id);
      const after = db.prepare("SELECT qty FROM products WHERE id=?").get(product.id).qty;
      recordStockMovement(product, "sale", -qty, after, user.username, "B-" + String(billId).padStart(8, "0"), "Sold on bill.");
      const saleId = Number(db.prepare("INSERT INTO sales(date,product,qty,total,payment,cost,unit,product_id,bill_id,tax_amount) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(date, productLabel(product), qty, gross - share - (taxMode === "inclusive" ? lineTax : 0), method, qty * product.cost, product.unit, product.id, billId, lineTax).lastInsertRowid);
      if (settings.shop_type === "pharmacy") allocatePharmacyBatchStock(product.id,qty,saleId);
      for (const serial of serials) {
        const expiry = warrantyMonths > 0 ? warrantyExpiry(date, warrantyMonths) : "";
        db.prepare("INSERT INTO sold_devices(serial,product_id,product_name,bill_id,sale_id,sold_date,warranty_months,warranty_expires,customer,phone) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(serial, product.id, product.name, billId, saleId, date, warrantyMonths, expiry, customer, phone);
      }
    });
    syncSales(billId);
    db.exec("COMMIT");
    return billId;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  response.end(JSON.stringify(value));
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => part.trim().split("=")).filter(pair => pair.length === 2));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Request must contain valid JSON.")); }
    });
    request.on("error", reject);
  });
}

function readBinary(request, maxBytes = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooLarge = false;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => tooLarge ? reject(httpError(413, "Backup file is too large (maximum 256 MB).")) : resolve(Buffer.concat(chunks, size)));
    request.on("error", reject);
  });
}

function currentUser(request) {
  const token = parseCookies(request.headers.cookie).sid;
  if (!token) return null;
  const hash = tokenHash(token);
  const session = db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.active=1`).get(hash, Date.now());
  if (!session) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash);
  return session || null;
}

function createSession(user, response) {
  const token = randomBytes(32).toString("base64url");
  const expiry = Date.now() + 12 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(tokenHash(token), user.id, expiry);
  response.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${isSecureRequest(response.req) ? "; Secure" : ""}`);
}

function publicUser(user) {
  return {
    id: user.id, username: user.username, role: user.role, active: Boolean(user.active),
    displayName: user.display_name || user.username,
    avatarData: user.avatar_data || null,
    email: user.email || "", emailVerified: Boolean(user.email_verified),
    permissions: { ...capsOf(user), users: can(user, "team") || can(user, "admins") }
  };
}

function passwordMatches(user, password) {
  const candidate = scryptSync(password, user?.salt || "unknown-user-salt", 64);
  const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
  return timingSafeEqual(candidate, expected);
}

function makePassword(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}
function makeRecoveryCode() { return randomBytes(24).toString("hex").toUpperCase(); }
function hashRecoveryCode(code) { return createHash("sha256").update(code).digest("hex"); }

async function sendGmail(to, subject, text) {
  const gmailUser = String(process.env.SHOP_GMAIL_USER || "").trim();
  const appPassword = String(process.env.SHOP_GMAIL_APP_PASSWORD || "").replace(/\s/g, "");
  if (!gmailUser || !appPassword) throw new Error("Gmail recovery is not configured on the shop server.");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(gmailUser) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new Error("A valid Gmail sender and recipient address are required.");
  const socket = tlsConnect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com" });
  socket.setTimeout(20000, () => socket.destroy(new Error("Gmail connection timed out.")));
  let smtpBuffer = "", smtpLines = "", smtpFailure = null;
  const smtpResponses = [], smtpWaiters = [];
  const deliverSmtpResponse = response => {
    const waiter = smtpWaiters.shift();
    if (waiter) waiter.resolve(response); else smtpResponses.push(response);
  };
  socket.on("data", chunk => {
    smtpBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = smtpBuffer.indexOf("\r\n")) >= 0) {
      const line = smtpBuffer.slice(0, newline);
      smtpBuffer = smtpBuffer.slice(newline + 2);
      smtpLines += (smtpLines ? "\n" : "") + line;
      if (/^\d{3} /.test(line)) {
        const lines = smtpLines.split("\n");
        deliverSmtpResponse({ code: line.slice(0, 3), lines });
        smtpLines = "";
      }
    }
  });
  socket.on("error", error => {
    smtpFailure = error;
    while (smtpWaiters.length) smtpWaiters.shift().reject(error);
  });
  const readResponse = () => {
    if (smtpResponses.length) return Promise.resolve(smtpResponses.shift());
    if (smtpFailure) return Promise.reject(smtpFailure);
    return new Promise((resolve, reject) => smtpWaiters.push({ resolve, reject }));
  };
  const expect = async (command, codes) => {
    const pending = readResponse();
    if (command !== null) socket.write(command + "\r\n");
    const response = await pending;
    if (!codes.includes(response.code)) throw new Error("Gmail rejected the email request.");
    return response;
  };
  try {
    await new Promise((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
    await expect(null, ["220"]);
    await expect("EHLO localhost", ["250"]);
    await expect("AUTH LOGIN", ["334"]);
    await expect(Buffer.from(gmailUser).toString("base64"), ["334"]);
    await expect(Buffer.from(appPassword).toString("base64"), ["235"]);
    await expect(`MAIL FROM:<${gmailUser}>`, ["250"]);
    await expect(`RCPT TO:<${to}>`, ["250", "251"]);
    await expect("DATA", ["354"]);
    const safeText = String(text).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const message = [`From: Shop Desk <${gmailUser}>`, `To: <${to}>`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", safeText, "."].join("\r\n");
    await expect(message, ["250"]);
    await expect("QUIT", ["221"]);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally { if (!socket.destroyed) socket.end(); }
}

function stateFor(user) {
  const settings = db.prepare("SELECT * FROM settings WHERE id=1").get();
  const inventory = can(user, "inventory");
  const salesPermission = can(user, "sales");
  const onlineOrdersPermission = can(user, "online_orders");
  const expensesPermission = can(user, "expenses");
  const supplierEditPermission = can(user, "supplier_purchases");
  return {
    shopName: settings?.shop_name || "Bolts & Boards",
    workspace: settings?.workspace || "Uttara, Dhaka",
    contactNumber: settings?.contact_number || "",
    website: settings?.website || "",
    email: settings?.email || "",
    facebookPage: settings?.facebook_page || "",
    whatsappNumber: settings?.whatsapp_number || "",
    contactAddress: settings?.contact_address || "",
    shopType: settings?.shop_type || "general",
    pharmacyBatches: inventory && settings?.shop_type === "pharmacy"
      ? db.prepare(`SELECT b.*,p.name AS product_name,p.unit AS product_unit,md.generic_name,md.strength,md.dosage_form,md.manufacturer,
          MAX(0,b.quantity_remaining-b.quantity_quarantined) AS sellable_quantity
        FROM medicine_batches b JOIN products p ON p.id=b.product_id LEFT JOIN medicine_details md ON md.product_id=p.id
        ORDER BY CASE WHEN b.expiry_date='' THEN 0 ELSE 1 END,b.expiry_date,p.name COLLATE NOCASE,b.id`).all()
      : [],
    currencyCode: settings?.currency_code || "BDT",
    locale: settings?.locale || "en-BD",
    language: settings ? (settings.language === "bn" ? "bn" : "en") : "bn",
    banglaDigits: settings ? Boolean(settings.bangla_digits) : true,
    taxRate: settings?.tax_rate || 0,
    taxMode: settings?.tax_mode || "none",
    requireCustomer: Boolean(settings?.require_customer),
    allowDiscounts: settings ? Boolean(settings.allow_discounts) : true,
    paymentMethods: String(settings?.payment_methods || "Cash,bKash,Nagad,Card,Due").split(",").map(value => value.trim()).filter(Boolean),
    permissions: publicUser(user).permissions,
    categories: db.prepare("SELECT id,name FROM categories ORDER BY CASE WHEN name='Other' THEN 1 ELSE 0 END, name COLLATE NOCASE").all(),
    products: (inventory || supplierEditPermission
      ? db.prepare(`SELECT p.*,md.generic_name,md.strength,md.dosage_form,md.manufacturer FROM products p LEFT JOIN medicine_details md ON md.product_id=p.id ORDER BY p.name`).all()
      : (salesPermission || onlineOrdersPermission)
        ? db.prepare(`SELECT p.id,p.name,p.sku,p.barcode,p.price,p.cost,p.qty,p.min,p.icon,p.unit,p.pack_name,p.pack_size,p.category,p.brand,p.color,p.size,p.material,
            md.generic_name,md.strength,md.dosage_form,md.manufacturer
          FROM products p LEFT JOIN medicine_details md ON md.product_id=p.id ORDER BY p.name`).all()
        : []).map(product => settings?.shop_type === "pharmacy" ? { ...product, available_to_sell: pharmacyAvailableQty(product.id) } : product),
    dues: salesPermission ? duesSummary() : null,
    sales: salesPermission ? db.prepare(`SELECT s.*,
      COALESCE(r.qty,0) AS returned_qty,
      COALESCE(r.amount,0) AS returned_amount,
      CASE WHEN s.qty>0 THEN MAX(0,s.qty-COALESCE(r.qty,0)) ELSE s.qty END AS original_remaining_qty
      FROM sales s LEFT JOIN (
        SELECT sale_id,SUM(qty) qty,SUM(total) amount FROM sales_returns WHERE sale_id IS NOT NULL GROUP BY sale_id
      ) r ON r.sale_id=s.id ORDER BY s.id DESC`).all().map(sale => {
        const fraction = sale.qty > 0 ? Math.min(1, Number(sale.returned_qty || 0) / sale.qty) : 0;
        return { ...sale, original_qty: sale.qty, original_total: sale.total, original_cost: sale.cost,
          original_tax_amount: sale.tax_amount, qty: Math.max(0, sale.qty - Number(sale.returned_qty || 0)),
          total: Math.max(0, sale.total * (1 - fraction)),
          cost: Math.max(0, sale.cost * (1 - fraction)),
          tax_amount: Math.max(0, Number(sale.tax_amount || 0) * (1 - fraction)) };
      }) : [],
    salesReturns: salesPermission ? db.prepare("SELECT * FROM sales_returns ORDER BY id DESC LIMIT 2000").all() : [],
    onlineOrderReturns: onlineOrdersPermission ? db.prepare("SELECT * FROM sales_returns WHERE online_order_id IS NOT NULL ORDER BY id DESC LIMIT 2000").all() : [],
    serviceJobs: salesPermission && settings?.shop_type === "mobile" ? db.prepare("SELECT * FROM service_jobs ORDER BY id DESC LIMIT 2000").all().map(job => {
      const payments = db.prepare("SELECT date,amount,method,received_by FROM service_job_payments WHERE job_id=? ORDER BY id").all(job.id);
      const parts = db.prepare("SELECT product_id,product_name,qty,unit,unit_cost FROM service_job_parts WHERE job_id=? ORDER BY id").all(job.id);
      const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
      const charge = job.status === "Delivered" ? Number(job.final_charge) : Number(job.estimate);
      return { ...job, job_no: "R-" + String(job.id).padStart(6, "0"), payments, parts, paid, due: Math.max(0, charge - paid) };
    }) : [],
    onlineOrderCustomers: onlineOrdersPermission ? db.prepare("SELECT name,phone,address,city_area FROM (SELECT customer_name AS name,customer_phone AS phone,shipping_address AS address,city_area FROM online_orders UNION SELECT customer AS name,phone,'' AS address,'' AS city_area FROM bills) WHERE LENGTH(TRIM(name))>0 ORDER BY name COLLATE NOCASE LIMIT 500").all() : [],
    onlineOrders: onlineOrdersPermission ? db.prepare("SELECT * FROM online_orders ORDER BY id DESC LIMIT 2000").all().map(order => ({
      ...order,
      lines: JSON.parse(order.lines || "[]")
    })) : [],
    devices: salesPermission && settings?.shop_type === "mobile" ? db.prepare("SELECT * FROM sold_devices ORDER BY sold_date DESC,id DESC LIMIT 5000").all() : [],
    expenses: expensesPermission ? db.prepare("SELECT * FROM expenses ORDER BY id DESC").all() : []
  };
}
const mobileServiceEnabled = () => db.prepare("SELECT shop_type FROM settings WHERE id=1").get()?.shop_type === "mobile";

// The owner is the "jahangir" account (or, if that does not exist, the first administrator) and always has every power. Everyone else has only what is granted to them.
const CAPS = ["inventory", "sales", "expenses", "server_load", "team", "admins", "records", "repair_records", "settings", "supplier_purchases", "backups", "online_orders", "delete_online_orders"];
const ownerId = () => (db.prepare("SELECT id FROM users WHERE username='jahangir' COLLATE NOCASE").get() || db.prepare("SELECT MIN(id) AS id FROM users WHERE role='admin'").get()).id;
const can = (user, permission) => permission === "repair_records"
  ? user.id === ownerId() || user.role === "admin" || Boolean(user.can_repair_records)
  : permission === "online_orders"
  ? !pharmacyMode() && (user.id === ownerId() || Boolean(user.can_online_orders))
  : permission === "delete_online_orders"
  ? user.id === ownerId() || Boolean(user.can_delete_online_orders)
  : permission === "server_load"
  ? user.id === ownerId() || user.role === "admin" || Boolean(user.can_server_load)
  : ["settings", "supplier_purchases"].includes(permission)
  ? (user.username.toLowerCase() === "jahangir" && user.role === "admin") || Boolean(user[`can_${permission}`])
  : user.id === ownerId() || Boolean(user[`can_${permission}`]);
const capsOf = account => Object.fromEntries(CAPS.map(cap => [cap, can(account, cap)]));
const manageable = (actor, target) => target.id !== ownerId() && target.id !== actor.id && can(actor, target.role === "admin" ? "admins" : "team");
// An account can hand out only powers it holds itself; staff cannot hold team or administrator powers.
const grantCaps = (actor, role, wanted, current = {}) => Object.fromEntries(CAPS.map(cap => {
  const protectedGrant = ["settings", "supplier_purchases"].includes(cap);
  const mayGrant = cap === "backups"
    ? actor.username.toLowerCase() === "jahangir" && actor.role === "admin" ? Boolean(wanted?.[cap]) : Boolean(current[cap])
    : cap === "server_load"
    ? actor.role === "admin" ? Boolean(wanted?.[cap]) : Boolean(current[cap])
    : ["repair_records", "online_orders", "delete_online_orders"].includes(cap)
    ? actor.role === "admin" ? Boolean(wanted?.[cap]) : Boolean(current[cap])
    : protectedGrant
    ? can(actor, cap) ? Boolean(wanted?.[cap]) : Boolean(current[cap])
    : Boolean(current[cap]) || can(actor, cap);
      return [cap, (role === "admin" || !["team", "admins", "backups"].includes(cap)) && Boolean(wanted?.[cap]) && mayGrant ? 1 : 0];
}));
function requirePermission(user, permission) {
  return can(user, permission);
}

function canManageCategories(user) {
  return can(user, "records") && requirePermission(user, "inventory");
}

function canManageSalesRecords(user) {
  return can(user, "records") && requirePermission(user, "sales");
}

function categoryId(name) {
  return db.prepare("SELECT id FROM categories WHERE name=? COLLATE NOCASE").get(name)?.id;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00`));
}

async function handleApi(request, response, url) {
  const route = url.pathname;
  const method = request.method;
  if (method !== "GET" && !originAllowed(request)) {
    return json(response, 403, { error: "Cross-origin requests are not allowed." });
  }
  if (route === "/api/connect" && method === "GET") return json(response, 200, connectInfo());
  if (route === "/api/connect/qr.svg" && method === "GET") {
    const info = connectInfo();
    const target = url.searchParams.get("url");
    const address = target && info.urls.includes(target) ? target : info.primary;
    const svg = qrSvg(address, { size: 260, title: `Open ${info.shopName} on this device` });
    response.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
    response.end(svg);
    return;
  }
  if (route === "/api/auth/status" && method === "GET") {
    const bootSettings = db.prepare("SELECT language FROM settings WHERE id=1").get();
    return json(response, 200, {
      setupRequired: db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0,
      emailRecoveryAvailable: Boolean(process.env.SHOP_GMAIL_USER && process.env.SHOP_GMAIL_APP_PASSWORD),
      language: bootSettings?.language === "en" ? "en" : "bn"
    });
  }
  if (route === "/api/setup" && method === "POST") {
    const body = await readJson(request);
    if (!setupToken || db.prepare("SELECT COUNT(*) AS count FROM users").get().count !== 0) return json(response, 403, { error: "Owner setup is already complete." });
    const supplied = Buffer.from(String(body.setupCode || ""));
    const expected = Buffer.from(setupToken);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(response, 403, { error: "Setup code is not valid." });
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(body.username || "") || typeof body.password !== "string" || body.password.length < 12) {
      return json(response, 400, { error: "Use a 3–32 character username and a password of at least 12 characters." });
    }
    const { salt, hash } = makePassword(body.password);
    const result = db.prepare("INSERT INTO users(username,salt,password_hash,role,can_inventory,can_sales,can_expenses,can_team,can_admins,can_records,can_repair_records,can_settings,can_supplier_purchases,can_backups) VALUES(?,?,?,'admin',1,1,1,1,1,1,1,1,1,1)").run(body.username, salt, hash);
    setupToken = null;
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(Number(result.lastInsertRowid));
    createSession(user, response);
    return json(response, 201, { user: publicUser(user) });
  }

  if (route === "/api/login" && method === "POST") {
    const ip = clientIp(request);
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5) return json(response, 429, { error: "Too many sign-in attempts. Try again in 10 minutes." });
    const body = await readJson(request);
    const user = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1").get(String(body.username || ""));
    if (!user || !passwordMatches(user, String(body.password || ""))) {
      const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 10 * 60 * 1000 };
      current.count++;
      loginAttempts.set(ip, current);
      return json(response, 401, { error: "Username or password is incorrect." });
    }
    loginAttempts.delete(ip);
    createSession(user, response);
    return json(response, 200, { user: publicUser(user) });
  }

  if (route === "/api/logout" && method === "POST") {
    const token = parseCookies(request.headers.cookie).sid;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
    return json(response, 200, { ok: true }, { "Set-Cookie": `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecureRequest(request) ? "; Secure" : ""}` });
  }

  if (route === "/api/recover-account" && method === "POST") {
    const ip = clientIp(request);
    const attempt = recoveryAttempts.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5) return json(response, 429, { error: "Too many recovery attempts. Try again in 10 minutes." });
    const body = await readJson(request);
    const username = String(body.username || "").trim();
    const suppliedCode = String(body.recoveryCode || "").replace(/[\s-]/g, "").toUpperCase();
    const account = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1").get(username);
    const savedCode = account && db.prepare("SELECT code_hash FROM recovery_codes WHERE user_id=?").get(account.id);
    const suppliedHash = hashRecoveryCode(suppliedCode);
    const expectedHash = Buffer.from(savedCode?.code_hash || "0".repeat(64), "hex");
    const actualHash = Buffer.from(suppliedHash, "hex");
    const emailCode = account && db.prepare("SELECT code_hash,expires_at,attempts FROM email_recovery_codes WHERE user_id=?").get(account.id);
    const expectedEmailHash = Buffer.from(emailCode?.code_hash || "0".repeat(64), "hex");
    const validOfflineCode = Boolean(savedCode && expectedHash.length === actualHash.length && timingSafeEqual(actualHash, expectedHash));
    const validEmailCode = Boolean(emailCode && emailCode.expires_at > Date.now() && emailCode.attempts < 5 && expectedEmailHash.length === actualHash.length && timingSafeEqual(actualHash, expectedEmailHash));
    const validCode = validOfflineCode || validEmailCode;
    if (!account || !validCode) {
      if (emailCode && emailCode.expires_at > Date.now() && emailCode.attempts < 5) db.prepare("UPDATE email_recovery_codes SET attempts=attempts+1 WHERE user_id=?").run(account.id);
      const current = attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 10 * 60 * 1000 };
      current.count++;
      recoveryAttempts.set(ip, current);
      return json(response, 401, { error: "Username or recovery code is incorrect, or recovery has not been set up." });
    }
    if (typeof body.password !== "string" || body.password.length < 12) return json(response, 400, { error: "New password must be at least 12 characters." });
    const replacementCode = makeRecoveryCode();
    const { salt, hash } = makePassword(body.password);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE users SET salt=?,password_hash=? WHERE id=?").run(salt, hash, account.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(account.id);
      db.prepare("INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,updated_at=CURRENT_TIMESTAMP").run(account.id, hashRecoveryCode(replacementCode));
      db.prepare("DELETE FROM email_recovery_codes WHERE user_id=?").run(account.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    recoveryAttempts.delete(ip);
    return json(response, 200, { ok: true, replacementRecoveryCode: replacementCode }, { "Set-Cookie": `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecureRequest(request) ? "; Secure" : ""}` });
  }

  if (route === "/api/email-recovery-request" && method === "POST") {
    const ip = clientIp(request);
    const sendLimit = emailRecoverySendAttempts.get(ip);
    if (sendLimit && sendLimit.until > Date.now() && sendLimit.count >= 3) return json(response, 429, { error: "Too many email code requests. Try again in 15 minutes." });
    const body = await readJson(request);
    const current = sendLimit && sendLimit.until > Date.now() ? sendLimit : { count: 0, until: Date.now() + 15 * 60 * 1000 };
    current.count++;
    emailRecoverySendAttempts.set(ip, current);
    const account = db.prepare("SELECT id,email FROM users WHERE username=? COLLATE NOCASE AND active=1 AND email_verified=1 AND email<>''").get(String(body.username || "").trim());
    if (account && process.env.SHOP_GMAIL_USER && process.env.SHOP_GMAIL_APP_PASSWORD) {
      const code = String(randomInt(0, 100000000)).padStart(8, "0");
      db.prepare("INSERT INTO email_recovery_codes(user_id,code_hash,expires_at,attempts) VALUES(?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0")
        .run(account.id, hashRecoveryCode(code), Date.now() + 10 * 60 * 1000);
      try { await sendGmail(account.email, "Shop Desk password reset code", `Your password reset code is ${code}.\n\nIt expires in 10 minutes and can only be used once. If you did not request this, ignore this email.`); }
      catch (error) {
        db.prepare("DELETE FROM email_recovery_codes WHERE user_id=?").run(account.id);
        console.error("Could not send account recovery email:", error.message);
      }
    }
    return json(response, 200, { ok: true, message: "If the account has a verified recovery email, a code will arrive shortly." });
  }

  if (route === "/api/backups/offsite/oauth/callback" && method === "GET") {
    const sendPage = (status, title, message, ok) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(htmlPage(title, message, ok));
    };
    const error = url.searchParams.get("error");
    if (error) return sendPage(400, "Google Drive was not connected", error === "access_denied" ? "You cancelled the Google permission screen. Nothing was changed." : `Google returned: ${error}`, false);
    const saved = String(metaValue("offsite_oauth_state") || "");
    const [savedState, expiresAt] = saved.split(":");
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    if (!state || !savedState || state !== savedState || Number(expiresAt) < Date.now()) {
      return sendPage(400, "This Google sign-in link has expired", "Start the connection again from Shop Desk → Backup and restore.", false);
    }
    setMetaValue("offsite_oauth_state", "");
    if (!code) return sendPage(400, "Google Drive was not connected", "Google did not return an authorisation code. Try again.", false);
    try {
      const tokens = await driveClient.exchangeCode(code);
      tokens.email = await driveClient.accountEmail(tokens);
      saveOffsiteTokens(tokens);
      db.prepare("UPDATE offsite_backup SET connected_email=?, last_error='' WHERE id=1").run(tokens.email || "");
      logSystem("Connected Google Drive for offsite backups");
      return sendPage(200, "Google Drive connected", `Offsite backups can now be uploaded${tokens.email ? ` to ${tokens.email}` : ""}. Return to the Backup and restore screen and run a backup now.`, true);
    } catch (exchangeError) {
      console.error("Google Drive connection failed:", exchangeError.message);
      db.prepare("UPDATE offsite_backup SET last_error=? WHERE id=1").run(String(exchangeError.message).slice(0, 500));
      return sendPage(400, "Google Drive could not be connected", exchangeError.message || "Try again from Shop Desk.", false);
    }
  }

  const user = currentUser(request);
  response.on("finish", () => { if (user && method !== "GET" && response.statusCode < 400) logActivity(user, method, route); });
  if (!user) return json(response, 401, { error: "Please sign in." });
  if (pharmacyMode() && route.startsWith("/api/online-orders") && method !== "GET") {
    return json(response,403,{error:"Online-order stock handling is not enabled for Pharmacy yet. Use New bill so all dispensed medicines are linked to their batch and expiry date."});
  }
  if (["/api/profile/email-verification", "/api/profile/email-verification/confirm", "/api/recovery-code"].includes(route) && user.role !== "admin" && user.id !== ownerId()) {
    return json(response, 403, { error: "Only Jahangir and administrators can set up or change account recovery options." });
  }
  if (route === "/api/auth/me" && method === "GET") return json(response, 200, { user: publicUser(user) });
  if (route === "/api/update-check" && method === "GET") {
    if (user.role !== "admin" && !can(user, "settings")) return json(response, 403, { error: "Shop settings access is required to check for updates." });
    const manifestUrl = String(process.env.SHOP_UPDATE_MANIFEST_URL || "").trim();
    if (!manifestUrl) return json(response, 200, { configured: false, current: appVersion });
    // HTTPS only. SHOP_UPDATE_ALLOW_HTTP=1 is for local testing with a loopback URL.
    const loopbackHttp = /^(1|true|yes)$/i.test(process.env.SHOP_UPDATE_ALLOW_HTTP || "") && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(manifestUrl);
    if (!/^https:\/\//i.test(manifestUrl) && !loopbackHttp) return json(response, 503, { configured: true, error: "SHOP_UPDATE_MANIFEST_URL must be an HTTPS address." });
    const fetchText = async address => {
      const reply = await fetch(address, { signal: AbortSignal.timeout(10000), headers: { "user-agent": `ShopDesk/${appVersion}` } });
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
      return reply.text();
    };
    try {
      const [manifestBytes, signature] = await Promise.all([fetchText(manifestUrl), fetchText(manifestUrl + ".sig")]);
      const parsed = parseManifest(Buffer.from(manifestBytes, "utf8"), signature);
      if (!parsed.valid) return json(response, 502, {
        configured: true,
        current: appVersion,
        error: "The update notice could not be verified. Ask your supplier for a correctly signed release.",
        code: parsed.problem
      });
      const latest = parsed.manifest;
      try { db.prepare("INSERT INTO activity_log(username,action) VALUES(?,?)").run(user.username, `Checked for updates (latest: ${latest.version})`); } catch { /* logging must never block the check */ }
      return json(response, 200, {
        configured: true,
        verified: true,
        current: appVersion,
        latest: latest.version,
        updateAvailable: compareVersions(latest.version, appVersion) > 0,
        released: latest.released,
        notes: latest.notes,
        url: latest.url,
        sha256: latest.sha256,
        size: latest.size
      });
    } catch (error) {
      return json(response, 502, { configured: true, current: appVersion, error: `Could not check for updates: ${error.message}` });
    }
  }
  if (route === "/api/system/status" && method === "GET") {
    if (!can(user, "server_load")) return json(response, 403, { error: "Server load access has not been granted to this account." });
    return json(response, 200, serverLoadStatus());
  }
  if (route === "/api/profile/email-verification" && method === "POST") {
    const body = await readJson(request);
    const email = String(body.email || "").trim().toLowerCase();
    if (!passwordMatches(user, String(body.currentPassword || ""))) return json(response, 403, { error: "Current password is incorrect." });
    if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return json(response, 400, { error: "Enter a valid email address." });
    if (!process.env.SHOP_GMAIL_USER || !process.env.SHOP_GMAIL_APP_PASSWORD) return json(response, 503, { error: "Gmail email recovery is not configured on the shop server yet." });
    const lastSent = emailVerificationSendTimes.get(user.id) || 0;
    if (Date.now() - lastSent < 60_000) return json(response, 429, { error: "Wait one minute before requesting another verification code." });
    const claimed = db.prepare("SELECT id FROM users WHERE email=? AND email_verified=1 AND id<>?").get(email, user.id);
    if (claimed) return json(response, 409, { error: "That email address is already verified on another account." });
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    db.prepare("INSERT INTO email_verifications(user_id,email,code_hash,expires_at,attempts) VALUES(?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0")
      .run(user.id, email, hashRecoveryCode(code), Date.now() + 10 * 60 * 1000);
    emailVerificationSendTimes.set(user.id, Date.now());
    try { await sendGmail(email, "Verify your Shop Desk recovery email", `Your email verification code is ${code}.\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`); }
    catch (error) {
      db.prepare("DELETE FROM email_verifications WHERE user_id=?").run(user.id);
      console.error("Could not send email verification:", error.message);
      return json(response, 502, { error: "Gmail could not send the verification email. Check the server Gmail configuration and try again." });
    }
    return json(response, 200, { ok: true, message: "Verification code sent. Check your inbox and spam folder." });
  }
  if (route === "/api/profile/email-verification/confirm" && method === "POST") {
    const body = await readJson(request);
    const verification = db.prepare("SELECT * FROM email_verifications WHERE user_id=?").get(user.id);
    const code = String(body.code || "").replace(/\s/g, "");
    if (!verification || verification.expires_at <= Date.now() || verification.attempts >= 5) return json(response, 400, { error: "The verification code has expired. Request a new one." });
    const candidate = Buffer.from(hashRecoveryCode(code), "hex");
    const expected = Buffer.from(verification.code_hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      db.prepare("UPDATE email_verifications SET attempts=attempts+1 WHERE user_id=?").run(user.id);
      return json(response, 400, { error: "Verification code is incorrect." });
    }
    const claimed = db.prepare("SELECT id FROM users WHERE email=? AND email_verified=1 AND id<>?").get(verification.email, user.id);
    if (claimed) { db.prepare("DELETE FROM email_verifications WHERE user_id=?").run(user.id); return json(response, 409, { error: "That email address is already verified on another account." }); }
    db.prepare("UPDATE users SET email=?,email_verified=1 WHERE id=?").run(verification.email, user.id);
    db.prepare("DELETE FROM email_verifications WHERE user_id=?").run(user.id);
    const refreshed = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    return json(response, 200, { ok: true, user: publicUser(refreshed) });
  }
  if (route === "/api/recovery-code" && method === "POST") {
    const body = await readJson(request);
    if (!passwordMatches(user, String(body.currentPassword || ""))) return json(response, 403, { error: "Current password is incorrect." });
    const code = makeRecoveryCode();
    db.prepare("INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,updated_at=CURRENT_TIMESTAMP").run(user.id, hashRecoveryCode(code));
    return json(response, 200, { recoveryCode: code });
  }
  if (route === "/api/state" && method === "GET") return json(response, 200, stateFor(user));
  if (route === "/api/profile" && method === "PATCH") {
    const body = await readJson(request);
    const displayName = String(body.displayName || "").trim();
    const avatarData = body.avatarData === null ? null : body.avatarData;
    if (!displayName || displayName.length > 40) return json(response, 400, { error: "Display name must be between 1 and 40 characters." });
    if (avatarData !== null && (typeof avatarData !== "string" || avatarData.length > 200_000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatarData))) {
      return json(response, 400, { error: "Choose a valid photo under 5 MB." });
    }
    db.prepare("UPDATE users SET display_name=?,avatar_data=? WHERE id=?").run(displayName, avatarData, user.id);
    return json(response, 200, { user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(user.id)) });
  }
  if (route === "/api/export" && method === "GET") {
    if (user.role !== "admin") return json(response, 403, { error: "Administrator access required." });
    const tables = ["settings", "products", "categories", "medicine_details", "medicine_batches", "medicine_batch_sales", "medicine_batch_returns", "sales", "sales_returns", "expenses", "bills", "bill_payments", "online_orders", "service_jobs", "service_job_payments", "service_job_parts", "sold_devices", "customers", "suppliers", "purchases", "purchase_lines", "supplier_payments", "stock_movements", "activity_log"];
    const backup = { format: "shop-desk-json-backup-v2", exportedAt: new Date().toISOString(), tables: {} };
    for (const table of tables) backup.tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    return json(response, 200, backup, { "Content-Disposition": "attachment; filename=shop-desk-backup.json" });
  }

  if (route === "/api/settings" && method === "PUT") {
    if (!can(user, "settings")) return json(response, 403, { error: "Shop settings access is required." });
    const body = await readJson(request);
    const validTypes = ["hardware", "grocery", "clothing", "pharmacy", "mobile", "restaurant", "general"];
    const validCurrencies = ["BDT", "USD", "EUR", "GBP", "INR", "PKR", "NPR", "LKR", "AUD", "CAD"];
    const validLocales = ["en-BD", "bn-BD", "en-US", "en-GB", "en-IN", "en-PK", "en-NP", "en-LK", "en-AU", "en-CA"];
    const methods = Array.isArray(body.paymentMethods) ? [...new Set(body.paymentMethods.map(value => String(value).trim()).filter(Boolean))] : [];
    const contactNumber = String(body.contactNumber || "").trim();
    const website = String(body.website || "").trim();
    const email = String(body.email || "").trim();
    const facebookPage = String(body.facebookPage || "").trim();
    const whatsappNumber = String(body.whatsappNumber || "").trim();
    const contactAddress = String(body.contactAddress || "").trim();
    const taxRate = Number(body.taxRate);
    const existingSettings = db.prepare("SELECT language, bangla_digits FROM settings WHERE id=1").get() || {};
    const language = body.language === undefined ? (existingSettings.language || "en") : (body.language === "bn" ? "bn" : "en");
    const banglaDigits = body.banglaDigits === undefined ? Boolean(existingSettings.bangla_digits) : Boolean(body.banglaDigits);
    if (!validText(body.shopName) || !validText(body.workspace) || !validTypes.includes(body.shopType) || !validCurrencies.includes(body.currencyCode) || !validLocales.includes(body.locale) ||
        !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100 || !["none", "inclusive", "exclusive"].includes(body.taxMode) || !methods.length || methods.length > 10 || methods.some(value => value.length > 40) || contactNumber.length > 60 || website.length > 250 || email.length > 254 || (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) || facebookPage.length > 250 || whatsappNumber.length > 60 || contactAddress.length > 300) {
      return json(response, 400, { error: "Check the shop type, currency, tax, and payment settings." });
    }
    db.prepare(`INSERT INTO settings(id,shop_name,workspace,shop_type,currency_code,locale,tax_rate,tax_mode,require_customer,allow_discounts,payment_methods,contact_number,website,email,facebook_page,whatsapp_number,contact_address,language,bangla_digits)
      VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET shop_name=excluded.shop_name,workspace=excluded.workspace,shop_type=excluded.shop_type,
      currency_code=excluded.currency_code,locale=excluded.locale,tax_rate=excluded.tax_rate,tax_mode=excluded.tax_mode,
      require_customer=excluded.require_customer,allow_discounts=excluded.allow_discounts,payment_methods=excluded.payment_methods,contact_number=excluded.contact_number,website=excluded.website,email=excluded.email,facebook_page=excluded.facebook_page,whatsapp_number=excluded.whatsapp_number,contact_address=excluded.contact_address,
      language=excluded.language,bangla_digits=excluded.bangla_digits`)
      .run(body.shopName.trim(), body.workspace.trim(), body.shopType, body.currencyCode, body.locale, taxRate, body.taxMode, body.requireCustomer ? 1 : 0, body.allowDiscounts ? 1 : 0, methods.join(","), contactNumber, website, email, facebookPage, whatsappNumber, contactAddress, language, banglaDigits ? 1 : 0);
    addProfileCategories(body.shopType);
    ensurePharmacyDetails();
    return json(response, 200, stateFor(user));
  }

  if (route === "/api/pharmacy/medex" && method === "GET") {
    if (!pharmacyMode()) return json(response, 403, { error: "Medicine info lookup is only available when the shop type is Pharmacy." });
    if (!requirePermission(user, "sales") && !requirePermission(user, "inventory")) {
      return json(response, 403, { error: "Sales or inventory access is required to check medicine information." });
    }
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 120);
    if (!query) return json(response, 200, { ok: true, query: "", searchUrl: buildMedexSearchUrl(""), results: [], message: "" });
    const customDbPath = process.env.SHOP_MEDEX_DB || join(dataDir, "medex.db");
    const payload = await fetchMedexSearch(query, { customDbPath });
    return json(response, 200, { ...payload, query });
  }
  if (route === "/api/pharmacy/medex/details" && method === "GET") {
    if (!pharmacyMode()) return json(response, 403, { error: "Medicine info lookup is only available when the shop type is Pharmacy." });
    if (!requirePermission(user, "sales") && !requirePermission(user, "inventory")) {
      return json(response, 403, { error: "Sales or inventory access is required to check medicine information." });
    }
    const targetUrl = normalizeMedexUrl(url.searchParams.get("url") || "");
    if (!targetUrl) return json(response, 400, { error: "Enter a valid MedEx medicine URL." });
    const customDbPath = process.env.SHOP_MEDEX_DB || join(dataDir, "medex.db");
    const payload = await fetchMedexDetails(targetUrl, { customDbPath });
    return json(response, 200, payload);
  }

  if (route === "/api/pharmacy/expiry" && method === "GET") {
    if (!pharmacyMode()) return json(response,403,{error:"Pharmacy inventory is only available when the shop type is Pharmacy."});
    if (!requirePermission(user,"inventory")) return json(response,403,{error:"Inventory access is required to view medicine expiry details."});
    const cutoff = addDaysToDate(today(),90);
    const batches = db.prepare(`SELECT b.*,p.name AS product_name,p.unit AS product_unit,
      MAX(0,b.quantity_remaining-b.quantity_quarantined) AS sellable_quantity
      FROM medicine_batches b JOIN products p ON p.id=b.product_id
      WHERE b.quantity_remaining>0 AND (b.expiry_date='' OR b.expiry_date<=?)
      ORDER BY CASE WHEN b.expiry_date='' THEN 0 ELSE 1 END,b.expiry_date,p.name COLLATE NOCASE`).all(cutoff);
    return json(response,200,{batches,today:today(),cutoff});
  }
  const pharmacyBatchesMatch = route.match(/^\/api\/pharmacy\/products\/(\d+)\/batches$/);
  if (pharmacyBatchesMatch && method === "GET") {
    if (!pharmacyMode()) return json(response,403,{error:"Pharmacy inventory is only available when the shop type is Pharmacy."});
    if (!requirePermission(user,"inventory")) return json(response,403,{error:"Inventory access is required to view medicine batches."});
    const productId = Number(pharmacyBatchesMatch[1]);
    const product = db.prepare("SELECT id,name,unit FROM products WHERE id=?").get(productId);
    if (!product) return json(response,404,{error:"Medicine not found."});
    const batches = db.prepare(`SELECT b.*,MAX(0,b.quantity_remaining-b.quantity_quarantined) AS sellable_quantity
      FROM medicine_batches b WHERE b.product_id=? ORDER BY CASE WHEN b.expiry_date='' THEN 0 ELSE 1 END,b.expiry_date,b.id`).all(productId);
    return json(response,200,{product,batches,today:today()});
  }
  if (route === "/api/pharmacy/batches" && method === "POST") {
    if (!pharmacyMode()) return json(response,403,{error:"Pharmacy inventory is only available when the shop type is Pharmacy."});
    if (!requirePermission(user,"inventory")) return json(response,403,{error:"Inventory access is required to receive medicine stock."});
    const body = await readJson(request), productId = Number(body.productId);
    const batchNumber = String(body.batchNumber || "").trim().slice(0,80), expiryDate = String(body.expiryDate || "").trim();
    const quantity = Number(body.quantity), unitCost = Number(body.unitCost);
    const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
    if (!product) return json(response,404,{error:"Medicine not found."});
    if (!validText(batchNumber) || !validDate(expiryDate) || !validQty(quantity,product.unit,0.001,Number(product.pack_size)>0) || !validAmount(unitCost)) {
      return json(response,400,{error:"Enter a batch number, valid expiry date, positive quantity, and non-negative unit cost."});
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT id,expiry_date FROM medicine_batches WHERE product_id=? AND batch_number=? COLLATE NOCASE").get(productId,batchNumber);
      if (existing && existing.expiry_date !== expiryDate) throw httpError(409,"That batch number already exists with a different expiry date.");
      if (existing) db.prepare("UPDATE medicine_batches SET quantity_received=quantity_received+?,quantity_remaining=quantity_remaining+?,unit_cost=? WHERE id=?").run(quantity,quantity,unitCost,existing.id);
      else db.prepare(`INSERT INTO medicine_batches(product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,received_date,created_by)
        VALUES(?,?,?,?,?,0,?,?,?)`).run(productId,batchNumber,expiryDate,quantity,quantity,unitCost,today(),user.username);
      const after = Number((Number(product.qty)+quantity).toFixed(6));
      const averageCost = after > 0 ? Math.round(((Number(product.qty)*Number(product.cost)+quantity*unitCost)/after)*100)/100 : unitCost;
      db.prepare("UPDATE products SET qty=?,cost=? WHERE id=?").run(after,averageCost,productId);
      recordStockMovement(product,"pharmacy batch receipt",quantity,after,user.username,batchNumber,`Batch ${batchNumber}; expires ${expiryDate}.`,unitCost);
      db.exec("COMMIT");
      return json(response,201,stateFor(user));
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} if (error.status) return json(response,error.status,{error:error.message}); if (String(error.message).includes("UNIQUE")) return json(response,409,{error:"That batch number already exists for this medicine."}); throw error; }
  }
  const pharmacyBatchMatch = route.match(/^\/api\/pharmacy\/batches\/(\d+)$/);
  if (pharmacyBatchMatch && method === "PATCH") {
    if (!pharmacyMode()) return json(response,403,{error:"Pharmacy inventory is only available when the shop type is Pharmacy."});
    if (!requirePermission(user,"inventory") || !can(user,"records")) return json(response,403,{error:"Inventory and edit-record access are required to correct batch details."});
    const id=Number(pharmacyBatchMatch[1]), body=await readJson(request), batchNumber=String(body.batchNumber||"").trim().slice(0,80), expiryDate=String(body.expiryDate||"").trim();
    const batch=db.prepare("SELECT * FROM medicine_batches WHERE id=?").get(id);
    if (!batch) return json(response,404,{error:"Medicine batch not found."});
    if (!validText(batchNumber) || !validDate(expiryDate)) return json(response,400,{error:"Enter a valid batch number and expiry date."});
    try { db.prepare("UPDATE medicine_batches SET batch_number=?,expiry_date=? WHERE id=?").run(batchNumber,expiryDate,id); }
    catch(error) { if(String(error.message).includes("UNIQUE")) return json(response,409,{error:"That batch number is already used for this medicine."}); throw error; }
    try { db.prepare("INSERT INTO activity_log(username,action) VALUES(?,?)").run(user.username,`Corrected medicine batch ${batchNumber} (batch ID ${id})`); } catch {}
    return json(response,200,stateFor(user));
  }
  if (route === "/api/categories" && method === "POST") {
    if (!canManageCategories(user)) return json(response, 403, { error: "Edit-record and inventory access are required to manage categories." });
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return json(response, 400, { error: "Category name must be 1 to 80 characters." });
    try {
      db.prepare("INSERT INTO categories(name) VALUES(?)").run(name);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return json(response, 409, { error: "That category already exists." });
      throw error;
    }
    return json(response, 201, stateFor(user));
  }
  const categoryMatch = route.match(/^\/api\/categories\/(\d+)$/);
  if (categoryMatch && method === "PATCH") {
    if (!canManageCategories(user)) return json(response, 403, { error: "Edit-record and inventory access are required to manage categories." });
    const body = await readJson(request);
    const id = Number(categoryMatch[1]);
    const category = db.prepare("SELECT name FROM categories WHERE id=?").get(id);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!category) return json(response, 404, { error: "Category not found." });
    if (category.name.toLowerCase() === "other") return json(response, 400, { error: "The Other category cannot be renamed." });
    if (!name || name.length > 80) return json(response, 400, { error: "Category name must be 1 to 80 characters." });
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE categories SET name=? WHERE id=?").run(name, id);
      db.prepare("UPDATE products SET category=? WHERE category=? COLLATE NOCASE").run(name, category.name);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (String(error.message).includes("UNIQUE")) return json(response, 409, { error: "That category already exists." });
      throw error;
    }
    return json(response, 200, stateFor(user));
  }
  if (categoryMatch && method === "DELETE") {
    if (!canManageCategories(user)) return json(response, 403, { error: "Edit-record and inventory access are required to manage categories." });
    const id = Number(categoryMatch[1]);
    const category = db.prepare("SELECT name FROM categories WHERE id=?").get(id);
    if (!category) return json(response, 404, { error: "Category not found." });
    if (category.name.toLowerCase() === "other") return json(response, 400, { error: "The Other category cannot be deleted." });
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE products SET category='Other' WHERE category=? COLLATE NOCASE").run(category.name);
      db.prepare("DELETE FROM categories WHERE id=?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(response, 200, stateFor(user));
  }

  if (route === "/api/products" && method === "POST") {
    if (!requirePermission(user, "inventory")) return json(response, 403, { error: "You do not have inventory permission." });
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const sku = String(body.sku || "—").trim().slice(0, 100);
    const unit = typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : "piece";
    const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : "Other";
    const barcode = String(body.barcode || "").trim().slice(0, 120);
    const price = Number(body.price);
    const cost = Number(body.cost);
    const qty = Number(body.qty);
    const min = Number(body.min);
    const packSize = Number(body.pack_size || 0), packName = String(body.pack_name || "").trim().slice(0, 20);
    const batchNumber = String(body.batchNumber || "").trim().slice(0,80), expiryDate = String(body.expiryDate || "").trim();
    const medicineDetails = {
      generic_name: String(body.genericName || "").trim().slice(0,160),
      strength: String(body.strength || "").trim().slice(0,80),
      dosage_form: String(body.dosageForm || "").trim().slice(0,80),
      manufacturer: String(body.manufacturer || "").trim().slice(0,160)
    };
    const pharmacy = pharmacyMode();
    if (pharmacy && qty > 0 && (!validText(batchNumber) || !validDate(expiryDate))) {
      return json(response,400,{error:"For opening stock, enter the medicine batch number and expiry date. You can receive more stock later from Batches & expiry."});
    }

    if (!name) return json(response, 400, { error: "Product name is required." });
    if (name.length > 200) return json(response, 400, { error: "Product name must be 200 characters or fewer." });
    if (!validAmount(price)) return json(response, 400, { error: "Selling price must be a valid non-negative number." });
    if (!validAmount(cost)) return json(response, 400, { error: "Cost price must be a valid non-negative number." });
    if (!categoryId(category)) return json(response, 400, { error: `Category "${category}" does not exist. Please pick or create a valid category.` });
    if (!validQty(qty, unit, 0, packSize > 0)) return json(response, 400, { error: `Quantity (${body.qty}) is not valid for unit "${unit}". Whole numbers required unless using fractional units (kg, liter, meter, etc.).` });
    if (!validQty(min, unit, 0, packSize > 0)) return json(response, 400, { error: `Low-stock alert (${body.min}) is not valid for unit "${unit}".` });
    if (unit.length > 30) return json(response, 400, { error: "Unit must be 30 characters or fewer." });
    if (!(packSize >= 0) || packSize > 1000000) return json(response, 400, { error: "Pack size must be between 0 and 1,000,000." });
    if (barcode && db.prepare("SELECT id, name FROM products WHERE barcode=? COLLATE NOCASE").get(barcode)) {
      const existing = db.prepare("SELECT name FROM products WHERE barcode=? COLLATE NOCASE").get(barcode);
      return json(response, 409, { error: `Barcode "${barcode}" is already assigned to "${existing.name}".` });
    }
    const clothingKeys = ["brand", "color", "size", "material"];
    const clothing = Object.fromEntries(clothingKeys.map(key => [key, String(body[key] || "").trim().slice(0, 60)]));
    db.exec("BEGIN IMMEDIATE");
    try {
      const created = db.prepare("INSERT INTO products(name,sku,price,cost,qty,min,icon,unit,category,pack_name,pack_size,barcode,brand,color,size,material) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(name, sku, price, cost, qty, min, String(body.icon || "📦").slice(0, 16), unit, category, packName, packSize, barcode, clothing.brand, clothing.color, clothing.size, clothing.material);
      const productId = Number(created.lastInsertRowid);
      if (pharmacy) {
        db.prepare("INSERT INTO medicine_details(product_id,generic_name,strength,dosage_form,manufacturer) VALUES(?,?,?,?,?)")
          .run(productId,medicineDetails.generic_name,medicineDetails.strength,medicineDetails.dosage_form,medicineDetails.manufacturer);
        if (Number(qty)>0) db.prepare(`INSERT INTO medicine_batches(product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,received_date,created_by)
          VALUES(?,?,?,?,?,0,?,?,?)`).run(productId,batchNumber,expiryDate,qty,qty,cost,today(),user.username);
      }
      if (Number(qty) > 0) recordStockMovement({ id: productId, name, unit, cost }, "opening stock", qty, qty, user.username, "New product", pharmacy ? `Batch ${batchNumber}; expires ${expiryDate}.` : "");
      db.exec("COMMIT");
      return json(response, 201, stateFor(user));
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (String(error.message).includes("UNIQUE")) return json(response,409,{error:"A batch with that number already exists for this medicine."});
      throw error;
    }
  }
  const productMatch = route.match(/^\/api\/products\/(\d+)$/);
  if (productMatch && method === "PATCH") {
    const canEditInventoryItem = can(user, "records") && requirePermission(user, "inventory");
    if (!canEditInventoryItem) return json(response, 403, { error: "You do not have permission to edit inventory items." });
    const body = await readJson(request);
    const product = db.prepare("SELECT id,name,sku,barcode,price,cost,qty,min,unit,category,pack_name,pack_size,brand,color,size,material FROM products WHERE id=?").get(Number(productMatch[1]));
    if (!product) return json(response, 404, { error: "Inventory item not found." });
    const name = typeof body.name === "string" ? body.name.trim() : product.name;
    const sku = typeof body.sku === "string" ? body.sku.trim() : product.sku;
    const barcode = typeof body.barcode === "string" ? body.barcode.trim() : product.barcode;
    const price = Object.hasOwn(body, "price") ? Number(body.price) : product.price;
    const cost = Object.hasOwn(body, "cost") ? Number(body.cost) : product.cost;
    const qty = Object.hasOwn(body, "qty") ? Number(body.qty) : product.qty;
    if (pharmacyMode() && Math.abs(qty-Number(product.qty))>0.000001) return json(response,409,{error:"Direct stock edits are disabled for Pharmacy so batch totals remain accurate. Use Batches & expiry or Record supplier purchase."});
    const min = Object.hasOwn(body, "min") ? Number(body.min) : product.min;
    const unit = typeof body.unit === "string" ? body.unit.trim() : product.unit;
    const packSize = Object.hasOwn(body, "pack_size") ? Number(body.pack_size || 0) : product.pack_size;
    const packName = typeof body.pack_name === "string" ? body.pack_name.trim().slice(0, 20) : product.pack_name;
    const clothingKeys = ["brand", "color", "size", "material"];
    const clothing = Object.fromEntries(clothingKeys.map(key => [key, typeof body[key] === "string" ? body[key].trim().slice(0, 60) : product[key]]));
    const category = typeof body.category === "string" ? body.category.trim() : product.category;

    if (!name) return json(response, 400, { error: "Product name is required." });
    if (name.length > 200) return json(response, 400, { error: "Product name must be 200 characters or fewer." });
    if (!validAmount(price)) return json(response, 400, { error: "Selling price must be a valid non-negative number." });
    if (!validAmount(cost)) return json(response, 400, { error: "Cost price must be a valid non-negative number." });
    if (!categoryId(category)) return json(response, 400, { error: `Category "${category}" does not exist.` });
    if (!validQty(qty, unit, 0, packSize > 0)) return json(response, 400, { error: `Quantity (${qty}) is not valid for unit "${unit}".` });
    if (!validQty(min, unit, 0, packSize > 0)) return json(response, 400, { error: `Low-stock alert (${min}) is not valid for unit "${unit}".` });
    if (!(packSize >= 0) || packSize > 1000000) return json(response, 400, { error: "Pack size is invalid." });
    if (barcode && db.prepare("SELECT id, name FROM products WHERE barcode=? COLLATE NOCASE AND id<>?").get(barcode, Number(productMatch[1]))) {
      const existing = db.prepare("SELECT name FROM products WHERE barcode=? COLLATE NOCASE AND id<>?").get(barcode, Number(productMatch[1]));
      return json(response, 409, { error: `Barcode "${barcode}" is already assigned to "${existing.name}".` });
    }
    const result = db.prepare("UPDATE products SET name=?,sku=?,barcode=?,price=?,cost=?,qty=?,min=?,unit=?,category=?,pack_name=?,pack_size=?,brand=?,color=?,size=?,material=? WHERE id=?")
      .run(name, sku, barcode, price, cost, qty, min, unit, category, packName, packSize, clothing.brand, clothing.color, clothing.size, clothing.material, Number(productMatch[1]));
    if (!result.changes) return json(response, 404, { error: "Inventory item not found." });
    if (pharmacyMode()) db.prepare("INSERT INTO medicine_details(product_id,generic_name,strength,dosage_form,manufacturer) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET generic_name=excluded.generic_name,strength=excluded.strength,dosage_form=excluded.dosage_form,manufacturer=excluded.manufacturer")
      .run(Number(productMatch[1]),String(body.genericName||"").trim().slice(0,160),String(body.strength||"").trim().slice(0,80),String(body.dosageForm||"").trim().slice(0,80),String(body.manufacturer||"").trim().slice(0,160));
    if (Math.abs(qty - product.qty) > 1e-6) recordStockMovement({ ...product, name, unit, cost }, "manual adjustment", qty - product.qty, qty, user.username, "Inventory edit", "Quantity set from item editor.");
    return json(response, 200, stateFor(user));
  }
  if (productMatch && method === "DELETE") {
    if (pharmacyMode() && db.prepare("SELECT 1 FROM medicine_batches WHERE product_id=? LIMIT 1").get(Number(productMatch[1]))) return json(response,409,{error:"This medicine has batch history. Keep the record for audit and set sellable stock to zero instead of deleting it."});
    if (!can(user, "records") || !requirePermission(user, "inventory")) {
      return json(response, 403, { error: "Edit-record and inventory access are required to delete inventory items." });
    }
    const product = db.prepare("SELECT * FROM products WHERE id=?").get(Number(productMatch[1]));
    if (!product) return json(response, 404, { error: "Inventory item not found." });
    if (product.qty > 0) recordStockMovement(product, "product removed", -product.qty, 0, user.username, "Inventory deletion", "Remaining stock removed from active inventory.");
    const result = db.prepare("DELETE FROM products WHERE id=?").run(Number(productMatch[1]));
    if (!result.changes) return json(response, 404, { error: "Inventory item not found." });
    return json(response, 200, stateFor(user));
  }
  if (route === "/api/inventory/bulk" && method === "POST") {
    if (user.role !== "admin" || !can(user, "records") || !requirePermission(user, "inventory")) {
      return json(response, 403, { error: "Administrator, edit-record, and inventory access are required for bulk inventory upload." });
    }
    const body = await readJson(request);
    if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 500) {
      return json(response, 400, { error: "Upload between 1 and 500 inventory rows." });
    }
    const isPharmacy = pharmacyMode();
    const seenIds = new Set();
    const rows = body.rows.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(`Row ${index + 2} is not a valid inventory item.`);
      }
      const id = item.id === "" || item.id === null || item.id === undefined ? null : Number(item.id);
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const sku = typeof item.sku === "string" ? item.sku.trim() : "";
      const barcode = item.barcode === null || item.barcode === undefined ? null : String(item.barcode).trim();
      const unit = typeof item.unit === "string" && item.unit.trim() ? item.unit.trim() : null;
      const category = typeof item.category === "string" && item.category.trim() ? item.category.trim().replace(/\s+/g, " ") : "Other";
      const apparel = Object.fromEntries(["brand", "color", "size", "material"].map(key => [key, item[key] === null || item[key] === undefined ? null : String(item[key]).trim()]));
      const packName = item.pack_name === null || item.pack_name === undefined ? null : String(item.pack_name).trim();
      const packSize = item.pack_size === null || item.pack_size === undefined || item.pack_size === "" ? null : Number(item.pack_size);
      const genericName = item.genericName === null || item.genericName === undefined ? null : String(item.genericName).trim();
      const strength = item.strength === null || item.strength === undefined ? null : String(item.strength).trim();
      const dosageForm = item.dosageForm === null || item.dosageForm === undefined ? null : String(item.dosageForm).trim();
      const manufacturer = item.manufacturer === null || item.manufacturer === undefined ? null : String(item.manufacturer).trim();
      const batchNumber = item.batchNumber === null || item.batchNumber === undefined ? "" : String(item.batchNumber).trim();
      const expiryDate = item.expiryDate === null || item.expiryDate === undefined ? "" : String(item.expiryDate).trim();
      const price = Number(item.price);
      const cost = Number(item.cost);
      const qty = Number(item.qty);
      const min = Number(item.min);
      const hasPack = (packSize || 0) > 0;
      if (item.price === "" || item.price === null || item.cost === "" || item.cost === null ||
          item.qty === "" || item.qty === null || item.min === "" || item.min === null ||
          (id !== null && (!Number.isInteger(id) || id < 1 || seenIds.has(id))) ||
          !name || name.length > 200 || sku.length > 100 || (barcode !== null && barcode.length > 120) || (unit !== null && unit.length > 30) || category.length > 80 ||
          !Number.isFinite(price) || price < 0 || !Number.isFinite(cost) || cost < 0 ||
          Object.values(apparel).some(value => value !== null && value.length > 60) ||
          (packName !== null && packName.length > 20) ||
          (packSize !== null && (!Number.isFinite(packSize) || packSize < 0 || packSize > 1000000)) ||
          (genericName !== null && genericName.length > 160) ||
          (strength !== null && strength.length > 80) ||
          (dosageForm !== null && dosageForm.length > 80) ||
          (manufacturer !== null && manufacturer.length > 160) ||
          batchNumber.length > 80 ||
          !validQty(qty, typeof unit === "string" ? unit : "", 0, hasPack) || !validQty(min, typeof unit === "string" ? unit : "", 0, hasPack)) {
        throw new Error(`Row ${index + 2} has invalid data. Check the name, SKU, prices, quantity, and low-stock alert.`);
      }
      if (isPharmacy && id === null && qty > 0 && (!validText(batchNumber) || !validDate(expiryDate))) {
        throw new Error(`Row ${index + 2} (${name}): new Pharmacy medicines with opening stock require a Batch Number and Expiry Date (YYYY-MM-DD).`);
      }
      if (id !== null) seenIds.add(id);
      return { id, name, sku, barcode, price, cost, qty, min, unit, category, ...apparel, packName, packSize, genericName, strength, dosageForm, manufacturer, batchNumber, expiryDate, rowNumber: index + 2 };
    });
    const incomingBarcodes = new Set();
    for (const item of rows) if (item.barcode) {
      const key = item.barcode.toLocaleLowerCase();
      if (incomingBarcodes.has(key)) throw new Error(`Barcode ${item.barcode} appears more than once in the upload.`);
      incomingBarcodes.add(key);
      const duplicate = db.prepare("SELECT id FROM products WHERE barcode=? COLLATE NOCASE AND id<>?").get(item.barcode, item.id || 0);
      if (duplicate) throw new Error(`Barcode ${item.barcode} is already assigned to another product.`);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const category of new Set(rows.map(item => item.category))) seedCategory(category);
      for (const item of rows) {
        if (item.id === null) {
          const created = db.prepare("INSERT INTO products(name,sku,price,cost,qty,min,icon,unit,category,barcode,brand,color,size,material,pack_name,pack_size) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(item.name, item.sku, item.price, item.cost, item.qty, item.min, "📦", item.unit || "piece", item.category, item.barcode || "", item.brand || "", item.color || "", item.size || "", item.material || "", item.packName || "", item.packSize || 0);
          const productId = Number(created.lastInsertRowid);
          if (isPharmacy || item.genericName !== null || item.strength !== null || item.dosageForm !== null || item.manufacturer !== null) {
            db.prepare("INSERT INTO medicine_details(product_id,generic_name,strength,dosage_form,manufacturer) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET generic_name=excluded.generic_name,strength=excluded.strength,dosage_form=excluded.dosage_form,manufacturer=excluded.manufacturer")
              .run(productId, item.genericName || "", item.strength || "", item.dosageForm || "", item.manufacturer || "");
          }
          if (isPharmacy && item.qty > 0) {
            db.prepare(`INSERT INTO medicine_batches(product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,received_date,created_by)
              VALUES(?,?,?,?,?,0,?,?,?)`).run(productId, item.batchNumber, item.expiryDate, item.qty, item.qty, item.cost, today(), user.username);
            recordStockMovement({ id: productId, name: item.name, unit: item.unit || "piece", cost: item.cost }, "opening stock", item.qty, item.qty, user.username, "Bulk inventory upload", `Batch ${item.batchNumber}; expires ${item.expiryDate}.`);
          } else if (item.qty > 0) {
            recordStockMovement({ id: productId, name: item.name, unit: item.unit || "piece", cost: item.cost }, "opening stock", item.qty, item.qty, user.username, "Bulk inventory upload");
          }
        } else {
          const before = db.prepare("SELECT id,name,qty,unit,cost FROM products WHERE id=?").get(item.id);
          if (!before) throw new Error(`Row for Product ID ${item.id} refers to an item that no longer exists. No changes were saved.`);
          const qtyDelta = Number((item.qty - before.qty).toFixed(6));
          if (isPharmacy && Math.abs(qtyDelta) > 1e-6) {
            if (qtyDelta < 0 || !validText(item.batchNumber) || !validDate(item.expiryDate)) {
              throw new Error(`Row ${item.rowNumber} (${item.name}): to add stock for an existing Pharmacy medicine via CSV, include a valid Batch Number and Expiry Date (YYYY-MM-DD). To reduce or adjust existing batches, use Batches & expiry.`);
            }
          }
          const result = db.prepare("UPDATE products SET name=?,sku=?,price=?,cost=?,qty=?,min=?,unit=COALESCE(?,unit),category=?,barcode=COALESCE(?,barcode),brand=COALESCE(?,brand),color=COALESCE(?,color),size=COALESCE(?,size),material=COALESCE(?,material),pack_name=COALESCE(?,pack_name),pack_size=COALESCE(?,pack_size) WHERE id=?")
            .run(item.name, item.sku, item.price, item.cost, item.qty, item.min, item.unit, item.category, item.barcode, item.brand, item.color, item.size, item.material, item.packName, item.packSize, item.id);
          if (!result.changes) throw new Error(`Row for Product ID ${item.id} refers to an item that no longer exists. No changes were saved.`);
          if (isPharmacy || item.genericName !== null || item.strength !== null || item.dosageForm !== null || item.manufacturer !== null) {
            const existingMed = db.prepare("SELECT generic_name,strength,dosage_form,manufacturer FROM medicine_details WHERE product_id=?").get(item.id);
            db.prepare("INSERT INTO medicine_details(product_id,generic_name,strength,dosage_form,manufacturer) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET generic_name=excluded.generic_name,strength=excluded.strength,dosage_form=excluded.dosage_form,manufacturer=excluded.manufacturer")
              .run(item.id, item.genericName ?? existingMed?.generic_name ?? "", item.strength ?? existingMed?.strength ?? "", item.dosageForm ?? existingMed?.dosage_form ?? "", item.manufacturer ?? existingMed?.manufacturer ?? "");
          }
          if (isPharmacy && qtyDelta > 1e-6) {
            const existingBatch = db.prepare("SELECT id,expiry_date FROM medicine_batches WHERE product_id=? AND batch_number=? COLLATE NOCASE").get(item.id, item.batchNumber);
            if (existingBatch && existingBatch.expiry_date !== item.expiryDate) {
              throw new Error(`Row ${item.rowNumber} (${item.name}): batch ${item.batchNumber} already exists with a different expiry date (${existingBatch.expiry_date}).`);
            }
            if (existingBatch) {
              db.prepare("UPDATE medicine_batches SET quantity_received=quantity_received+?,quantity_remaining=quantity_remaining+?,unit_cost=? WHERE id=?").run(qtyDelta, qtyDelta, item.cost, existingBatch.id);
            } else {
              db.prepare(`INSERT INTO medicine_batches(product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,received_date,created_by)
                VALUES(?,?,?,?,?,0,?,?,?)`).run(item.id, item.batchNumber, item.expiryDate, qtyDelta, qtyDelta, item.cost, today(), user.username);
            }
            recordStockMovement({ ...before, name: item.name, unit: item.unit || before.unit, cost: item.cost }, "pharmacy batch receipt", qtyDelta, item.qty, user.username, item.batchNumber, `Bulk CSV upload · Batch ${item.batchNumber}; expires ${item.expiryDate}.`, item.cost);
          } else if (Math.abs(qtyDelta) > 1e-6) {
            recordStockMovement({ ...before, name: item.name, unit: item.unit || before.unit, cost: item.cost }, "manual adjustment", qtyDelta, item.qty, user.username, "Bulk inventory upload", "Quantity set from CSV upload.");
          }
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(response, 200, stateFor(user));
  }

  if (route === "/api/suppliers" && method === "GET") {
    if (!requirePermission(user, "inventory") && !can(user, "supplier_purchases")) return json(response, 403, { error: "Supplier history access is required." });
    const suppliers = db.prepare(`SELECT s.*,
      ROUND(COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.supplier_id=s.id),0),2) AS total_bought,
      ROUND(COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id=s.id),0),2) AS total_paid,
      ROUND(s.opening_balance + COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.supplier_id=s.id),0) -
        COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id=s.id),0),2) AS balance
      FROM suppliers s WHERE s.active=1 ORDER BY s.name COLLATE NOCASE`).all();
    const payments = db.prepare(`SELECT sp.*,s.name AS supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id=sp.supplier_id ORDER BY sp.id DESC LIMIT 200`).all();
    return json(response, 200, { suppliers, payments });
  }
  if (route === "/api/suppliers" && method === "POST") {
    if (!requirePermission(user, "inventory")) return json(response, 403, { error: "You do not have inventory permission." });
    const body = await readJson(request), name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim(), address = String(body.address || "").trim();
    const opening = Number(body.openingBalance || 0);
    if (!name || name.length > 120 || phone.length > 40 || address.length > 300 || !validAmount(opening)) return json(response, 400, { error: "Enter a supplier name and valid contact details or opening balance." });
    if (db.prepare("SELECT id FROM suppliers WHERE name=? COLLATE NOCASE").get(name)) return json(response, 409, { error: "A supplier with that name already exists." });
    try { db.prepare("INSERT INTO suppliers(name,phone,address,opening_balance) VALUES(?,?,?,?)").run(name, phone, address, opening); }
    catch (error) { if (String(error.message).includes("UNIQUE")) return json(response, 409, { error: "A supplier with that name already exists." }); throw error; }
    return json(response, 201, { suppliers: db.prepare("SELECT * FROM suppliers WHERE active=1 ORDER BY name COLLATE NOCASE").all() });
  }
  const supplierEditMatch = route.match(/^\/api\/suppliers\/(\d+)$/);
  if (supplierEditMatch && method === "PATCH") {
    if (user.role !== "admin" || !can(user, "supplier_purchases")) return json(response, 403, { error: "Supplier purchase access is required to edit supplier records." });
    const body = await readJson(request), id = Number(supplierEditMatch[1]);
    const name = String(body.name || "").trim(), phone = String(body.phone || "").trim(), address = String(body.address || "").trim();
    const opening = Number(body.openingBalance);
    if (!db.prepare("SELECT id FROM suppliers WHERE id=? AND active=1").get(id)) return json(response, 404, { error: "Supplier not found." });
    if (!name || name.length > 120 || phone.length > 40 || address.length > 300 || !validAmount(opening)) return json(response, 400, { error: "Enter a supplier name and valid contact details or opening balance." });
    if (db.prepare("SELECT id FROM suppliers WHERE name=? COLLATE NOCASE AND id<>?").get(name, id)) return json(response, 409, { error: "A supplier with that name already exists." });
    db.prepare("UPDATE suppliers SET name=?,phone=?,address=?,opening_balance=? WHERE id=?").run(name, phone, address, opening, id);
    return json(response, 200, { ok: true });
  }
  if (route === "/api/purchases" && method === "GET") {
    if (!requirePermission(user, "inventory") && !can(user, "supplier_purchases")) return json(response, 403, { error: "Supplier history access is required." });
    const purchases = db.prepare(`SELECT p.id,p.supplier_id,p.date,p.total,p.reference,p.note,p.created_by,s.name AS supplier_name,
      (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id=p.id) AS line_count
      FROM purchases p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC`).all().map(p => ({
        ...p,
        items: db.prepare("SELECT product_id AS productId,product_name AS productName,qty,unit,unit_cost AS cost,batch_number AS batchNumber,expiry_date AS expiryDate FROM purchase_lines WHERE purchase_id=? ORDER BY id").all(p.id)
      }));
    const movements = can(user, "inventory")
      ? db.prepare("SELECT * FROM stock_movements ORDER BY id DESC LIMIT 300").all()
      : db.prepare("SELECT * FROM stock_movements WHERE kind LIKE '%purchase%' ORDER BY id DESC LIMIT 300").all();
    const payments = db.prepare("SELECT sp.*,s.name AS supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id=sp.supplier_id ORDER BY sp.id DESC").all();
    return json(response, 200, { purchases, movements, payments });
  }
  const purchaseEditMatch = route.match(/^\/api\/purchases\/(\d+)$/);
  if (purchaseEditMatch && method === "PATCH") {
    if (pharmacyMode()) {
      const body = await readJson(request);
      if (body.items !== undefined) return json(response,409,{error:"Editing Pharmacy purchase quantities is disabled to preserve batch history. Keep the original supplier receipt and make a new stock receipt or documented batch correction."});
      const date=String(body.date||""),reference=String(body.reference||"").trim(),note=String(body.note||"").trim(),id=Number(purchaseEditMatch[1]);
      if (!validDate(date) || reference.length>100 || note.length>500) return json(response,400,{error:"Enter a valid purchase date, reference, and note."});
      const purchase=db.prepare("SELECT id FROM purchases WHERE id=?").get(id);
      if (!purchase) return json(response,404,{error:"Purchase not found."});
      if (!can(user,"supplier_purchases")) return json(response,403,{error:"Supplier purchase edit access is required."});
      db.prepare("UPDATE purchases SET date=?,reference=?,note=? WHERE id=?").run(date,reference,note,id);
      return json(response,200,{ok:true});
    }
    if (!can(user, "supplier_purchases")) return json(response, 403, { error: "Supplier purchase edit access is required." });
    const body = await readJson(request), id = Number(purchaseEditMatch[1]);
    const date = String(body.date || ""), reference = String(body.reference || "").trim(), note = String(body.note || "").trim();
    const purchase = db.prepare("SELECT * FROM purchases WHERE id=?").get(id);
    if (!purchase) return json(response, 404, { error: "Purchase not found." });
    if (!validDate(date) || reference.length > 100 || note.length > 500) return json(response, 400, { error: "Enter a valid purchase date, reference, and note." });
    if (body.items === undefined) {
      db.prepare("UPDATE purchases SET date=?,reference=?,note=? WHERE id=?").run(date, reference, note, id);
      return json(response, 200, { ok: true });
    }
    const lines = Array.isArray(body.items) ? body.items : [];
    if (!lines.length || lines.length > 100) return json(response, 400, { error: "A purchase must contain between 1 and 100 items." });
    const oldLines = db.prepare("SELECT * FROM purchase_lines WHERE purchase_id=? ORDER BY id").all(id);
    if (oldLines.some(line => line.product_id === null)) return json(response, 409, { error: "This older purchase contains an item that cannot be matched to current inventory. Only its date, reference, and note can be edited." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const newLines = lines.map(line => {
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(Number(line.productId));
        const qty = Number(line.qty), cost = Number(line.cost);
        if (!product || !validQty(qty, product.unit, 0.001, product.pack_size > 0) || !validAmount(cost)) throw httpError(400, "A purchase item is invalid. Check its product, quantity, and cost.");
        return { product, qty, cost, lineTotal: Math.round(qty * cost * 100) / 100 };
      });
      const oldByProduct = new Map(), newByProduct = new Map();
      for (const line of oldLines) {
        const key = Number(line.product_id), item = oldByProduct.get(key) || { qty: 0, value: 0 };
        item.qty += Number(line.qty); item.value += Number(line.line_total); oldByProduct.set(key, item);
      }
      for (const line of newLines) {
        const key = line.product.id, item = newByProduct.get(key) || { qty: 0, value: 0 };
        item.qty += line.qty; item.value += line.lineTotal; newByProduct.set(key, item);
      }
      const ids = new Set([...oldByProduct.keys(), ...newByProduct.keys()]);
      for (const productId of ids) {
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
        if (!product) throw httpError(409, "A product in this purchase no longer exists in inventory.");
        const oldItem = oldByProduct.get(productId) || { qty: 0, value: 0 };
        const newItem = newByProduct.get(productId) || { qty: 0, value: 0 };
        const before = Number(product.qty), delta = Number((newItem.qty - oldItem.qty).toFixed(6));
        const after = Number((before + delta).toFixed(6));
        if (after < -0.000001) throw httpError(409, `Cannot reduce ${product.name} by that amount; current stock is only ${before} ${product.unit}.`);
        const costDelta = newItem.value - oldItem.value;
        let nextCost = Number(product.cost);
        if (after > 0 && before + 0.000001 >= oldItem.qty) {
          const remainingCostValue = before * Number(product.cost) - oldItem.value + newItem.value;
          if (remainingCostValue >= 0) nextCost = Number((remainingCostValue / after).toFixed(2));
        }
        db.prepare("UPDATE products SET qty=?,cost=? WHERE id=?").run(Math.max(0, after), nextCost, productId);
        if (Math.abs(delta) > 0.000001 || Math.abs(costDelta) > 0.001) {
          recordStockMovement(product, "purchase correction", delta, Math.max(0, after), user.username,
            "P-" + String(id).padStart(8, "0"), "Edited supplier purchase lines.", nextCost);
        }
      }
      db.prepare("DELETE FROM purchase_lines WHERE purchase_id=?").run(id);
      const total = Math.round(newLines.reduce((sum, line) => sum + line.lineTotal, 0) * 100) / 100;
      const otherBalance = db.prepare(`SELECT s.opening_balance +
        COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.supplier_id=s.id AND p.id<>?),0) -
        COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id=s.id),0) AS value
        FROM suppliers s WHERE s.id=?`).get(id, purchase.supplier_id).value;
      if (otherBalance + total < -0.001) throw httpError(409, "This purchase total cannot be reduced below payments already recorded for the supplier.");
      db.prepare("UPDATE purchases SET date=?,total=?,reference=?,note=? WHERE id=?").run(date, total, reference, note, id);
      for (const line of newLines) db.prepare("INSERT INTO purchase_lines(purchase_id,product_id,product_name,qty,unit,unit_cost,line_total) VALUES(?,?,?,?,?,?,?)")
        .run(id, line.product.id, line.product.name, line.qty, line.product.unit || "piece", line.cost, line.lineTotal);
      db.exec("COMMIT");
      return json(response, 200, { ok: true });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (error.status) return json(response, error.status, { error: error.message });
      throw error;
    }
  }
  if (route === "/api/purchases" && method === "POST") {
    if (!requirePermission(user, "inventory")) return json(response, 403, { error: "You do not have inventory permission." });
    const body = await readJson(request), supplierId = Number(body.supplierId), lines = Array.isArray(body.items) ? body.items : [];
    const date = body.date || today(), paid = Number(body.paid || 0), method = String(body.method || "Cash").trim().slice(0, 40);
    const pharmacyPurchase = pharmacyMode();
    const reference = String(body.reference || "").trim().slice(0, 100), note = String(body.note || "").trim().slice(0, 500);
    if (!Number.isInteger(supplierId) || !validDate(date) || !lines.length || lines.length > 100 || !validAmount(paid)) return json(response, 400, { error: "Purchase details are invalid." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const supplier = db.prepare("SELECT * FROM suppliers WHERE id=? AND active=1").get(supplierId);
      if (!supplier) throw httpError(404, "Choose an active supplier.");
      const items = lines.map(line => {
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(Number(line.productId));
        const qty = Number(line.qty), cost = Number(line.cost);
        const batchNumber = String(line.batchNumber||"").trim().slice(0,80), expiryDate = String(line.expiryDate||"").trim();
        if (!product || !validQty(qty, product.unit, 0.001, product.pack_size > 0) || !validAmount(cost)) throw httpError(400, "A purchase line is invalid. Check the product, quantity, and buying cost.");
        if (pharmacyPurchase && (!validText(batchNumber) || !validDate(expiryDate))) throw httpError(400,"Every Pharmacy purchase line needs a batch number and expiry date.");
        return { product, qty, cost, batchNumber, expiryDate, total: Math.round(qty * cost * 100) / 100 };
      });
      const total = Math.round(items.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
      if (paid > total + 0.001) throw httpError(400, "Payment cannot be more than this purchase total.");
      const id = Number(db.prepare("INSERT INTO purchases(supplier_id,date,total,reference,note,created_by) VALUES(?,?,?,?,?,?)")
        .run(supplierId, date, total, reference, note, user.username).lastInsertRowid);
      for (const item of items) {
        const { product, qty, cost } = item;
        const current = db.prepare("SELECT id,name,qty,unit,cost FROM products WHERE id=?").get(product.id);
        const before = Number(current.qty), after = Number((before + qty).toFixed(6));
        const averageCost = after > 0 ? Math.round(((before * Number(current.cost) + qty * cost) / after) * 100) / 100 : cost;
        db.prepare("UPDATE products SET qty=?,cost=? WHERE id=?").run(after, averageCost, current.id);
        db.prepare("INSERT INTO purchase_lines(purchase_id,product_id,product_name,qty,unit,unit_cost,line_total,batch_number,expiry_date) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(id, product.id, product.name, qty, product.unit || "piece", cost, item.total, pharmacyPurchase ? item.batchNumber : "", pharmacyPurchase ? item.expiryDate : "");
        if (pharmacyPurchase) {
          const existingBatch = db.prepare("SELECT id,expiry_date FROM medicine_batches WHERE product_id=? AND batch_number=? COLLATE NOCASE").get(product.id,item.batchNumber);
          if (existingBatch && existingBatch.expiry_date !== item.expiryDate) throw httpError(409,`Batch ${item.batchNumber} already exists for ${product.name} with a different expiry date.`);
          if (existingBatch) db.prepare("UPDATE medicine_batches SET quantity_received=quantity_received+?,quantity_remaining=quantity_remaining+?,unit_cost=?,supplier_id=?,purchase_id=? WHERE id=?").run(qty,qty,cost,supplierId,id,existingBatch.id);
          else db.prepare(`INSERT INTO medicine_batches(product_id,batch_number,expiry_date,quantity_received,quantity_remaining,quantity_quarantined,unit_cost,supplier_id,purchase_id,received_date,created_by)
            VALUES(?,?,?,?,?,0,?,?,?,?,?)`).run(product.id,item.batchNumber,item.expiryDate,qty,qty,cost,supplierId,id,date,user.username);
        }
        recordStockMovement(current, "purchase", qty, after, user.username, "P-" + String(id).padStart(8, "0"), pharmacyPurchase ? `Supplier: ${supplier.name}; batch ${item.batchNumber}; expiry ${item.expiryDate}` : `Supplier: ${supplier.name}`, cost);
      }
      if (paid > 0) db.prepare("INSERT INTO supplier_payments(supplier_id,date,amount,method,note,received_by) VALUES(?,?,?,?,?,?)")
        .run(supplierId, date, paid, method, `Payment on purchase P-${String(id).padStart(8, "0")}`, user.username);
      db.exec("COMMIT");
      return json(response, 201, { id, total });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (error.status) return json(response, error.status, { error: error.message });
      throw error;
    }
  }
  const supplierPaymentMatch = route.match(/^\/api\/suppliers\/(\d+)\/payments$/);
  if (supplierPaymentMatch && method === "POST") {
    if (!requirePermission(user, "inventory")) return json(response, 403, { error: "You do not have inventory permission." });
    const body = await readJson(request), supplierId = Number(supplierPaymentMatch[1]), amount = Number(body.amount);
    const date = body.date || today(), method = String(body.method || "Cash").trim().slice(0, 40), note = String(body.note || "").trim().slice(0, 500);
    if (!validDate(date) || !(amount > 0) || !Number.isFinite(amount)) return json(response, 400, { error: "Enter a valid payment date and amount." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const supplier = db.prepare("SELECT id,opening_balance FROM suppliers WHERE id=? AND active=1").get(supplierId);
      if (!supplier) throw httpError(404, "Supplier not found.");
      const balance = db.prepare(`SELECT ? + COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id=?),0) -
        COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id=?),0) AS value`).get(supplier.opening_balance, supplierId, supplierId).value;
      if (amount > balance + 0.001) throw httpError(400, "Payment cannot be more than the supplier's outstanding balance.");
      db.prepare("INSERT INTO supplier_payments(supplier_id,date,amount,method,note,received_by) VALUES(?,?,?,?,?,?)")
        .run(supplierId, date, amount, method, note, user.username);
      db.exec("COMMIT");
      return json(response, 201, { ok: true });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (error.status) return json(response, error.status, { error: error.message });
      throw error;
    }
  }
  const supplierPaymentEditMatch = route.match(/^\/api\/supplier-payments\/(\d+)$/);
  if (supplierPaymentEditMatch && method === "PATCH") {
    if (!can(user, "supplier_purchases")) return json(response, 403, { error: "Supplier purchase edit access is required." });
    const body = await readJson(request), id = Number(supplierPaymentEditMatch[1]);
    const payment = db.prepare("SELECT * FROM supplier_payments WHERE id=?").get(id);
    if (!payment) return json(response, 404, { error: "Supplier payment not found." });
    const date = String(body.date || ""), amount = Number(body.amount);
    const methodName = String(body.method || "").trim(), note = String(body.note || "").trim();
    if (!validDate(date) || !(amount > 0) || !Number.isFinite(amount) || methodName.length > 40 || note.length > 500) return json(response, 400, { error: "Enter a valid payment date, amount, method, and note." });
    const balanceWithoutPayment = db.prepare(`SELECT s.opening_balance +
      COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.supplier_id=s.id),0) -
      COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.supplier_id=s.id),0) + ? AS value
      FROM suppliers s WHERE s.id=?`).get(payment.amount, payment.supplier_id).value;
    if (amount > balanceWithoutPayment + 0.001) return json(response, 400, { error: "Payment cannot be more than the supplier's outstanding balance." });
    db.prepare("UPDATE supplier_payments SET date=?,amount=?,method=?,note=? WHERE id=?").run(date, amount, methodName || "Cash", note, id);
    return json(response, 200, { ok: true });
  }

  if (route === "/api/sales" && method === "POST") {
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    if (pharmacyMode()) return json(response,400,{error:"Use New bill for Pharmacy sales so unexpired batches are selected and recorded."});
    const body = await readJson(request);
    const quantity = Number(body.qty);
    const productId = Number(body.productId);
    const salePrice = Object.hasOwn(body, "price") ? Number(body.price) : null;
    const settings = db.prepare("SELECT tax_rate,tax_mode,require_customer,payment_methods,shop_type FROM settings WHERE id=1").get() || {};
    const allowedPayments = String(settings.payment_methods || "Cash,bKash,Nagad,Card,Due").split(",").map(value => value.trim()).filter(Boolean);
    if (settings.require_customer) return json(response, 400, { error: "This shop requires customer details on every sale. Please use 'New bill' instead." });
    if (settings.tax_mode && settings.tax_mode !== "none") return json(response, 400, { error: "Tax is enabled for this shop. Use 'New bill' so tax is calculated and shown on receipt." });
    if (/due|credit|unpaid/i.test(String(body.payment || ""))) return json(response, 400, { error: "Use 'New bill' to record a customer due balance or credit payment." });
    if (!Number.isInteger(productId) || productId <= 0) return json(response, 400, { error: "Please select a valid product from inventory." });
    if (!Number.isInteger(quantity) || quantity < 1) return json(response, 400, { error: "Please enter a valid whole number quantity of at least 1." });
    if (!validText(body.payment)) return json(response, 400, { error: "Please choose a payment method." });
    if (!allowedPayments.includes(String(body.payment))) return json(response, 400, { error: `Payment method "${body.payment}" is not enabled. Choose from: ${allowedPayments.join(", ")}.` });
    if (salePrice !== null && !validAmount(salePrice)) return json(response, 400, { error: "Sale price must be a valid non-negative amount per unit." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
      if (!product) {
        db.exec("ROLLBACK");
        return json(response, 404, { error: "Selected product was not found in inventory." });
      }
      if (quantity > product.qty) {
        db.exec("ROLLBACK");
        return json(response, 409, { error: `Not enough stock for "${product.name}". Available in stock: ${product.qty} ${product.unit || 'piece'}, Requested: ${quantity}.` });
      }
      if (settings.shop_type === "mobile" && /smartphone|feature phone|tablet|mobile phone/i.test(String(product.category || ""))) {
        db.exec("ROLLBACK");
        return json(response, 400, { error: "Use New bill for phones and tablets so their IMEI/serial and warranty are recorded." });
      }
      const unitSalePrice = salePrice === null ? product.price : salePrice;
      const taxMode = ["none", "inclusive", "exclusive"].includes(settings.tax_mode) ? settings.tax_mode : "none";
      const taxRate = taxMode === "none" ? 0 : Math.max(0, Math.min(100, Number(settings.tax_rate) || 0));
      const gross = quantity * unitSalePrice;
      const taxAmount = taxMode === "exclusive" ? Math.round(gross * taxRate) / 100 : taxMode === "inclusive" ? Math.round((gross - gross / (1 + taxRate / 100)) * 100) / 100 : 0;
      const revenue = taxMode === "inclusive" ? gross - taxAmount : gross;
      const clock = new Date();
      const date = new Date(clock.getTime() - clock.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      db.prepare("UPDATE products SET qty=qty-? WHERE id=?").run(quantity, productId);
      recordStockMovement(product, "sale", -quantity, product.qty - quantity, user.username, "Sale", "Single-item sale.");
      db.prepare("INSERT INTO sales(date,product,qty,total,payment,cost,unit,product_id,tax_amount) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(date, productLabel(product), quantity, taxMode === "exclusive" ? gross : revenue, String(body.payment).slice(0, 40), quantity * product.cost, product.unit, product.id, taxAmount);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(response, 201, stateFor(user));
  }
  if (route === "/api/service-jobs" && method === "POST") {
    if (!mobileServiceEnabled()) return json(response, 403, { error: "Repair jobs are available only for the Mobile phone sales & service shop profile." });
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const body = await readJson(request);
    const customer = String(body.customer || "").trim(), phone = String(body.phone || "").trim();
    const brand = String(body.brand || "").trim(), model = String(body.model || "").trim();
    const deviceSerial = String(body.deviceSerial || "").trim(), issue = String(body.issue || "").trim();
    const promisedDate = String(body.promisedDate || ""), estimate = Number(body.estimate), advance = Number(body.advance || 0);
    const notes = String(body.notes || "").trim(), method = String(body.method || "Cash").trim();
    const allowed = String(db.prepare("SELECT payment_methods FROM settings WHERE id=1").get()?.payment_methods || "Cash,bKash,Nagad,Card,Due").split(",").map(value => value.trim()).filter(value => value && !/due|credit|unpaid/i.test(value));
    if (!customer || customer.length > 120 || !phone || phone.length > 40 || !model || model.length > 120 || brand.length > 80 || deviceSerial.length > 120 ||
        !validText(issue) || issue.length > 500 || (promisedDate && !validDate(promisedDate)) || !validAmount(estimate) ||
        !Number.isFinite(advance) || advance < 0 || advance > estimate + 0.001 || notes.length > 500 ||
        (advance > 0 && !allowed.includes(method))) return json(response, 400, { error: "Repair intake details or advance payment are invalid. An advance cannot exceed the estimate." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const date = today();
      const result = db.prepare("INSERT INTO service_jobs(received_date,promised_date,customer,phone,brand,model,device_serial,issue,estimate,notes,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(date, promisedDate, customer, phone, brand, model, deviceSerial, issue, estimate, notes, user.username, user.username);
      if (advance > 0) db.prepare("INSERT INTO service_job_payments(job_id,date,amount,method,received_by) VALUES(?,?,?,?,?)").run(result.lastInsertRowid, date, advance, method, user.username);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return json(response, 201, stateFor(user));
  }
  const serviceJobMatch = route.match(/^\/api\/service-jobs\/(\d+)$/);
  if (serviceJobMatch && method === "PATCH") {
    if (!mobileServiceEnabled()) return json(response, 403, { error: "Repair jobs are available only for the Mobile phone sales & service shop profile." });
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const id = Number(serviceJobMatch[1]), body = await readJson(request), job = db.prepare("SELECT * FROM service_jobs WHERE id=?").get(id);
    if (!job) return json(response, 404, { error: "Repair job not found." });
    const repairAdministrator = user.role === "admin" || user.id === ownerId();
    if (job.status === "Delivered" && !can(user, "repair_records")) return json(response, 403, { error: "Only users with delivered repair access can change a completed repair job." });
    if (job.status === "Cancelled" && !repairAdministrator) return json(response, 403, { error: "Only an administrator can reopen a cancelled repair job." });
    if (job.status === "Delivered" && body.status !== undefined && body.status !== "Delivered" && !repairAdministrator) return json(response, 403, { error: "Only an administrator can reopen a delivered repair job." });
    const issue = body.issue === undefined ? job.issue : String(body.issue || "").trim();
    const diagnosis = body.diagnosis === undefined ? job.diagnosis : String(body.diagnosis || "").trim();
    const status = body.status === undefined ? job.status : String(body.status);
    const promisedDate = body.promisedDate === undefined ? job.promised_date : String(body.promisedDate || "");
    let partsUsed = body.partsUsed === undefined ? job.parts_used : String(body.partsUsed || "").trim();
    const estimate = body.estimate === undefined ? Number(job.estimate) : Number(body.estimate);
    const finalCharge = body.finalCharge === undefined ? Number(job.final_charge) : Number(body.finalCharge);
    let partsCost = body.partsCost === undefined ? Number(job.parts_cost) : Number(body.partsCost);
    const repairWarrantyDays = body.repairWarrantyDays === undefined ? Number(job.repair_warranty_days || 0) : Number(body.repairWarrantyDays);
    const notes = body.notes === undefined ? job.notes : String(body.notes || "").trim();
    const paymentAmount = Number(body.paymentAmount || 0), paymentMethod = String(body.paymentMethod || "Cash").trim();
    const statuses = ["Received", "Diagnosing", "Waiting for parts", "In repair", "Ready", "Delivered", "Cancelled"];
    const paymentMethods = String(db.prepare("SELECT payment_methods FROM settings WHERE id=1").get()?.payment_methods || "Cash,bKash,Nagad,Card,Due").split(",").map(value => value.trim()).filter(value => value && !/due|credit|unpaid/i.test(value));
    if (!validText(issue) || issue.length > 500 || diagnosis.length > 500 || partsUsed.length > 500 || notes.length > 500 ||
        !statuses.includes(status) || (promisedDate && !validDate(promisedDate)) || !validAmount(estimate) || !validAmount(finalCharge) || !validAmount(partsCost) ||
        !Number.isInteger(repairWarrantyDays) || repairWarrantyDays < 0 || repairWarrantyDays > 365 ||
        !Number.isFinite(paymentAmount) || paymentAmount < 0 || (paymentAmount > 0 && !paymentMethods.includes(paymentMethod))) return json(response, 400, { error: "Repair update details are invalid." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const oldParts = db.prepare("SELECT * FROM service_job_parts WHERE job_id=? ORDER BY id").all(id);
      const requestedParts = status === "Cancelled" ? [] : body.parts === undefined
        ? oldParts.map(part => ({ productId: part.product_id, qty: part.qty }))
        : body.parts;
      if (!Array.isArray(requestedParts) || requestedParts.length > 50) throw httpError(400, "Enter at most 50 valid repair parts.");
      for (const part of oldParts) {
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(part.product_id);
        if (!product) throw httpError(409, "Restore inventory item " + part.product_name + " before changing this job's parts.");
        const after = Number((product.qty + Number(part.qty)).toFixed(6));
        db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, product.id);
        recordStockMovement(product, "repair part reversal", part.qty, after, user.username, "R-" + String(id).padStart(6, "0"), "Restored while updating repair job parts.", part.unit_cost);
      }
      db.prepare("DELETE FROM service_job_parts WHERE job_id=?").run(id);
      const usedParts = new Map();
      partsCost = 0;
      const partLabels = [];
      for (const part of requestedParts) {
        const productId = Number(part.productId), qty = Number(part.qty), product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
        if (!product || !validQty(qty, product?.unit, 0.001, product?.pack_size > 0)) throw httpError(400, "A repair part or quantity is invalid.");
        usedParts.set(productId, (usedParts.get(productId) || 0) + qty);
        if (usedParts.get(productId) > product.qty + 0.000001) throw httpError(409, "Not enough stock for repair part " + product.name + ".");
        const after = Number((product.qty - qty).toFixed(6));
        db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, product.id);
        recordStockMovement(product, "repair part", -qty, after, user.username, "R-" + String(id).padStart(6, "0"), "Used for " + job.brand + " " + job.model + " repair.");
        db.prepare("INSERT INTO service_job_parts(job_id,product_id,product_name,qty,unit,unit_cost) VALUES(?,?,?,?,?,?)").run(id, product.id, product.name, qty, product.unit || "piece", product.cost);
        partsCost += qty * Number(product.cost || 0);
        partLabels.push(product.name + " × " + qty + " " + (product.unit || "piece"));
      }
      if (body.parts !== undefined || status === "Cancelled") partsUsed = partLabels.join(", ");
      const paidBefore = Number(db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM service_job_payments WHERE job_id=?").get(id).amount);
      if (status === "Cancelled" && paidBefore > 0) throw httpError(409, "A job with payments cannot be cancelled. Refund or settle its payment first.");
      const paidAfter = paidBefore + paymentAmount;
      const applicableCharge = status === "Delivered" ? finalCharge : estimate;
      const reopeningDelivered = repairAdministrator && job.status === "Delivered" && status !== "Delivered";
      if (paidAfter > applicableCharge + 0.001 && !(reopeningDelivered && paymentAmount === 0)) throw httpError(400, "Payments cannot be more than the current estimated or final charge. Increase the estimate before reopening this delivered job.");
      let saleId = job.sale_id;
      if (status === "Delivered" && !saleId) {
        const date = today(), itemName = ["Repair service", "R-" + String(id).padStart(6, "0"), [job.brand, job.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
        const paymentLabel = paidAfter <= 0 ? "Due" : paidAfter + 0.001 < finalCharge ? "Partial" : "Paid";
        const sale = db.prepare("INSERT INTO sales(date,product,qty,total,payment,cost,unit,service_job_id) VALUES(?,?,?,?,?,?,?,?)")
          .run(date, itemName, 1, finalCharge, paymentLabel, partsCost, "job", id);
        saleId = Number(sale.lastInsertRowid);
      } else if (saleId && status === "Delivered") {
        db.prepare("UPDATE sales SET total=?,cost=? WHERE id=? AND service_job_id=?").run(finalCharge, partsCost, saleId, id);
      } else if (saleId && reopeningDelivered) {
        db.prepare("DELETE FROM sales WHERE id=? AND service_job_id=?").run(saleId, id);
        saleId = null;
      }
      const deliveredDate = status === "Delivered" ? job.delivered_date || today() : job.delivered_date;
      const repairWarrantyExpires = status === "Delivered" ? addDaysToDate(deliveredDate, repairWarrantyDays) : "";
      db.prepare("UPDATE service_jobs SET issue=?,diagnosis=?,status=?,promised_date=?,parts_used=?,estimate=?,final_charge=?,parts_cost=?,repair_warranty_days=?,repair_warranty_expires=?,notes=?,delivered_date=?,sale_id=?,updated_by=? WHERE id=?")
        .run(issue, diagnosis, status, promisedDate, partsUsed, estimate, finalCharge, partsCost, repairWarrantyDays, repairWarrantyExpires, notes, deliveredDate, saleId, user.username, id);
      if (paymentAmount > 0) db.prepare("INSERT INTO service_job_payments(job_id,date,amount,method,received_by) VALUES(?,?,?,?,?)").run(id, today(), paymentAmount, paymentMethod, user.username);
      if (saleId && status === "Delivered") {
        const paidTotal = paidAfter;
        db.prepare("UPDATE sales SET payment=? WHERE id=?").run(paidTotal <= 0 ? "Due" : paidTotal + 0.001 < finalCharge ? "Partial" : "Paid", saleId);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); if (error.status) return json(response, error.status, { error: error.message }); throw error; }
    return json(response, 200, stateFor(user));
  }
  if (serviceJobMatch && method === "DELETE") {
    if (!mobileServiceEnabled()) return json(response, 403, { error: "Repair jobs are available only for the Mobile phone sales & service shop profile." });
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const id = Number(serviceJobMatch[1]), job = db.prepare("SELECT * FROM service_jobs WHERE id=?").get(id);
    if (!job) return json(response, 404, { error: "Repair job not found." });
    const repairAdministrator = user.role === "admin" || user.id === ownerId();
    const delegatedDeliveredAccess = job.status === "Delivered" && can(user, "repair_records");
    if (!repairAdministrator && !delegatedDeliveredAccess) return json(response, 403, { error: "Only Jahangir, an administrator, or a staff member granted delivered repair access can delete this job. Staff access applies only to delivered jobs." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const parts = db.prepare("SELECT * FROM service_job_parts WHERE job_id=? ORDER BY id").all(id);
      let restoredLines = 0;
      for (const part of parts) {
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(part.product_id);
        if (!product) continue;
        const after = Number((product.qty + Number(part.qty)).toFixed(6));
        db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, product.id);
        recordStockMovement(product, "repair job deletion reversal", part.qty, after, user.username, "R-" + String(id).padStart(6, "0"), "Stock restored when an authorized user deleted the repair job.", part.unit_cost);
        restoredLines++;
      }
      db.prepare("DELETE FROM sales WHERE service_job_id=?").run(id);
      db.prepare("DELETE FROM service_jobs WHERE id=?").run(id);
      db.prepare("INSERT INTO activity_log(username,action) VALUES(?,?)").run(user.username, `Deleted repair job R-${String(id).padStart(6, "0")} for ${job.customer}; removed its repair sale/payments and restored ${restoredLines} part line(s).`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return json(response, 200, stateFor(user));
  }
  const billPath = route.match(/^\/api\/bills\/(\d+)(\/payments)?$/);
  const billFail = error => { if (error.status) return json(response, error.status, { error: error.message }); throw error; };
  if (route === "/api/bills" && method === "POST") {
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    try { const id = saveBill(await readJson(request), user); return json(response, 201, { ...stateFor(user), bill: billById(id) }); } catch (error) { return billFail(error); }
  }
  if (billPath && !billPath[2] && (method === "PUT" || method === "DELETE")) {
    if (pharmacyMode()) return json(response,409,{error:"Pharmacy bills are read-only after saving to preserve medicine batch traceability. Process a return and create a corrected bill."});
    if (!requirePermission(user, "sales") || !can(user, "records")) return json(response, 403, { error: "You do not have permission to edit or delete bills." });
    const id = Number(billPath[1]);
    try {
      if (method === "PUT" && db.prepare("SELECT 1 FROM sales_returns WHERE bill_id=? LIMIT 1").get(id)) throw httpError(409, "This bill has recorded returns and cannot be edited. Keep the return audit trail intact.");
      if (method === "DELETE") { removeBill(id, user.username); return json(response, 200, stateFor(user)); }
      saveBill(await readJson(request), user, id);
      return json(response, 200, { ...stateFor(user), bill: billById(id) });
    } catch (error) { return billFail(error); }
  }
  if (billPath?.[2] && method === "POST") {
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const id = Number(billPath[1]), body = await readJson(request), amount = Number(body.amount), bill = billById(id);
    if (!bill) return json(response, 404, { error: "Bill not found." });
    if (!(amount > 0) || amount > bill.due + 0.001 || !validText(body.method)) return json(response, 400, { error: "Enter an amount up to the due balance." });
    db.prepare("INSERT INTO bill_payments(bill_id,date,amount,method,received_by) VALUES(?,?,?,?,?)").run(id, today(), amount, String(body.method).slice(0, 40), user.username);
    syncSales(id);
    return json(response, 200, { ...stateFor(user), bill: billById(id) });
  }
  if (route === "/api/bills" && method === "GET") { // GET /api/bills list
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const bills = db.prepare("SELECT id FROM bills ORDER BY id DESC LIMIT 2000").all().map(row => billById(row.id));
    return json(response, 200, { bills });
  }
  const billMatch = route.match(/^\/api\/bills\/(\d+)$/);
  if (billMatch && method === "GET") {
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const bill = billById(Number(billMatch[1]));
    return bill ? json(response, 200, bill) : json(response, 404, { error: "Bill not found." });
  }
  const returnMatch = route.match(/^\/api\/sales\/(\d+)\/returns$/);
  if (returnMatch && method === "POST") {
    if (!requirePermission(user, "sales") || !requirePermission(user, "inventory")) return json(response, 403, { error: "Sales and inventory access are required to process a return." });
    const body = await readJson(request), saleId = Number(returnMatch[1]);
    const qty = Number(body.qty), refundAmount = Number(body.refundAmount || 0);
    db.exec("BEGIN IMMEDIATE");
    try {
      const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(saleId);
      if (!sale) throw httpError(404, "Original sale not found.");
      if (sale.bill_id && db.prepare("SELECT 1 FROM online_orders WHERE bill_id=? LIMIT 1").get(sale.bill_id)) throw httpError(409, "This sale belongs to an Online Order. Process its return from Online Orders so the order status and return history stay in sync.");
      if (!sale.product_id) throw httpError(409, "This older sale is not linked to inventory, so its stock cannot be safely returned.");
      const product = db.prepare("SELECT * FROM products WHERE id=?").get(sale.product_id);
      if (!product) throw httpError(409, "The original inventory item no longer exists. Restore the item before processing this return.");
      if (!validQty(qty, sale.unit, 0.001) || qty <= 0) throw httpError(400, "Enter a valid return quantity.");
      const previous = db.prepare("SELECT COALESCE(SUM(qty),0) qty,COALESCE(SUM(total),0) amount,COALESCE(SUM(refund_amount),0) refunded FROM sales_returns WHERE sale_id=?").get(saleId);
      if (qty > sale.qty - Number(previous.qty) + 0.000001) throw httpError(409, `Only ${Math.max(0, sale.qty - Number(previous.qty))} ${sale.unit} remains eligible for return.`);
      const hasDeviceRecords = db.prepare("SELECT 1 FROM sold_devices WHERE sale_id=? LIMIT 1").get(saleId);
      const returnSerials = Array.isArray(body.serials) ? body.serials.map(value => String(value || "").trim()) : [];
      if (hasDeviceRecords) {
        const eligible = new Set(db.prepare("SELECT serial FROM sold_devices WHERE sale_id=? AND status='Sold'").all(saleId).map(device => device.serial.toLocaleUpperCase()));
        if (!Number.isInteger(qty) || returnSerials.length !== qty || returnSerials.some(serial => !eligible.has(serial.toLocaleUpperCase())) || new Set(returnSerials.map(serial => serial.toLocaleUpperCase())).size !== returnSerials.length) throw httpError(400, "Choose the exact IMEI/serial number for every device being returned.");
      } else if (returnSerials.length) throw httpError(400, "Those IMEI/serial numbers are not registered to this sale.");
      const returnedValue = Math.round((sale.total + Number(sale.tax_amount || 0)) / sale.qty * qty * 100) / 100;
      let maxRefund = returnedValue;
      if (sale.bill_id) {
        const bill = billById(sale.bill_id);
        const afterReturnNet = Math.max(0, bill.total - bill.returned - returnedValue);
        maxRefund = Math.max(0, Math.min(returnedValue, bill.paid - afterReturnNet - bill.refunded));
      } else {
        maxRefund = Math.max(0, returnedValue - Number(previous.refunded));
      }
      if (!validAmount(refundAmount) || refundAmount > maxRefund + 0.001) throw httpError(400, `Refund cannot exceed ${maxRefund.toFixed(2)}. The returned amount first reduces any outstanding bill balance.`);
      const reason = String(body.reason || "").trim().slice(0, 300);
      const refundMethod = refundAmount > 0 ? String(body.refundMethod || "").trim().slice(0, 40) : "";
      if (refundAmount > 0 && !validText(refundMethod)) throw httpError(400, "Choose a refund method.");
      const after = Number((product.qty + qty).toFixed(6));
      const returnRecord = db.prepare(`INSERT INTO sales_returns(date,product,qty,total,payment,cost,unit,product_id,reason,sale_id,bill_id,refund_amount,refund_method,actor)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(today(), sale.product, qty, returnedValue, refundAmount > 0 ? refundMethod : "Credit adjustment", sale.qty > 0 ? sale.cost / sale.qty * qty : 0, sale.unit || "piece", product.id, reason, sale.id, sale.bill_id, refundAmount, refundMethod, user.username);
      db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, product.id);
      if (pharmacyMode()) quarantinePharmacyReturn(sale.id,qty,Number(returnRecord.lastInsertRowid),product,user.username);
      recordStockMovement(product, "sales return", qty, after, user.username, sale.bill_id ? "B-" + String(sale.bill_id).padStart(8, "0") : "Sale #" + sale.id, reason || (pharmacyMode() ? "Customer return quarantined from resale." : "Customer return."), sale.qty > 0 ? sale.cost / sale.qty : product.cost);
      for (const serial of returnSerials) db.prepare("UPDATE sold_devices SET status='Returned' WHERE sale_id=? AND serial=? COLLATE NOCASE AND status='Sold'").run(saleId, serial);
      if (sale.bill_id) syncSales(sale.bill_id);
      db.exec("COMMIT");
      return json(response, 201, stateFor(user));
    } catch (error) { db.exec("ROLLBACK"); if (error.status) return json(response, error.status, { error: error.message }); throw error; }
  }
  const saleMatch = route.match(/^\/api\/sales\/(\d+)$/);
  if (saleMatch && method === "PATCH") {
    if (pharmacyMode()) return json(response,409,{error:"Pharmacy sales cannot be edited directly because that would break the medicine-batch audit trail. Process a return and create a corrected bill."});
    if (!canManageSalesRecords(user)) return json(response, 403, { error: "Sales and edit-record access are required to edit sales records." });
    const body = await readJson(request);
    db.exec("BEGIN IMMEDIATE");
    try {
      const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(Number(saleMatch[1]));
      if (!sale) {
        db.exec("ROLLBACK");
        return json(response, 404, { error: "Sales record not found." });
      }
      if (sale.bill_id && db.prepare("SELECT 1 FROM online_orders WHERE bill_id=? LIMIT 1").get(sale.bill_id)) {
        db.exec("ROLLBACK");
        throw httpError(409, "This sale belongs to an online order bill and cannot be edited directly.");
      }
      if (sale.bill_id && db.prepare("SELECT 1 FROM online_orders WHERE bill_id=? LIMIT 1").get(sale.bill_id)) {
        db.exec("ROLLBACK");
        return json(response, 409, { error: "This sale belongs to an online order bill and cannot be deleted directly." });
      }
      if (sale.service_job_id) {
        db.exec("ROLLBACK");
        return json(response, 409, { error: "Repair service sales are managed from the Repairs screen so their job and payment records stay in sync." });
      }
      if (db.prepare("SELECT 1 FROM sales_returns WHERE sale_id=? LIMIT 1").get(sale.id)) {
        db.exec("ROLLBACK");
        return json(response, 409, { error: "This sale has recorded returns and cannot be edited. Keep the return audit trail intact." });
      }
      const date = body.date === undefined ? sale.date : body.date;
      const payment = body.payment === undefined ? sale.payment : body.payment;
      const quantity = body.qty === undefined ? sale.qty : Number(body.qty);
      const unitPrice = body.price === undefined ? sale.total / sale.qty : Number(body.price);
      const targetId = body.productId === undefined ? sale.product_id : Number(body.productId);
      if (!validDate(date) || !validText(payment) || !Number.isInteger(quantity) || quantity < 1 ||
          !validAmount(unitPrice)) {
        db.exec("ROLLBACK");
        return json(response, 400, { error: "Enter a valid date, payment method, whole-number quantity, and sale price." });
      }

      if (sale.product_id === null || sale.product_id === undefined) {
        if (body.productId !== undefined || (body.qty !== undefined && quantity !== sale.qty)) {
          db.exec("ROLLBACK");
          return json(response, 409, { error: "This older sale is not linked to one inventory item. Its item and quantity cannot be changed safely." });
        }
        db.prepare("UPDATE sales SET date=?,total=?,payment=? WHERE id=?")
          .run(date, quantity * unitPrice, String(payment).slice(0, 40), sale.id);
      } else {
        if (!Number.isInteger(targetId) || targetId < 1) {
          db.exec("ROLLBACK");
          return json(response, 400, { error: "Choose an inventory item for this sale." });
        }
        const target = db.prepare("SELECT * FROM products WHERE id=?").get(targetId);
        if (!target) {
          db.exec("ROLLBACK");
          return json(response, 409, { error: "The selected inventory item no longer exists. Choose an active item." });
        }
        const oldProduct = db.prepare("SELECT * FROM products WHERE id=?").get(sale.product_id);
        let unitCost;
        if (targetId === sale.product_id) {
          const availableAfterReturn = target.qty + sale.qty;
          if (quantity > availableAfterReturn) {
            db.exec("ROLLBACK");
            return json(response, 409, { error: `Only ${availableAfterReturn} ${target.unit} would be available for this corrected sale.` });
          }
          db.prepare("UPDATE products SET qty=? WHERE id=?").run(availableAfterReturn - quantity, targetId);
          const after = availableAfterReturn - quantity;
          if (Math.abs(sale.qty - quantity) > 1e-6) recordStockMovement(target, "sale correction", sale.qty - quantity, after, user.username, "Sale #" + sale.id, "Quantity changed while correcting a sale.");
          unitCost = sale.cost / sale.qty;
        } else {
          if (quantity > target.qty) {
            db.exec("ROLLBACK");
            return json(response, 409, { error: `Only ${target.qty} ${target.unit} currently remain in the selected item.` });
          }
          if (oldProduct) {
            const afterReturn = Number((oldProduct.qty + sale.qty).toFixed(6));
            db.prepare("UPDATE products SET qty=? WHERE id=?").run(afterReturn, oldProduct.id);
            recordStockMovement(oldProduct, "sale correction reversal", sale.qty, afterReturn, user.username, "Sale #" + sale.id, "Original stock restored while changing the sold item.");
          }
          db.prepare("UPDATE products SET qty=qty-? WHERE id=?").run(quantity, targetId);
          recordStockMovement(target, "sale correction", -quantity, target.qty - quantity, user.username, "Sale #" + sale.id, "Corrected sale moved to this item.");
          unitCost = target.cost;
        }
        db.prepare("UPDATE sales SET date=?,product=?,qty=?,total=?,payment=?,cost=?,unit=?,product_id=? WHERE id=?")
          .run(date, target.name, quantity, quantity * unitPrice, String(payment).slice(0, 40), quantity * unitCost, target.unit, target.id, sale.id);
      }
      // Update bill snapshot so changes reflect on printed invoices
      if (sale.bill_id) {
        const billSales = db.prepare("SELECT product, qty, unit, (total / qty) as price, product_id FROM sales WHERE bill_id = ? AND is_return = 0").all(sale.bill_id);
        const billSnapshot = JSON.stringify(billSales.map(s => ({
          productId: s.product_id,
          name: s.product,
          qty: s.qty,
          price: s.price,
          unit: s.unit
        })));
        db.prepare("UPDATE bills SET lines = ? WHERE id = ?").run(billSnapshot, sale.bill_id);
      }
      db.exec("COMMIT");
      return json(response, 200, stateFor(user));
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
  if (saleMatch && method === "DELETE") {
    if (pharmacyMode()) return json(response,409,{error:"Pharmacy sales cannot be deleted directly because that would break the medicine-batch audit trail."});
    if (!canManageSalesRecords(user)) return json(response, 403, { error: "Sales and edit-record access are required to delete sales records." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(Number(saleMatch[1]));
      if (!sale) {
        db.exec("ROLLBACK");
        return json(response, 404, { error: "Sales record not found." });
      }
      if (sale.service_job_id) {
        db.exec("ROLLBACK");
        return json(response, 409, { error: "Repair service sales are managed from the Repairs screen so their job and payment records stay in sync." });
      }
      if (db.prepare("SELECT 1 FROM sales_returns WHERE sale_id=? LIMIT 1").get(sale.id)) {
        db.exec("ROLLBACK");
        return json(response, 409, { error: "This sale has recorded returns and cannot be deleted. Keep the return audit trail intact." });
      }
      let product = sale.product_id ? db.prepare("SELECT * FROM products WHERE id=?").get(sale.product_id) : null;
      if (!sale.product_id) {
        const matches = db.prepare("SELECT * FROM products WHERE name=? COLLATE NOCASE").all(sale.product);
        if (matches.length === 1) product = matches[0];
        else {
          db.exec("ROLLBACK");
          return json(response, 409, { error: "This older sale cannot be matched safely to inventory, so it was not deleted and stock was left unchanged." });
        }
      }
      // A linked item may already have been removed from inventory. In that case
      // preserve the historical behavior and delete the sale without recreating it.
      if (product) {
        const after = Number((product.qty + sale.qty).toFixed(6));
        db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, product.id);
        recordStockMovement(product, "sale reversal", sale.qty, after, user.username, "Sale #" + sale.id, "Stock restored when deleting a sale.");
      }
      db.prepare("DELETE FROM sales WHERE id=?").run(sale.id);
      db.exec("COMMIT");
      return json(response, 200, stateFor(user));
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  const onlineOrderMatch = route.match(/^\/api\/online-orders(?:\/(\d+))?$/);
  if (route === "/api/online-orders" && method === "GET") {
    if (!requirePermission(user, "online_orders")) return json(response, 403, { error: "You do not have online orders permission." });
    const orders = db.prepare("SELECT * FROM online_orders ORDER BY id DESC LIMIT 2000").all().map(order => ({
      ...order,
      lines: JSON.parse(order.lines || "[]")
    }));
    return json(response, 200, { orders });
  }
  if (onlineOrderMatch && onlineOrderMatch[1] && method === "GET") {
    if (!requirePermission(user, "online_orders")) return json(response, 403, { error: "You do not have online orders permission." });
    const order = db.prepare("SELECT * FROM online_orders WHERE id=?").get(Number(onlineOrderMatch[1]));
    if (!order) return json(response, 404, { error: "Online order not found." });
    return json(response, 200, { ...order, lines: JSON.parse(order.lines || "[]") });
  }
  if (route === "/api/online-orders" && method === "POST") {
    if (!requirePermission(user, "online_orders")) return json(response, 403, { error: "You do not have online orders permission." });
    const body = await readJson(request);
    const customerName = String(body.customerName || "").trim();
    const customerPhone = String(body.customerPhone || "").trim();
    const shippingAddress = String(body.shippingAddress || "").trim();
    const cityArea = String(body.cityArea || "").trim();
    const courier = String(body.courier || "").trim();
    const trackingId = String(body.trackingId || "").trim();
    const deliveryCharge = Number(body.deliveryCharge || 0);
    const discount = Number(body.discount || 0);
    const advancePaid = Number(body.advancePaid || 0);
    const paymentMethod = String(body.paymentMethod || "Cash on Delivery").trim();
    const orderStatus = String(body.orderStatus || "Pending").trim();
    const notes = String(body.notes || "").trim();
    const items = Array.isArray(body.items) ? body.items : [];

    const validStatuses = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled", "Returned"];
    if (!validStatuses.includes(orderStatus)) return json(response, 400, { error: "Order status is invalid. Choose from: " + validStatuses.join(", ") });
    if (!customerName) return json(response, 400, { error: "Customer name is required." });
    if (customerName.length > 120) return json(response, 400, { error: "Customer name must be 120 characters or fewer." });
    if (!customerPhone) return json(response, 400, { error: "Customer phone number is required." });
    if (customerPhone.length > 40) return json(response, 400, { error: "Customer phone must be 40 characters or fewer." });
    if (!shippingAddress) return json(response, 400, { error: "Shipping address is required." });
    if (shippingAddress.length > 500) return json(response, 400, { error: "Shipping address must be 500 characters or fewer." });
    if (!validAmount(deliveryCharge)) return json(response, 400, { error: "Delivery charge must be a valid non-negative number." });
    if (!validAmount(discount)) return json(response, 400, { error: "Discount must be a valid non-negative number." });
    if (!validAmount(advancePaid)) return json(response, 400, { error: "Advance payment must be a valid non-negative number." });
    if (!items.length) return json(response, 400, { error: "Please add at least one clothing item to the order." });
    if (items.length > 50) return json(response, 400, { error: "An order can contain at most 50 items." });

    db.exec("BEGIN IMMEDIATE");
    try {
      const lines = [];
      let subtotal = 0;
      const shouldDeductStock = ["Confirmed", "Processing", "Shipped", "Delivered"].includes(orderStatus);

      for (const item of items) {
        const productId = Number(item.productId);
        const qty = Number(item.qty);
        const price = Number(item.price);
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
        if (!product) throw httpError(404, `Product ID #${productId} was not found in inventory.`);
        if (!validQty(qty, product.unit, 0.001) || qty <= 0) throw httpError(400, `Enter a valid quantity for item "${product.name}".`);
        if (!validAmount(price)) throw httpError(400, `Enter a valid price for item "${product.name}".`);
        if (shouldDeductStock && product.qty < qty) {
          throw httpError(409, `Not enough stock for "${product.name}" (${[product.brand, product.size, product.color].filter(Boolean).join(" · ")}). Available in stock: ${product.qty} ${product.unit || 'piece'}, Requested: ${qty}.`);
        }
        const lineTotal = Math.round(qty * price * 100) / 100;
        subtotal += lineTotal;
        lines.push({
          productId: product.id,
          name: product.name,
          category: product.category,
          brand: product.brand || "",
          color: product.color || "",
          size: product.size || "",
          material: product.material || "",
          unit: product.unit || "piece",
          qty,
          price,
          lineTotal,
          cost: product.cost || 0
        });
      }

      if (discount > subtotal + deliveryCharge) throw httpError(400, `Discount (${discount}) cannot exceed the subtotal plus delivery charge (${subtotal + deliveryCharge}).`);
      const total = Math.max(0, Math.round((subtotal + deliveryCharge - discount) * 100) / 100);
      if (advancePaid > total) throw httpError(400, `Advance payment (${advancePaid}) cannot exceed order total (${total}).`);
      const dueCod = Math.max(0, Math.round((total - advancePaid) * 100) / 100);
      const paymentStatus = dueCod <= 0.001 && total > 0 ? "Paid" : advancePaid > 0 ? "Partial" : "Pending";
      const date = today();

      const countRow = db.prepare("SELECT MAX(id) AS maxId FROM online_orders").get();
      const nextId = (countRow?.maxId || 0) + 1;
      const orderNo = "ORD-" + String(nextId).padStart(6, "0");

      const stockDeducted = shouldDeductStock ? 1 : 0;
      if (shouldDeductStock) {
        for (const line of lines) {
          const product = db.prepare("SELECT * FROM products WHERE id=?").get(line.productId);
          const after = Number((product.qty - line.qty).toFixed(6));
          db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, line.productId);
          recordStockMovement(product, "online order", -line.qty, after, user.username, orderNo, `Online order placed for ${customerName}`);
        }
      }

      const result = db.prepare(`INSERT INTO online_orders(
        order_no, date, customer_name, customer_phone, shipping_address, city_area, courier, tracking_id,
        delivery_charge, discount, subtotal, total, advance_paid, due_cod, payment_method, payment_status,
        order_status, notes, lines, stock_deducted, created_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        orderNo, date, customerName, customerPhone, shippingAddress, cityArea, courier, trackingId,
        deliveryCharge, discount, subtotal, total, advancePaid, dueCod, paymentMethod, paymentStatus,
        orderStatus, notes, JSON.stringify(lines), stockDeducted, user.username
      );

      db.exec("COMMIT");
      return json(response, 201, { ...stateFor(user), orderId: Number(result.lastInsertRowid), orderNo });
    } catch (error) {
      db.exec("ROLLBACK");
      if (error.status) return json(response, error.status, { error: error.message });
      throw error;
    }
  }

  const onlineOrderBillMatch = route.match(/^\/api\/online-orders\/(\d+)\/bill$/);
  if (onlineOrderBillMatch && method === "POST") {
    if (!requirePermission(user, "online_orders") || !requirePermission(user, "sales")) return json(response, 403, { error: "Online Orders and Sales access are required to create a linked bill." });
    const id = Number(onlineOrderBillMatch[1]);
    db.exec("BEGIN IMMEDIATE");
    try {
      const order = db.prepare("SELECT * FROM online_orders WHERE id=?").get(id);
      if (!order) throw httpError(404, "Online order not found.");
      if (order.bill_id) throw httpError(409, "This online order already has a linked Sales bill.");
      if (!order.stock_deducted) throw httpError(409, "Confirm the order before creating a Sales bill so inventory is deducted exactly once.");
      const lines = JSON.parse(order.lines || "[]");
      if (!lines.length) throw httpError(400, "This order has no billable items.");
      const paid = Number(order.advance_paid || 0);
      const billId = Number(db.prepare(`INSERT INTO bills(date,customer,phone,payment,discount,total,cashier,lines,tax_amount,tax_rate,tax_mode,delivery_charge)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(order.date, order.customer_name, order.customer_phone, paid > 0 ? order.payment_method : "Due", order.discount, order.total, user.username,
        JSON.stringify(lines.map(line => ({ productId: line.productId, name: [line.name, line.brand, line.size, line.color, line.material].filter(Boolean).join(" · "), category: line.category, brand: line.brand || "", color: line.color || "", size: line.size || "", material: line.material || "", unit: line.unit || "piece", qty: line.qty, price: line.price, serials: [], warrantyMonths: 0 }))), 0, 0, "none", order.delivery_charge).lastInsertRowid);
      if (paid > 0) db.prepare("INSERT INTO bill_payments(bill_id,date,amount,method,received_by) VALUES(?,?,?,?,?)").run(billId, order.date, paid, order.payment_method || "Cash", user.username);
      let discountLeft = Number(order.discount || 0);
      const subtotal = Number(order.subtotal || 0);
      lines.forEach((line, index) => {
        const gross = Number(line.lineTotal || line.qty * line.price);
        const share = Math.min(gross, Math.max(0, index === lines.length - 1 ? discountLeft : subtotal > 0 ? Math.round(order.discount * gross / subtotal * 100) / 100 : 0));
        discountLeft = Math.round((discountLeft - share) * 100) / 100;
        const saleId = Number(db.prepare("INSERT INTO sales(date,product,qty,total,payment,cost,unit,product_id,bill_id,tax_amount) VALUES(?,?,?,?,?,?,?,?,?,0)")
          .run(order.date, [line.name, line.brand, line.size, line.color, line.material].filter(Boolean).join(" · "), line.qty, gross - share, paid > 0 ? order.payment_method : "Due", Number(line.cost || 0) * Number(line.qty), line.unit || "piece", line.productId || null, billId).lastInsertRowid);
        db.prepare("UPDATE sales_returns SET bill_id=?,sale_id=? WHERE online_order_id=? AND order_line_index=? AND bill_id IS NULL")
          .run(billId, saleId, id, index);
      });
      db.prepare("UPDATE online_orders SET bill_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(billId, id);
      syncSales(billId);
      db.exec("COMMIT");
      return json(response, 201, { ...stateFor(user), bill: billById(billId) });
    } catch (error) { db.exec("ROLLBACK"); if (error.status) return json(response, error.status, { error: error.message }); throw error; }
  }

  const onlineOrderReturnMatch = route.match(/^\/api\/online-orders\/(\d+)\/returns$/);
  if (onlineOrderReturnMatch && method === "POST") {
    if (!requirePermission(user, "online_orders") || !requirePermission(user, "inventory")) return json(response, 403, { error: "Online Orders and inventory access are required to process an order return." });
    const id = Number(onlineOrderReturnMatch[1]), body = await readJson(request);
    const refundAmount = Number(body.refundAmount || 0);
    const requestedItems = Array.isArray(body.items) ? body.items : [{ lineIndex: body.lineIndex, qty: body.qty }];
    if (!requestedItems.length || requestedItems.length > 50) return json(response, 400, { error: "Choose at least one item to return (up to 50)." });
    db.exec("BEGIN IMMEDIATE");
    try {
      const order = db.prepare("SELECT * FROM online_orders WHERE id=?").get(id);
      if (!order) throw httpError(404, "Online order not found.");
      const recordingLegacyReturnedOrder = order.order_status === "Returned" && !order.stock_deducted;
      if (pharmacyMode()) throw httpError(403, "Online-order returns are unavailable for Pharmacy until batch-aware returns are supported. Process pharmacy returns through the Sales history workflow.");
      if (order.order_status !== "Delivered" && !recordingLegacyReturnedOrder) throw httpError(409, "Only delivered orders can be returned.");
      if (!order.stock_deducted && !recordingLegacyReturnedOrder) throw httpError(409, "This order has no deducted inventory to return. Confirm and deliver it before recording a return.");
      const lines = JSON.parse(order.lines || "[]"), seen = new Set(), selected = [];
      for (const item of requestedItems) {
        const lineIndex = Number(item.lineIndex), qty = Number(item.qty), line = lines[lineIndex];
        if (!Number.isInteger(lineIndex) || seen.has(lineIndex)) throw httpError(400, "Each returned item must be selected only once.");
        seen.add(lineIndex);
        const productId = Number(line?.productId ?? line?.product_id);
        if (!line || !Number.isInteger(productId) || productId <= 0) throw httpError(400, `“${line?.name || "This item"}” has no linked inventory record, so it cannot be returned to stock. Update the order item link first.`);
        const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
        if (!product) throw httpError(409, `The original inventory item "${line.name}" no longer exists.`);
        if (!validQty(qty, line.unit || product.unit, 0.001) || qty <= 0) throw httpError(400, `Enter a valid return quantity for "${line.name}".`);
        const linkedSale = order.bill_id ? db.prepare("SELECT id FROM sales WHERE bill_id=? ORDER BY id LIMIT 1 OFFSET ?").get(order.bill_id, lineIndex) : null;
        const previous = db.prepare("SELECT COALESCE(SUM(qty),0) qty FROM sales_returns WHERE (online_order_id=? AND order_line_index=?) OR sale_id=?").get(id, lineIndex, linkedSale?.id || -1);
        const remaining = Number(line.qty) - Number(previous.qty);
        if (qty > remaining + 0.000001) throw httpError(409, `Only ${Math.max(0, remaining)} ${line.unit || "piece"} remains eligible for "${line.name}".`);
        const gross = Number(line.lineTotal || line.qty * line.price);
        const beforeDiscount = Math.round(gross / Number(line.qty) * qty * 100) / 100;
        const discountShare = Number(order.subtotal) > 0 ? Math.round(Number(order.discount || 0) * beforeDiscount / Number(order.subtotal) * 100) / 100 : 0;
        selected.push({ lineIndex, line, product, qty, linkedSale, returnedValue: Math.max(0, beforeDiscount - discountShare) });
      }
      const totalReturnedValue = Math.round(selected.reduce((sum, item) => sum + item.returnedValue, 0) * 100) / 100;
      const reason = String(body.reason || "Customer return").trim().slice(0, 300);
      const refundMethod = refundAmount > 0 ? String(body.refundMethod || "").trim().slice(0, 40) : "";
      const priorReturns = db.prepare("SELECT COALESCE(SUM(total),0) amount,COALESCE(SUM(refund_amount),0) refunded FROM sales_returns WHERE online_order_id=?").get(id);
      const linkedBill = order.bill_id ? billById(order.bill_id) : null;
      const remainingAfterReturn = Math.max(0, (linkedBill ? linkedBill.netTotal : Number(order.total) - Number(priorReturns.amount || 0)) - totalReturnedValue);
      const amountPaid = linkedBill ? linkedBill.paid : Number(order.advance_paid || 0);
      const alreadyRefunded = linkedBill ? linkedBill.refunded : Number(priorReturns.refunded || 0);
      const refundLimit = Math.max(0, Math.min(totalReturnedValue, amountPaid - remainingAfterReturn - alreadyRefunded));
      if (!validAmount(refundAmount) || refundAmount > refundLimit + 0.001) throw httpError(400, `Refund cannot exceed ${refundLimit.toFixed(2)}. Returned value first reduces the unpaid bill balance.`);
      if (refundAmount > 0 && !validText(refundMethod)) throw httpError(400, "Choose a refund method.");
      let refundLeft = Math.round(refundAmount * 100) / 100;
      for (const item of selected) {
        const { lineIndex, line, product, qty, linkedSale, returnedValue } = item;
        const lineRefund = Math.min(returnedValue, refundLeft);
        refundLeft = Math.round((refundLeft - lineRefund) * 100) / 100;
        if (order.stock_deducted) {
          const currentProduct = db.prepare("SELECT * FROM products WHERE id=?").get(product.id);
          const after = Number((currentProduct.qty + qty).toFixed(6));
          db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, currentProduct.id);
          recordStockMovement(currentProduct, "online order return", qty, after, user.username, order.order_no, reason, Number(line.cost || currentProduct.cost || 0));
        }
        db.prepare(`INSERT INTO sales_returns(date,product,qty,total,payment,cost,unit,product_id,reason,sale_id,bill_id,online_order_id,order_line_index,refund_amount,refund_method,actor)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(today(), [line.name,line.brand,line.size,line.color,line.material].filter(Boolean).join(" · "), qty, returnedValue, lineRefund > 0 ? refundMethod : "Credit adjustment", Number(line.cost || 0) * qty, line.unit || product.unit || "piece", product.id, reason, linkedSale?.id || null, order.bill_id || null, id, lineIndex, lineRefund, lineRefund > 0 ? refundMethod : "", user.username);
      }
      const returnedQty = Number(db.prepare("SELECT COALESCE(SUM(qty),0) qty FROM sales_returns WHERE online_order_id=?").get(id).qty);
      const allQty = lines.reduce((sum, item) => sum + Number(item.qty || 0), 0);
      const fullyReturned = returnedQty + 0.000001 >= allQty;
      const nextStatus = fullyReturned ? "Returned" : order.order_status;
      db.prepare("UPDATE online_orders SET order_status=?,stock_deducted=CASE WHEN ? THEN 0 ELSE stock_deducted END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(nextStatus, fullyReturned ? 1 : 0, id);
      if (order.bill_id) syncSales(order.bill_id);
      db.exec("COMMIT");
      return json(response, 201, stateFor(user));
    } catch (error) { db.exec("ROLLBACK"); if (error.status) return json(response, error.status, { error: error.message }); throw error; }
  }

  if (onlineOrderMatch && onlineOrderMatch[1] && method === "PATCH") {
    if (!requirePermission(user, "online_orders")) return json(response, 403, { error: "You do not have online orders permission." });
    const id = Number(onlineOrderMatch[1]);
    const body = await readJson(request);
    const existing = db.prepare("SELECT * FROM online_orders WHERE id=?").get(id);
    if (!existing) return json(response, 404, { error: "Online order not found." });
    const priorReturns = db.prepare("SELECT 1 FROM sales_returns WHERE online_order_id=? LIMIT 1").get(id);
    if (priorReturns && (Array.isArray(body.items) || ["discount", "deliveryCharge", "advancePaid"].some(key => body[key] !== undefined) || (body.orderStatus !== undefined && body.orderStatus !== existing.order_status))) return json(response, 409, { error: "This order has recorded returns. Its items, amounts, and status are locked to preserve the return history." });
    if (existing.bill_id && (Array.isArray(body.items) || ["customerName", "customerPhone", "discount", "deliveryCharge", "advancePaid"].some(key => body[key] !== undefined))) return json(response, 409, { error: "This order already has a linked Sales bill. Its customer, items, and amounts can no longer be edited." });
    if (existing.bill_id && body.orderStatus !== undefined && !["Confirmed", "Processing", "Shipped", "Delivered", "Returned"].includes(String(body.orderStatus))) return json(response, 409, { error: "This order has a linked Sales bill. Cancel or reverse it through its return workflow." });

    db.exec("BEGIN IMMEDIATE");
    try {
      const prevLines = JSON.parse(existing.lines || "[]");
      const customerName = body.customerName !== undefined ? String(body.customerName || "").trim() : existing.customer_name;
      const customerPhone = body.customerPhone !== undefined ? String(body.customerPhone || "").trim() : existing.customer_phone;
      const shippingAddress = body.shippingAddress !== undefined ? String(body.shippingAddress || "").trim() : existing.shipping_address;
      const cityArea = body.cityArea !== undefined ? String(body.cityArea || "").trim() : existing.city_area;
      const courier = body.courier !== undefined ? String(body.courier || "").trim() : existing.courier;
      const trackingId = body.trackingId !== undefined ? String(body.trackingId || "").trim() : existing.tracking_id;
      const deliveryCharge = body.deliveryCharge !== undefined ? Number(body.deliveryCharge) : existing.delivery_charge;
      const discount = body.discount !== undefined ? Number(body.discount) : existing.discount;
      const advancePaid = body.advancePaid !== undefined ? Number(body.advancePaid) : existing.advance_paid;
      const paymentMethod = body.paymentMethod !== undefined ? String(body.paymentMethod || "").trim() : existing.payment_method;
      const orderStatus = body.orderStatus !== undefined ? String(body.orderStatus || "").trim() : existing.order_status;
      const notes = body.notes !== undefined ? String(body.notes || "").trim() : existing.notes;

      const validStatuses = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled", "Returned"];
      if (!validStatuses.includes(orderStatus)) throw httpError(400, "Invalid order status. Choose from: " + validStatuses.join(", "));
      if (!customerName) throw httpError(400, "Customer name is required.");
      if (!customerPhone) throw httpError(400, "Customer phone number is required.");
      if (!shippingAddress) throw httpError(400, "Shipping address is required.");
      if (!validAmount(deliveryCharge)) throw httpError(400, "Delivery charge must be a valid non-negative number.");
      if (!validAmount(discount)) throw httpError(400, "Discount must be a valid non-negative number.");
      if (!validAmount(advancePaid)) throw httpError(400, "Advance payment must be a valid non-negative number.");

      let lines = prevLines;
      let subtotal = existing.subtotal;

      if (Array.isArray(body.items)) {
        if (!body.items.length) throw httpError(400, "Order must have at least one product item.");
        if (existing.stock_deducted) {
          for (const line of prevLines) {
            const product = db.prepare("SELECT * FROM products WHERE id=?").get(line.productId);
            if (product) {
              const after = Number((product.qty + line.qty).toFixed(6));
              db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, line.productId);
              recordStockMovement(product, "online order item edit (restore)", line.qty, after, user.username, existing.order_no, "Stock restored while editing online order items.");
            }
          }
        }
        lines = [];
        subtotal = 0;
        for (const item of body.items) {
          const productId = Number(item.productId);
          const qty = Number(item.qty);
          const price = Number(item.price);
          const product = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
          if (!product) throw httpError(404, `Product ID #${productId} not found in inventory.`);
          if (!validQty(qty, product.unit, 0.001) || qty <= 0) throw httpError(400, `Enter a valid quantity for item "${product.name}".`);
          if (!validAmount(price)) throw httpError(400, `Enter a valid price for item "${product.name}".`);
          const lineTotal = Math.round(qty * price * 100) / 100;
          subtotal += lineTotal;
          lines.push({
            productId: product.id,
            name: product.name,
            category: product.category,
            brand: product.brand || "",
            color: product.color || "",
            size: product.size || "",
            material: product.material || "",
            unit: product.unit || "piece",
            qty,
            price,
            lineTotal,
            cost: product.cost || 0
          });
        }
      }

      const total = Math.max(0, Math.round((subtotal + deliveryCharge - discount) * 100) / 100);
      if (advancePaid > total) throw httpError(400, `Advance payment (${advancePaid}) cannot exceed order total (${total}).`);
      const dueCod = Math.max(0, Math.round((total - advancePaid) * 100) / 100);
      const paymentStatus = dueCod <= 0.001 && total > 0 ? "Paid" : advancePaid > 0 ? "Partial" : "Pending";

      const targetDeductStock = ["Confirmed", "Processing", "Shipped", "Delivered"].includes(orderStatus);
      let stockDeducted = existing.stock_deducted;

      if (Array.isArray(body.items)) {
        if (targetDeductStock) {
          for (const line of lines) {
            const product = db.prepare("SELECT * FROM products WHERE id=?").get(line.productId);
            if (!product || product.qty < line.qty) {
              throw httpError(409, `Not enough stock for "${line.name}" (${[line.brand, line.size, line.color].filter(Boolean).join(" · ")}). Available: ${product ? product.qty : 0}, Requested: ${line.qty}.`);
            }
            const after = Number((product.qty - line.qty).toFixed(6));
            db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, line.productId);
            recordStockMovement(product, "online order", -line.qty, after, user.username, existing.order_no, "Stock updated for order");
          }
          stockDeducted = 1;
        } else {
          stockDeducted = 0;
        }
      } else {
        if (!existing.stock_deducted && targetDeductStock) {
          for (const line of lines) {
            const product = db.prepare("SELECT * FROM products WHERE id=?").get(line.productId);
            if (!product || product.qty < line.qty) {
              throw httpError(409, `Not enough stock for "${line.name}" (${[line.brand, line.size, line.color].filter(Boolean).join(" · ")}). Available: ${product ? product.qty : 0}, Required: ${line.qty}.`);
            }
            const after = Number((product.qty - line.qty).toFixed(6));
            db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, line.productId);
            recordStockMovement(product, "online order", -line.qty, after, user.username, existing.order_no, `Stock deducted on order ${orderStatus}`);
          }
          stockDeducted = 1;
        } else if (existing.stock_deducted && !targetDeductStock) {
          for (const line of lines) {
            const product = db.prepare("SELECT * FROM products WHERE id=?").get(line.productId);
            if (product) {
              const after = Number((product.qty + line.qty).toFixed(6));
              db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, line.productId);
              recordStockMovement(product, "online order reversal", line.qty, after, user.username, existing.order_no, `Stock restored on order status changed to ${orderStatus}`);
            }
          }
          stockDeducted = 0;
        }
      }

      db.prepare(`UPDATE online_orders SET
        customer_name=?, customer_phone=?, shipping_address=?, city_area=?, courier=?, tracking_id=?,
        delivery_charge=?, discount=?, subtotal=?, total=?, advance_paid=?, due_cod=?, payment_method=?,
        payment_status=?, order_status=?, notes=?, lines=?, stock_deducted=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(
        customerName, customerPhone, shippingAddress, cityArea, courier, trackingId,
        deliveryCharge, discount, subtotal, total, advancePaid, dueCod, paymentMethod,
        paymentStatus, orderStatus, notes, JSON.stringify(lines), stockDeducted, id
      );

      db.exec("COMMIT");
      return json(response, 200, stateFor(user));
    } catch (error) {
      db.exec("ROLLBACK");
      if (error.status) return json(response, error.status, { error: error.message });
      throw error;
    }
  }

  if (onlineOrderMatch && onlineOrderMatch[1] && method === "DELETE") {
    if (!requirePermission(user, "online_orders") || !requirePermission(user, "delete_online_orders")) {
      return json(response, 403, { error: "Online order delete access is required. Ask Jahangir or an administrator to grant it in Team access." });
    }
    const id = Number(onlineOrderMatch[1]);
    const existing = db.prepare("SELECT * FROM online_orders WHERE id=?").get(id);
    if (!existing) return json(response, 404, { error: "Online order not found." });
    if (existing.bill_id) return json(response, 409, { error: "This order has a linked Sales bill and cannot be deleted." });

    db.exec("BEGIN IMMEDIATE");
    try {
      if (existing.stock_deducted) {
        const lines = JSON.parse(existing.lines || "[]");
        const returnedByProduct = new Map(db.prepare("SELECT product_id,SUM(qty) qty FROM sales_returns WHERE online_order_id=? GROUP BY product_id").all(id).map(row => [Number(row.product_id), Number(row.qty)]));
        for (const line of lines) {
          const alreadyReturned = Math.min(Number(line.qty || 0), returnedByProduct.get(Number(line.productId)) || 0);
          returnedByProduct.set(Number(line.productId), Math.max(0, (returnedByProduct.get(Number(line.productId)) || 0) - alreadyReturned));
          const restoreQty = Math.max(0, Number(line.qty || 0) - alreadyReturned);
          if (!restoreQty) continue;
          const product = db.prepare("SELECT * FROM products WHERE id=?").get(line.productId);
          if (product) {
            const after = Number((product.qty + restoreQty).toFixed(6));
            db.prepare("UPDATE products SET qty=? WHERE id=?").run(after, line.productId);
            recordStockMovement(product, "online order deletion", restoreQty, after, user.username, existing.order_no, "Stock restored for unreturned items when deleting online order.");
          }
        }
      }
      db.prepare("DELETE FROM sales_returns WHERE online_order_id=?").run(id);
      db.prepare("DELETE FROM online_orders WHERE id=?").run(id);
      db.exec("COMMIT");
      return json(response, 200, stateFor(user));
    } catch (error) {
      db.exec("ROLLBACK");
      if (error.status) return json(response, error.status, { error: error.message });
      throw error;
    }
  }

  const expenseMatch = route.match(/^\/api\/expenses\/(\d+)$/);
  if (expenseMatch && method === "PATCH") {
    if (!can(user, "records") || !requirePermission(user, "expenses")) {
      return json(response, 403, { error: "Edit-record and expense access are required to edit expenses." });
    }
    const body = await readJson(request);
    const expense = db.prepare("SELECT * FROM expenses WHERE id=?").get(Number(expenseMatch[1]));
    if (!expense) return json(response, 404, { error: "Expense record not found." });
    const date = body.date === undefined ? expense.date : body.date;
    const category = body.category === undefined ? expense.category : body.category;
    const note = body.note === undefined ? expense.note : body.note;
    const amount = body.amount === undefined ? expense.amount : Number(body.amount);
    if (!validDate(date) || !validText(category) || category.length > 100 ||
        typeof note !== "string" || note.length > 500 || !validAmount(amount)) {
      return json(response, 400, { error: "Enter a valid date, category, note (up to 500 characters), and non-negative amount." });
    }
    db.prepare("UPDATE expenses SET date=?,category=?,note=?,amount=? WHERE id=?")
      .run(date, category.trim(), note.trim(), amount, expense.id);
    return json(response, 200, stateFor(user));
  }
  if (expenseMatch && method === "DELETE") {
    if (!can(user, "records") || !requirePermission(user, "expenses")) {
      return json(response, 403, { error: "Edit-record and expense access are required to delete expenses." });
    }
    const result = db.prepare("DELETE FROM expenses WHERE id=?").run(Number(expenseMatch[1]));
    if (!result.changes) return json(response, 404, { error: "Expense record not found." });
    return json(response, 200, stateFor(user));
  }
  if (route === "/api/expenses" && method === "POST") {
    if (!requirePermission(user, "expenses")) return json(response, 403, { error: "You do not have expense permission." });
    const body = await readJson(request);
    if (!validDate(body.date) || !validText(body.category) || !validAmount(body.amount)) return json(response, 400, { error: "Expense details are invalid." });
    db.prepare("INSERT INTO expenses(date,category,note,amount) VALUES(?,?,?,?)")
      .run(body.date, String(body.category).slice(0, 100), String(body.note || "").slice(0, 500), Number(body.amount));
    return json(response, 201, stateFor(user));
  }

  if (route === "/api/cash" && method === "GET") {
    if (!requirePermission(user, "sales")) return json(response, 403, { error: "You do not have sales permission." });
    const date = url.searchParams.get("date") || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(response, 400, { error: "Choose a valid date." });
    const one = (sql, ...args) => db.prepare(sql).get(...args).v;
    const received = new Map();
    for (const row of db.prepare("SELECT method, SUM(amount) AS amount FROM bill_payments WHERE date=? GROUP BY method").all(date)) received.set(row.method, row.amount);
    for (const row of db.prepare("SELECT payment AS method, SUM(total) AS amount FROM sales WHERE date=? AND bill_id IS NULL AND service_job_id IS NULL AND payment<>'Due' GROUP BY payment").all(date)) received.set(row.method, (received.get(row.method) || 0) + row.amount);
    for (const row of db.prepare("SELECT method,SUM(amount) AS amount FROM service_job_payments WHERE date=? GROUP BY method").all(date)) received.set(row.method, (received.get(row.method) || 0) + row.amount);
    for (const row of db.prepare("SELECT refund_method AS method, SUM(refund_amount) AS amount FROM sales_returns WHERE date=? AND refund_amount>0 GROUP BY refund_method").all(date)) received.set(row.method, (received.get(row.method) || 0) - row.amount);
    const returns = one("SELECT COALESCE(SUM(total),0) AS v FROM sales_returns WHERE date=?", date);
    const billed = one("SELECT COALESCE(SUM(total),0) AS v FROM bills WHERE date=?", date) + one("SELECT COALESCE(SUM(total),0) AS v FROM sales WHERE date=? AND bill_id IS NULL AND service_job_id IS NULL", date) + one("SELECT COALESCE(SUM(final_charge),0) AS v FROM service_jobs WHERE delivered_date=?", date);
    const paidSameDay = one("SELECT COALESCE(SUM(p.amount),0) AS v FROM bill_payments p JOIN bills b ON b.id=p.bill_id WHERE p.date=? AND b.date=?", date, date);
    const dueCollected = one("SELECT COALESCE(SUM(p.amount),0) AS v FROM bill_payments p JOIN bills b ON b.id=p.bill_id WHERE p.date=? AND b.date<?", date, date) + one("SELECT COALESCE(SUM(p.amount),0) AS v FROM service_job_payments p JOIN service_jobs j ON j.id=p.job_id WHERE p.date=? AND j.delivered_date<?", date, date);
    const dueAfterNewSales = one("SELECT COALESCE(SUM(total),0) AS v FROM bills WHERE date=?", date) - paidSameDay + one("SELECT COALESCE(SUM(total),0) AS v FROM sales WHERE date=? AND bill_id IS NULL AND service_job_id IS NULL AND payment='Due'", date) + one("SELECT COALESCE(SUM(final_charge),0) AS v FROM service_jobs WHERE delivered_date=? AND status='Delivered'", date) - one("SELECT COALESCE(SUM(p.amount),0) AS v FROM service_job_payments p JOIN service_jobs j ON j.id=p.job_id WHERE j.delivered_date=? AND p.date<=?", date, date);
    const returnedFromNewSales = one(`SELECT COALESCE(SUM(r.total),0) AS v FROM sales_returns r
      LEFT JOIN bills b ON b.id=r.bill_id LEFT JOIN sales s ON s.id=r.sale_id
      WHERE r.date=? AND ((r.bill_id IS NOT NULL AND b.date=?) OR (r.bill_id IS NULL AND s.date=?))`, date, date, date);
    const newDue = Math.max(0, dueAfterNewSales - returnedFromNewSales);
    const expenses = can(user, "expenses") ? one("SELECT COALESCE(SUM(amount),0) AS v FROM expenses WHERE date=?", date) : null;
    return json(response, 200, { date, receipts: [...received].map(([method, amount]) => ({ method, amount })), totalReceived: [...received.values()].reduce((n, v) => n + v, 0), dueCollected, billed, newDue, returns, expenses });
  }
  const backupFileMatch = route.match(/^\/api\/backups\/download\/([a-zA-Z0-9._-]+)$/);
  if (backupFileMatch && method === "GET") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    const name = backupFileMatch[1];
    if (!/^shop-\d{4}-\d{2}-\d{2}(?:-\d{6,13})?\.sqlite3$/.test(name)) return json(response, 400, { error: "Backup name is invalid." });
    const file = join(backupDir, name);
    if (!existsSync(file)) return json(response, 404, { error: "Backup file not found." });
    response.writeHead(200, { "Content-Type": "application/vnd.sqlite3", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
    return;
  }
  if (route === "/api/backups/restore-upload" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    let bytes;
    try { bytes = await readBinary(request); } catch (error) { return json(response, error.status || 400, { error: error.message || "The backup file could not be read." }); }
    if (bytes.length < 16 || bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0") return json(response, 400, { error: "Choose a valid Shop Desk SQLite backup file." });
    const uploadName = `shop-${today()}-${Date.now()}.sqlite3`, uploadFile = join(backupDir, uploadName);
    writeFileSync(uploadFile, bytes, { flag: "wx" });
    let check;
    try {
      check = new DatabaseSync(uploadFile);
      const integrity = check.prepare("PRAGMA integrity_check").get();
      const hasTable = table => Boolean(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
      if (integrity?.integrity_check !== "ok" || !["users", "settings", "products", "sales", "bills"].every(hasTable)) throw new Error("This file is not a valid Shop Desk database backup.");
    } catch (error) {
      try { check?.close(); } catch {}
      rmSync(uploadFile, { force: true });
      return json(response, 400, { error: error.message || "The backup could not be checked." });
    }
    check.close();
    const safetyName = `shop-${today()}-${Date.now() + 1}.sqlite3`, safetyFile = join(backupDir, safetyName);
    let databaseClosed = false;
    try {
      db.exec(`VACUUM INTO '${safetyFile.replace(/'/g, "''")}'`);
      db.close(); databaseClosed = true;
      copyFileSync(uploadFile, dbFile);
      db = new DatabaseSync(dbFile);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      upgradeRestoredDatabase();
      return json(response, 200, { ok: true, safetyBackup: safetyName, restoredBackup: uploadName });
    } catch (error) {
      if (!databaseClosed) { rmSync(uploadFile, { force: true }); return json(response, 500, { error: "Restore could not start. The current database is still open and unchanged." }); }
      try { db?.close(); } catch {}
      try { copyFileSync(safetyFile, dbFile); db = new DatabaseSync(dbFile); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); upgradeRestoredDatabase(); }
      catch (restoreError) { console.error("Could not reopen the safety copy after restore failure:", restoreError); }
      rmSync(uploadFile, { force: true });
      return json(response, 500, { error: "Restore failed. The pre-restore safety copy was kept." });
    }
  }
  if (route === "/api/fresh-start" && method === "POST") {
    const owner = db.prepare("SELECT id FROM users WHERE username='jahangir' COLLATE NOCASE AND role='admin'").get();
    if (user.username.toLowerCase() !== "jahangir" || user.role !== "admin" || !owner || owner.id !== user.id) return json(response, 403, { error: "Only the Jahangir administrator can prepare a fresh shop setup." });
    const body = await readJson(request);
    if (body.confirmation !== "FRESH START") return json(response, 400, { error: "Type FRESH START to confirm this action." });
    let backupName;
    try { backupName = runBackup("fresh-start"); }
    catch (error) { return json(response, 500, { error: "A safety backup could not be created, so no data was cleared: " + error.message }); }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["medicine_batch_sales", "medicine_batch_returns", "medicine_batches", "medicine_details", "service_job_parts", "service_job_payments", "service_jobs", "online_orders", "sold_devices", "bill_payments", "sales_returns", "sales", "bills", "expenses", "purchase_lines", "purchases", "supplier_payments", "stock_movements", "customers", "suppliers", "products", "categories", "activity_log"]) db.exec(`DELETE FROM ${table}`);
      db.prepare("DELETE FROM sessions WHERE user_id<>?").run(owner.id);
      db.prepare("DELETE FROM users WHERE id<>?").run(owner.id);
      db.prepare(`INSERT INTO settings(id,shop_name,workspace,shop_type,currency_code,locale,tax_rate,tax_mode,require_customer,allow_discounts,payment_methods,contact_number,website,email,facebook_page,whatsapp_number,contact_address)
        VALUES(1,'Shop Desk','Set workspace','general','BDT','en-BD',0,'none',0,1,'Cash,bKash,Nagad,Card,Due','','','','','','')
        ON CONFLICT(id) DO UPDATE SET shop_name=excluded.shop_name,workspace=excluded.workspace,shop_type=excluded.shop_type,
        currency_code=excluded.currency_code,locale=excluded.locale,tax_rate=excluded.tax_rate,tax_mode=excluded.tax_mode,
        require_customer=excluded.require_customer,allow_discounts=excluded.allow_discounts,payment_methods=excluded.payment_methods,contact_number=excluded.contact_number,website=excluded.website,email=excluded.email,facebook_page=excluded.facebook_page,whatsapp_number=excluded.whatsapp_number,contact_address=excluded.contact_address`).run();
      for (const name of profileCategories.general) seedCategory(name);
      db.exec("COMMIT");
      return json(response, 200, { ok: true, backup: backupName });
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      return json(response, 500, { error: "Fresh start failed. The saved backup is " + backupName + ". " + error.message });
    }
  }
  const backupDeleteMatch = route.match(/^\/api\/backups\/([a-zA-Z0-9._-]+)$/);
  if (backupDeleteMatch && method === "DELETE") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    const name = backupDeleteMatch[1];
    if (!/^shop-\d{4}-\d{2}-\d{2}(?:-\d{6,13})?\.sqlite3$/.test(name)) return json(response, 400, { error: "Backup name is invalid." });
    const file = join(backupDir, name);
    if (!existsSync(file)) return json(response, 404, { error: "Backup file not found. Refresh the backup list and try again." });
    try { rmSync(file); }
    catch (error) { return json(response, 500, { error: "Could not delete the backup: " + error.message }); }
    return json(response, 200, { ok: true, deleted: name });
  }
  if (route === "/api/backups/restore" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    const body = await readJson(request), name = String(body.name || "");
    if (!/^shop-\d{4}-\d{2}-\d{2}(?:-\d{6,13})?\.sqlite3$/.test(name)) return json(response, 400, { error: "Backup name is invalid." });
    const file = join(backupDir, name);
    if (!existsSync(file)) return json(response, 404, { error: "Backup file not found." });
    let check;
    try {
      check = new DatabaseSync(file);
      const integrity = check.prepare("PRAGMA integrity_check").get();
      const hasTable = table => Boolean(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
      if (integrity?.integrity_check !== "ok" || !["users", "settings", "products", "sales", "bills"].every(hasTable)) throw new Error("This file is not a valid Shop Desk database backup.");
    } catch (error) { try { check?.close(); } catch {} return json(response, 400, { error: error.message || "The backup could not be checked." }); }
    check.close();
    const safetyName = `shop-${today()}-${Date.now()}.sqlite3`;
    const safetyFile = join(backupDir, safetyName);
    let databaseClosed = false;
    try {
      db.exec(`VACUUM INTO '${safetyFile.replace(/'/g, "''")}'`);
      db.close();
      databaseClosed = true;
      copyFileSync(file, dbFile);
      db = new DatabaseSync(dbFile);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      upgradeRestoredDatabase();
      return json(response, 200, { ok: true, safetyBackup: safetyName });
    } catch (error) {
      if (!databaseClosed) return json(response, 500, { error: "Restore could not start. The current database is still open and unchanged." });
      try { db?.close(); } catch {}
      try { copyFileSync(safetyFile, dbFile); db = new DatabaseSync(dbFile); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); upgradeRestoredDatabase(); } catch (restoreError) { console.error("Could not reopen the safety copy after restore failure:", restoreError); }
      return json(response, 500, { error: "Restore failed. The pre-restore safety copy was kept." });
    }
  }
  if (route === "/api/backups/offsite" && method === "GET") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    return json(response, 200, offsitePublic());
  }
  if (route === "/api/backups/offsite/config" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    const body = await readJson(request);
    const keep = Math.max(1, Math.min(90, Number(body.keep) || DEFAULT_KEEP));
    const folderName = String(body.folderName || DEFAULT_FOLDER_NAME).trim().slice(0, 60) || DEFAULT_FOLDER_NAME;
    db.prepare("UPDATE offsite_backup SET enabled=?, keep=?, folder_name=? WHERE id=1").run(body.enabled ? 1 : 0, keep, folderName);
    return json(response, 200, offsitePublic());
  }
  if (route === "/api/backups/offsite/connect" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    if (!driveClient.configured) {
      return json(response, 503, { error: "Google Drive is not configured on this server yet. Add SHOP_GOOGLE_CLIENT_ID and SHOP_GOOGLE_CLIENT_SECRET, restart Shop Desk, then try again.", code: "not_configured" });
    }
    const state = randomBytes(24).toString("hex");
    setMetaValue("offsite_oauth_state", `${state}:${Date.now() + 15 * 60 * 1000}`);
    return json(response, 200, {
      url: driveClient.authUrl(state),
      redirectUri: offsiteRedirectUri,
      onServerPc: offsiteRedirectUri.includes("localhost") || offsiteRedirectUri.includes("127.0.0.1")
    });
  }
  if (route === "/api/backups/offsite/disconnect" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    db.prepare("UPDATE offsite_backup SET connection='', connected_email='', enabled=0, last_error='' WHERE id=1").run();
    logSystem("Disconnected Google Drive offsite backups");
    return json(response, 200, offsitePublic());
  }
  if (route === "/api/backups/offsite/run" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    if (!driveClient.configured) return json(response, 503, { error: "Google Drive is not configured on this server yet.", code: "not_configured" });
    try {
      const result = await uploadOffsite("manual");
      return json(response, 200, { ok: true, result, status: offsitePublic() });
    } catch (error) {
      return json(response, 502, { error: "Offsite backup failed: " + error.message, status: offsitePublic() });
    }
  }
  if (route === "/api/backups/offsite/test" && method === "POST") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    if (!driveClient.configured) return json(response, 503, { error: "Google Drive is not configured on this server yet.", code: "not_configured" });
    try {
      const email = await withDrive(tokens => driveClient.accountEmail(tokens));
      db.prepare("UPDATE offsite_backup SET connected_email=?, last_error='' WHERE id=1").run(email || "");
      logSystem("Tested the Google Drive offsite backup connection");
      return json(response, 200, { ok: true, email, status: offsitePublic() });
    } catch (error) {
      return json(response, 502, { error: "Google Drive could not be reached: " + error.message });
    }
  }
  if (route === "/api/backups/offsite/files" && method === "GET") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    try {
      const files = await withDrive(async tokens => {
        const folderId = await driveClient.folderId(tokens, offsiteRow().folder_name || DEFAULT_FOLDER_NAME);
        return driveClient.list(tokens, folderId);
      });
      return json(response, 200, { files });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (route === "/api/backups" && (method === "GET" || method === "POST")) {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    let created;
    try { if (method === "POST") created = runBackup("manual"); } catch (error) { return json(response, 500, { error: "Backup failed: " + error.message }); }
    const files = existsSync(backupDir) ? readdirSync(backupDir).filter(name => /^shop-\d{4}-\d{2}-\d{2}(?:-\d{6,13})?\.sqlite3$/.test(name)).sort().reverse().map(name => ({ name, size: statSync(join(backupDir, name)).size })) : [];
    return json(response, method === "POST" ? 201 : 200, { files, ...(created ? { created } : {}) });
  }
  if (route === "/api/backups/folders" && method === "GET") {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    if (url.searchParams.get("roots") === "1") {
      const roots = process.platform === "win32" ? Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", letter => `${letter}:\\`).filter(root => existsSync(root)) : ["/"];
      return json(response, 200, { roots });
    }
    const requested = url.searchParams.get("path") || backupDir;
    if (!isAbsolute(requested)) return json(response, 400, { error: "Choose an absolute folder path on the server PC." });
    const folder = normalize(requested);
    try {
      if (!statSync(folder).isDirectory()) return json(response, 400, { error: "That location is not a folder." });
      const folders = readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => ({ name: entry.name, path: join(folder, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
      const parent = dirname(folder);
      return json(response, 200, { current: folder, parent: parent === folder ? null : parent, folders });
    } catch (error) { return json(response, 400, { error: "The server could not open that folder: " + error.message }); }
  }
  if (route === "/api/backups/schedule" && (method === "GET" || method === "POST")) {
    if (user.role !== "admin" || !can(user, "backups")) return json(response, 403, { error: "Backup and restore access is required." });
    if (method === "POST") {
      const body = await readJson(request);
      const directory = typeof body.directory === "string" ? normalize(body.directory.trim()) : "";
      if (typeof body.enabled !== "boolean" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || "")) || !directory || directory.length > 1000 || !isAbsolute(directory)) {
        return json(response, 400, { error: "Choose whether scheduled backups are enabled, enter a valid time, and provide an absolute folder path on the server PC." });
      }
      try { mkdirSync(directory, { recursive: true }); }
      catch (error) { return json(response, 400, { error: "The server could not use that backup folder: " + error.message }); }
      db.prepare("UPDATE backup_schedule SET enabled=?,time=?,directory=? WHERE id=1").run(body.enabled ? 1 : 0, body.time, directory);
      backupDir = directory;
    }
    const schedule = db.prepare("SELECT enabled,time,directory,last_run_date,last_backup_at FROM backup_schedule WHERE id=1").get();
    return json(response, 200, { enabled: Boolean(schedule.enabled), time: schedule.time, directory: schedule.directory || backupDir, lastBackupAt: schedule.last_backup_at || null });
  }
  if (route === "/api/activity" && method === "GET") {
    if (!can(user, "team") && !can(user, "admins")) return json(response, 403, { error: "Only administrators can view the activity log." });
    return json(response, 200, { rows: db.prepare("SELECT at, username, action FROM activity_log ORDER BY id DESC LIMIT 500").all() });
  }
  const adminCount = () => db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get().count;
  if (route === "/api/users" && method === "GET") {
    if (!can(user, "team") && !can(user, "admins")) return json(response, 403, { error: "You do not have access to team settings." });
    return json(response, 200, db.prepare("SELECT * FROM users ORDER BY username").all().map(item => ({
      id: item.id, username: item.username, role: item.role, active: Boolean(item.active), owner: item.id === ownerId(),
      fullAccess: item.role === "admin" && CAPS.every(cap => can(item, cap)),
      manageable: manageable(user, item), permissions: capsOf(item), createdAt: item.created_at
    })));
  }
  if (route === "/api/users" && method === "POST") {
    const body = await readJson(request);
    const role = body.role === "admin" || String(body.username || "").toLowerCase() === "jahangir" ? "admin" : "staff";
    if (!can(user, role === "admin" ? "admins" : "team")) return json(response, 403, { error: role === "admin" ? "You cannot create administrators." : "You cannot create staff accounts." });
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(body.username || "") || typeof body.password !== "string" || body.password.length < 12) {
      return json(response, 400, { error: "Use a 3–32 character username and a password of at least 12 characters." });
    }
    const g = grantCaps(user, role, body.permissions);
    const { salt, hash } = makePassword(body.password);
    try {
    db.prepare("INSERT INTO users(username,salt,password_hash,role,can_inventory,can_sales,can_expenses,can_server_load,can_online_orders,can_delete_online_orders,can_team,can_admins,can_records,can_repair_records,can_settings,can_supplier_purchases,can_backups) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(body.username, salt, hash, role, g.inventory, g.sales, g.expenses, g.server_load, g.online_orders, g.delete_online_orders, g.team, g.admins, g.records, g.repair_records, g.settings, g.supplier_purchases, g.backups);
    } catch {
      return json(response, 409, { error: "That username is already in use." });
    }
    return json(response, 201, { ok: true });
  }
  const userMatch = route.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === "PATCH") {
    const body = await readJson(request);
    const target = db.prepare("SELECT * FROM users WHERE id=?").get(Number(userMatch[1]));
    if (!target) return json(response, 404, { error: "User not found." });
    const self = target.id === user.id, allowed = manageable(user, target);
    if ((body.role !== undefined || body.permissions !== undefined || body.active !== undefined) && !allowed) return json(response, 403, { error: self ? "You cannot change your own access." : "You do not have permission to manage this account." });
    if (body.password !== undefined && !self && !allowed) return json(response, 403, { error: "You do not have permission to manage this account." });
    if (body.password !== undefined && (typeof body.password !== "string" || body.password.length < 12)) return json(response, 400, { error: "Password must be at least 12 characters." });
    if (body.password !== undefined && self && !passwordMatches(user, String(body.currentPassword || ""))) return json(response, 403, { error: "Current password is incorrect." });
    if (body.role !== undefined) {
      if (!["admin", "staff"].includes(body.role)) return json(response, 400, { error: "Unsupported role change." });
      if (body.role !== target.role) {
        if (!can(user, "admins")) return json(response, 403, { error: "You need the 'manage administrators' power to change roles." });
        if (body.role === "staff" && target.active && adminCount() <= 1) return json(response, 409, { error: "You cannot demote the last active administrator." });
        db.prepare("UPDATE users SET role=? WHERE id=?").run(body.role, target.id);
        if (body.role === "staff") db.prepare("UPDATE users SET can_team=0,can_admins=0,can_backups=0,can_repair_records=0,can_delete_online_orders=0 WHERE id=?").run(target.id);
        target.role = body.role;
      }
    }
    if (body.active === false && target.role === "admin" && target.active && adminCount() <= 1) return json(response, 409, { error: "You cannot disable the last active administrator." });
    if (body.permissions) {
      const g = grantCaps(user, target.role, body.permissions, capsOf(target));
      db.prepare("UPDATE users SET can_inventory=?,can_sales=?,can_expenses=?,can_server_load=?,can_online_orders=?,can_delete_online_orders=?,can_team=?,can_admins=?,can_records=?,can_repair_records=?,can_settings=?,can_supplier_purchases=?,can_backups=? WHERE id=?")
        .run(g.inventory, g.sales, g.expenses, g.server_load, g.online_orders, g.delete_online_orders, g.team, g.admins, g.records, g.repair_records, g.settings, g.supplier_purchases, g.backups, target.id);
    }
    if (typeof body.active === "boolean") {
      db.prepare("UPDATE users SET active=? WHERE id=?").run(body.active ? 1 : 0, target.id);
      if (!body.active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    }
    if (typeof body.password === "string") {
      const { salt, hash } = makePassword(body.password);
      db.prepare("UPDATE users SET salt=?,password_hash=? WHERE id=?").run(salt, hash, target.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(target.id);
    }
    return json(response, 200, { ok: true });
  }
  if (userMatch && method === "DELETE") {
    const target = db.prepare("SELECT * FROM users WHERE id=?").get(Number(userMatch[1]));
    if (!target) return json(response, 404, { error: "User not found." });
    if (target.id === user.id) return json(response, 409, { error: "You cannot remove your own account." });
    if (!manageable(user, target)) return json(response, 403, { error: "You do not have permission to manage this account." });
    if (target.role === "admin" && target.active && adminCount() <= 1) return json(response, 409, { error: "You cannot remove the last active administrator." });
    db.prepare("DELETE FROM users WHERE id=?").run(target.id);
    return json(response, 200, { ok: true });
  }
  return json(response, 404, { error: "API route not found." });
}

db.exec(`CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, username TEXT NOT NULL, action TEXT NOT NULL)`);
const billNumber = id => "B-" + String(id).padStart(8, "0");
const ACTIONS = [
  ["POST", /^\/api\/bills$/, () => "Created a bill"],
  ["PUT", /^\/api\/bills\/(\d+)$/, m => `Edited bill ${billNumber(m[1])}`],
  ["DELETE", /^\/api\/bills\/(\d+)$/, m => `Deleted bill ${billNumber(m[1])}`],
  ["POST", /^\/api\/bills\/(\d+)\/payments$/, m => `Received a payment on bill ${billNumber(m[1])}`],
  ["POST", /^\/api\/online-orders$/, () => "Created an online order"],
  ["POST", /^\/api\/online-orders\/\d+\/bill$/, m => `Created a Sales bill for online order #${m[0].match(/\d+/)?.[0] || ""}`],
  ["POST", /^\/api\/online-orders\/\d+\/returns$/, m => `Processed a return for online order #${m[0].match(/\d+/)?.[0] || ""}`],
  ["PATCH", /^\/api\/online-orders\/(\d+)$/, m => `Updated online order #${m[1]}`],
  ["DELETE", /^\/api\/online-orders\/(\d+)$/, m => `Deleted online order #${m[1]}`],
  ["POST", /^\/api\/products$/, () => "Added a product"],
  ["PATCH", /^\/api\/products\/(\d+)$/, m => `Edited product ${db.prepare("SELECT name FROM products WHERE id=?").get(Number(m[1]))?.name || "#" + m[1]}`],
  ["DELETE", /^\/api\/products\/(\d+)$/, m => `Removed product #${m[1]}`],
  ["POST", /^\/api\/users$/, () => "Added a team account"],
  ["PATCH", /^\/api\/users\/(\d+)$/, m => `Changed account ${db.prepare("SELECT username FROM users WHERE id=?").get(Number(m[1]))?.username || "#" + m[1]}`],
  ["DELETE", /^\/api\/users\/(\d+)$/, m => `Removed account #${m[1]}`],
  ["POST", /^\/api\/backups$/, () => "Made a manual backup"],
  ["DELETE", /^\/api\/backups\/(shop-\d{4}-\d{2}-\d{2}(?:-\d{6,13})?\.sqlite3)$/, m => `Deleted backup ${m[1]}`],
  ["POST", /^\/api\/fresh-start$/, () => "Prepared a fresh shop setup (backup created)"]
];
function logActivity(user, method, route) {
  if (/^\/api\/(login|logout|setup|auth)/.test(route)) return;
  try {
    const hit = ACTIONS.find(([m, re]) => m === method && re.test(route));
    const text = hit ? hit[2](route.match(hit[1])) : `${method} ${route.replace("/api/", "")}`;
    db.prepare("INSERT INTO activity_log(username,action) VALUES(?,?)").run(user.username, text);
    db.prepare("DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - 20000").run();
  } catch { /* logging must never break a request */ }
}
// Scheduled backup of the whole database (consistent copy, safe while the shop is running). Keeps the newest 14.
let backupDir = db.prepare("SELECT directory FROM backup_schedule WHERE id=1").get()?.directory || process.env.SHOP_BACKUP_DIR || join(dataDir, "backups");
function runBackup(reason) {
  mkdirSync(backupDir, { recursive: true });
  const dailyName = `shop-${today()}.sqlite3`;
  if (reason === "auto" && existsSync(join(backupDir, dailyName))) return dailyName;
  let suffix = Date.now();
  let name = reason === "auto" ? dailyName : `shop-${today()}-${suffix}.sqlite3`;
  while (existsSync(join(backupDir, name))) name = `shop-${today()}-${++suffix}.sqlite3`;
  const file = join(backupDir, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const files = readdirSync(backupDir).filter(name => /^shop-\d{4}-\d{2}-\d{2}(?:-\d{6,13})?\.sqlite3$/.test(name)).sort();
  files.slice(0, Math.max(0, files.length - 14)).forEach(name => rmSync(join(backupDir, name), { force: true }));
  return name;
}
// ---- Google Drive offsite backups ----
const googleClientId = String(process.env.SHOP_GOOGLE_CLIENT_ID || "").trim();
const googleClientSecret = String(process.env.SHOP_GOOGLE_CLIENT_SECRET || "").trim();
const backupKeyMaterial = loadBackupKeyMaterial(dataDir);
const offsiteRedirectUri = String(process.env.SHOP_OAUTH_REDIRECT || "").trim() ||
  (publicBaseUrl ? `${publicBaseUrl}/api/backups/offsite/oauth/callback` : `http://localhost:${typeof port === "number" ? port : 8765}/api/backups/offsite/oauth/callback`);
const driveClient = new GoogleDriveBackup({
  clientId: googleClientId, clientSecret: googleClientSecret, redirectUri: offsiteRedirectUri, keyMaterial: backupKeyMaterial,
  endpoints: {
    auth: process.env.SHOP_GOOGLE_AUTH_URL,
    token: process.env.SHOP_GOOGLE_TOKEN_URL,
    files: process.env.SHOP_GOOGLE_FILES_URL,
    upload: process.env.SHOP_GOOGLE_UPLOAD_URL
  }
});
const offsiteRow = () => db.prepare("SELECT * FROM offsite_backup WHERE id=1").get();
function logSystem(action) { try { db.prepare("INSERT INTO activity_log(username,action) VALUES('system',?)").run(action); } catch { /* logging must never break a request */ } }
function offsitePublic() {
  const row = offsiteRow() || {};
  let connected = false;
  if (row.connection) { try { decryptSecret(row.connection, backupKeyMaterial); connected = true; } catch { connected = false; } }
  return {
    configured: driveClient.configured, connected, email: row.connected_email || "",
    enabled: Boolean(row.enabled), keep: row.keep || DEFAULT_KEEP, folderName: row.folder_name || DEFAULT_FOLDER_NAME,
    lastAttemptAt: row.last_attempt_at || null, lastSuccessAt: row.last_success_at || null,
    lastError: row.last_error || "", lastFile: row.last_file || "", redirectUri: offsiteRedirectUri, encrypted: true
  };
}
function saveOffsiteTokens(tokens) {
  db.prepare("UPDATE offsite_backup SET connection=? WHERE id=1").run(encryptSecret(tokens, backupKeyMaterial));
}
function offsiteTokens() {
  const row = offsiteRow();
  if (!row?.connection) throw new Error("Google Drive is not connected yet.");
  return decryptSecret(row.connection, backupKeyMaterial);
}
async function freshOffsiteTokens() {
  let tokens = offsiteTokens();
  if (!tokens.accessToken || Number(tokens.expiresAt || 0) <= Date.now()) {
    tokens = await driveClient.refresh(tokens);
    saveOffsiteTokens(tokens);
  }
  return tokens;
}
async function withDrive(action) {
  let tokens = await freshOffsiteTokens();
  try { return await action(tokens); }
  catch (error) {
    if (error.code === "reauth" || error.status === 401) {
      tokens = await driveClient.refresh(tokens);
      saveOffsiteTokens(tokens);
      return await action(tokens);
    }
    throw error;
  }
}
async function uploadOffsite(reason = "auto") {
  const row = offsiteRow();
  if (!row) throw new Error("Offsite backup is not set up.");
  if (reason !== "manual" && !row.enabled) throw new Error("Offsite backup is turned off.");
  if (!row.connection) throw new Error("Connect Google Drive first.");
  db.prepare("UPDATE offsite_backup SET last_attempt_at=?, last_error='' WHERE id=1").run(new Date().toISOString());
  try {
    const localName = runBackup("offsite");
    const plain = readFileSync(join(backupDir, localName));
    const shopName = db.prepare("SELECT shop_name FROM settings WHERE id=1").get()?.shop_name || "shop";
    const payload = prepareOffsitePayload({ dbBuffer: plain, keyMaterial: backupKeyMaterial, shopName });
    const uploaded = await withDrive(async tokens => {
      const folderId = await driveClient.folderId(tokens, row.folder_name || DEFAULT_FOLDER_NAME);
      const file = await driveClient.upload(tokens, { name: payload.name, buffer: payload.buffer, folderId });
      await driveClient.prune(tokens, folderId, row.keep || DEFAULT_KEEP);
      return file;
    });
    const fileName = uploaded?.name || payload.name;
    db.prepare("UPDATE offsite_backup SET last_success_at=?, last_error='', last_file=? WHERE id=1").run(new Date().toISOString(), fileName);
    logSystem(`Uploaded an encrypted offsite backup (${reason})`);
    return { file: fileName, bytes: payload.encryptedBytes, localBackup: localName, encrypted: true };
  } catch (error) {
    db.prepare("UPDATE offsite_backup SET last_error=? WHERE id=1").run(String(error.message).slice(0, 500));
    logSystem(`Offsite backup failed: ${String(error.message).slice(0, 200)}`);
    throw error;
  }
}
let offsiteRunning = false;
async function offsiteTick() {
  if (offsiteRunning) return;
  const row = offsiteRow();
  if (!row?.enabled || !row.connection) return;
  const now = Date.now();
  const lastSuccess = row.last_success_at ? Date.parse(row.last_success_at) : 0;
  const lastAttempt = row.last_attempt_at ? Date.parse(row.last_attempt_at) : 0;
  if (now - lastSuccess < 20 * 3600 * 1000) return; // one successful upload a day is enough
  if (now - lastAttempt < 3600 * 1000) return; // retry failures at most hourly
  offsiteRunning = true;
  try { await uploadOffsite("auto"); }
  catch (error) { console.error("Offsite backup failed:", error.message); }
  finally { offsiteRunning = false; }
}
setInterval(() => { offsiteTick(); }, 15 * 60 * 1000).unref();
setTimeout(() => { offsiteTick(); }, 90 * 1000).unref();

const scheduledBackup = () => {
  const schedule = db.prepare("SELECT enabled,time,directory,last_run_date,last_run_time,last_run_directory FROM backup_schedule WHERE id=1").get();
  if (!schedule?.enabled) return;
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const date = today();
  if (currentTime < schedule.time || (schedule.last_run_date === date && schedule.last_run_time === schedule.time && schedule.last_run_directory === backupDir)) return;
  try {
    runBackup("auto");
    db.prepare("UPDATE backup_schedule SET last_run_date=?,last_run_time=?,last_run_directory=?,last_backup_at=? WHERE id=1").run(date, schedule.time, backupDir, now.toISOString());
    console.info(`Scheduled backup completed at ${now.toLocaleString()}.`);
  } catch (error) { console.error("Scheduled backup failed:", error.message); }
};
scheduledBackup();
setInterval(scheduledBackup, 30000).unref();

const server = createServer(async (request, response) => {
  const allowEmbed = process.env.SHOP_ALLOW_EMBED === "1";
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!allowEmbed) response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  if (isSecureRequest(request)) response.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (request.url === "/healthz") { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("ok"); return; }
  response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'${allowEmbed ? "" : "; frame-ancestors 'none'"}`);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try { await handleApi(request, response, url); }
    catch (error) {
      console.error("Request error:", error);
      if (!response.headersSent) json(response, 400, { error: error.message || "The request could not be completed." });
      else response.destroy();
    }
    return;
  }
  let requested;
  try {
    requested = url.pathname === "/" ? "index.html"
      : url.pathname === "/join" ? "join.html"
      : decodeURIComponent(url.pathname.slice(1));
  }
  catch { response.writeHead(400).end("Bad request"); return; }
  // Serve only the app's public files; never expose the SQLite database, backups, logs, or source tree.
  const publicFiles = ["index.html", "app.js", "styles.css", "join.html", "manifest.webmanifest", "sw.js", "offline.html"];
  const publicFolder = /^(icons|i18n|fonts)\/[A-Za-z0-9._-]+$/.test(requested);
  if (!publicFiles.includes(requested) && !publicFolder) return response.writeHead(404).end("Not found");
  const file = normalize(join(root, requested));
  const relativePath = relative(root, file);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return response.writeHead(404).end("Not found");
  let contents;
  try {
    contents = readFileSync(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const headers = {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    "Cache-Control": requested === "sw.js" ? "no-cache, no-store, must-revalidate" : "no-cache"
  };
  if (requested === "sw.js") headers["Service-Worker-Allowed"] = "/";
  if (requested === "join.html") {
    const info = connectInfo();
    const lanList = info.urls.map((address, index) => `<li><a href="${escapeHtml(address)}">${escapeHtml(address)}${index === 0 ? " <span>প্রধান</span>" : ""}</a></li>`).join("");
    contents = contents.toString("utf8")
      .replace("{{SHOP_NAME}}", escapeHtml(info.shopName))
      .replace("{{LAN_LIST}}", lanList);
  }
  response.writeHead(200, headers);
  response.end(contents);
});

const onListening = () => {
  console.log(`Shop Desk is running on ${typeof port === "number" ? `${host}:${port}` : "the host's application socket"}${trustProxy ? " (behind HTTPS proxy)" : ""}`);
  const info = connectInfo();
  console.log(`Phones and tablets on the shop Wi-Fi can open: ${info.primary}`);
  console.log(`SQLite database: ${join(dataDir, "shop.sqlite3")}`);
  console.log("Press Ctrl+C to stop the server.");
};
if (typeof port === "number") server.listen(port, host, onListening); else server.listen(port, onListening);

// Flush the SQLite write-ahead log cleanly when the host stops or restarts the app.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  server.close();
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
