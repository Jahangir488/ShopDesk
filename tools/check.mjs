#!/usr/bin/env node
// Fast sanity checks that run without any npm packages:
//   npm run check
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeQr, qrSvg } from "../lib/qr.mjs";
import { buildMedexSearchUrl, getMedexCatalogStats, normalizeMedexUrl, parseMedexDetailsHtml, parseMedexSearchHtml, searchLocalMedexCatalog } from "../lib/medex.mjs";
import { decryptBuffer, encryptBuffer } from "../lib/offsite.mjs";
import { compareVersions, parseManifest, signManifest, verifyManifest } from "../lib/release.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = message => console.log(`  ok  ${message}`);
const fail = message => { failures++; console.error(` FAIL ${message}`); };

console.log("Syntax");
const files = ["server.mjs", "app.js", "sw.js", ...readdirSync(join(root, "lib")).filter(name => name.endsWith(".mjs")).map(name => join("lib", name)), ...readdirSync(join(root, "tools")).filter(name => name.endsWith(".mjs")).map(name => join("tools", name))];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status === 0) ok(file); else fail(`${file}: ${result.stderr.split("\n")[0]}`);
}

console.log("Responsive header");
try {
  const css = readFileSync(join(root, "styles.css"), "utf8");
  const topbar = css.match(/\.topbar\{([^}]+)\}/)?.[1] || "";
  if (!topbar.includes("height:auto") || !topbar.includes("min-height:58px") || !topbar.includes("flex-wrap:wrap")) fail("topbar must grow when browser zoom or narrow width wraps its controls");
  ok("header can grow instead of clipping wrapped controls");
} catch (error) { fail("responsive header: " + error.message); }

console.log("Translations");
try {
  const bn = JSON.parse(readFileSync(join(root, "i18n", "bn.json"), "utf8"));
  const en = JSON.parse(readFileSync(join(root, "i18n", "en.json"), "utf8"));
  const entries = Object.entries(bn.strings || {});
  const empty = entries.filter(([, value]) => !String(value || "").trim());
  if (empty.length) fail(`empty translations: ${empty.map(([key]) => key).join(", ")}`);
  for (const rule of bn.patterns || []) { try { new RegExp(rule.re); } catch { fail(`bad pattern: ${rule.re}`); } }
  if (!en.strings) fail("en.json needs a strings object");
  ok(`${entries.length} Bangla strings, ${(bn.patterns || []).length} patterns`);
} catch (error) { fail("i18n JSON: " + error.message); }

console.log("Manifest and icons");
try {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
  for (const field of ["name", "short_name", "start_url", "display", "icons"]) if (!manifest[field]) fail(`manifest missing ${field}`);
  for (const icon of manifest.icons) {
    const exists = readdirSync(join(root, "icons")).includes(icon.src.split("/").pop());
    if (!exists) fail(`missing icon file ${icon.src}`);
  }
  ok(`${manifest.icons.length} icons, display=${manifest.display}`);
} catch (error) { fail("manifest: " + error.message); }

console.log("Release manifest");
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = {
    product: "Shop Desk", version: "12.0.1", released: new Date().toISOString(),
    url: "https://downloads.example.com/ShopDesk-12.0.1.zip",
    sha256: "a".repeat(64), size: 123, minVersion: "11.0.0", notes: "check"
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = signManifest(bytes, privateKey);
  const parsed = parseManifest(bytes, signature, { publicKey });
  if (!parsed.valid) fail("signed release manifest rejected");
  const changed = Buffer.from(bytes.toString("utf8").replace("12.0.1", "12.0.9"));
  if (verifyManifest(changed, signature, { publicKey }).valid) fail("tampered manifest accepted");
  if (compareVersions("12.0.10", "12.0.9") <= 0 || compareVersions("12.0.0", "12.0.1") >= 0) fail("version comparison");
  ok("Ed25519 release manifest, tamper detection and versions");
} catch (error) { fail("release manifest: " + error.message); }

console.log("Pharmacy workflow and no licensing gates");
try {
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const app = readFileSync(join(root, "app.js"), "utf8");
  for (const removed of ["lib/license.mjs", "lib/license-public.mjs", "LICENSING.md", "3 - Build Licence Kit.bat", "4 - Issue Customer Licence.bat", "tools/license-issue.mjs", "tools/license-keygen.mjs", "tools/supplier-licence.mjs", "tools/licence-kit.mjs", "tools/make-licence-kit.mjs"]) {
    if (existsSync(join(root, removed))) fail(`removed licensing file still exists: ${removed}`);
  }
  for (const forbidden of ["/api/license", "licenseStatus", "verifyLicense", "signLicense", "licensedFeatureEnabled", "shopTypeLocked"]) {
    if (server.includes(forbidden) || app.includes(forbidden)) fail(`licensing token still present: ${forbidden}`);
  }
  for (const token of ["medicine_batches", "medicine_batch_sales", "pharmacyAvailableQty", "allocatePharmacyBatchStock", "quarantinePharmacyReturn", "/api/pharmacy/medex", "/api/restaurant/packages", "can_food_packages"]) {
    if (!server.includes(token)) fail(`server is missing Pharmacy/Restaurant safeguard: ${token}`);
  }
  for (const token of ["openPharmacyBatchManager", "openPharmacyMedicineLookup", "mountMedexLookupBox", "bulkInventoryTemplateConfig", "pharmacy-inventory-template.csv", "restaurant-inventory-template.csv", "Food & restaurant", "openFoodPackageManager", "openFoodPackageEditor", "purchase-batch", "genericName", "expiryDate", "productSellableQty"]) {
    if (!app.includes(token)) fail(`Pharmacy/Restaurant interface is missing ${token}`);
  }
  if (buildMedexSearchUrl("Napa 500") !== "https://medex.com.bd/search?search=Napa+500") fail("MedEx search URL builder failed");
  if (normalizeMedexUrl("https://evil.example.com/brands/1") !== "") fail("MedEx URL validation accepted non-MedEx host");
  const sampleSearch = parseMedexSearchHtml(`<a href="https://medex.com.bd/brands/1019/napa-500-mg-tablet" class="hoverable-block"><div class="col-xs-12 data-row-top">Napa <span class="inline-dosage-form">Tablet</span></div><div class="col-xs-12 data-row-strength"><span class="grey-ligten">500 mg</span></div><div class="col-xs-12">Paracetamol</div><div class="col-xs-12 data-row-company">Beximco Pharmaceuticals Ltd.</div></a>`);
  if (sampleSearch.length !== 1 || sampleSearch[0].name !== "Napa" || sampleSearch[0].dosageForm !== "Tablet" || sampleSearch[0].strength !== "500 mg" || sampleSearch[0].genericName !== "Paracetamol") {
    fail("MedEx search HTML parser failed");
  }
  const sampleDetails = parseMedexDetailsHtml(`<h1>Napa <small class="h1-subtitle">Tablet</small></h1><div title="Generic Name">Paracetamol</div><div title="Strength">500 mg</div><div title="Manufactured by">Beximco Pharmaceuticals Ltd.</div><div class="package-container">Unit Price: ৳ 1.20</div><h3 class="ac-header">Indications</h3><div class="ac-body">Fever and mild to moderate pain.</div>`, "https://medex.com.bd/brands/1019/napa-500-mg-tablet");
  if (!sampleDetails || sampleDetails.unitPrice !== 1.2 || sampleDetails.sections.length !== 1 || sampleDetails.sections[0].title !== "Indications") {
    fail("MedEx details HTML parser failed");
  }
  const catalogStats = getMedexCatalogStats();
  if (catalogStats.totalMedicines < 19000 || catalogStats.totalMonographs < 100) {
    fail(`bundled MedEx catalog incomplete: ${JSON.stringify(catalogStats)}`);
  }
  const napaResults = searchLocalMedexCatalog("Napa");
  if (!napaResults.some(item => item.name === "Napa" && item.genericName === "Paracetamol")) {
    fail("bundled MedEx catalog search for Napa failed");
  }
  ok(`licensing removed, shop types unlocked, Pharmacy batch flows and MedEx catalog (${catalogStats.totalMedicines} medicines) intact`);
} catch (error) { fail("Pharmacy workflow: " + error.message); }

console.log("Restaurant receipt and shop-type categories");
try {
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const app = readFileSync(join(root, "app.js"), "utf8");
  if (!server.includes("SELECT id,name FROM categories WHERE shop_type=?")) fail("state must only return categories for the active shop type");
  if (!server.includes("INSERT INTO categories(name,shop_type) VALUES(?,?)")) fail("custom categories must be assigned to the active shop type");
  const start = app.indexOf("function restaurantBillHtml(bill) {");
  const end = app.indexOf("\nfunction billHtml(bill) {", start);
  if (start < 0 || end < 0) throw new Error("restaurantBillHtml is missing");
  const source = app.slice(start, end);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const money = value => `৳${Number(value).toFixed(2)}`;
  const fmtQty = (qty, unit) => `${qty} ${unit}`;
  const billNo = id => `B-${String(id).padStart(8, "0")}`;
  const data = { shopName: "Test Restaurant", workspace: "Dhaka", contactNumber: "01700000000", locale: "en-BD" };
  const bill = { id: 7, created_at: "2026-10-27 10:00:00", customer: "", phone: "", cashier: "admin", payment: "Cash", payments: [{ method: "Cash", amount: 430 }], paid: 430, due: 0, total: 430, discount: 0, tax_amount: 0, lines: [
    { name: "Rice + Chicken + Vegetables Package (Portion: 1:1 · Type: Package Counter · Prep: Standard lunch · Kitchen: Plain Rice + Chicken Curry + Mixed Vegetables)", category: "Combo Meals", brand: "Plain Rice + Chicken Curry + Mixed Vegetables", color: "Standard lunch", size: "1:1", unit: "package", qty: 2, price: 180 },
    { name: "Chicken Fry (Portion: Full · Type: Chicken · Prep: Spicy)", category: "Main Course", material: "Chicken", color: "Spicy", size: "Full", unit: "plate", qty: 1, price: 70 }
  ] };
  const html = new Function("data", "esc", "money", "fmtQty", "billNo", "bill", `${source}\nreturn restaurantBillHtml(bill);`)(data, esc, money, fmtQty, billNo, bill);
  for (const token of ["RESTAURANT RECEIPT", "width:72mm", ">Item</th>", ">Qty</th>", ">Rate</th>", ">Amount</th>", "Includes:", "Rice + Chicken + Vegetables Package</b>", "Thank you for dining with us!"]) {
    if (!html.includes(token)) fail(`restaurant receipt is missing ${token}`);
  }
  for (const token of ["Type: Package Counter", "(Portion: 1:1", "Thank you for shopping with us!"]) {
    if (html.includes(token)) fail(`restaurant receipt contains unwanted generic content: ${token}`);
  }
  ok("shop-type category filtering and dedicated 80mm restaurant receipt");
} catch (error) { fail("Restaurant receipt/categories: " + error.message); }

console.log("Returns, net sales, and profit");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const html = readFileSync(join(root, "index.html"), "utf8");
  const start = app.indexOf("function summarizeSales(sales) {");
  const end = app.indexOf("\nfunction renderReport() {", start);
  if (start < 0 || end < 0) throw new Error("summarizeSales is missing");
  const source = app.slice(start, end);
  const sales = [
    { original_total: 200, original_cost: 100, total: 0, cost: 0, original_tax_amount: 20, tax_amount: 0 },
    { original_total: 100, original_cost: 60, total: 50, cost: 30, original_tax_amount: 10, tax_amount: 5 },
    { original_total: 80, original_cost: 40, total: 80, cost: 40, original_tax_amount: 0, tax_amount: 0 }
  ];
  const summary = new Function("sales", `${source}\nreturn summarizeSales(sales);`)(sales);
  const expected = { grossSales: 380, returnedValue: 250, netSales: 130, profitBeforeReturns: 180, returnedProfit: 120, profitAfterReturns: 60, returnedTax: 25, netTax: 5 };
  for (const [key, value] of Object.entries(expected)) if (Math.abs(summary[key] - value) > 0.000001) fail(`${key}: expected ${value}, got ${summary[key]}`);
  const fullReturn = new Function("sales", `${source}\nreturn summarizeSales(sales);`)([sales[0]]);
  if (fullReturn.netSales !== 0 || fullReturn.netCost !== 0 || fullReturn.profitAfterReturns !== 0) fail("a fully returned item must contribute zero net sales, cost, and profit");
  for (const id of ["dashboard-returns-total", "dashboard-refunds-total", "today-sales-breakdown", "today-profit-breakdown", "report-returns", "report-net-sales"]) {
    if (!html.includes(`id="${id}"`)) fail(`return/profit summary element is missing: ${id}`);
  }
  ok("returns reduce sales and profit correctly; gross, returns, net sales, and refunded totals are visible");
} catch (error) { fail("Returns/profit: " + error.message); }

console.log("Sales history overview and filters");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const html = readFileSync(join(root, "index.html"), "utf8");
  const sales = [
    { id: 1, payment: "Cash", returned_qty: 0, original_total: 200, original_cost: 100, total: 200, cost: 100 },
    { id: 2, payment: "Due", returned_qty: 1, original_total: 100, original_cost: 60, total: 50, cost: 30 }
  ];
  const summarizeStart = app.indexOf("function summarizeSales(sales) {");
  const summarizeEnd = app.indexOf("\nfunction summarizeOnlineDashboard", summarizeStart);
  const summaryStart = app.indexOf("function salesSummaryHtml(sales, filtering = false) {");
  const summaryEnd = app.indexOf("\nfunction salesQuickFilterMatches", summaryStart);
  const filterStart = app.indexOf("function salesQuickFilterMatches(sale, filter) {");
  const filterEnd = app.indexOf("\nfunction renderSalesQuickFilters", filterStart);
  if ([summarizeStart, summarizeEnd, summaryStart, summaryEnd, filterStart, filterEnd].some(index => index < 0)) throw new Error("sales history summary/filter helpers are missing");
  const summaryHtml = new Function("sales", "t", "localizeDigits", "money", `${app.slice(summarizeStart, summarizeEnd)}\n${app.slice(summaryStart, summaryEnd)}\nreturn salesSummaryHtml(sales, true);`)(sales, value => value, String, value => `৳${value}`);
  for (const token of ["Sale lines", "Gross sales", "Returned value", "Net sales after returns", "Profit after returns", "<b>2</b>", "<b>৳300</b>", "<b>৳50</b>", "<b>৳250</b>", "<b>৳120</b>"]) {
    if (!summaryHtml.includes(token)) fail(`sales history summary is missing ${token}`);
  }
  const matches = new Function("sale", "filter", `${app.slice(filterStart, filterEnd)}\nreturn salesQuickFilterMatches(sale, filter);`);
  if (!matches(sales[0], "") || !matches(sales[0], "all") || !matches(sales[0], "payment:Cash") || matches(sales[0], "payment:Due")) fail("sales payment quick filter failed");
  if (!matches(sales[1], "returned") || matches(sales[0], "returned") || !matches(sales[1], "payment:Due")) fail("sales return quick filter failed");
  for (const token of ["data-sales-quick-filter", "salesQuickFilterMatches(s, salesQuickFilter)", "salesSummaryHtml(matchingSales, filtering)", "salesQuickFilter = \"\"; filterSales()", "currentMatchingSales.map"]) {
    if (!app.includes(token)) fail(`sales history filtering/printing is missing ${token}`);
  }
  for (const id of ["sales-summary", "sales-quick-filters", "sales-table"]) if (!html.includes(`id="${id}"`)) fail(`sales history element is missing: ${id}`);
  if (!(html.indexOf('id="sales-summary"') < html.indexOf('id="sales-quick-filters"') && html.indexOf('id="sales-quick-filters"') < html.indexOf('class="table-scroll sales-scroll"'))) fail("sales summary and quick filters must appear above the history list");
  if (!html.includes('class="table-scroll sales-scroll" tabindex="0"')) fail("sales history list must remain keyboard-scrollable");
  ok("sales summary, payment/return filters, filtered printing, and detailed scrollable history are covered");
} catch (error) { fail("Sales history overview: " + error.message); }

console.log("Online sales dashboard");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const html = readFileSync(join(root, "index.html"), "utf8");
  const start = app.indexOf("function summarizeSales(sales) {");
  const end = app.indexOf("\nfunction renderReport() {", start);
  if (start < 0 || end < 0 || !app.includes("function summarizeOnlineDashboard(orders, sales, today)")) throw new Error("online dashboard summary is missing");
  const source = app.slice(start, end);
  const today = "2026-10-27", yesterday = "2026-10-26";
  const orders = [
    { id: 1, bill_id: 11, date: today, total: 500, due_cod: 100, order_status: "Delivered" },
    { id: 2, bill_id: 12, date: today, total: 300, due_cod: 300, order_status: "Shipped" },
    { id: 3, bill_id: null, date: yesterday, total: 200, due_cod: 200, order_status: "Pending" },
    { id: 4, bill_id: 13, date: yesterday, total: 400, due_cod: 0, order_status: "Returned" },
    { id: 5, bill_id: null, date: yesterday, total: 150, due_cod: 0, order_status: "Cancelled" }
  ];
  const sales = [
    { bill_id: 11, date: today, original_total: 400, original_cost: 200, total: 300, cost: 150 },
    { bill_id: 12, date: today, original_total: 250, original_cost: 100, total: 250, cost: 100 },
    { bill_id: 13, date: yesterday, original_total: 400, original_cost: 200, total: 0, cost: 0 },
    { bill_id: 99, date: today, original_total: 1000, original_cost: 500, total: 1000, cost: 500 }
  ];
  const summary = new Function("orders", "sales", "today", `${source}\nreturn summarizeOnlineDashboard(orders, sales, today);`)(orders, sales, today);
  const expected = { todayOrderCount: 2, todayOrderValue: 800, activeOrderCount: 2, activeCod: 500, pendingCount: 1, shippedCount: 1, deliveredCount: 1, returnedCount: 1, cancelledCount: 1 };
  for (const [key, value] of Object.entries(expected)) if (summary[key] !== value) fail(`${key}: expected ${value}, got ${summary[key]}`);
  const salesExpected = { grossSales: 650, returnedValue: 100, netSales: 550, profitBeforeReturns: 350, returnedProfit: 50, profitAfterReturns: 300 };
  for (const [key, value] of Object.entries(salesExpected)) if (Math.abs(summary.sales[key] - value) > 0.000001) fail(`online ${key}: expected ${value}, got ${summary.sales[key]}`);
  for (const id of ["dashboard-online-sales", "online-today-orders", "online-gross-sales", "online-returned-value", "online-net-sales", "online-profit-after-returns", "online-active-cod", "online-dashboard-status", "online-orders-show-all", "online-orders-list-meta", "dashboard-online-orders-list"]) {
    if (!html.includes(`id="${id}"`)) fail(`online dashboard element is missing: ${id}`);
  }
  const filterStart = app.indexOf("const ONLINE_DASHBOARD_STATUS_GROUPS = [");
  const filterEnd = app.indexOf("\nfunction renderOnlineDashboard", filterStart);
  if (filterStart < 0 || filterEnd < 0) throw new Error("online dashboard status filter is missing");
  const filterSource = app.slice(filterStart, filterEnd);
  const filterOrders = new Function("orders", "statusFilter", `${filterSource}\nreturn onlineDashboardOrdersForStatus(orders, statusFilter);`);
  const filterFixture = [...orders,
    { id: 6, order_status: "Confirmed" },
    { id: 7, order_status: "Processing" }
  ];
  const filteredIds = status => filterOrders(filterFixture, status).map(order => order.id);
  const filterExpected = { "": [1, 2, 3, 4, 5, 6, 7], pending: [3], processing: [6, 7], shipped: [2], delivered: [1], returned: [4], cancelled: [5] };
  for (const [status, expectedIds] of Object.entries(filterExpected)) {
    if (JSON.stringify(filteredIds(status)) !== JSON.stringify(expectedIds)) fail(`online status filter ${status || "all"} returned ${filteredIds(status)}`);
  }
  for (const token of ["data-online-status-filter", "data-online-show-all", "aria-pressed", "dashboardOnlineStatusFilter !== nextFilter"]) {
    if (!app.includes(token)) fail(`online dashboard status controls are missing ${token}`);
  }
  const css = readFileSync(join(root, "styles.css"), "utf8");
  const listRule = css.match(/\.dashboard-online-orders-list\s*\{([^}]+)\}/)?.[1] || "";
  if (!listRule.includes("max-height:") || !listRule.includes("overflow-y: auto")) fail("dashboard online orders must have a bounded, vertically scrollable list");
  if (app.includes("const recent = orders.slice(0, 5)")) fail("dashboard online orders must not discard orders beyond the first five");
  ok("online orders, linked sales, returns, profit, statuses, active COD, clickable filters, and scrolling are covered");
} catch (error) { fail("Online sales dashboard: " + error.message); }

console.log("Install files");
try {
  const required = [
    "INSTALL.md", "Dockerfile", "docker-compose.yml", ".env.example",
    "1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat",
    "install/windows/install-shopdesk.ps1", "install/windows/install-shopdesk.bat",
    "install/windows/update-shopdesk.ps1", "install/windows/uninstall-shopdesk.ps1",
    "install/windows/uninstall-shopdesk.bat",
    "install/windows/repair-shopdesk.ps1", "install/windows/repair-shopdesk.bat",
    "install/linux/install-shopdesk.sh", "install/linux/uninstall-shopdesk.sh", "install/linux/shopdesk.service",
    "join.html", "offline.html", "icons/shopdesk.ico", "tools/make-icons.mjs"
  ];
  const missing = required.filter(file => !existsSync(join(root, file)));
  if (missing.length) fail("missing install files: " + missing.join(", "));
  else ok(`${required.length} install and PWA files present`);
  // Batch files must keep Windows line endings; LF-only copies break cmd.exe blocks.
  for (const bat of ["1 - Install Shop Desk.bat", "2 - Uninstall Shop Desk.bat", "install/windows/install-shopdesk.bat", "install/windows/uninstall-shopdesk.bat", "install/windows/repair-shopdesk.bat"]) {
    const bytes = readFileSync(join(root, bat));
    if (!bytes.includes("\r\n") || bytes.toString("latin1").replace(/\r\n/g, "").includes("\n")) fail(`${bat} must use CRLF line endings`);
  }
  ok("batch files use CRLF line endings");
  const installer = readFileSync(join(root, "install", "windows", "install-shopdesk.ps1"), "utf8");
  for (const token of ["vendor", "*.pem"]) if (!installer.includes(token)) fail(`installer should exclude ${token}`);
  const updater = readFileSync(join(root, "install", "windows", "update-shopdesk.ps1"), "utf8");
  const linuxInstaller = readFileSync(join(root, "install", "linux", "install-shopdesk.sh"), "utf8");
  if (!installer.includes('"tools"')) fail("Windows installer must exclude tools");
  if (!updater.includes("tools")) fail("Windows updater must exclude tools");
  if (!linuxInstaller.includes("--exclude 'tools'")) fail("Linux installer must exclude tools");
  ok("customer installers exclude tools, vendor keys and PEM files");
  const ico = readFileSync(join(root, "icons", "shopdesk.ico"));
  const imageOffset = ico.readUInt32LE(18);
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 1 || ico[6] !== 0 || ico[7] !== 0) fail("Shop Desk Windows icon must be a single 256px ICO image");
  if (ico.subarray(imageOffset, imageOffset + 8).toString("hex") !== "89504e470d0a1a0a") fail("Shop Desk ICO image must contain a PNG payload");
  const offline = readFileSync(join(root, "offline.html"), "utf8");
  if (!offline.includes('src="/icons/icon-192.png"') || offline.includes("🏪")) fail("offline page must use the branded icon instead of an emoji");
  ok("custom PWA, offline and Windows shortcut icons");
} catch (error) { fail("install files: " + error.message); }

console.log("Windows scripts");
try {
  // Join-Path and Test-Path throw for a drive letter that does not exist (F: on a
  // PC without that drive), which stopped the installer before it did anything.
  const scripts = ["install-shopdesk.ps1", "repair-shopdesk.ps1", "uninstall-shopdesk.ps1", "update-shopdesk.ps1"];
  for (const name of scripts) {
    const text = readFileSync(join(root, "install", "windows", name), "utf8");
    if (/\bJoin-Path\s/.test(text)) fail(`${name} must use Join-SafePath; Join-Path throws when a drive letter is missing`);
    if (!text.includes("function Join-SafePath")) fail(`${name} is missing the Join-SafePath helper`);
    if (!text.includes("[System.IO.File]::Exists")) fail(`${name} is missing the .NET file checks`);
    if (/Test-Path\s+\(Join-/.test(text)) fail(`${name} checks a path with Test-Path`);
  }
  const installer = readFileSync(join(root, "install", "windows", "install-shopdesk.ps1"), "utf8");
  if (!installer.includes("if (Test-AppFile $candidate) { return $candidate }")) fail("the drive scan must use Test-AppFile");
  for (const name of ["install-shopdesk.ps1", "repair-shopdesk.ps1"]) {
    const text = readFileSync(join(root, "install", "windows", name), "utf8");
    if (!text.includes("function Write-UrlShortcut") || !text.includes("IconFile=$iconPath")) fail(`${name} must give the desktop shortcuts the Shop Desk icon`);
    if (!text.includes("http://127.0.0.1:$Port/")) fail(`${name} must use IPv4 loopback for the local desktop URL`);
  }
  if (!installer.includes('cd /d `"%~dp0app`"')) fail("the install launcher must run from the app directory containing server.mjs");
  const repair = readFileSync(join(root, "install", "windows", "repair-shopdesk.ps1"), "utf8");
  if (!repair.includes("$oldWorkingDir = 'cd /d \"%~dp0\"'") || !repair.includes("$runContents.Replace($oldWorkingDir, 'cd /d \"%~dp0app\"')")) fail("repair must migrate an existing run-shop.cmd to the app directory");
  if (!installer.includes("Waiting for the local server") || !installer.includes("timed out")) fail("the installer should show progress while checking server startup");
  if (!installer.includes("[System.IO.DriveInfo]::new") || !installer.includes("$drive.IsReady")) fail("the installer must reject a drive that is not ready");
  if (!installer.includes('"/R:2", "/W:2"')) fail("Robocopy must not retry a failed copy for hours");
  ok(`${scripts.length} Windows scripts probe drives, set the desktop icon and use IPv4 loopback`);
} catch (error) { fail("Windows scripts: " + error.message); }

console.log("QR code");
try {
  const matrix = encodeQr("http://192.168.0.10:8765/", { errorCorrectionLevel: "M" });
  if (matrix.length !== 25) fail(`unexpected QR size ${matrix.length}`);
  const svg = qrSvg("http://192.168.0.10:8765/");
  if (!svg.startsWith("<svg") || !svg.includes("<path")) fail("QR SVG output");
  ok(`version 2 QR (${matrix.length}x${matrix.length}) and SVG output`);
} catch (error) { fail("QR: " + error.message); }

console.log("Backup encryption");
try {
  const key = "check-key-0123456789";
  const source = Buffer.from("SQLite format 3\0payload");
  const sealed = encryptBuffer(source, key);
  if (!decryptBuffer(sealed, key).equals(source)) fail("encryption roundtrip");
  let rejected = false;
  try { decryptBuffer(sealed, "wrong-key-0123456789"); } catch { rejected = true; }
  if (!rejected) fail("wrong backup key was accepted");
  ok("AES-256-GCM roundtrip and wrong-key rejection");
} catch (error) { fail("backup encryption: " + error.message); }

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
