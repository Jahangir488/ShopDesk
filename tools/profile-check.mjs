#!/usr/bin/env node
// End-to-end regression checks for shop-profile data and session isolation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = mkdtempSync(join(tmpdir(), "shopdesk-profile-check-"));
const setupCode = "ProfileCheckSetup2026!";
const password = "ProfileCheckPass2026!";
let child, output = "";

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  cookie = "";
  constructor(base) { this.base = base; }
  async request(path, { method = "GET", body, expected } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    } else if (body !== undefined) {
      headers["content-type"] = "application/octet-stream";
      payload = body;
    }
    const response = await fetch(this.base + path, { method, headers, body: payload });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`);
    return response;
  }
  async json(path, options = {}) {
    const response = await this.request(path, options);
    const value = await response.json();
    if (options.expected === undefined) assert.ok(response.ok, `${path}: ${value.error}`);
    return value;
  }
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SHOP_HOST: "127.0.0.1", SHOP_DATA_DIR: dataDir, SHOP_SETUP_CODE: setupCode },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-6000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-6000); });
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/healthz`)).ok) { healthy = true; break; } } catch {}
    await sleep(75);
  }
  assert.ok(healthy, `test server did not start\n${output}`);

  const a = new Client(base), b = new Client(base);
  await a.json("/api/setup", { method: "POST", body: { setupCode, username: "admin", password }, expected: 201 });
  let state = await a.json("/api/state");
  assert.equal(state.shopType, "general");
  assert.equal(state.profiles.length, 7);
  assert.ok(state.categories.length > 0, "fresh master settings and categories must initialize");
  await b.json("/api/login", { method: "POST", body: { username: "admin", password } });

  const product = name => ({
    name, sku: name.toUpperCase().replaceAll(" ", "-"), price: 20, cost: 10,
    qty: 0, min: 0, unit: name.includes("Pharmacy") ? "tablet" : "piece", category: "Other"
  });
  await a.json("/api/products", { method: "POST", body: product("General Only"), expected: 201 });
  const pharmacyId = state.profiles.find(profile => profile.type === "pharmacy").id;
  state = await a.json("/api/profiles/switch", { method: "POST", body: { profileId: pharmacyId } });
  assert.equal(state.shopType, "pharmacy");
  assert.equal(state.products.length, 0);
  assert.ok(state.categories.some(category => category.name === "Other"), "new profile categories must match its type");
  await a.json("/api/products", { method: "POST", body: product("Pharmacy Only"), expected: 201 });
  await a.json("/api/expenses", { method: "POST", body: { date: new Date().toISOString().slice(0, 10), category: "Pharmacy expense", note: "", amount: 15 }, expected: 201 });

  let otherSession = await b.json("/api/state");
  assert.equal(otherSession.shopType, "general");
  assert.deepEqual(otherSession.products.map(item => item.name), ["General Only"]);
  assert.equal(otherSession.expenses.length, 0, "one session switching must not change another session");
  state = await a.json("/api/state");
  assert.equal(state.shopType, "pharmacy");
  assert.deepEqual(state.products.map(item => item.name), ["Pharmacy Only"]);
  assert.deepEqual(state.expenses.map(item => item.category), ["Pharmacy expense"]);
  const team = await a.json("/api/users");
  assert.equal(team[0].username, "admin", "team access must remain shared");
  const rejectedSettings = await a.json("/api/settings", { method: "PUT", body: { shopType: "grocery" }, expected: 409 });
  assert.match(rejectedSettings.error, /fixed for this profile/);

  const pharmacyBackup = await a.json("/api/backups", { method: "POST", body: {}, expected: 201 });
  const pharmacySchedule = await a.json("/api/backups/schedule");
  assert.match(pharmacySchedule.directory, /profiles[\\/]pharmacy[\\/]backups/);
  const pharmacyFiles = await a.json("/api/backups");
  assert.ok(pharmacyFiles.files.some(file => file.name === pharmacyBackup.created));
  const generalBackup = await b.json("/api/backups", { method: "POST", body: {}, expected: 201 });
  const generalSchedule = await b.json("/api/backups/schedule");
  assert.ok(!generalSchedule.directory.includes(`${join("profiles", "pharmacy")}`), "master backup directory must remain independent");
  const downloaded = await b.request(`/api/backups/download/${generalBackup.created}`);
  const rejectedRestore = await a.json("/api/backups/restore-upload", { method: "POST", body: Buffer.from(await downloaded.arrayBuffer()), expected: 400 });
  assert.match(rejectedRestore.error, /belongs to General store/);
  state = await a.json("/api/state");
  assert.deepEqual(state.products.map(item => item.name), ["Pharmacy Only"], "cross-type restore must not change data");

  await a.json("/api/products", { method: "POST", body: product("Temporary Pharmacy"), expected: 201 });
  await a.json("/api/backups/restore", { method: "POST", body: { name: pharmacyBackup.created } });
  state = await a.json("/api/state");
  assert.equal(state.shopType, "pharmacy");
  assert.deepEqual(state.products.map(item => item.name), ["Pharmacy Only"]);
  otherSession = await b.json("/api/state");
  assert.equal(otherSession.shopType, "general");
  assert.deepEqual(otherSession.products.map(item => item.name), ["General Only"]);

  for (const type of ["grocery", "restaurant", "hardware", "clothing", "mobile"]) {
    const id = state.profiles.find(profile => profile.type === type).id;
    const switched = await a.json("/api/profiles/switch", { method: "POST", body: { profileId: id } });
    assert.equal(switched.shopType, type);
    assert.equal(switched.products.length, 0, `${type} must start empty`);
    assert.ok(switched.categories.length > 0, `${type} categories must initialize`);
    assert.equal(switched.expenses.length, 0, `${type} expenses must start empty`);
  }
  console.log("  ok  seven isolated profiles, independent sessions, shared team access, fixed types, separate backups, and safe restore");
} catch (error) {
  console.error("FAIL shop-profile isolation:", error);
  if (output) console.error(output);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(1500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(dataDir, { recursive: true, force: true });
}
