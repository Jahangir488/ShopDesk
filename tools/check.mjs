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

console.log("Modal save actions");
try {
  const app = readFileSync(join(root, "app.js"), "utf8"), start = app.indexOf("function openModal("), end = app.indexOf("function closeModal", start), modal = app.slice(start, end);
  if (start < 0 || end < 0 || !modal.includes('submit.classList.remove("hidden")') || !modal.includes("submit.disabled = false")) fail("a read-only modal can hide Save on the next Add/Receive form");
  if (!modal.includes('cancel.textContent = t("Cancel")')) fail("modal Close/Cancel labels can leak into the next form");
  if (!app.includes('$("#cancel-modal").textContent = t("Close")') || !app.includes('closeModal(); openPharmacyReceiveBatch();')) fail("Pharmacy batch list does not distinguish Close from Receive batch Save");
  ok("Batches & expiry is a read-only list; Receive batch and Add medicine always restore Save");
} catch (error) { fail("modal save actions: " + error.message); }

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

console.log("Bulk inventory CSV size and Category column");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const maxBytesExpression = app.match(/const BULK_INVENTORY_MAX_FILE_BYTES = ([^;]+);/)?.[1];
  const maxRowsExpression = app.match(/const BULK_INVENTORY_MAX_ROWS = ([^;]+);/)?.[1];
  const maxBytes = maxBytesExpression ? new Function(`return (${maxBytesExpression});`)() : 0;
  const maxRows = maxRowsExpression ? new Function(`return (${maxRowsExpression});`)() : 0;
  if (maxBytes < 25 * 1024 * 1024) fail("bulk inventory browser limit must allow at least 25 MB");
  if (maxRows < 25000) fail("bulk inventory browser limit must allow at least 25,000 rows");
  if (!server.includes("readJson(request, 64_000_000)")) fail("bulk inventory endpoint needs its larger bounded JSON body limit");
  if (!server.includes("body.rows.length > 25000")) fail("bulk inventory endpoint still has the old row limit");
  if (!app.includes('getCol(values, "category", "product category")')) fail("inventory CSV Category column is not mapped");
  if (!server.includes("seedCategory(category, currentShopType())")) fail("bulk categories must be created only for the active shop type");
  const parserStart = app.indexOf("function parseCsv(text) {");
  const parserEnd = app.indexOf("\n// <dialog>", parserStart);
  if (parserStart < 0 || parserEnd < 0) throw new Error("parseCsv is missing");
  const parseCsv = new Function(`${app.slice(parserStart, parserEnd)}\nreturn parseCsv;`)();
  const headers = ["Product ID", "Product Name", "SKU", "Selling Price", "Cost", "Quantity", "Low Stock Alert", "Unit", "Category", "Barcode", "Brand", "Smaller Unit", "Units per Pack"];
  const records = Array.from({ length: 22000 }, (_, index) => [
    "", `Bulk Product ${index} ${"N".repeat(170)}`, `BULK-${index}-${"S".repeat(80)}`,
    "12.50", "8.25", "2", "1", "piece",
    index === 0 ? "Bulk, Category" : index === 1 ? "নতুন ক্যাটাগরি" : "Bulk Category",
    `9${String(index).padStart(8, "0")}${"B".repeat(90)}`, "R".repeat(55), "", ""
  ]);
  const csvCell = value => `"${String(value ?? "").split('"').join('""')}"`;
  const csv = [headers, ...records].map(row => row.map(csvCell).join(",")).join("\r\n");
  if (Buffer.byteLength(csv, "utf8") <= 400000) throw new Error("large CSV fixture is not over 400 KB");
  if (Buffer.byteLength(csv, "utf8") > maxBytes) throw new Error("22,000-row CSV fixture exceeds the browser file-size limit");
  const parsed = parseCsv(csv);
  if (parsed.length !== records.length + 1) fail(`large CSV parsed ${parsed.length - 1} rows instead of ${records.length}`);
  if (parsed[1]?.[8] !== "Bulk, Category" || parsed[2]?.[8] !== "নতুন ক্যাটাগরি") fail("quoted or Bangla Category values were not preserved");
  ok(`${records.length} rows / ${(Buffer.byteLength(csv, "utf8") / 1024).toFixed(0)} KB CSV parsed; Category mapping and shop-type creation safeguards present`);
} catch (error) { fail("bulk inventory CSV: " + error.message); }

console.log("Pharmacy catalog import defaults and expiry hold");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  for (const token of [
    "const newPharmacyItem = isPharmacy && id === null;",
    "const price = newPharmacyItem && missingNumber(item.price) ? 0 : Number(item.price);",
    "const qty = newPharmacyItem && missingNumber(item.qty) ? 0 : Number(item.qty);",
    "const min = newPharmacyItem && missingNumber(item.min) ? 5 : Number(item.min);",
    "if (expiryDate && !validDate(expiryDate))",
    "const batchNumber = item.batchNumber || `LEGACY-${productId}`;",
    "expiry verification required before sale"
  ]) if (!server.includes(token)) fail(`Pharmacy catalog import safeguard is missing: ${token}`);
  if (!server.includes("WHERE product_id=? AND expiry_date<>'' AND expiry_date>=?")) fail("blank-expiry Pharmacy stock must remain unavailable for sale");
  if (!server.includes("!validText(item.batchNumber) || !validDate(item.expiryDate)")) fail("existing-medicine stock additions must retain dated-batch validation");
  if (!app.includes("Blank Selling Price, Cost, and Quantity on new medicines become 0; blank Low Stock Alert becomes 5.")) fail("Pharmacy blank-default confirmation is missing");
  if (!app.includes("legacyStockCount")) fail("Pharmacy upload must disclose rows held for expiry verification");
  ok("new-medicine blank defaults, generated LEGACY batches, existing-stock validation, and unknown-expiry sale hold present");
} catch (error) { fail("Pharmacy catalog import: " + error.message); }

console.log("Pharmacy Online Sales batch safety");
try {
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  if (server.includes("!pharmacyMode() && (user.id === ownerId()") || server.includes("Online-order stock handling is not enabled for Pharmacy yet")) fail("Pharmacy Online Orders permission is disabled");
  if (server.includes("Online-order returns are unavailable for Pharmacy")) fail("Pharmacy online returns are still disabled");
  for (const token of [
    "function deductOnlineOrderStock(",
    "function restoreOnlineOrderStock(",
    "function moveOnlineOrderAllocationsToSale(",
    "allocatePharmacyBatchStock(product.id, Number(line.qty), onlineOrderAllocationId(order.id, lineIndex))",
    "quarantinePharmacyReturn(linkedSale?.id || onlineOrderAllocationId(id, lineIndex)",
    "releasePharmacyBatchStock(allocationId, quantity, product, actor",
    "Use the Online Orders return action so returned medicines are quarantined"
  ]) if (!server.includes(token)) fail(`Pharmacy online-order batch safeguard is missing: ${token}`);
  ok("Pharmacy Online Orders stay enabled with FEFO allocation, bill transfer, cancellation release, and quarantined returns");
} catch (error) { fail("Pharmacy Online Sales: " + error.message); }

console.log("Pharmacy packaging, purchase conversion, and POS units");
try {
  const app = readFileSync(join(root, "app.js"), "utf8"), server = readFileSync(join(root, "server.mjs"), "utf8"), css = readFileSync(join(root, "styles.css"), "utf8");
  for (const token of ["sale_units TEXT NOT NULL DEFAULT '[]'", "function resolveMedicineSale(", "function resolveMedicinePurchase(", "resolveMedicineSale(item, product)", "resolveMedicinePurchase(body, product)", "Number(body.purchaseQuantity || 0) === 0", "saleUnit: line.saleUnit || \"\""]) {
    if (!server.includes(token)) fail(`Pharmacy unit server support is missing: ${token}`);
  }
  for (const token of ["function openMedicineProductForm(", "function readPharmacyUnitForm(", "function openPharmacyReceiveBatch(", "function medicinePurchaseUnits(", "purchaseUnit: selected?.name || product.unit", "saleQty: line.qty / unitOf(line).f"]) {
    if (!app.includes(token)) fail(`Pharmacy unit UI support is missing: ${token}`);
  }
  if (!css.includes(".pharmacy-purchase-calculator")) fail("Pharmacy purchase calculator styling is missing");
  if ((app.match(/line\.mode = selected\.key;/g) || []).length < 4) fail("POS unit changes do not consistently initialize one package and its configured price");
  const helperStart = server.indexOf("function parseMedicineUnits("), helperEnd = server.indexOf("function ensurePharmacyBatches", helperStart);
  const serverApi = new Function("validAmount", "httpError", `${server.slice(helperStart, helperEnd)}\nreturn { resolveMedicineSale, resolveMedicinePurchase };`)(
    value => Number.isFinite(Number(value)) && Number(value) >= 0,
    (status, message) => Object.assign(new Error(message), { status })
  );
  const serverProduct = { id: 1, name: "Napa", unit: "tablet", sale_units: JSON.stringify([{ name: "strip", factor: 10, price: 15 }, { name: "box", factor: 100, price: 140 }]), allow_loose: 0 };
  let looseBlocked = false;
  try { serverApi.resolveMedicineSale({ qty: 1, price: 2 }, serverProduct); } catch (error) { looseBlocked = error.status === 409; }
  if (!looseBlocked) fail("API requests without saleUnit bypass the loose-dispensing restriction");
  const serverSale = serverApi.resolveMedicineSale({ saleUnit: "strip", saleQty: 2, salePrice: 15 }, serverProduct);
  const serverPurchase = serverApi.resolveMedicinePurchase({ purchaseUnit: "box", purchaseQuantity: 5, purchasePrice: 500 }, { ...serverProduct, allow_loose: 1 });
  if (serverSale.qty !== 20 || serverSale.price !== 1.5 || serverPurchase.qty !== 500 || serverPurchase.cost !== 5) fail("server-side package sale/purchase conversion is wrong");
  const formStart = app.indexOf("function medicineUnitFormValues("), formEnd = app.indexOf("function attachPharmacyUnitCalculator", formStart);
  const formApi = new Function("esc", "money", "currencySymbol", `${app.slice(formStart, formEnd)}\nreturn { readPharmacyUnitForm };`)(String, value => `৳${Number(value)}`, () => "৳");
  const purchaseForm = new Map(Object.entries({ unit: "tablet", price: "2", supplierUnit: "box", innerUnit: "strip", innerPerSupplier: "10", basePerInner: "10", innerPrice: "15", supplierPrice: "140", allowLoose: "on", purchaseQuantity: "5", purchasePrice: "500" }));
  const converted = formApi.readPharmacyUnitForm(purchaseForm);
  if (converted.qty !== 500 || converted.cost !== 5 || converted.purchaseQuantity * converted.purchasePrice !== 2500) fail(`box/strip/tablet purchase conversion is wrong: ${JSON.stringify(converted)}`);
  if (converted.units[0].factor !== 10 || converted.units[1].factor !== 100 || converted.units[1].price !== 140) fail("package selling prices/factors are wrong");
  const emptyPurchase = new Map(purchaseForm); emptyPurchase.set("purchaseQuantity", "0");
  const emptyConfig = formApi.readPharmacyUnitForm(emptyPurchase);
  if (emptyConfig.qty !== 0 || emptyConfig.cost !== 0) fail("zero-stock medicine setup creates an accidental opening purchase");
  const syrupForm = new Map(Object.entries({ unit: "ml", price: "1.5", supplierUnit: "bottle", innerUnit: "", innerPerSupplier: "", basePerInner: "100", supplierPrice: "", allowLoose: "on", purchaseQuantity: "2", purchasePrice: "200" }));
  const syrup = formApi.readPharmacyUnitForm(syrupForm);
  if (syrup.qty !== 200 || syrup.cost !== 2 || syrup.units[0].price !== 150) fail("single-level bottle/ml conversion is wrong");
  const posStart = app.indexOf("const FRACTIONAL ="), posEnd = app.indexOf("const baseRender = render;", posStart);
  if (formStart < 0 || formEnd < 0 || posStart < 0 || posEnd < 0) throw new Error("Pharmacy unit helpers are missing");
  const posApi = new Function("data", "esc", "money", `${app.slice(posStart, posEnd)}\nreturn { pharmacyLineFields, unitOf, qtyCell, priceCell, lineDetail, lineUnits };`)(
    { shopType: "pharmacy" }, String, value => `৳${Number(value)}`
  );
  const product = { unit: "tablet", price: 2, allow_loose: true, medicine_units: [{ name: "strip", factor: 10, price: 15 }, { name: "box", factor: 100, price: 140 }] };
  const line = { unit: "tablet", packSize: 0, price: 1.5, qty: 20, max: 480, mode: "medicine:strip", ...posApi.pharmacyLineFields(product) };
  if (posApi.unitOf(line).f !== 10 || !posApi.qtyCell(line, 0).includes('value="2"') || !posApi.qtyCell(line, 0).includes('max="48"')) fail("POS strip quantity does not convert base tablets correctly");
  if (!posApi.priceCell(line, 0).includes('value="15"')) fail("POS strip price is not shown per strip");
  const detail = posApi.lineDetail({ unit: "tablet", qty: 20, price: 1.5, saleUnit: "strip", saleQty: 2, salePrice: 15, unitFactor: 10, packSize: 0 });
  if (!detail.includes("2 strip") || !detail.includes("20 tablet")) fail(`receipt does not preserve selected unit conversion: ${detail}`);
  const noLoose = { unit: "tablet", allowLoose: false, medicineUnits: product.medicine_units };
  if (posApi.lineUnits(noLoose).some(unit => unit.key === "base")) fail("disabled loose sales still appear in the POS unit list");
  ok("5 boxes calculate to 500 tablets; POS converts strips/boxes, preserves prices, blocks loose units, and supports bottle/ml purchases");
} catch (error) { fail("Pharmacy unit conversion: " + error.message); }

console.log("Large inventory rendering and completion feedback");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const html = readFileSync(join(root, "index.html"), "utf8");
  if (!server.includes("pharmacyAvailability.get(Number(product.id))") || !server.includes("GROUP BY product_id")) fail("Pharmacy availability must use one grouped query");
  if (server.includes("available_to_sell: pharmacyAvailableQty(product.id)")) fail("state still runs one Pharmacy availability query per product");
  if (!app.includes("toast(`Download complete: ${filename}`, 4000)")) fail("generated downloads need a completion message");
  if (!app.includes("toast(`Upload complete:")) fail("bulk inventory uploads need a completion message");
  if (!html.includes('id="inventory-pagination"')) fail("inventory pagination markup is missing");
  const start = app.indexOf("function renderInventoryProducts() {");
  const end = app.indexOf("\nconst LARGE_LIST_PAGE_SIZE", start);
  if (start < 0 || end < 0) throw new Error("renderInventoryProducts is missing");
  const element = (value = "") => ({ value, innerHTML: "", textContent: "", classList: { toggle() {} } });
  const elements = { "#search": element(), "#products-table": element(), "#products-empty": element(), "#inventory-pagination": element(), "#inventory-summary": element() };
  const products = Array.from({ length: 22000 }, (_, index) => ({ id: index + 1, name: `Product ${index + 1}`, sku: `SKU-${index + 1}`, barcode: "", unit: "piece", category: "Bulk", brand: "", color: "", size: "", material: "", price: 10, cost: 5, qty: 2, min: 1, icon: "📦" }));
  const data = { products, shopType: "general", permissions: {} };
  const api = new Function("$", "data", "signedInUser", "esc", "money", "productSellableQty", `const INVENTORY_PAGE_SIZE = 250; let inventoryPage = 1;\n${app.slice(start, end)}\nreturn { render: renderInventoryProducts, setPage: value => { inventoryPage = value; } };`)(
    selector => elements[selector], data, { permissions: {} }, String, value => `৳${Number(value)}`, product => Number(product.qty || 0)
  );
  api.render();
  const renderedRows = (elements["#products-table"].innerHTML.match(/<tr>/g) || []).length;
  if (renderedRows !== 250) fail(`large inventory rendered ${renderedRows} rows instead of 250`);
  if (!elements["#inventory-pagination"].innerHTML.includes("Page 1 of 88")) fail("large inventory page count is incorrect");
  if (!elements["#inventory-summary"].innerHTML.includes("22000 products")) fail("inventory summary no longer covers all products");
  api.setPage(2); api.render();
  if (!elements["#inventory-pagination"].innerHTML.includes("Showing 251–500 of 22000")) fail("inventory second page did not render the correct range");
  for (const shopType of ["general", "pharmacy", "restaurant", "clothing", "mobile", "hardware", "grocery"]) {
    data.shopType = shopType; api.setPage(1); api.render();
    const count = (elements["#products-table"].innerHTML.match(/<tr>/g) || []).length;
    if (count !== 250) fail(`${shopType} inventory rendered ${count} rows instead of 250`);
  }
  ok("22,000 products render 250 rows per page in every shop type; grouped Pharmacy availability and completion messages present");
} catch (error) { fail("large inventory rendering: " + error.message); }

console.log("Large data lists across all shop modules");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const html = readFileSync(join(root, "index.html"), "utf8");
  for (const id of ["sales-pagination", "online-orders-pagination", "repairs-pagination", "devices-pagination", "stock-watch-pagination", "dashboard-online-pagination", "expenses-pagination"]) {
    if (!html.includes(`id="${id}"`)) fail(`large-list pagination container is missing: ${id}`);
  }
  for (const token of [
    "tbody.innerHTML = page.visible.map(job => {",
    "body.innerHTML = page.visible.map(device => {",
    "tbody.innerHTML = page.visible.map(order => {",
    "const visibleOrders = page.visible;",
    "page.visible.map(item => `<tr><td class=\"product-cell\"",
    "$(\"#expenses-table\").innerHTML = page.visible.map(item =>"
  ]) {
    if (!app.includes(token)) fail(`large-list renderer is missing: ${token}`);
  }
  if (app.includes('$("#sales-table").innerHTML = localSaleGroups.map')) fail("Local Sales still renders every group before filtering");
  const helperStart = app.indexOf("const LARGE_LIST_PAGE_SIZE = 250;");
  const helperEnd = app.indexOf("\ndocument.addEventListener", helperStart);
  const filterStart = app.indexOf("function filterSales() {");
  const filterEnd = app.indexOf('\n["#sales-search"', filterStart);
  if (helperStart < 0 || helperEnd < 0 || filterStart < 0 || filterEnd < 0) throw new Error("shared pager or Local Sales renderer is missing");
  const element = (value = "") => ({ value, innerHTML: "", textContent: "", classList: { toggle() {} } });
  const elements = Object.fromEntries(["#sales-search", "#sales-from", "#sales-to", "#sales-table", "#sales-count", "#sales-summary", "#sales-empty", "#sales-pagination"].map(selector => [selector, element()]));
  const groups = Array.from({ length: 22000 }, (_, index) => ({ key: `sale:${index + 1}`, billId: 0, date: "2026-10-28", lines: [{ id: index + 1, product: `Product ${index + 1}`, payment: "Cash", original_total: 10, total: 10 }] }));
  const localApi = new Function("$", "data", "signedInUser", "groupLocalSales", "localSaleGroupTotals", "localSaleGroupHtml", "billNo", "money", `
    let currentMatchingSales = [], currentLocalSaleGroups = [];
    ${app.slice(helperStart, helperEnd)}
    ${app.slice(filterStart, filterEnd)}
    return { filterSales, getGroups: () => currentLocalSaleGroups, getSales: () => currentMatchingSales };
  `)(selector => elements[selector], { sales: groups, permissions: {} }, { permissions: {} }, value => value, () => ({ net: 0 }), () => "<tr>", String, Number);
  localApi.filterSales();
  const localRows = (elements["#sales-table"].innerHTML.match(/<tr>/g) || []).length;
  if (localRows !== 250) fail(`Local Sales rendered ${localRows} rows instead of 250`);
  if (localApi.getGroups().length !== 22000 || localApi.getSales().length !== 22000) fail("Local Sales totals/printing lost full filtered data");
  if (!elements["#sales-pagination"].innerHTML.includes("Page 1 of 88")) fail("Local Sales page count is incorrect");
  const stateStart = server.indexOf("function stateFor(user) {"), stateEnd = server.indexOf("\nconst mobileServiceEnabled", stateStart);
  const stateSource = server.slice(stateStart, stateEnd);
  for (const token of ["serviceJobPayments", "serviceJobParts", "WHERE job_id IN (${placeholders})"]) if (!stateSource.includes(token)) fail(`repair grouped query is missing: ${token}`);
  if (stateSource.includes(".all(job.id)")) fail("repair state still runs payment/parts queries per job");
  ok("Local Sales, Online Orders, Repairs, Devices, Stock Watch, dashboard orders, and Expenses use bounded rendering; repair queries are grouped");
} catch (error) { fail("all-module large data: " + error.message); }

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

console.log("Local Sales bill grouping and online separation");
try {
  const app = readFileSync(join(root, "app.js"), "utf8");
  const html = readFileSync(join(root, "index.html"), "utf8");
  const server = readFileSync(join(root, "server.mjs"), "utf8");
  const start = app.indexOf("function groupLocalSales(sales) {");
  const end = app.indexOf("\n// Weighed and measured items", start);
  if (start < 0 || end < 0) throw new Error("local sales grouping helpers are missing");
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const api = new Function("summarizeSales", "billNo", "t", "esc", "money", "localizeDigits", "dateLabel", `${app.slice(start, end)}\nreturn { groupLocalSales, localSaleGroupTotals, localSaleGroupHtml };`)(
    summarizeSalesForCheck, id => `B-${String(id).padStart(8, "0")}`, value => value, esc, value => `৳${Number(value)}`, String, value => value
  );
  function summarizeSalesForCheck(sales) {
    return (sales || []).reduce((sum, item) => {
      const gross = Number(item.original_total ?? item.total ?? 0), net = Number(item.total || 0), grossCost = Number(item.original_cost ?? item.cost ?? 0), netCost = Number(item.cost || 0);
      sum.grossSales += gross; sum.returnedValue += Math.max(0, gross - net); sum.netSales += net; sum.netTax += Number(item.tax_amount || 0);
      sum.profitAfterReturns += net - netCost; sum.profitBeforeReturns += gross - grossCost;
      return sum;
    }, { grossSales: 0, returnedValue: 0, netSales: 0, netTax: 0, profitAfterReturns: 0, profitBeforeReturns: 0 });
  }
  const sales = [
    { id: 4, bill_id: 12, online_order_linked: 1, date: "2026-10-27", product: "Online only", qty: 1, total: 999, payment: "Cash" },
    { id: 3, bill_id: 11, online_order_linked: 0, date: "2026-10-27", product: "Chicken", original_qty: 2, qty: 1, original_total: 220, total: 170, returned_qty: 1, original_remaining_qty: 1, product_id: 2, unit: "plate", payment: "Partial", bill_customer: "A customer", bill_phone: "01700", bill_total: 400, bill_returned: 50, bill_paid: 200 },
    { id: 2, bill_id: 11, online_order_linked: 0, date: "2026-10-27", product: "Rice", original_qty: 2, qty: 2, original_total: 180, total: 180, returned_qty: 0, original_remaining_qty: 2, product_id: 1, unit: "plate", payment: "Partial", bill_customer: "A customer", bill_phone: "01700", bill_total: 400, bill_returned: 50, bill_paid: 200 },
    { id: 1, bill_id: null, online_order_linked: 0, date: "2026-10-26", product: "Direct item", original_qty: 1, qty: 1, original_total: 80, total: 80, returned_qty: 0, unit: "piece", payment: "Due" }
  ];
  const groups = api.groupLocalSales(sales);
  if (groups.length !== 2 || groups[0].billId !== 11 || groups[0].lines.length !== 2 || groups[1].billId !== 0) fail("local sales must group bill lines and exclude online-linked bills");
  if (groups[0].lines.map(line => line.id).join(",") !== "2,3") fail("items inside a local bill must retain their original order");
  const totals = api.localSaleGroupTotals(groups[0]);
  if (totals.net !== 350 || totals.due !== 150 || totals.returned !== 50) fail(`local bill totals are wrong: ${JSON.stringify(totals)}`);
  const billHtml = api.localSaleGroupHtml(groups[0], true, true);
  for (const token of ["B-00000011", "A customer", "Rice", "Chicken", "Paid</span> ৳200", "Due</span> ৳150", "data-print-bill", "data-local-bill-action=\"receive\"", "data-sale-action=\"return\""]) {
    if (!billHtml.includes(token)) fail(`grouped local bill is missing ${token}`);
  }
  if ((billHtml.match(/class="local-sale-item"/g) || []).length !== 2 || (billHtml.match(/<tr>/g) || []).length !== 1) fail("a local bill must be one row containing all of its items");
  if (billHtml.includes("Online only") || billHtml.includes("B-00000012")) fail("online-linked bill leaked into Local Sales");
  if (!api.localSaleGroupHtml(groups[1], true, true).includes("Direct sale")) fail("unbilled direct local sales must remain visible");
  for (const token of ["Local Sales", "BILL / SALE", "CUSTOMER", "ITEMS", 'id="online-order-bills">Online bills']) if (!html.includes(token)) fail(`Local Sales markup is missing ${token}`);
  if (html.includes('id="sales-quick-filters"')) fail("the reverted sales quick-filter UI must not return");
  for (const token of ["online_order_linked", 'scope === "online"', 'scope === "local"', "NOT EXISTS(SELECT 1 FROM online_orders"]) if (!server.includes(token)) fail(`server-side local/online separation is missing ${token}`);
  for (const token of ["currentLocalSaleGroups", 'openBills(false, {}, "local")', 'openBills(false, {}, "online")', "filter(row => !Number(row.online_order_id || 0))"]) if (!app.includes(token)) fail(`local sales filtering/printing is missing ${token}`);
  ok("local bills group all items, direct sales remain, and online bills/returns stay separate");
} catch (error) { fail("Local Sales: " + error.message); }

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
