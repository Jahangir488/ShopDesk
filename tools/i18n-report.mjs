#!/usr/bin/env node
// Show interface text that still needs a Bangla translation.
//   npm run i18n:report
//   npm run i18n:report -- --all
// Add missing entries to i18n/bn.json under "strings" (exact English text).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dict = JSON.parse(readFileSync(join(root, "i18n", "bn.json"), "utf8"));
const strings = dict.strings || {};
const patterns = (dict.patterns || []).map(rule => { try { return new RegExp(rule.re); } catch { return null; } }).filter(Boolean);
const showAll = process.argv.includes("--all");

const found = new Map();
const add = (text, where) => {
  let value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || value.length < 3 || value.length > 120) return;
  if (!/[A-Za-z]{2}/.test(value)) return;
  if (/^(https?:|\/|\.\/|#|data:|mailto:)/.test(value)) return;
  if (/^[\w.-]+$/.test(value) && !/\s/.test(value)) return; // identifiers and keys
  if (/\$\{/.test(value)) return;
  if (/^[a-z0-9_-]+$/.test(value)) return;
  if (/(px|rem|rgba?\(|border-|var\(--|grid-template|font-)/.test(value)) return;
  if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(value)) return;
  if (/^[A-Z_]+$/.test(value) && value.length < 6) return;
  const decoded = value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  if (strings[value] || strings[decoded] || patterns.some(pattern => pattern.test(value))) return;
  const entry = found.get(value) || { value, where: new Set() };
  entry.where.add(where);
  found.set(value, entry);
};

// index.html visible text and attributes
const html = readFileSync(join(root, "index.html"), "utf8")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ");
for (const match of html.matchAll(/>([^<>]+)</g)) add(match[1], "index.html");
for (const match of html.matchAll(/(?:placeholder|title|aria-label|alt)="([^"]+)"/g)) add(match[1], "index.html");

// app.js: messages, titles and small markup text
const app = readFileSync(join(root, "app.js"), "utf8");
for (const match of app.matchAll(/(?:toast|openModal|confirm|alert)\(\s*"((?:[^"\\]|\\.)+)"/g)) add(match[1], "app.js");
for (const match of app.matchAll(/throw new Error\(\s*"((?:[^"\\]|\\.)+)"/g)) add(match[1], "app.js");
for (const match of app.matchAll(/<(?:label|th|td|button|h2|h3|p|option|span|small|b|strong)[^>]*>([^<>{}]+)</g)) add(match[1], "app.js");

const all = [...found.values()].sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value));
const list = showAll ? all : all.slice(0, 120);
console.log(`${all.length} untranslated string(s) found in the interface.`);
for (const entry of list) {
  console.log(`\n${JSON.stringify(entry.value)}   (${[...entry.where].join(", ")})`);
}
if (!showAll && all.length > list.length) console.log(`\n… ${all.length - list.length} more. Run with --all to see everything.`);
console.log(`\nTranslated so far: ${Object.keys(strings).length} strings + ${patterns.length} patterns.`);
