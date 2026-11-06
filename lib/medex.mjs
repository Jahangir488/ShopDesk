// MedEx Bangladesh (https://medex.com.bd/search) offline 19,590-medicine catalog
// (sourced from NasirSunny50/Bangladeshi-Medicine-API), optional data/medex.db
// SQLite reader, and live HTML parser/fallback for Pharmacy medicine lookup.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

export const MEDEX_BASE_URL = "https://medex.com.bd";
export const MEDEX_SEARCH_URL = "https://medex.com.bd/search";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_GZ_PATH = join(__dirname, "medex-catalog.json.gz");

let cachedCatalog = null;
function loadBundledCatalog() {
  if (cachedCatalog) return cachedCatalog;
  try {
    if (!existsSync(CATALOG_GZ_PATH)) {
      cachedCatalog = { brands: [], monographs: {}, byUrl: new Map(), byId: new Map() };
      return cachedCatalog;
    }
    const raw = gunzipSync(readFileSync(CATALOG_GZ_PATH)).toString("utf8");
    const parsed = JSON.parse(raw);
    const brands = Array.isArray(parsed.brands) ? parsed.brands : [];
    const monographs = parsed.monographs && typeof parsed.monographs === "object" ? parsed.monographs : {};
    const byUrl = new Map();
    const byId = new Map();
    for (const item of brands) {
      const fullUrl = `${MEDEX_BASE_URL}/brands/${item.u}`;
      item.fullUrl = fullUrl;
      item._bLower = String(item.b || "").toLowerCase();
      item._gLower = String(item.g || "").toLowerCase();
      item._sLower = String(item.s || "").toLowerCase();
      item._fLower = String(item.f || "").toLowerCase();
      item._cLower = String(item.c || "").toLowerCase();
      byUrl.set(fullUrl.toLowerCase(), item);
      byId.set(Number(item.i), item);
    }
    cachedCatalog = { brands, monographs, byUrl, byId };
    return cachedCatalog;
  } catch {
    cachedCatalog = { brands: [], monographs: {}, byUrl: new Map(), byId: new Map() };
    return cachedCatalog;
  }
}

export function getMedexCatalogStats() {
  const cat = loadBundledCatalog();
  return {
    totalMedicines: cat.brands.length,
    totalMonographs: Object.keys(cat.monographs).length
  };
}

const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&ndash;": "–",
  "&mdash;": "—",
  "&times;": "×",
  "&deg;": "°",
  "&plusmn;": "±",
  "&micro;": "µ"
};

export function decodeHtmlText(html = "") {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|times|deg|plusmn|micro|#39);/gi, match => ENTITY_MAP[match.toLowerCase()] || match)
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : "";
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export function cleanInlineText(html = "") {
  return decodeHtmlText(html).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function buildMedexSearchUrl(query = "") {
  const q = String(query || "").trim().slice(0, 120);
  if (!q) return MEDEX_SEARCH_URL;
  const url = new URL(MEDEX_SEARCH_URL);
  url.searchParams.set("search", q);
  return url.toString();
}

export function normalizeMedexUrl(rawUrl = "") {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, MEDEX_BASE_URL);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    const host = parsed.hostname.toLowerCase();
    if (host !== "medex.com.bd" && host !== "www.medex.com.bd") return "";
    parsed.protocol = "https:";
    parsed.hostname = "medex.com.bd";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractFirstMatch(html, regex) {
  const match = String(html || "").match(regex);
  return match ? cleanInlineText(match[1]) : "";
}

function extractUnitPrice(text = "") {
  const cleaned = String(text || "").replace(/,/g, "");
  const unitMatch = cleaned.match(/Unit\s*Price\s*:\s*৳?\s*([0-9]+(?:\.[0-9]+)?)/i)
    || cleaned.match(/^([0-9]+(?:\.[0-9]+)?)$/)
    || cleaned.match(/৳\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!unitMatch) return null;
  const num = Number(unitMatch[1]);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function formatCatalogItem(item) {
  const unitPrice = item.p != null ? extractUnitPrice(String(item.p)) : extractUnitPrice(item.pt || "");
  const priceText = item.pt || (item.p ? `Unit Price: ৳ ${item.p}${item.pk ? ` (${item.pk})` : ""}` : "");
  return {
    id: item.i,
    type: "brand",
    name: item.b,
    dosageForm: item.f || "",
    strength: item.s || "",
    genericName: item.g || "",
    manufacturer: item.c || "",
    priceText,
    unitPrice,
    url: item.fullUrl || `${MEDEX_BASE_URL}/brands/${item.u}`
  };
}

export function searchLocalMedexCatalog(query = "", { limit = 40, customDbPath = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  // 1. If an external Bangladeshi-Medicine-API SQLite file (medex.db) is present, query it directly
  if (customDbPath && existsSync(customDbPath)) {
    try {
      const extDb = new DatabaseSync(customDbPath, { readOnly: true });
      const like = `%${q}%`;
      const prefix = `${q}%`;
      const rows = extDb.prepare(`
        SELECT id, slug, url, brand_name, dosage_form, strength, generic_name, company, unit_price, price_text, pack_sizes
        FROM medicines
        WHERE brand_name LIKE ? OR generic_name LIKE ? OR company LIKE ? OR strength LIKE ?
        ORDER BY
          CASE
            WHEN LOWER(brand_name) = ? THEN 0
            WHEN LOWER(brand_name) LIKE ? THEN 1
            WHEN LOWER(generic_name) = ? THEN 2
            WHEN LOWER(generic_name) LIKE ? THEN 3
            ELSE 4
          END,
          brand_name COLLATE NOCASE
        LIMIT ?
      `).all(like, like, like, like, q, prefix, q, prefix, limit);
      extDb.close();
      if (rows.length) {
        return rows.map(r => ({
          id: r.id,
          type: "brand",
          name: r.brand_name || "",
          dosageForm: r.dosage_form || "",
          strength: r.strength || "",
          genericName: r.generic_name || "",
          manufacturer: r.company || "",
          priceText: r.price_text || (r.unit_price ? `Unit Price: ৳ ${r.unit_price}` : ""),
          unitPrice: extractUnitPrice(r.unit_price || r.price_text || ""),
          url: normalizeMedexUrl(r.url) || `${MEDEX_BASE_URL}/brands/${r.id}/${r.slug || ""}`
        }));
      }
    } catch { /* fall through to bundled catalog */ }
  }

  // 2. Search bundled 19,590-medicine catalog
  const { brands } = loadBundledCatalog();
  if (!brands.length) return [];

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const item of brands) {
    let score = 0;
    if (item._bLower === q) score = 100;
    else if (item._bLower.startsWith(q)) score = 85;
    else if (item._bLower.includes(q)) score = 70;
    else if (item._gLower === q) score = 65;
    else if (item._gLower.startsWith(q)) score = 60;
    else if (item._gLower.includes(q)) score = 50;
    else if (item._cLower.includes(q)) score = 35;

    if (score === 0 && tokens.length > 1) {
      const hay = `${item._bLower} ${item._sLower} ${item._fLower} ${item._gLower} ${item._cLower}`;
      if (tokens.every(t => hay.includes(t))) {
        score = item._bLower.startsWith(tokens[0]) ? 80 : 45;
      }
    }

    if (score > 0) {
      if (item.p) score += 2; // slight boost when unit price is known
      if (/^(tablet|capsule|syrup|suspension|pediatric drops|oral)/i.test(item.f || "")) score += 1;
      scored.push({ score, item });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.item._bLower.localeCompare(b.item._bLower) || a.item._fLower.localeCompare(b.item._fLower));
  return scored.slice(0, limit).map(entry => formatCatalogItem(entry.item));
}

function findCatalogDetails(targetUrl = "", { customDbPath = "" } = {}) {
  const url = normalizeMedexUrl(targetUrl);
  const idMatch = url.match(/\/brands\/(\d+)/i);
  const brandId = idMatch ? Number(idMatch[1]) : 0;

  // Check optional external medex.db first
  if (brandId && customDbPath && existsSync(customDbPath)) {
    try {
      const extDb = new DatabaseSync(customDbPath, { readOnly: true });
      const row = extDb.prepare("SELECT * FROM medicines WHERE id=?").get(brandId);
      if (row) {
        let monographRow = row;
        if (!row.indications && row.generic_name) {
          const fallback = extDb.prepare("SELECT * FROM medicines WHERE generic_name=? AND detail_scraped=1 LIMIT 1").get(row.generic_name);
          if (fallback) monographRow = fallback;
        }
        const altBrands = row.generic_name
          ? extDb.prepare("SELECT brand_name, dosage_form, strength, company, unit_price FROM medicines WHERE generic_name=? AND id<>? ORDER BY unit_price IS NULL, brand_name COLLATE NOCASE LIMIT 15").all(row.generic_name, brandId)
          : [];
        extDb.close();
        const sections = [];
        const add = (title, val) => { if (val && String(val).trim()) sections.push({ title, content: String(val).trim() }); };
        add("Indications", monographRow.indications);
        add("Composition", monographRow.composition);
        add("Pharmacology", monographRow.pharmacology);
        add("Dosage & Administration", monographRow.dosage_and_administration);
        add("Interaction", monographRow.interaction);
        add("Contraindications", monographRow.contraindications);
        add("Side Effects", monographRow.side_effects);
        add("Pregnancy & Lactation", monographRow.pregnancy_and_lactation);
        add("Precautions & Warnings", monographRow.precautions_and_warnings);
        add("Overdose Effects", monographRow.overdose_effects);
        add("Therapeutic Class", monographRow.therapeutic_class);
        add("Storage Conditions", monographRow.storage_conditions);
        if (altBrands.length) {
          sections.push({
            title: `Other Bangladeshi brands of ${row.generic_name}`,
            content: altBrands.map(b => `• ${b.brand_name}${b.strength ? ` (${b.strength})` : ""}${b.dosage_form ? ` ${b.dosage_form}` : ""} — ${b.company || ""}${b.unit_price ? ` · ৳${b.unit_price}` : ""}`).join("\n")
          });
        }
        return {
          name: row.brand_name || "",
          dosageForm: row.dosage_form || "",
          strength: row.strength || "",
          genericName: row.generic_name || "",
          manufacturer: row.company || "",
          pricing: row.price_text || (row.unit_price ? `Unit Price: ৳ ${row.unit_price}` : ""),
          unitPrice: extractUnitPrice(row.unit_price || row.price_text || ""),
          url,
          sections
        };
      }
      extDb.close();
    } catch { /* fall through */ }
  }

  const cat = loadBundledCatalog();
  const item = (brandId && cat.byId.get(brandId)) || cat.byUrl.get(url.toLowerCase());
  if (!item) return null;

  const gKey = String(item.g || "").trim().toLowerCase();
  let rawSections = cat.monographs[gKey] || null;
  if (!rawSections && gKey) {
    // Try partial generic key match (e.g. "esomeprazole magnesium trihydrate" -> "esomeprazole")
    for (const [key, val] of Object.entries(cat.monographs)) {
      if (gKey.includes(key) || key.includes(gKey)) {
        rawSections = val;
        break;
      }
    }
  }

  const sections = (rawSections || []).map(([title, content]) => ({ title, content }));

  // Also include other Bangladeshi brands with the same generic name from the 19,590 catalog
  if (gKey) {
    const peers = cat.brands
      .filter(b => b._gLower === gKey && b.i !== item.i)
      .slice(0, 15);
    if (peers.length) {
      sections.push({
        title: `Other Bangladeshi brands of ${item.g}`,
        content: peers.map(b => `• ${b.b}${b.s ? ` (${b.s})` : ""}${b.f ? ` ${b.f}` : ""} — ${b.c || ""}${b.p ? ` · ৳${b.p}` : ""}`).join("\n")
      });
    }
  }

  const pricing = item.pt || (item.p ? `Unit Price: ৳ ${item.p}${item.pk ? ` (${item.pk})` : ""}` : "");
  return {
    name: item.b || "",
    dosageForm: item.f || "",
    strength: item.s || "",
    genericName: item.g || "",
    manufacturer: item.c || "",
    pricing,
    unitPrice: item.p != null ? extractUnitPrice(String(item.p)) : extractUnitPrice(pricing),
    url: item.fullUrl || url,
    sections
  };
}

export function parseMedexSearchHtml(html = "") {
  const source = String(html || "");
  if (!source) return [];
  const results = [];
  const seen = new Set();

  const anchorRegex = /<a\b([^>]*href=["']((?:https?:\/\/(?:www\.)?medex\.com\.bd)?\/(?:brands|generics)\/[^"'#?\s]+)[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(source)) !== null) {
    const rawHref = match[2];
    const inner = match[3];
    const url = normalizeMedexUrl(rawHref);
    if (!url || seen.has(url)) continue;

    const isGeneric = /\/generics\//i.test(url);
    const type = isGeneric ? "generic" : "brand";

    let dosageForm = extractFirstMatch(inner, /<span\b[^>]*class=["'][^"']*inline-dosage-form[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
      || extractFirstMatch(inner, /<img\b[^>]*title=["']([^"']+)["'][^>]*>/i)
      || extractFirstMatch(inner, /<small\b[^>]*>([\s\S]*?)<\/small>/i);

    const topRowMatch = inner.match(/<div\b[^>]*class=["'][^"']*data-row-top[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    let name = "";
    if (topRowMatch) {
      const topHtml = topRowMatch[1].replace(/<span\b[^>]*class=["'][^"']*inline-dosage-form[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, "");
      name = cleanInlineText(topHtml);
    }
    if (!name) {
      name = extractFirstMatch(inner, /<h[2-5]\b[^>]*>([\s\S]*?)<\/h[2-5]>/i);
    }

    let strength = extractFirstMatch(inner, /<div\b[^>]*class=["'][^"']*data-row-strength[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      || extractFirstMatch(inner, /<span\b[^>]*class=["'][^"']*grey-ligten[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);

    let manufacturer = extractFirstMatch(inner, /<div\b[^>]*class=["'][^"']*data-row-company[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      || extractFirstMatch(inner, /<span\b[^>]*class=["'][^"']*company-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);

    let genericName = "";
    const colRegex = /<div\b[^>]*class=["']([^"']*col-xs-12[^"']*)["'][^>]*>([\s\S]*?)<\/div>/gi;
    let colMatch;
    while ((colMatch = colRegex.exec(inner)) !== null) {
      const cls = colMatch[1];
      if (/data-row-top|data-row-strength|data-row-company/i.test(cls)) continue;
      if (/data-row-company/i.test(colMatch[2])) continue;
      const text = cleanInlineText(colMatch[2]);
      if (text && !genericName) genericName = text;
    }

    if (!name) {
      const lines = decodeHtmlText(inner).split("\n").map(line => line.trim()).filter(Boolean);
      name = lines[0] || "";
      if (!strength && lines[1] && /\b(mg|mcg|g|ml|iu|%)\b/i.test(lines[1])) strength = lines[1];
      if (!genericName && lines[2]) genericName = lines[2];
      if (!manufacturer && lines[3]) manufacturer = lines[3];
    }

    if (isGeneric && !genericName && name) {
      genericName = name;
    }

    const priceText = extractFirstMatch(inner, /((?:Unit|Strip|Pack)\s*Price\s*:\s*৳\s*[0-9.,]+|৳\s*[0-9.,]+)/i);
    const unitPrice = extractUnitPrice(priceText || inner);

    if (!name || /^(brands|generics|search|home|medex)$/i.test(name)) continue;

    seen.add(url);
    results.push({
      type,
      name,
      dosageForm: dosageForm || "",
      strength: strength || "",
      genericName: genericName || "",
      manufacturer: manufacturer || "",
      priceText: priceText || "",
      unitPrice,
      url
    });
    if (results.length >= 25) break;
  }

  return results;
}

export function parseMedexDetailsHtml(html = "", pageUrl = "") {
  const source = String(html || "");
  if (!source) return null;

  const h1Match = source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let name = "";
  let dosageForm = "";
  if (h1Match) {
    const h1Inner = h1Match[1];
    dosageForm = extractFirstMatch(h1Inner, /<small\b[^>]*class=["'][^"']*h1-subtitle[^"']*["'][^>]*>([\s\S]*?)<\/small>/i)
      || extractFirstMatch(h1Inner, /<small\b[^>]*>([\s\S]*?)<\/small>/i);
    name = cleanInlineText(h1Inner.replace(/<small\b[^>]*>[\s\S]*?<\/small>/gi, ""));
  }

  const genericName = extractFirstMatch(source, /<div\b[^>]*title=["']Generic Name["'][^>]*>([\s\S]*?)<\/div>/i)
    || extractFirstMatch(source, /<a\b[^>]*href=["'][^"']*\/generics\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);

  const strength = extractFirstMatch(source, /<div\b[^>]*title=["']Strength["'][^>]*>([\s\S]*?)<\/div>/i)
    || extractFirstMatch(source, /<span\b[^>]*class=["'][^"']*strength[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);

  const manufacturer = extractFirstMatch(source, /<div\b[^>]*title=["']Manufactured by["'][^>]*>([\s\S]*?)<\/div>/i)
    || extractFirstMatch(source, /<a\b[^>]*href=["'][^"']*\/companies\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);

  const packageBlock = source.match(/<div\b[^>]*class=["'][^"']*package-container[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    || source.match(/<div\b[^>]*class=["'][^"']*packages-wrapper[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    || "";
  const pricing = decodeHtmlText(packageBlock)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join(" · ");
  const unitPrice = extractUnitPrice(pricing || packageBlock);

  const sections = [];
  const sectionRegex = /<h[2-4]\b[^>]*class=["'][^"']*ac-header[^"']*["'][^>]*>([\s\S]*?)<\/h[2-4]>\s*(?:<\/div>\s*)?<div\b[^>]*class=["'][^"']*ac-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let secMatch;
  while ((secMatch = sectionRegex.exec(source)) !== null) {
    const title = cleanInlineText(secMatch[1]);
    const content = decodeHtmlText(secMatch[2]);
    if (title && content) {
      sections.push({ title, content: content.slice(0, 2000) });
    }
  }

  return {
    name: name || "",
    dosageForm: dosageForm || "",
    strength: strength || "",
    genericName: genericName || "",
    manufacturer: manufacturer || "",
    pricing: pricing || "",
    unitPrice,
    url: normalizeMedexUrl(pageUrl) || MEDEX_SEARCH_URL,
    sections
  };
}

export async function fetchMedexSearch(query, { timeoutMs = 5000, customDbPath = "" } = {}) {
  const searchUrl = buildMedexSearchUrl(query);
  // First search the local 19,590-medicine Bangladesh catalog (instant, offline, Cloudflare-proof)
  const localResults = searchLocalMedexCatalog(query, { limit: 40, customDbPath });
  if (localResults.length) {
    return {
      ok: true,
      source: "catalog",
      searchUrl,
      results: localResults,
      message: ""
    };
  }

  // Fallback to live medex.com.bd search if not in local catalog
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(searchUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,bn;q=0.8"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ok: false,
        searchUrl,
        results: [],
        message: `No match in the offline catalog (19,590 medicines) and MedEx returned HTTP ${response.status}. Click 'Open on MedEx.com.bd' to check in your browser.`
      };
    }
    const html = await response.text();
    const results = parseMedexSearchHtml(html);
    return {
      ok: true,
      source: "live",
      searchUrl,
      results,
      message: results.length ? "" : "No matches found in the 19,590-medicine catalog. Click 'Open on MedEx.com.bd' to view the full search page."
    };
  } catch {
    return {
      ok: false,
      searchUrl,
      results: [],
      message: "No match found in the offline 19,590-medicine catalog. Click 'Open on MedEx.com.bd' to search online in your browser."
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMedexDetails(targetUrl, { timeoutMs = 4500, customDbPath = "" } = {}) {
  const url = normalizeMedexUrl(targetUrl);
  if (!url) {
    throw new Error("Invalid MedEx URL.");
  }

  const catalogDetails = findCatalogDetails(url, { customDbPath });
  if (catalogDetails) {
    return {
      ok: true,
      source: "catalog",
      url,
      details: catalogDetails,
      message: ""
    };
  }

  // Try enriching from live MedEx if online and not blocked by Cloudflare
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,bn;q=0.8"
      },
      signal: controller.signal
    });
    if (response.ok) {
      const html = await response.text();
      if (!html.slice(0, 2000).includes("Security Check")) {
        const liveDetails = parseMedexDetailsHtml(html, url);
        if (liveDetails && (liveDetails.sections.length || liveDetails.pricing)) {
          return {
            ok: true,
            source: "live",
            url,
            details: liveDetails,
            message: ""
          };
        }
      }
    }
  } catch { /* fall back to catalogDetails */ }
  finally {
    clearTimeout(timer);
  }

  if (catalogDetails) {
    return {
      ok: true,
      source: "catalog",
      url,
      details: catalogDetails,
      message: ""
    };
  }

  return {
    ok: false,
    url,
    details: null,
    message: "Could not load details right now. Click 'Open on MedEx.com.bd' to view in your browser."
  };
}
