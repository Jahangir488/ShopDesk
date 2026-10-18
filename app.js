const $ = selector => document.querySelector(selector);
const money = amount => {
  const value = Number(amount) || 0, currency = data.currencyCode || "BDT";
  const locale = data.banglaDigits ? "bn-BD" : (data.locale || "en-BD");
  try { return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(value); }
  catch { return `${currency} ${localizeDigits(Math.round(value).toLocaleString())}`; }
};
const currencySymbol = () => {
  try { return new Intl.NumberFormat(data.locale || "en-BD", { style: "currency", currency: data.currencyCode || "BDT", maximumFractionDigits: 0 }).formatToParts(0).find(part => part.type === "currency")?.value || data.currencyCode || "BDT"; }
  catch { return data.currencyCode || "BDT"; }
};
const paymentChoices = () => data.paymentMethods?.length ? data.paymentMethods : ["Cash", "bKash", "Nagad", "Card", "Due"];
const paymentOptions = (selected, options = paymentChoices()) => {
  const current = selected || (options.includes("Cash") ? "Cash" : options[0]);
  return [...new Set([...options, current].filter(Boolean))].map(method => `<option ${method === current ? "selected" : ""}>${esc(method)}</option>`).join("");
};
const quickPaymentChoices = () => paymentChoices().filter(method => !/due|credit|unpaid/i.test(method));
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const dateLabel = value => new Date(`${value}T12:00:00`).toLocaleDateString(data.banglaDigits || hasBangla() ? "bn-BD" : (data.locale || "en-BD"), { day: "numeric", month: "short" });
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let data = { shopName: "Shop Desk", workspace: "", contactNumber: "", website: "", email: "", facebookPage: "", whatsappNumber: "", contactAddress: "", shopType: "general", currencyCode: "BDT", locale: "en-BD", taxRate: 0, taxMode: "none", requireCustomer: false, allowDiscounts: true, paymentMethods: ["Cash", "bKash", "Nagad", "Card", "Due"], products: [], sales: [], onlineOrders: [], serviceJobs: [], devices: [], expenses: [], categories: [], permissions: {} };
const featureEnabled = feature => !Array.isArray(data.licenseFeatures) || data.licenseFeatures.includes(feature);
const productSellableQty = product => data.shopType === "pharmacy" ? Number(product.available_to_sell || 0) : Number(product.qty || 0);
let signedInUser = null;
let toastTimer;

// ---- Language (English / বাংলা) -------------------------------------------------
const I18N = { code: "en", strings: {}, patterns: [], loaded: false };
const hasBangla = () => I18N.code === "bn";
const bnDigits = value => String(value).replace(/\d/g, digit => "০১২৩৪৫৬৭৮৯"[Number(digit)]);
const localizeDigits = value => (data.banglaDigits ? bnDigits(value) : String(value));
function t(text, vars) {
  const source = String(text ?? "");
  if (!hasBangla() || !source) return source;
  const trimmed = source.trim();
  let translated = I18N.strings[trimmed];
  if (translated !== undefined) {
    const start = source.slice(0, source.indexOf(trimmed));
    const end = source.slice(source.indexOf(trimmed) + trimmed.length);
    translated = start + translated + end;
  } else {
    for (const rule of I18N.patterns) {
      try {
        const pattern = new RegExp(rule.re);
        if (pattern.test(trimmed)) { translated = trimmed.replace(pattern, rule.bn); break; }
      } catch { /* ignore a bad rule */ }
    }
  }
  if (translated === undefined) return source;
  return vars ? String(translated).replace(/\{(\w+)\}/g, (match, key) => (vars[key] ?? match)) : String(translated);
}
const tt = text => t(text);
const I18N_SKIP = "script,style,textarea,code,pre,[data-no-i18n],.no-i18n";
function translateTextNode(node) {
  if (!hasBangla() || !node || node.nodeType !== 3 || !node.nodeValue) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(I18N_SKIP)) return;
  const translated = t(node.nodeValue);
  if (translated !== node.nodeValue) node.nodeValue = translated;
}
function translateAttributes(element) {
  if (!hasBangla() || !element || element.nodeType !== 1 || element.closest(I18N_SKIP)) return;
  for (const name of ["placeholder", "title", "aria-label", "alt", "data-label"]) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const translated = t(value);
    if (translated !== value) element.setAttribute(name, translated);
  }
}
function translateDom(root = document.body) {
  if (!hasBangla() || !root) return;
  if (root.nodeType === 3) { translateTextNode(root); return; }
  if (root.nodeType === 1) translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 3) translateTextNode(node);
    else translateAttributes(node);
  }
}
let i18nObserver = null, i18nScheduled = false;
const i18nPending = new Set();
function scheduleI18nFlush() {
  if (i18nScheduled) return;
  i18nScheduled = true;
  const run = () => {
    i18nScheduled = false;
    if (!hasBangla()) { i18nPending.clear(); return; }
    const nodes = [...i18nPending];
    i18nPending.clear();
    for (const node of nodes) { try { translateDom(node); } catch { /* keep rendering */ } }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}
function startI18nObserver() {
  if (i18nObserver || typeof MutationObserver !== "function") return;
  i18nObserver = new MutationObserver(records => {
    if (!hasBangla()) return;
    for (const record of records) {
      if (record.type === "characterData") i18nPending.add(record.target);
      else if (record.type === "attributes") i18nPending.add(record.target);
      else record.addedNodes.forEach(node => { if (node.nodeType === 1 || node.nodeType === 3) i18nPending.add(node); });
    }
    // Batches are merged: a panel that finishes rendering while another
    // translation pass is queued must not be dropped.
    scheduleI18nFlush();
  });
  i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["placeholder", "title", "aria-label", "alt", "data-label"] });
}
async function loadLanguage(code) {
  const language = code === "bn" ? "bn" : "en";
  I18N.code = language;
  if (language === "bn" && !I18N.loaded) {
    try {
      const response = await fetch("/i18n/bn.json", { credentials: "same-origin" });
      const payload = await response.json();
      I18N.strings = payload.strings || {};
      I18N.patterns = payload.patterns || [];
      I18N.loaded = true;
    } catch { I18N.strings = {}; I18N.patterns = []; }
  }
  document.documentElement.lang = language;
  document.body.classList.toggle("lang-bn", language === "bn");
  if (language === "bn") { startI18nObserver(); translateDom(document.body); }
}
function renderLicenseBanner() {
  const license = data.license;
  const main = document.querySelector(".main");
  if (!main || !license) return;
  const show = license.readOnly || (license.state !== "active" && license.warning) || (license.state === "active" && license.warning);
  let banner = $("#license-banner");
  if (!show) { banner?.remove(); return; }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "license-banner";
    banner.className = "license-banner";
    banner.setAttribute("role", "status");
    main.prepend(banner);
  }
  const days = Math.max(0, Number(license.daysLeft) || 0);
  let message;
  if (license.readOnly) message = `${t("Read-only mode")} — ${t("Billing is paused. Your data, reports, exports and backups are still available.")}`;
  else if (license.state === "trial") message = `${t("Trial")} · ${t("Trial ends")}: ${days} ${t("days left")}`;
  else message = `${t("Your licence expires soon")}: ${days} ${t("days left")}`;
  const canActivate = signedInUser?.role === "admin";
  banner.innerHTML = `<span class="license-banner-text">${esc(message)}</span>${canActivate
    ? `<button type="button" class="button primary" data-open-license>${esc(t("Enter licence key"))}</button>`
    : `<span class="license-banner-hint">${esc(t("Ask an administrator to enter a licence key."))}</span>`}`;
}
let backupWarningCheckedAt = 0;
async function renderBackupWarning() {
  if (!data.permissions?.backups || !document.querySelector(".main")) return;
  if (Date.now() - backupWarningCheckedAt < 60_000) return;
  backupWarningCheckedAt = Date.now();
  let status;
  try { status = await api("/api/backups/offsite"); } catch { return; }
  const stale = status.connected && status.enabled && (!status.lastSuccessAt || Date.now() - new Date(status.lastSuccessAt).getTime() > 48 * 3600 * 1000);
  const existing = $("#backup-warning");
  if (!stale) { existing?.remove(); return; }
  const main = document.querySelector(".main");
  const banner = existing || document.createElement("div");
  banner.id = "backup-warning";
  banner.className = "backup-warning";
  banner.setAttribute("role", "status");
  banner.innerHTML = `<span>${esc(t("Your last offsite backup is more than 48 hours old. Restore protection before the computer is lost or damaged."))}</span><button type="button" class="button secondary">${esc(t("Open backup settings"))}</button>`;
  banner.querySelector("button").onclick = () => showScreen("backup-tools", true);
  if (!existing) {
    const licenseBanner = $("#license-banner");
    if (licenseBanner) licenseBanner.after(banner); else main.prepend(banner);
  }
}
function openLicenseModal() {
  const license = data.license || {};
  const rows = [
    [t("Plan"), license.plan || "—"],
    [t("Status"), license.state === "active" ? t("Activated") : license.state === "trial" ? t("Trial") : t("Read-only mode")],
    [t("Days left"), String(license.daysLeft ?? 0)],
    [t("Expires"), license.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : "—"],
    [t("Licensed to"), license.licensedTo || "—"]
  ];
  if (license.state === "trial") rows.push([t("Trial ends"), license.trialEndsAt ? new Date(license.trialEndsAt).toLocaleDateString() : "—"]);
  openModal(t("Licence & plan"), `<div class="license-summary">${rows.map(([label, value]) => `<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join("")}</div>
    <label>${esc(t("Licence key"))}<textarea name="licenseKey" rows="4" autocomplete="off" spellcheck="false" placeholder="${esc(t("Paste the licence key you received"))}"></textarea></label>
    <p class="form-hint">${esc(t("Send this ID to your supplier when asking for a licence."))} <code id="license-install-id">${esc(license.installId || "")}</code> <button type="button" class="user-action" id="copy-install-id">${esc(t("Copy"))}</button></p>`,
    async form => {
      const token = String(form.get("licenseKey") || "").trim();
      if (!token) throw new Error(t("Paste the licence key you received."));
      data.license = await api("/api/license/activate", { method: "POST", body: JSON.stringify({ token }) });
      renderLicenseBanner();
      render();
      toast(t("Activated"));
    });
  const submit = $("#submit-modal");
  if (submit) submit.textContent = t("Activate");
  const copyButton = $("#copy-install-id");
  if (copyButton) copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(license.installId || "");
      toast(t("Installation ID copied"));
    } catch {
      const field = $("#license-install-id");
      if (field) {
        const range = document.createRange();
        range.selectNodeContents(field);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      toast(t("Select the ID and copy it."));
    }
  };
}
document.addEventListener("click", event => {
  if (event.target.closest("[data-open-license]")) { event.preventDefault(); openLicenseModal(); }
});

function refreshTopbarClock() {
  const now = new Date(), locale = data.banglaDigits || hasBangla() ? "bn-BD" : (data.locale || "en-BD");
  $("#today").textContent = now.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  $("#topbar-time").textContent = now.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
async function refreshServerLoad() {
  if (!signedInUser?.permissions?.server_load) return;
  try {
    const status = await api("/api/system/status");
    const cpu = status.cpuPercent == null ? "…" : `${status.cpuPercent}%`;
    const memory = status.memoryPercent == null ? "—" : `${status.memoryPercent}%`;
    const hours = Math.floor(status.uptimeSeconds / 3600), minutes = Math.floor(status.uptimeSeconds % 3600 / 60);
    $("#server-load").textContent = `Server · CPU ${cpu} · RAM ${memory}`;
    $("#server-load").title = `System RAM in use; shop app memory ${status.appMemoryMb} MB · server uptime ${hours}h ${minutes}m`;
    $("#server-load").classList.remove("server-load-offline");
    $("#server-load").classList.toggle("server-load-warning", Number(status.cpuPercent) >= 80 || Number(status.memoryPercent) >= 90);
  } catch (error) {
    if (/server load access has not been granted/i.test(error.message)) {
      if (signedInUser?.permissions) signedInUser.permissions.server_load = false;
      $("#server-load").classList.add("hidden");
      return;
    }
    $("#server-load").textContent = "Server load unavailable";
    $("#server-load").title = error.message;
    $("#server-load").classList.add("server-load-offline");
    $("#server-load").classList.remove("server-load-warning");
  }
}
refreshTopbarClock();
setInterval(refreshTopbarClock, 1000);
// The app script is running, so remove the "unsupported browser" notice if it was shown.
document.querySelectorAll(".browser-warning").forEach(node => node.remove());

const screenTitles = { dashboard: "Dashboard", inventory: "Inventory", sales: "Sales", "online-orders": "Online orders", repairs: "Repairs", devices: "Device sales & warranty", expenses: "Expenses", reports: "Reports", users: "Team access", "backup-tools": "Backup and restore" };
function showScreen(screen, updateHash = false) {
  const link = document.querySelector(`[data-screen-link="${screen}"]`);
  if (!screenTitles[screen] || link?.classList.contains("hidden")) screen = "dashboard";
  document.querySelectorAll("[data-screen]").forEach(view => view.classList.toggle("hidden", view.dataset.screen !== screen));
  document.querySelectorAll("[data-screen-link]").forEach(item => {
    const active = item.dataset.screenLink === screen;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $(".topbar b").textContent = t(screenTitles[screen]);
  if (screen === "backup-tools") renderBackupManager();
  if (screen === "repairs") renderRepairJobs();
  if (screen === "online-orders") renderOnlineOrders();
  if (updateHash && location.hash !== `#${screen}`) history.pushState(null, "", `#${screen}`);
  window.scrollTo(0, 0);
}
document.addEventListener("click", event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest("a[href^='#']");
  if (!link) return;
  const screen = link.dataset.screenLink || link.getAttribute("href").slice(1);
  if (screenTitles[screen]) {
    event.preventDefault();
    showScreen(screen, true);
  }
});
window.addEventListener("hashchange", () => showScreen(location.hash.slice(1)));
window.addEventListener("popstate", () => showScreen(location.hash.slice(1)));
showScreen(location.hash.slice(1) || "dashboard");

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login" && path !== "/api/setup") {
    showAuth();
    throw new Error(t("Your session ended. Please sign in again."));
  }
  if (!response.ok) {
    if (response.status === 402 && payload?.code === "license_expired") { data.license = payload.license; renderLicenseBanner(); }
    throw new Error(tt(payload?.error || "The request could not be completed."));
  }
  return payload;
}
async function updateState(path, body, method = "POST") {
  data = await api(path, { method, body: JSON.stringify(body) });
  render();
}
function toast(message) {
  const element = $("#toast");
  element.textContent = tt(message);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3000);
}
function showAuth() {
  signedInUser = null;
  $("#auth-screen").classList.remove("hidden");
  $("#login-form").classList.add("hidden");
  $("#setup-form").classList.add("hidden");
  $("#main-app").classList.add("auth-locked");
}
function showError(selector, message) {
  $(selector).textContent = tt(message);
}
function localizeCurrencyLabels(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!/৳|\$|€|£|₹|₨/.test(node.nodeValue)) continue;
    const parent = node.parentElement;
    if (parent?.closest("label,.bill-total,.purchase-line-total")) node.nodeValue = node.nodeValue.replace(/৳|\$|€|£|₹|₨/g, currencySymbol());
  }
}
function toggleSignedInView(isSignedIn) {
  $("#auth-screen").classList.toggle("hidden", isSignedIn);
  $("#main-app").classList.toggle("auth-locked", !isSignedIn);
}
async function loadWorkspace(user) {
  signedInUser = user;
  data = await api("/api/state");
  await loadLanguage(data.language || "en");
  refreshTopbarClock();
  refreshServerLoad();
  toggleSignedInView(true);
  $("#signed-in-as").textContent = user.displayName || user.username;
  $("#users-nav").classList.toggle("hidden", !(user.permissions?.team || user.permissions?.admins));
  render();
  showScreen(location.hash.slice(1) || "dashboard");
  if (user.permissions?.team || user.permissions?.admins) await loadUsers();
}
async function startApp() {
  try {
    try {
      const boot = await api("/api/auth/status");
      await loadLanguage(boot.language || "bn");
    } catch { /* the language file is optional; keep English */ }
    try {
      const session = await api("/api/auth/me");
      await loadWorkspace(session.user);
      return;
    } catch { /* No active session; show sign-in or first-time setup below. */ }
    const status = await api("/api/auth/status");
    $("#request-email-code").classList.toggle("hidden", !status.emailRecoveryAvailable);
    $("#auth-screen").classList.remove("hidden");
    $("#main-app").classList.add("auth-locked");
    if (status.setupRequired) {
      $("#setup-form").classList.remove("hidden");
      $("#login-form").classList.add("hidden");
      $("#recovery-form").classList.add("hidden");
    } else {
      $("#login-form").classList.remove("hidden");
      $("#setup-form").classList.add("hidden");
      $("#recovery-form").classList.add("hidden");
    }
  } catch (error) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="db-error">Database unavailable. Make sure the shop server is running, then reload this page.</div>`);
  }
}

$("#setup-form").onsubmit = async event => {
  event.preventDefault();
  showError("#setup-error", "");
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/setup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    await loadWorkspace(result.user);
  } catch (error) { showError("#setup-error", error.message); }
};
$("#login-form").onsubmit = async event => {
  event.preventDefault();
  showError("#login-error", "");
  const loginForm = event.currentTarget;
  const form = new FormData(loginForm);
  try {
    const result = await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    loginForm.reset();
    await loadWorkspace(result.user);
  } catch (error) { showError("#login-error", error.message); }
};
$("#show-recovery").onclick = () => {
  $("#login-form").classList.add("hidden");
  $("#recovery-form").classList.remove("hidden");
  $("#recovery-entry").classList.remove("hidden");
  $("#recovery-success").classList.add("hidden");
  $("#recovery-form").reset();
  $("#recovery-form [type=submit]").disabled = false;
  $("#recovery-form [type=submit]").textContent = "Reset password";
  showError("#recovery-error", "");
};
$("#recovery-back-login").onclick = () => {
  $("#recovery-form").classList.add("hidden");
  $("#login-form").classList.remove("hidden");
  $("#recovery-form").reset();
  showError("#recovery-error", "");
};
$("#request-email-code").onclick = async () => {
  const username = $("#recovery-form [name=username]").value.trim();
  if (!username) { showError("#recovery-error", "Enter your username first."); return; }
  const button = $("#request-email-code");
  button.disabled = true;
  showError("#recovery-error", "");
  $("#email-recovery-status").textContent = "Requesting a reset code…";
  try {
    const result = await api("/api/email-recovery-request", { method: "POST", body: JSON.stringify({ username }) });
    $("#email-recovery-status").textContent = result.message;
  } catch (error) { $("#email-recovery-status").textContent = error.message; }
  finally { button.disabled = false; }
};
$("#recovery-form").onsubmit = async event => {
  event.preventDefault();
  showError("#recovery-error", "");
  const form = new FormData(event.currentTarget);
  const password = String(form.get("password") || "");
  if (password !== form.get("confirmPassword")) return showError("#recovery-error", "The new passwords do not match.");
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/recover-account", { method: "POST", body: JSON.stringify({ username: form.get("username"), recoveryCode: form.get("recoveryCode"), password }) });
    $("#recovery-entry").classList.add("hidden");
    const success = $("#recovery-success");
    success.innerHTML = `<p class="eyebrow">PASSWORD RESET</p><h2>Password changed</h2><p>Sign in with your new password. Save this replacement recovery code somewhere safe; the code you used is no longer valid.</p><label>New recovery code<input id="replacement-recovery-code" readonly></label><button class="button secondary" id="copy-replacement-code" type="button">Copy recovery code</button><p class="auth-error" id="recovery-copy-status" aria-live="polite"></p>`;
    $("#replacement-recovery-code").value = result.replacementRecoveryCode;
    $("#copy-replacement-code").onclick = async () => {
      try { await navigator.clipboard.writeText(result.replacementRecoveryCode); $("#recovery-copy-status").textContent = "Copied. Store the code somewhere safe."; }
      catch { $("#replacement-recovery-code").select(); $("#recovery-copy-status").textContent = "Select and copy the code above, then store it somewhere safe."; }
    };
    success.classList.remove("hidden");
    submit.textContent = "Password reset";
  } catch (error) { showError("#recovery-error", error.message); }
  finally { if (!$("#recovery-entry").classList.contains("hidden")) submit.disabled = false; }
};
$("#logout").onclick = async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch { /* Sign out locally even if the server is unavailable. */ }
  showAuth();
  startApp();
};

function reportRange() {
  const today = dateKey(new Date());
  const start = $("#report-from").value || dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const end = $("#report-to").value || today;
  const startDate = new Date(start + "T12:00:00");
  const dayCount = Math.max(1, Math.round((new Date(end + "T12:00:00") - startDate) / 86400000) + 1);
  const monthly = dayCount > 62;
  const buckets = [];
  if (start <= end) {
    if (monthly) {
      const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      while (dateKey(cursor).slice(0, 7) <= end.slice(0, 7)) {
        buckets.push({ key: dateKey(cursor).slice(0, 7), label: cursor.toLocaleDateString(data.locale || "en-BD", { month: "short", year: "2-digit" }) });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else {
      const cursor = new Date(startDate);
      while (dateKey(cursor) <= end) {
        buckets.push({ key: dateKey(cursor), label: String(cursor.getDate()) });
        cursor.setDate(cursor.getDate() + 1);
      }
    }
  }
  return { start, end, buckets, monthly, caption: start > end ? "Invalid date range" : start + " to " + end };
}
function renderReport() {
  const permissions = data.permissions || {};
  const range = reportRange();
  const sales = data.sales.filter(item => item.date >= range.start && item.date <= range.end);
  const expenses = data.expenses.filter(item => item.date >= range.start && item.date <= range.end);
  const gross = sales.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const profit = sales.reduce((sum, item) => sum + Number(item.total || 0) - Number(item.cost || 0), 0);
  const tax = sales.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0);
  const costs = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  $("#report-caption").textContent = `${range.caption} · Sales, costs, and estimated profit`;
  $("#report-sales").textContent = permissions.sales ? money(gross) : "—";
  $("#report-profit").textContent = permissions.sales ? money(profit) : "—";
  $("#report-tax").textContent = permissions.sales ? money(tax) : "—";
  $("#report-expenses").textContent = permissions.expenses ? money(costs) : "—";
  $("#report-net").textContent = permissions.sales && permissions.expenses ? money(profit - costs) : "—";
  $("#chart-total").textContent = permissions.sales ? money(gross) : "—";
  $("#chart-label").textContent = `Gross sales · ${range.caption}`;
  const amounts = range.buckets.map(bucket => sales.filter(item => range.monthly ? item.date.startsWith(bucket.key) : item.date === bucket.key).reduce((sum, item) => sum + Number(item.total || 0), 0));
  const max = Math.max(1000, ...amounts);
  $("#chart-max").textContent = money(Math.ceil(max / 4 / 1000) * 1000 || 1000);
  $("#chart").innerHTML = amounts.map((amount, index) => {
    const label = range.monthly ? index % 2 === 0 || index === amounts.length - 1 : amounts.length <= 14 || index % 3 === 0 || index === amounts.length - 1;
    return `<div class="bar-group"><div class="bar ${range.buckets[index].key === dateKey(new Date()) ? "today-bar" : ""}" style="height:${Math.max(2, amount / max * 100)}%" title="${esc(range.buckets[index].label)}: ${money(amount)}"></div><span class="bar-label">${label ? esc(range.buckets[index].label) : ""}</span></div>`;
  }).join("");
}
function renderDashboardTrend() {
  const permissions = data.permissions || {};
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(); date.setDate(date.getDate() - (6 - index));
    const key = dateKey(date);
    const sales = permissions.sales ? data.sales.filter(item => item.date === key).reduce((sum, item) => sum + Number(item.total || 0), 0) : 0;
    const expenses = permissions.expenses ? data.expenses.filter(item => item.date === key).reduce((sum, item) => sum + Number(item.amount || 0), 0) : 0;
    return { key, label: date.toLocaleDateString("en-BD", { weekday: "short" }), sales, expenses };
  });
  const salesTotal = days.reduce((sum, day) => sum + day.sales, 0);
  const expenseTotal = days.reduce((sum, day) => sum + day.expenses, 0);
  const max = Math.max(1000, ...days.flatMap(day => [day.sales, day.expenses]));
  $("#trend-sales-total").textContent = permissions.sales ? money(salesTotal) : "No access";
  $("#trend-expenses-total").textContent = permissions.expenses ? money(expenseTotal) : "No access";
  $("#dashboard-trend").innerHTML = days.map(day => {
    const salesHeight = permissions.sales ? Math.max(0, day.sales / max * 100) : 0;
    const expenseHeight = permissions.expenses ? Math.max(0, day.expenses / max * 100) : 0;
    return `<div class="trend-day" title="${esc(day.key)} · Sales: ${money(day.sales)} · Expenses: ${permissions.expenses ? money(day.expenses) : "No access"}"><div class="trend-bars"><span class="trend-bar sales-bar" style="height:${salesHeight}%"></span><span class="trend-bar expenses-bar" style="height:${expenseHeight}%"></span></div><small>${esc(day.label)}</small></div>`;
  }).join("");
  const hasAccess = permissions.sales || permissions.expenses;
  const hasActivity = salesTotal > 0 || expenseTotal > 0;
  $("#dashboard-trend-empty").textContent = !hasAccess ? "You do not have access to sales or expense totals." : permissions.sales && permissions.expenses ? "No sales or expenses recorded in the last 7 days." : permissions.sales ? "No sales recorded in the last 7 days." : "No expenses recorded in the last 7 days.";
  $("#dashboard-trend-empty").classList.toggle("hidden", hasAccess && hasActivity);
  $("#dashboard-trend").classList.toggle("trend-no-access", !hasAccess);
}
function productLabel(product) {
  const details = [["Brand", product.brand], ["Color", product.color], ["Size", product.size], ["Material", product.material]].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  return details.length ? `${product.name} (${details.join(" · ")})` : product.name;
}
// Shared product picker used by New bill, Record sale and Online orders.
// <datalist> is deliberately avoided: Firefox filters datalist entries by their
// label text instead of the item name, so typing an item name showed no results.
function itemSearchHaystack(item) {
  return [item.name, item.sku, item.barcode, item.category, item.brand, item.color, item.size, item.material, item.unit]
    .filter(Boolean).join(" ").toLocaleLowerCase();
}
function closeItemSearches(root = document) {
  let closed = false;
  root.querySelectorAll(".item-search-results").forEach(box => {
    if (box.classList.contains("hidden")) return;
    box.classList.add("hidden");
    box.innerHTML = "";
    box.closest(".item-search")?.querySelector("input")?.setAttribute("aria-expanded", "false");
    closed = true;
  });
  return closed;
}
function initItemSearch({ input, results, toggle, getItems, onPick, emptyText = "No matching item found." }) {
  if (!input || !results) return null;
  let matches = [], active = -1;
  const hide = () => {
    results.classList.add("hidden");
    results.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
    matches = [];
  };
  const highlight = () => {
    results.querySelectorAll(".item-search-option").forEach((option, index) => {
      const selected = index === active;
      option.classList.toggle("active", selected);
      option.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) {
        option.scrollIntoView?.({ block: "nearest" });
        input.setAttribute("aria-activedescendant", option.id);
      }
    });
    if (active < 0) input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    const query = input.value.trim().toLocaleLowerCase(), items = getItems() || [], ranked = [];
    for (const item of items) {
      const name = String(item.name || "").toLocaleLowerCase();
      const sku = String(item.sku || "").toLocaleLowerCase();
      const barcode = String(item.barcode || "").toLocaleLowerCase();
      let score = -1;
      if (!query) score = 0;
      else if (name === query) score = 1;
      else if (sku === query) score = 2;
      else if (barcode === query) score = 3;
      else if (name.startsWith(query)) score = 4;
      else if (sku.startsWith(query) || barcode.startsWith(query)) score = 5;
      else if (itemSearchHaystack(item).includes(query)) score = 6;
      if (score >= 0) ranked.push({ item, score });
    }
    ranked.sort((a, b) => a.score - b.score);
    matches = ranked.slice(0, 60).map(entry => entry.item);
    active = -1;
    input.removeAttribute("aria-activedescendant");
    if (!matches.length) {
      results.innerHTML = `<p class="item-search-empty">${esc(emptyText)}</p>`;
    } else {
      results.innerHTML = matches.map((item, index) => {
        const details = [item.brand, item.color, item.size, item.material, item.category].filter(Boolean).map(value => esc(value)).join(" · ");
        const codes = [item.sku && item.sku !== "—" ? `SKU ${item.sku}` : "", item.barcode ? `Barcode ${item.barcode}` : ""].filter(Boolean).map(value => esc(value)).join(" · ");
        const stock = `${fmtQty(data.shopType === "pharmacy" ? productSellableQty(item) : Number(item.qty) || 0, item.unit || "piece")} ${data.shopType === "pharmacy" ? "unexpired in stock" : "in stock"}`;
        return `<button type="button" class="item-search-option" role="option" id="${results.id}-opt-${index}" data-index="${index}" aria-selected="false"><span class="item-search-main"><b>${esc(item.name)}</b>${details ? `<small>${details}</small>` : ""}${codes ? `<small>${codes}</small>` : ""}</span><span class="item-search-meta"><b>${esc(money(item.price))}</b><small>${esc(stock)}</small></span></button>`;
      }).join("");
    }
    results.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  };
  const pickItem = item => {
    if (!item) return false;
    hide();
    input.value = "";
    onPick(item);
    return true;
  };
  const pick = index => pickItem(matches[index]);
  const exactMatch = query => (getItems() || []).find(item =>
    [item.name, item.sku, item.barcode].some(value => String(value || "").toLocaleLowerCase() === query) ||
    productLabel(item).toLocaleLowerCase() === query
  );
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", results.id);
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", () => { if (input.value.trim()) render(); else hide(); });
  input.addEventListener("click", () => { if (!input.value.trim()) render(); });
  input.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== input) hide(); }, 200); });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (!results.classList.contains("hidden")) { event.preventDefault(); event.stopPropagation(); hide(); }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.classList.contains("hidden")) { render(); return; }
      if (!matches.length) return;
      active = event.key === "ArrowDown" ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1);
      highlight();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const query = input.value.trim().toLocaleLowerCase();
      const exact = query ? exactMatch(query) : null;
      if (exact) { pickItem(exact); return; }
      if (matches.length) { pick(active >= 0 ? active : 0); return; }
      if (query) toast(emptyText);
    }
  });
  results.addEventListener("mousedown", event => event.preventDefault());
  results.addEventListener("click", event => {
    const option = event.target.closest("[data-index]");
    if (option && results.contains(option)) pick(Number(option.dataset.index));
  });
  toggle?.addEventListener("click", () => {
    if (results.classList.contains("hidden")) { render(); input.focus(); }
    else hide();
  });
  return { hide, render };
}
document.addEventListener("click", event => {
  document.querySelectorAll(".item-search").forEach(field => {
    if (field.contains(event.target)) return;
    const box = field.querySelector(".item-search-results");
    if (!box || box.classList.contains("hidden")) return;
    box.classList.add("hidden");
    box.innerHTML = "";
    field.querySelector("input")?.setAttribute("aria-expanded", "false");
  });
});
function renderInventoryProducts() {
  const query = $("#search").value.trim().toLocaleLowerCase();
  const products = data.products.filter(item => [item.name, item.sku, item.barcode, item.unit, item.category, item.brand, item.color, item.size, item.material, item.generic_name, item.strength, item.dosage_form, item.manufacturer].some(value => String(value || "").toLocaleLowerCase().includes(query)));
  const canEditItems = signedInUser?.permissions?.records && data.permissions?.inventory;
  const canDeleteItems = canEditItems;
  $("#products-table").innerHTML = products.map(item => { const details = (data.shopType === "pharmacy" ? [["Generic",item.generic_name],["Strength",item.strength],["Form",item.dosage_form],["Maker",item.manufacturer]] : [["Brand", item.brand], ["Color", item.color], ["Size", item.size], ["Material", item.material]]).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(" · "); return `<tr><td class="product-cell">${esc(item.icon || "📦")} &nbsp;${esc(item.name)}${details ? `<small class="form-hint">${esc(details)}</small>` : ""}</td><td>${esc(item.category || "Other")}</td><td class="sku">${esc(item.sku)}</td><td class="sku">${esc(item.barcode || "—")}</td><td>${esc(item.unit || "piece")}</td><td>${money(item.price)}</td><td class="qty">${data.shopType === "pharmacy" ? `${productSellableQty(item)} sellable / ${Number(item.qty||0)} total` : `${item.qty} ${esc(item.unit || "piece")}`}</td><td class="stock-value" title="${item.qty} × ${money(item.price)} per unit"><b>${money(Number(item.qty) * Number(item.price))}</b></td><td><span class="status ${productSellableQty(item) === 0 ? "out" : productSellableQty(item) <= item.min ? "low" : ""}">${productSellableQty(item) === 0 ? (data.shopType === "pharmacy" && Number(item.qty)>0 ? "No safe-to-sell stock" : "Out of stock") : productSellableQty(item) <= item.min ? "Low stock" : "In stock"}</span></td><td>${canEditItems ? `<button class="user-action" data-action="rename-product" data-id="${item.id}" data-name="${esc(item.name)}" data-unit="${esc(item.unit || "piece")}" data-category="${esc(item.category || "Other")}">Edit item</button>` : ""}${canDeleteItems ? `<button class="user-action danger" data-action="delete-product" data-id="${item.id}" data-name="${esc(productLabel(item))}" data-qty="${item.qty}" data-unit="${esc(item.unit || "piece")}">Delete</button>` : ""}</td></tr>`; }).join("");
  $("#products-empty").textContent = data.products.length ? "No inventory items match your search." : "No products yet. Add your first item to get started.";
  $("#products-empty").classList.toggle("hidden", products.length > 0);
  const cost = products.reduce((sum, item) => sum + Number(item.cost || 0) * Number(item.qty || 0), 0);
  const retail = products.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
  const low = products.filter(item => Number(item.qty || 0) <= Number(item.min || 0)).length;
  const stockByUnit = new Map();
  products.forEach(item => {
    const unit = String(item.unit || "piece").trim() || "piece";
    const key = unit.toLocaleLowerCase();
    const current = stockByUnit.get(key) || { label: unit, qty: 0 };
    current.qty += Number(item.qty || 0);
    stockByUnit.set(key, current);
  });
  const totalInStock = [...stockByUnit.values()].map(item => `${Number(item.qty.toFixed(3)).toLocaleString("en-BD")} ${item.label}`).join(" · ") || "0";
  $("#inventory-summary").innerHTML = `<div class="list-summary-heading"><b>Inventory totals</b><small>${products.length} product${products.length === 1 ? "" : "s"}${query ? " matching your search" : " in this inventory"}</small></div><div class="list-summary-cards"><div><small>Total in stock</small><b title="${esc(totalInStock)}">${esc(totalInStock)}</b></div><div><small>Stock at cost</small><b>${money(cost)}</b></div><div><small>Stock at selling price</small><b>${money(retail)}</b></div><div><small>Potential gross profit</small><b>${money(retail - cost)}</b></div><div><small>Low / out of stock</small><b>${low}</b></div></div>`;
}
const repairStatuses = ["Received", "Diagnosing", "Waiting for parts", "In repair", "Ready", "Delivered", "Cancelled"];
function renderRepairJobs() {
  const query = (document.querySelector("#repair-search")?.value || "").trim().toLocaleLowerCase();
  const status = document.querySelector("#repair-status-filter")?.value || "";
  const jobs = (data.serviceJobs || []).filter(job => (!status || job.status === status) &&
    [job.job_no, job.customer, job.phone, job.brand, job.model, job.device_serial, job.issue].some(value => String(value || "").toLocaleLowerCase().includes(query)));
  const tbody = document.querySelector("#repairs-table");
  if (!tbody) return;
  tbody.innerHTML = jobs.map(job => {
    const warranty = Number(job.repair_warranty_days || 0), expiry = job.repair_warranty_expires || "";
    const warrantyText = job.status === "Delivered" && warranty ? `${expiry && expiry >= dateKey(new Date()) ? "Active" : "Expired"} · ${dateLabel(expiry)}` : warranty ? `${warranty} days on delivery` : "—";
    const repairAdmin = signedInUser?.role === "admin";
    const canEdit = job.status === "Delivered" ? !!data.permissions?.repair_records : job.status === "Cancelled" ? repairAdmin : true;
    const canDelete = repairAdmin || (job.status === "Delivered" && !!data.permissions?.repair_records);
    return `<tr><td><b>${esc(job.job_no)}</b></td><td>${dateLabel(job.received_date)}</td><td>${esc(job.customer)}<small class="form-hint">${esc(job.phone)}</small></td><td>${esc([job.brand, job.model].filter(Boolean).join(" "))}<small class="form-hint">${esc(job.device_serial || "No IMEI/serial")}</small></td><td>${esc(job.issue)}</td><td><span class="status ${job.status === "Delivered" ? "" : job.status === "Cancelled" ? "out" : "low"}">${esc(job.status)}</span></td><td>${esc(warrantyText)}</td><td>${money(job.status === "Delivered" ? job.final_charge : job.estimate)}<small class="form-hint">Due ${money(job.due)}</small></td><td>${canEdit ? `<button type="button" class="user-action" data-repair-action="open" data-id="${job.id}">Open</button>` : `<button type="button" class="user-action" disabled title="Only an administrator can reopen a cancelled job. Delivered edits need assigned access.">Locked</button>`}<button type="button" class="user-action" data-repair-action="print" data-id="${job.id}">Print ticket</button>${canDelete ? `<button type="button" class="user-action danger" data-repair-action="delete" data-id="${job.id}">Delete</button>` : ""}</td></tr>`;
  }).join("");
  document.querySelector("#repairs-empty")?.classList.toggle("hidden", jobs.length > 0);
}
document.querySelector("#repair-search")?.addEventListener("input", renderRepairJobs);
document.querySelector("#repair-status-filter")?.addEventListener("change", renderRepairJobs);
function renderDevices() {
  const query = (document.querySelector("#device-search")?.value || "").trim().toLocaleLowerCase();
  const rows = (data.devices || []).filter(device => [device.serial, device.product_name, device.customer, device.phone].some(value => String(value || "").toLocaleLowerCase().includes(query)));
  const body = document.querySelector("#devices-table");
  if (!body) return;
  body.innerHTML = rows.map(device => {
    const expired = device.warranty_expires && device.warranty_expires < dateKey(new Date());
    const status = device.status === "Returned" ? "Returned" : !device.warranty_months ? "No warranty" : expired ? "Warranty expired" : "Warranty active";
    return `<tr><td><b>${esc(device.serial)}</b></td><td>${esc(device.product_name)}</td><td>${dateLabel(device.sold_date)}</td><td>${esc(device.customer || "—")}<small class="form-hint">${esc(device.phone || "")}</small></td><td>${device.warranty_expires ? dateLabel(device.warranty_expires) : "—"}</td><td><span class="status ${device.status === "Returned" || expired ? "out" : "low"}">${status}</span></td></tr>`;
  }).join("");
  document.querySelector("#devices-empty")?.classList.toggle("hidden", rows.length > 0);
}
document.querySelector("#device-search")?.addEventListener("input", renderDevices);
function repairPartRow(productId = "", qty = 1, index = 0) {
  const options = data.products.map(product => `<option value="${product.id}" ${Number(product.id) === Number(productId) ? "selected" : ""}>${esc(productLabel(product))} · ${product.qty} ${esc(product.unit || "piece")} · cost ${money(product.cost)}</option>`).join("");
  return `<div class="form-row repair-part-row" data-part-row="${index}"><label>Stock part<select name="partProduct" required><option value="">Choose a part</option>${options}</select></label><label>Qty<input name="partQty" type="number" min="0.001" step="any" value="${Number(qty)}" required></label><button class="user-action danger" type="button" data-remove-part aria-label="Remove part">Remove</button></div>`;
}
function printRepairTicket(job) {
  const paid = Number(job.paid || 0), charge = job.status === "Delivered" ? Number(job.final_charge || 0) : Number(job.estimate || 0);
  const device = [job.brand, job.model].filter(Boolean).join(" ");
  const parts = (job.parts || []).map(part => `${part.product_name} × ${part.qty} ${part.unit}`).join(", ");
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(job.job_no)} repair ticket</title><style>
@page{size:80mm auto;margin:5mm}*{box-sizing:border-box}body{width:70mm;margin:0 auto;color:#111;font:12px/1.4 system-ui,"Segoe UI",sans-serif}h1{text-align:center;font-size:18px;margin:0}h2{font-size:15px;margin:12px 0 5px}.muted{color:#555}.center{text-align:center}.rule{border-top:1px dashed #555;margin:8px 0}.row{display:flex;justify-content:space-between;gap:8px}.field{margin:5px 0;overflow-wrap:anywhere}.label{font-weight:700}.signature{display:flex;justify-content:space-between;gap:12px;margin-top:30px}.signature span{width:48%;border-top:1px solid #555;padding-top:4px;text-align:center;font-size:10px}small{font-size:10px}</style></head><body>
<h1>${esc(data.shopName)}</h1><div class="center muted">${esc(data.workspace)}</div><div class="rule"></div><div class="center"><b>REPAIR INTAKE TICKET</b><br><b>${esc(job.job_no)}</b></div>
<div class="row"><span>Received</span><b>${esc(dateLabel(job.received_date))}</b></div>${job.promised_date ? `<div class="row"><span>Promised</span><b>${esc(dateLabel(job.promised_date))}</b></div>` : ""}<div class="row"><span>Status</span><b>${esc(job.status)}</b></div>
<div class="rule"></div><div class="field"><span class="label">Customer:</span> ${esc(job.customer)}</div><div class="field"><span class="label">Phone:</span> ${esc(job.phone)}</div><div class="field"><span class="label">Device:</span> ${esc(device || "—")}</div><div class="field"><span class="label">IMEI / serial:</span> ${esc(job.device_serial || "—")}</div>
<h2>Reported issue</h2><div class="field">${esc(job.issue)}</div><h2>Condition / accessories</h2><div class="field">${esc(job.notes || "Not recorded")}</div>${job.diagnosis ? `<h2>Diagnosis</h2><div class="field">${esc(job.diagnosis)}</div>` : ""}${parts ? `<h2>Parts recorded</h2><div class="field">${esc(parts)}</div>` : ""}
<div class="rule"></div><div class="row"><span>${job.status === "Delivered" ? "Final charge" : "Estimate"}</span><b>${money(charge)}</b></div><div class="row"><span>Paid</span><b>${money(paid)}</b></div><div class="row"><span>Balance</span><b>${money(Math.max(0, charge - paid))}</b></div>${job.status === "Delivered" && Number(job.repair_warranty_days) > 0 ? `<div class="field">Repair warranty: ${Number(job.repair_warranty_days)} days · until ${esc(dateLabel(job.repair_warranty_expires))}</div>` : ""}
<p class="center muted">Keep this ticket and present it when collecting your device.</p><div class="signature"><span>Customer signature</span><span>Received by</span></div><p class="center"><small>Thank you</small></p></body></html>`);
}
document.querySelector("#new-repair")?.addEventListener("click", () => openModal("New repair job", `<div class="form-row"><label>Customer name<input name="customer" maxlength="120" required></label><label>Phone<input name="phone" maxlength="40" required></label></div><div class="form-row"><label>Brand<input name="brand" maxlength="80" placeholder="Samsung, Apple, Xiaomi"></label><label>Model<input name="model" maxlength="120" required></label></div><label>IMEI / serial number<input name="deviceSerial" maxlength="120" autocomplete="off"></label><label>Customer reported issue<textarea name="issue" maxlength="500" required></textarea></label><div class="form-row"><label>Promised date<input name="promisedDate" type="date"></label><label>Estimated charge (${esc(currencySymbol())})<input name="estimate" type="number" min="0" step="0.01" value="0" required></label></div><div class="form-row"><label>Advance received (${esc(currencySymbol())})<input name="advance" type="number" min="0" step="0.01" value="0"></label><label>Payment method<select name="method">${paymentOptions("Cash", quickPaymentChoices())}</select></label></div><label>Condition / accessories at intake<textarea name="notes" maxlength="500" placeholder="Scratches, cracks, included charger/SIM tray"></textarea></label><p class="form-hint">Do not record a customer's PIN or password. You can print an intake ticket after saving this job.</p>`, async form => {
  data = await api("/api/service-jobs", { method: "POST", body: JSON.stringify({ customer: form.get("customer"), phone: form.get("phone"), brand: form.get("brand"), model: form.get("model"), deviceSerial: form.get("deviceSerial"), issue: form.get("issue"), promisedDate: form.get("promisedDate"), estimate: Number(form.get("estimate")), advance: Number(form.get("advance")), method: form.get("method"), notes: form.get("notes") }) });
  render(); renderRepairJobs(); toast("Repair job created");
}));
document.querySelector("#repairs-table")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-repair-action]"); if (!button) return;
  const job = (data.serviceJobs || []).find(row => String(row.id) === button.dataset.id); if (!job) return;
  if (button.dataset.repairAction === "print") return printRepairTicket(job);
  if (button.dataset.repairAction === "delete") {
    const repairAdmin = signedInUser?.role === "admin";
    const canDelete = repairAdmin || (job.status === "Delivered" && !!data.permissions?.repair_records);
    if (!canDelete) return toast("Only an administrator or a staff member with delivered repair access can delete this job.");
    if (!confirm(`Permanently delete ${job.job_no} for ${job.customer}? This removes its repair payments and sales entry, and restores recorded parts to stock.`)) return;
    try {
      data = await api(`/api/service-jobs/${job.id}`, { method: "DELETE" });
      render(); renderRepairJobs(); toast("Repair job deleted");
    } catch (error) { toast(error.message); }
    return;
  }
  const paid = Number(job.paid || 0);
  const payments = (job.payments || []).map(p => `${dateLabel(p.date)} · ${money(p.amount)} · ${esc(p.method)}`).join("<br>") || "No payments recorded";
  const repairAdmin = signedInUser?.role === "admin";
  const allowedStatuses = !repairAdmin && ["Delivered", "Cancelled"].includes(job.status) ? [job.status] : repairStatuses;
  const statusOptions = allowedStatuses.map(value => `<option ${value === job.status ? "selected" : ""}>${esc(value)}</option>`).join("");
  const reopenHint = repairAdmin && job.status === "Delivered" ? `<p class="form-hint">Changing this job back from Delivered removes its repair sale from reports until you deliver it again. Payment history stays. If payments are above the estimate, raise the estimate before reopening.</p>` : repairAdmin && job.status === "Cancelled" ? `<p class="form-hint">You can reopen this cancelled job by choosing an active repair status.</p>` : "";
  const initialPartRows = (job.parts || []).map((part, index) => repairPartRow(part.product_id, part.qty, index)).join("");
  openModal(`${esc(job.job_no)} · ${esc(job.model)}`, `${reopenHint}<p><b>${esc(job.customer)}</b> · ${esc(job.phone)}<br>Received ${dateLabel(job.received_date)} · IMEI/serial: ${esc(job.device_serial || "—")}</p><label>Reported issue<input name="issue" value="${esc(job.issue)}" required></label><label>Diagnosis<input name="diagnosis" value="${esc(job.diagnosis)}"></label><div class="form-row"><label>Status<select name="status">${statusOptions}</select></label><label>Promised date<input type="date" name="promisedDate" value="${esc(job.promised_date || "")}"></label></div><div><b>Parts used (deducted from inventory)</b><div id="repair-parts-list">${initialPartRows}</div><button id="repair-add-part" class="button secondary" type="button">＋ Add part</button><p class="form-hint">Selecting a part reduces its stock when this job is saved. Removing parts restores their stock.</p></div><div class="form-row"><label>Estimated charge (${esc(currencySymbol())})<input name="estimate" type="number" min="0" step="0.01" value="${Number(job.estimate)}"></label><label>Final charge (${esc(currencySymbol())})<input name="finalCharge" type="number" min="0" step="0.01" value="${Number(job.final_charge)}"></label></div><label>Repair warranty after delivery (days)<input name="repairWarrantyDays" type="number" min="0" max="365" step="1" value="${Number(job.repair_warranty_days || 0)}"><small class="form-hint">Set 0 for no repair warranty. The expiry date is calculated when the job is delivered.</small></label><p class="form-hint">Parts cost is calculated from the inventory item buying costs: <b>${money(job.parts_cost)}</b></p><label>Condition / accessories / notes<textarea name="notes" maxlength="500">${esc(job.notes)}</textarea></label><hr><p><b>Payments</b><br>${payments}<br>Total paid: ${money(paid)} · Balance: ${money(job.due)}</p>${job.status !== "Cancelled" ? `<div class="form-row"><label>Collect payment (${esc(currencySymbol())})<input name="paymentAmount" type="number" min="0" step="0.01" value="0"></label><label>Method<select name="paymentMethod">${paymentOptions("Cash", quickPaymentChoices())}</select></label></div>` : ""}<p class="form-hint">Mark the job Delivered only when complete. Delivery records the final service charge in Sales and reports. Selected parts are deducted from stock and returned if removed from the job.</p>`, async form => {
    data = await api(`/api/service-jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ issue: form.get("issue"), diagnosis: form.get("diagnosis"), status: form.get("status"), promisedDate: form.get("promisedDate"), parts: [...$("#repair-parts-list").querySelectorAll("[data-part-row]")].map(row => ({ productId: Number(row.querySelector("[name=partProduct]").value), qty: Number(row.querySelector("[name=partQty]").value) })), estimate: Number(form.get("estimate")), finalCharge: Number(form.get("finalCharge")), repairWarrantyDays: Number(form.get("repairWarrantyDays") || 0), notes: form.get("notes"), paymentAmount: Number(form.get("paymentAmount") || 0), paymentMethod: form.get("paymentMethod") }) });
    render(); renderRepairJobs(); toast("Repair job updated");
  });
  $("#repair-add-part").onclick = () => {
    const list = $("#repair-parts-list");
    list.insertAdjacentHTML("beforeend", repairPartRow("", 1, list.children.length));
  };
  $("#repair-parts-list").onclick = event => {
    const remove = event.target.closest("[data-remove-part]");
    if (remove) remove.closest("[data-part-row]").remove();
  };
});
$("#search").addEventListener("input", renderInventoryProducts);

const clothSizes = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "28", "30", "32", "34", "36", "38", "40", "Free Size"];
const clothColors = ["Black", "White", "Navy Blue", "Maroon", "Olive Green", "Sky Blue", "Pink", "Grey", "Mustard", "Beige"];
const clothMaterials = ["100% Cotton", "Linen", "Denim", "Silk", "Georgette", "Twill", "Polyester", "Rayon"];

function clothingFormFields(product = {}) {
  if (data.shopType !== "clothing" || !featureEnabled("clothing")) return "";
  return `<div class="clothing-presets">
    <div class="form-row">
      <label>Brand / Label<input name="brand" maxlength="60" value="${esc(product.brand || "")}" placeholder="Brand or designer label"></label>
      <label>Fabric / Material<input name="material" maxlength="60" value="${esc(product.material || "")}" placeholder="e.g. 100% Cotton, Denim"></label>
    </div>
    <div class="quick-chips" data-target="material">
      ${clothMaterials.map(m => `<button type="button" class="quick-chip" data-val="${esc(m)}">${esc(m)}</button>`).join("")}
    </div>
    <div class="form-row">
      <label>Size<input name="size" maxlength="60" value="${esc(product.size || "")}" placeholder="e.g. M, L, XL, 32, Free Size"></label>
      <label>Color<input name="color" maxlength="60" value="${esc(product.color || "")}" placeholder="e.g. Navy Blue, Black"></label>
    </div>
    <div class="quick-chips" data-target="size">
      ${clothSizes.map(s => `<button type="button" class="quick-chip" data-val="${esc(s)}">${esc(s)}</button>`).join("")}
    </div>
    <div class="quick-chips" data-target="color">
      ${clothColors.map(c => `<button type="button" class="quick-chip" data-val="${esc(c)}">${esc(c)}</button>`).join("")}
    </div>
    <small class="form-hint">Track each size and color variant separately with its own stock and barcode/SKU.</small>
  </div>`;
}

function pharmacyFormFields(product = {}, includeOpeningBatch = false) {
  if (data.shopType !== "pharmacy" || !featureEnabled("pharmacy")) return "";
  return `<fieldset class="pharmacy-fields"><legend>Medicine details</legend>
    <div class="form-row"><label>Generic name<input name="genericName" maxlength="160" value="${esc(product.generic_name || "")}" placeholder="Active ingredient"></label><label>Strength<input name="strength" maxlength="80" value="${esc(product.strength || "")}" placeholder="e.g. 500 mg"></label></div>
    <div class="form-row"><label>Dosage form<input name="dosageForm" maxlength="80" value="${esc(product.dosage_form || "")}" placeholder="Tablet, capsule, syrup, cream"></label><label>Manufacturer<input name="manufacturer" maxlength="160" value="${esc(product.manufacturer || "")}" placeholder="Manufacturer / company"></label></div>
    ${includeOpeningBatch ? `<div class="pharmacy-batch-opening"><h4>Opening stock batch</h4><div class="form-row"><label>Batch number<input name="batchNumber" maxlength="80" placeholder="Printed batch / lot number"></label><label>Expiry date<input name="expiryDate" type="date"></label></div><small class="form-hint">Required when opening stock quantity is greater than zero. Unknown-expiry stock cannot be dispensed.</small></div>` : ""}
  </fieldset>`;
}

function attachClothingChipEvents() {
  $("#modal-fields")?.querySelectorAll(".quick-chips").forEach(box => {
    const targetName = box.dataset.target;
    if (!targetName) return;
    const input = $(`#modal-fields [name=${targetName}]`);
    if (!input) return;
    box.onclick = e => {
      const chip = e.target.closest(".quick-chip");
      if (!chip) return;
      input.value = chip.dataset.val;
      input.dispatchEvent(new Event("input"));
    };
  });
}

const orderStatuses = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled", "Returned"];

function renderOnlineOrders() {
  const container = $("#online-orders");
  if (!container || container.classList.contains("hidden")) return;
  const searchInput = $("#online-order-search");
  const query = (searchInput?.value || "").trim().toLocaleLowerCase();
  const statusFilter = $("#online-order-status-filter")?.value || "";
  const from = $("#online-orders-from")?.value || "";
  const to = $("#online-orders-to")?.value || "";
  const invalidRange = Boolean(from && to && from > to);

  const allOrders = data.onlineOrders || [];
  const returnCount = (data.onlineOrderReturns || []).length;
  const returnCountBadge = $("#online-order-return-count");
  if (returnCountBadge) returnCountBadge.textContent = returnCount ? String(returnCount) : "";
  const billShortcut = $("#online-order-bills");
  if (billShortcut) { billShortcut.disabled = !data.permissions?.sales; billShortcut.title = data.permissions?.sales ? "Open Sales bills" : "Sales permission is required"; }
  const orders = invalidRange ? [] : allOrders.filter(order => {
    if ((from && order.date < from) || (to && order.date > to)) return false;
    if (statusFilter && order.order_status !== statusFilter) return false;
    if (!query) return true;
    const fields = [
      order.order_no, order.customer_name, order.customer_phone, order.shipping_address,
      order.city_area, order.courier, order.tracking_id, order.payment_method, order.notes,
      ...(order.lines || []).flatMap(l => [l.name, l.size, l.color, l.brand])
    ];
    return fields.some(val => String(val || "").toLocaleLowerCase().includes(query));
  });

  const pendingOrders = orders.filter(o => o.order_status === "Pending");
  const processingOrders = orders.filter(o => ["Confirmed", "Processing"].includes(o.order_status));
  const shippedOrders = orders.filter(o => o.order_status === "Shipped");
  const deliveredOrders = orders.filter(o => o.order_status === "Delivered");
  const codDueAmount = orders.filter(o => ["Pending", "Confirmed", "Processing", "Shipped"].includes(o.order_status))
                               .reduce((sum, o) => sum + Number(o.due_cod || 0), 0);
  const deliveredTotal = deliveredOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const returnedCount = orders.filter(o => ["Returned", "Cancelled"].includes(o.order_status)).length;

  const metricsBox = $("#online-orders-metrics");
  if (metricsBox) {
    metricsBox.innerHTML = `
      <div><small>Pending Orders</small><b>${pendingOrders.length}</b><small class="form-hint">${money(pendingOrders.reduce((s, o) => s + Number(o.total || 0), 0))}</small></div>
      <div><small>Processing / Packed</small><b>${processingOrders.length}</b><small class="form-hint">${money(processingOrders.reduce((s, o) => s + Number(o.total || 0), 0))}</small></div>
      <div><small>Out for Delivery</small><b>${shippedOrders.length}</b><small class="form-hint">${money(shippedOrders.reduce((s, o) => s + Number(o.total || 0), 0))}</small></div>
      <div><small>Delivered (Revenue)</small><b>${deliveredOrders.length}</b><small class="form-hint">${money(deliveredTotal)}</small></div>
      <div><small>Pending COD to Collect</small><b>${money(codDueAmount)}</b><small class="form-hint">${returnedCount} returned/cancelled</small></div>
    `;
  }

  const tbody = $("#online-orders-table");
  if (!tbody) return;

  const canDeleteOnlineOrders = signedInUser?.permissions?.delete_online_orders && data.permissions?.online_orders;

  tbody.innerHTML = orders.map(order => {
    const lines = order.lines || [];
    const itemsHtml = lines.map(l => {
      const details = [
        l.size ? `<span class="cloth-size-badge">${esc(l.size)}</span>` : "",
        l.color ? `<span class="cloth-color-badge">${esc(l.color)}</span>` : "",
        l.brand ? `<span class="cloth-brand-badge">${esc(l.brand)}</span>` : ""
      ].filter(Boolean).join(" ");
      return `<div style="margin-bottom:4px"><b>${esc(l.name)}</b> × ${l.qty} ${esc(l.unit || "piece")}${details ? ` ${details}` : ""} · ${money(l.lineTotal || (l.qty * l.price))}</div>`;
    }).join("") || "—";

    const courierInfo = order.courier
      ? `<b>${esc(order.courier)}</b>${order.tracking_id ? `<br><small class="form-hint">Tracking: <b>${esc(order.tracking_id)}</b></small>` : ""}`
      : `<span style="color:var(--muted)">Not assigned</span>`;

    const paymentInfo = `<b>COD: ${money(order.due_cod)}</b><br><small class="form-hint">${esc(order.payment_method)} (${esc(order.payment_status)})</small>${order.advance_paid > 0 ? `<br><small class="form-hint">Advance: ${money(order.advance_paid)}</small>` : ""}`;

    const totalInfo = `<b>${money(order.total)}</b>${order.delivery_charge > 0 ? `<br><small class="form-hint">+ ${money(order.delivery_charge)} deliv.</small>` : ""}${order.discount > 0 ? `<br><small class="form-hint">- ${money(order.discount)} disc.</small>` : ""}`;
    const orderReturnRows = (data.onlineOrderReturns || []).filter(row => Number(row.online_order_id) === Number(order.id));
    const alreadyReturnedQty = orderReturnRows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    const orderedQty = (order.lines || []).reduce((sum, line) => sum + Number(line.qty || 0), 0);
    const canRecordReturn = ((order.order_status === "Delivered" && order.stock_deducted) || (order.order_status === "Returned" && !order.stock_deducted && alreadyReturnedQty + 0.000001 < orderedQty)) && data.permissions?.inventory;
    const returnButton = `<button class="user-action" type="button" data-order-action="return" data-id="${order.id}" ${canRecordReturn ? "" : `disabled title="${!data.permissions?.inventory ? "Inventory permission is required" : alreadyReturnedQty + 0.000001 >= orderedQty && order.order_status === "Returned" ? "Return history is complete" : order.order_status === "Returned" ? "Return history is complete" : "Available after delivery"}"`}>${order.order_status === "Returned" ? "Record return" : "Return"}</button>`;
    const deleteButton = canDeleteOnlineOrders ? `<button class="user-action danger" type="button" data-order-action="delete" data-id="${order.id}" ${order.bill_id ? `disabled title="Delete the linked Sales bill first"` : ""}>Delete</button>` : "";

    const actions = [
      order.bill_id ? `<button class="user-action" type="button" data-order-action="bill" data-id="${order.id}">Bill #${order.bill_id}</button>` : `<button class="user-action" type="button" data-order-action="create-bill" data-id="${order.id}" ${!data.permissions?.sales || !order.stock_deducted ? `disabled title="${!data.permissions?.sales ? "Sales access is required" : "Confirm the order first"}"` : ""}>Create bill</button>`,
      `<button class="user-action" type="button" data-order-action="slip" data-id="${order.id}" title="Print a packing slip without item prices">Pack Slip</button>`,
      `<button class="user-action" type="button" data-order-action="invoice" data-id="${order.id}" title="Print customer invoice with item prices">Invoice</button>`,
      `<button class="user-action" type="button" data-order-action="status" data-id="${order.id}" title="Update status and courier tracking">Status</button>`,
      `<button class="user-action" type="button" data-order-action="edit" data-id="${order.id}">Edit</button>`,
    ].join("");

    return `<tr>
      <td><b>${esc(order.order_no)}</b><div class="online-order-row-actions">${returnButton}${deleteButton}</div></td>
      <td>${dateLabel(order.date)}</td>
      <td class="product-cell"><b>${esc(order.customer_name)}</b><br><small class="form-hint">📞 ${esc(order.customer_phone)}</small><br><small class="form-hint">📍 ${esc(order.shipping_address)}${order.city_area ? ` (${esc(order.city_area)})` : ""}</small></td>
      <td style="white-space:normal">${itemsHtml}</td>
      <td>${courierInfo}</td>
      <td>${paymentInfo}</td>
      <td>${totalInfo}</td>
      <td><span class="status ${order.order_status.toLowerCase()}">${esc(order.order_status)}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join("");

  $("#online-orders-empty").textContent = invalidRange ? "Choose a valid date range." : allOrders.length ? "No online orders match your search, status, or date filters." : "No online orders yet. Click 'New online order' to record your first parcel or customer shipment.";
  $("#online-orders-empty").classList.toggle("hidden", orders.length > 0);

  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const totalCod = orders.reduce((sum, o) => sum + Number(o.due_cod || 0), 0);
  const summaryBox = $("#online-orders-summary");
  if (summaryBox) {
    summaryBox.innerHTML = `
      <div class="list-summary-heading"><b>Online order totals</b><small>${orders.length} order${orders.length === 1 ? "" : "s"}${query || statusFilter || from || to ? " matching filters" : " recorded"}</small></div>
      <div class="list-summary-cards">
        <div><small>Total orders</small><b>${orders.length}</b></div>
        <div><small>Total order value</small><b>${money(totalRevenue)}</b></div>
        <div><small>Total COD collection</small><b>${money(totalCod)}</b></div>
        <div><small>Delivered count</small><b>${orders.filter(o => o.order_status === "Delivered").length}</b></div>
        <div><small>Active in progress</small><b>${orders.filter(o => ["Pending", "Confirmed", "Processing", "Shipped"].includes(o.order_status)).length}</b></div>
      </div>
    `;
  }
}

function printOrderSlip(order, documentType = "packing-slip") {
  const showPrices = documentType === "invoice";
  const documentTitle = showPrices ? "Customer Invoice" : "Packing Slip";
  const lines = order.lines || [];
  const contactDetails = [
    data.contactNumber ? `Phone: ${data.contactNumber}` : "",
    data.whatsappNumber ? `WhatsApp: ${data.whatsappNumber}` : "",
    data.email ? `Email: ${data.email}` : "",
    data.website ? `Web: ${data.website}` : "",
    data.facebookPage ? `Facebook: ${data.facebookPage}` : ""
  ].filter(Boolean).map(esc).join(" · ");
  const rawReturnAddress = data.contactAddress || data.workspace;
  const returnAddress = /^[+()\d\s.-]+$/.test(rawReturnAddress) && rawReturnAddress.replace(/\D/g, "").length >= 7 ? "" : rawReturnAddress;
  const linesHtml = lines.map((l, i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #ddd">${i + 1}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #ddd">
        <b>${esc(l.name)}</b>
        ${l.brand ? `<br><small>Brand: ${esc(l.brand)}</small>` : ""}
        ${l.size ? ` · <small>Size: <b>${esc(l.size)}</b></small>` : ""}
        ${l.color ? ` · <small>Color: <b>${esc(l.color)}</b></small>` : ""}
        ${l.material ? ` · <small>Material: <b>${esc(l.material)}</b></small>` : ""}
      </td>
      <td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:center">${l.qty} ${esc(l.unit || "piece")}</td>
      ${showPrices ? `<td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right">${money(l.price)}</td><td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right"><b>${money(l.lineTotal || (l.qty * l.price))}</b></td>` : ""}
    </tr>
  `).join("");
  const invoiceTotals = showPrices ? `
    <table class="totals-table">
      <tr><td>Subtotal:</td><td style="text-align:right"><b>${money(order.subtotal)}</b></td></tr>
      ${order.delivery_charge > 0 ? `<tr><td>Delivery Charge:</td><td style="text-align:right">${money(order.delivery_charge)}</td></tr>` : ""}
      ${order.discount > 0 ? `<tr><td>Discount:</td><td style="text-align:right">- ${money(order.discount)}</td></tr>` : ""}
      <tr style="border-top:2px solid #222;font-size:15px"><td><b>Grand Total:</b></td><td style="text-align:right"><b>${money(order.total)}</b></td></tr>
      ${order.advance_paid > 0 ? `<tr><td>Advance Paid (${esc(order.payment_method)}):</td><td style="text-align:right;color:#166534"><b>- ${money(order.advance_paid)}</b></td></tr>` : ""}
      <tr><td>Balance / COD:</td><td style="text-align:right"><b>${money(order.due_cod)}</b></td></tr>
    </table>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.order_no)} ${documentTitle}</title><style>
    @page { margin: 8mm; size: auto; }
    body { font: 13px/1.4 system-ui, "Segoe UI", sans-serif; color: #111; max-width: 680px; margin: 0 auto; padding: 10px; }
    .header { text-align: center; border-bottom: 2px solid #222; padding-bottom: 10px; margin-bottom: 12px; }
    .header h1 { margin: 0 0 4px; font-size: 22px; }
    .header p { margin: 0; color: #555; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 10px 12px; background: #fafafa; }
    .card h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
    .card p { margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px; }
    th { background: #f0f3f5; padding: 7px 8px; text-align: left; border-bottom: 2px solid #ccc; font-weight: 700; }
    .totals-table { width: 280px; margin-left: auto; margin-top: 10px; }
    .totals-table td { padding: 4px 6px; }
    .cod-box { border: 2px dashed #b78103; background: #fffdf5; border-radius: 8px; padding: 12px; text-align: center; margin-top: 14px; }
    .cod-box h2 { margin: 0; font-size: 20px; color: #925800; }
    .footer { text-align: center; margin-top: 20px; padding-top: 10px; border-top: 1px solid #ddd; color: #666; font-size: 12px; }
  </style></head><body>
    <div class="header">
      <h1>${esc(data.shopName)}</h1>
      ${returnAddress ? `<p>${esc(returnAddress)}</p>` : ""}
      ${contactDetails ? `<p style="margin-top:3px">${contactDetails}</p>` : ""}
      <p style="margin-top:4px;font-weight:700;font-size:15px">${showPrices ? "CUSTOMER INVOICE" : "PACKING SLIP"}</p>
    </div>
    <div class="grid">
      <div class="card">
        <h3>Order Details</h3>
        <p>Order No: <b>${esc(order.order_no)}</b></p>
        <p>Order Date: ${dateLabel(order.date)}</p>
        <p>Status: <b>${esc(order.order_status)}</b></p>
        ${returnAddress ? `<p>Return address: <b>${esc(returnAddress)}</b></p>` : ""}
        <p>Courier: <b>${esc(order.courier || "Standard Delivery")}</b></p>
        ${order.tracking_id ? `<p>Tracking ID: <b>${esc(order.tracking_id)}</b></p>` : ""}
      </div>
      <div class="card">
        <h3>Deliver To (Customer)</h3>
        <p style="font-size:15px;font-weight:700">${esc(order.customer_name)}</p>
        <p style="font-weight:600">📞 ${esc(order.customer_phone)}</p>
        <p>📍 ${esc(order.shipping_address)}</p>
        ${order.city_area ? `<p>Area / Zone: <b>${esc(order.city_area)}</b></p>` : ""}
        ${order.notes ? `<p style="color:#666;font-style:italic">Note: ${esc(order.notes)}</p>` : ""}
      </div>
    </div>
    <table>
      <thead><tr><th style="width:30px">#</th><th>Product / Variant</th><th style="text-align:center;width:70px">Qty</th>${showPrices ? `<th style="text-align:right;width:90px">Price</th><th style="text-align:right;width:100px">Total</th>` : ""}</tr></thead>
      <tbody>${linesHtml}</tbody>
    </table>
    ${invoiceTotals}
    <div class="cod-box">
      <small style="text-transform:uppercase;font-weight:700;letter-spacing:.04em">Cash on Delivery (COD) Amount to Collect</small>
      <h2>${order.due_cod > 0 ? money(order.due_cod) : "PAID IN ADVANCE — DO NOT COLLECT"}</h2>
    </div>
    <div class="footer"><p>Thank you for shopping with ${esc(data.shopName)}!</p></div>
  </body></html>`;
  printHtml(html);
}

function openOnlineOrderModal(orderId = 0) {
  const existing = orderId ? (data.onlineOrders || []).find(o => Number(o.id) === Number(orderId)) : null;
  const couriers = ["Steadfast Courier", "Pathao Courier", "RedX", "Paperfly", "Sundarban Courier", "SA Paribahan", "In-house Delivery", "Other"];
  const paymentMethods = ["Cash on Delivery", "bKash", "Nagad", "Card", "Bank Transfer", "Paid in full"];

  const stockedProducts = data.products.filter(p => p.qty > 0 || (existing && (existing.lines || []).some(l => Number(l.productId) === Number(p.id))));
  if (!stockedProducts.length && !existing) return toast("No products in stock to create an online order.");

  let cart = existing ? (existing.lines || []).map(l => {
    const p = data.products.find(x => Number(x.id) === Number(l.productId));
    return {
      productId: l.productId,
      name: l.name,
      category: l.category || p?.category || "Other",
      brand: l.brand || p?.brand || "",
      size: l.size || p?.size || "",
      color: l.color || p?.color || "",
      unit: l.unit || p?.unit || "piece",
      price: Number(l.price),
      qty: Number(l.qty),
      cost: Number(l.cost || p?.cost || 0),
      max: p ? Number((p.qty + (existing.stock_deducted ? l.qty : 0)).toFixed(6)) : l.qty
    };
  }) : [];

  const title = existing ? `Edit Online Order ${esc(existing.order_no)}` : "New Online Order";

  const markup = `
      <label>Choose existing customer (optional)
        <select id="order-saved-customer"><option value="">New customer / enter details</option>${(data.onlineOrderCustomers || []).map((customer, index) => `<option value="${index}">${esc(customer.name)}${customer.phone ? ` · ${esc(customer.phone)}` : ""}</option>`).join("")}</select>
      </label>
      <div class="form-row"><label>Customer name<input name="customerName" maxlength="120" value="${esc(existing?.customer_name || "")}" placeholder="Customer full name" required></label>
      <label>Customer phone<input name="customerPhone" maxlength="40" value="${esc(existing?.customer_phone || "")}" placeholder="017XXXXXXXX" inputmode="tel" required></label></div>
    <label>Delivery / shipping address<input name="shippingAddress" maxlength="500" value="${esc(existing?.shipping_address || "")}" placeholder="House, Road, Area, Thana, District" required></label>
    <div class="form-row">
      <label>City / Delivery zone
        <input name="cityArea" id="order-city-area" maxlength="100" value="${esc(existing?.city_area || "Inside Dhaka")}" placeholder="Inside Dhaka, Outside Dhaka, etc.">
      </label>
      <label>Courier service
        <select name="courier" id="order-courier">
          ${couriers.map(c => `<option ${existing?.courier === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="quick-chips" id="delivery-zone-chips">
      <button type="button" class="quick-chip" data-zone="Inside Dhaka" data-charge="60">Inside Dhaka (৳60)</button>
      <button type="button" class="quick-chip" data-zone="Sub-Dhaka / Gazipur" data-charge="100">Sub-Dhaka (৳100)</button>
      <button type="button" class="quick-chip" data-zone="Outside Dhaka" data-charge="120">Outside Dhaka (৳120)</button>
      <button type="button" class="quick-chip" data-zone="Store Pickup" data-charge="0">Free (৳0)</button>
    </div>
    <div class="form-row">
      <label>Courier tracking / Consignment ID<input name="trackingId" maxlength="100" value="${esc(existing?.tracking_id || "")}" placeholder="e.g. SF-87263541"></label>
      <label>Order status
        <select name="orderStatus" id="order-status-select">
          ${orderStatuses.map(st => `<option ${(existing ? existing.order_status : "Pending") === st ? "selected" : ""}>${esc(st)}</option>`).join("")}
        </select>
      </label>
    </div>
    <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
    <div class="item-search">
      <label for="order-product-search">Add product to order</label>
      <div class="item-search-wrap">
        <input id="order-product-search" type="search" autocomplete="off" placeholder="Product name, size, color, SKU, or barcode">
        <button type="button" class="item-search-toggle" id="order-product-search-toggle" aria-label="Show all in-stock products" title="Show all in-stock products">▾</button>
        <div class="item-search-results hidden" id="order-product-search-results" role="listbox" aria-label="Matching in-stock products"></div>
      </div>
      <small class="form-hint">Pick a product from the list, or scan a barcode and press Enter, to add it to the order below.</small>
    </div>
    <div class="order-items-builder">
      <table>
        <thead>
          <tr>
            <th>ITEM &amp; SIZE/COLOR</th>
            <th style="width:90px">PRICE</th>
            <th style="width:75px">QTY</th>
            <th style="width:90px">TOTAL</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody id="order-cart-lines"></tbody>
      </table>
      <div class="empty" id="order-cart-empty">No items added yet. Search and pick clothing items above.</div>
    </div>
    <div class="form-row">
      <label>Delivery charge (${esc(currencySymbol())})<input name="deliveryCharge" id="order-delivery-charge" type="number" min="0" step="0.01" value="${Number(existing?.delivery_charge ?? 60)}" required></label>
      <label>Discount (${esc(currencySymbol())})<input name="discount" id="order-discount" type="number" min="0" step="0.01" value="${Number(existing?.discount || 0)}" required></label>
    </div>
    <div class="form-row">
      <label>Payment method
        <select name="paymentMethod">
          ${paymentMethods.map(pm => `<option ${existing?.payment_method === pm ? "selected" : ""}>${esc(pm)}</option>`).join("")}
        </select>
      </label>
      <label>Advance payment received (${esc(currencySymbol())})
        <input name="advancePaid" id="order-advance-paid" type="number" min="0" step="0.01" value="${Number(existing?.advance_paid || 0)}" placeholder="0.00">
      </label>
    </div>
    <label>Order note / special instructions<textarea name="notes" maxlength="500" placeholder="e.g. Call before delivery">${esc(existing?.notes || "")}</textarea></label>
    <div class="order-summary-box">
      <div class="order-summary-row"><span>Items subtotal:</span><b id="order-subtotal-disp">৳0</b></div>
      <div class="order-summary-row"><span>Delivery charge:</span><span id="order-delivery-disp">৳0</span></div>
      <div class="order-summary-row"><span>Discount:</span><span id="order-discount-disp">৳0</span></div>
      <div class="order-summary-row total"><span>Grand total:</span><b id="order-total-disp">৳0</b></div>
      <div class="order-summary-row"><span>Advance paid:</span><span id="order-advance-disp" style="color:#166534">৳0</span></div>
      <div class="order-summary-row cod"><span>CASH ON DELIVERY (COD):</span><b id="order-cod-disp">৳0</b></div>
    </div>
  `;

  openModal(title, markup, async form => {
    if (!cart.length) throw new Error("Please add at least one product item to the order.");
    if (cart.some(l => !(l.qty > 0))) throw new Error("Enter a valid quantity greater than 0 for each item.");
    for (const line of cart) {
      if (line.qty > line.max) throw new Error(`Not enough stock for "${line.name}". Only ${line.max} ${line.unit} available in stock.`);
    }

    const payload = {
      customerName: form.get("customerName").trim(),
      customerPhone: form.get("customerPhone").trim(),
      shippingAddress: form.get("shippingAddress").trim(),
      cityArea: form.get("cityArea").trim(),
      courier: form.get("courier"),
      trackingId: form.get("trackingId").trim(),
      orderStatus: form.get("orderStatus"),
      deliveryCharge: Number(form.get("deliveryCharge") || 0),
      discount: Number(form.get("discount") || 0),
      advancePaid: Number(form.get("advancePaid") || 0),
      paymentMethod: form.get("paymentMethod"),
      notes: form.get("notes").trim(),
      items: cart.map(l => ({
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        price: l.price,
        size: l.size,
        color: l.color,
        brand: l.brand,
        unit: l.unit
      }))
    };

    if (existing) {
      data = await api(`/api/online-orders/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      render();
      toast(`Order ${existing.order_no} updated`);
    } else {
      const result = await api("/api/online-orders", { method: "POST", body: JSON.stringify(payload) });
      const { orderId: newId, orderNo: newNo, ...state } = result;
      data = state;
      render();
      toast(`Order ${newNo} placed successfully`);
      const newOrder = (data.onlineOrders || []).find(o => o.id === newId);
      if (newOrder && confirm(`Order ${newNo} saved! Would you like to print the price-free packing slip now?`)) {
        printOrderSlip(newOrder);
      }
    }
  });

  dialog.classList.add("wide");
  $("#submit-modal").textContent = existing ? "Save changes" : "Place order";
  dialog.addEventListener("close", () => { dialog.classList.remove("wide"); $("#submit-modal").textContent = "Save"; }, { once: true });

  $("#order-saved-customer").onchange = event => {
    const customer = (data.onlineOrderCustomers || [])[Number(event.target.value)];
    if (!customer) return;
    $("#modal-fields [name=customerName]").value = customer.name || "";
    $("#modal-fields [name=customerPhone]").value = customer.phone || "";
    $("#modal-fields [name=shippingAddress]").value = customer.address || "";
    if (customer.city_area) $("#modal-fields [name=cityArea]").value = customer.city_area;
  };

  const calculate = () => {
    const subtotal = cart.reduce((sum, l) => sum + (l.price * l.qty), 0);
    const delivery = Number($("#order-delivery-charge")?.value) || 0;
    const discount = Number($("#order-discount")?.value) || 0;
    const total = Math.max(0, subtotal + delivery - discount);
    const advance = Number($("#order-advance-paid")?.value) || 0;
    const cod = Math.max(0, total - advance);

    $("#order-subtotal-disp").textContent = money(subtotal);
    $("#order-delivery-disp").textContent = money(delivery);
    $("#order-discount-disp").textContent = discount > 0 ? `- ${money(discount)}` : money(0);
    $("#order-total-disp").textContent = money(total);
    $("#order-advance-disp").textContent = advance > 0 ? `- ${money(advance)}` : money(0);
    $("#order-cod-disp").textContent = money(cod);
  };

  const drawCart = () => {
    $("#order-cart-lines").innerHTML = cart.map((line, i) => {
      const details = [
        line.size ? `<span class="cloth-size-badge">${esc(line.size)}</span>` : "",
        line.color ? `<span class="cloth-color-badge">${esc(line.color)}</span>` : ""
      ].filter(Boolean).join(" ");
      return `<tr>
        <td class="product-cell"><b>${esc(line.name)}</b>${details ? `<br>${details}` : ""}<br><small class="form-hint">In stock: ${line.max} ${esc(line.unit)}</small></td>
        <td><input type="number" min="0" step="0.01" class="bill-input" data-i="${i}" data-f="price" value="${Number(line.price)}" style="width:80px"></td>
        <td><input type="number" min="0.001" step="any" max="${line.max}" class="bill-input" data-i="${i}" data-f="qty" value="${Number(line.qty)}" style="width:65px"></td>
        <td><b>${money(line.price * line.qty)}</b></td>
        <td><button type="button" class="user-action danger" data-remove="${i}">×</button></td>
      </tr>`;
    }).join("");
    $("#order-cart-empty").classList.toggle("hidden", cart.length > 0);
    calculate();
  };

  const addProductLine = product => {
    if (!product) return;
    const existingLine = cart.find(l => Number(l.productId) === Number(product.id));
    if (!existingLine) {
      cart.push({
        productId: product.id,
        name: product.name,
        category: product.category || "Other",
        brand: product.brand || "",
        size: product.size || "",
        color: product.color || "",
        unit: product.unit || "piece",
        price: Number(product.price),
        cost: Number(product.cost || 0),
        qty: 1,
        max: Number(product.qty)
      });
    } else if (existingLine.qty < existingLine.max) {
      existingLine.qty++;
    } else {
      return toast(`Only ${existingLine.max} ${existingLine.unit} of ${existingLine.name} in stock.`);
    }
    drawCart();
    $("#order-product-search")?.focus();
  };
  initItemSearch({
    input: $("#order-product-search"),
    results: $("#order-product-search-results"),
    toggle: $("#order-product-search-toggle"),
    getItems: () => stockedProducts,
    onPick: addProductLine,
    emptyText: "No in-stock product matches that name, SKU, or barcode."
  });

  $("#order-cart-lines").oninput = e => {
    const input = e.target;
    const line = cart[input.dataset.i];
    if (!line) return;
    if (input.dataset.f === "price") line.price = Number(input.value) || 0;
    if (input.dataset.f === "qty") {
      let val = Number(input.value) || 0;
      if (val > line.max) { val = line.max; input.value = val; toast(`Only ${line.max} ${line.unit} available in stock.`); }
      line.qty = val;
    }
    input.closest("tr").cells[3].innerHTML = `<b>${money(line.price * line.qty)}</b>`;
    calculate();
  };

  $("#order-cart-lines").onclick = e => {
    const btn = e.target.closest("[data-remove]");
    if (btn) {
      cart.splice(Number(btn.dataset.remove), 1);
      drawCart();
    }
  };

  $("#delivery-zone-chips").onclick = e => {
    const chip = e.target.closest(".quick-chip");
    if (!chip) return;
    $("#order-city-area").value = chip.dataset.zone;
    $("#order-delivery-charge").value = chip.dataset.charge;
    calculate();
  };

  $("#order-delivery-charge").oninput = calculate;
  $("#order-discount").oninput = calculate;
  $("#order-advance-paid").oninput = calculate;

  drawCart();
}

function openOrderStatusModal(order) {
  const couriers = ["Steadfast Courier", "Pathao Courier", "RedX", "Paperfly", "Sundarban Courier", "SA Paribahan", "In-house Delivery", "Other"];
  const statusOptions = orderStatuses.map(st => `<option ${order.order_status === st ? "selected" : ""}>${esc(st)}</option>`).join("");
  const courierOptions = couriers.map(c => `<option ${order.courier === c ? "selected" : ""}>${esc(c)}</option>`).join("");

  const markup = `
    <p><b>${esc(order.order_no)}</b> · ${esc(order.customer_name)} (📞 ${esc(order.customer_phone)})<br>
    Delivery to: ${esc(order.shipping_address)}</p>
    <div class="form-row">
      <label>Order status<select name="orderStatus" required>${statusOptions}</select></label>
      <label>Courier service<select name="courier">${courierOptions}</select></label>
    </div>
    <label>Courier tracking / Consignment ID<input name="trackingId" value="${esc(order.tracking_id || "")}" placeholder="Enter tracking number"></label>
    <div class="form-row">
      <label>Advance payment received (${esc(currencySymbol())})<input name="advancePaid" type="number" min="0" step="0.01" value="${Number(order.advance_paid || 0)}"></label>
      <label>Order total (${esc(currencySymbol())})<input value="${money(order.total)}" disabled></label>
    </div>
    <label>Notes<textarea name="notes" maxlength="500">${esc(order.notes || "")}</textarea></label>
    <p class="form-hint">Changing status to Confirmed, Processing, Shipped, or Delivered automatically reserves and deducts stock. Changing to Cancelled or Returned restores stock.</p>
  `;

  openModal(`Update Order ${esc(order.order_no)}`, markup, async form => {
    data = await api(`/api/online-orders/${order.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        orderStatus: form.get("orderStatus"),
        courier: form.get("courier"),
        trackingId: form.get("trackingId").trim(),
        advancePaid: Number(form.get("advancePaid") || 0),
        notes: form.get("notes").trim()
      })
    });
    render();
    toast(`Order ${order.order_no} status updated to ${form.get("orderStatus")}`);
  });
}

function downloadOnlineOrdersExcel() {
  const orders = data.onlineOrders || [];
  if (!orders.length) return toast("No online orders to download.");
  const rows = [
    ["Order #", "Date", "Customer Name", "Phone", "Shipping Address", "City/Area", "Courier", "Tracking ID", "Items", "Subtotal", "Delivery Charge", "Discount", "Grand Total", "Advance Paid", "Due COD", "Payment Method", "Payment Status", "Order Status", "Notes"]
  ];
  for (const o of orders) {
    const itemsSummary = (o.lines || []).map(l => `${l.name} (${[l.size, l.color].filter(Boolean).join("/")}) x ${l.qty}`).join("; ");
    rows.push([
      o.order_no, o.date, o.customer_name, o.customer_phone, o.shipping_address, o.city_area,
      o.courier, o.tracking_id, itemsSummary, o.subtotal, o.delivery_charge, o.discount,
      o.total, o.advance_paid, o.due_cod, o.payment_method, o.payment_status, o.order_status, o.notes
    ]);
  }
  const csv = "﻿" + rows.map(row => row.map(val => csvCell(val)).join(",")).join("\r\n");
  downloadFile(`online-orders-${dateKey(new Date())}.csv`, csv);
  toast("Online orders downloaded");
}

document.querySelector("#online-order-search")?.addEventListener("input", renderOnlineOrders);
document.querySelector("#online-order-status-filter")?.addEventListener("change", renderOnlineOrders);
document.querySelector("#online-orders-from")?.addEventListener("change", renderOnlineOrders);
document.querySelector("#online-orders-to")?.addEventListener("change", renderOnlineOrders);
document.querySelector("#online-orders-clear-dates")?.addEventListener("click", () => { $("#online-orders-from").value = ""; $("#online-orders-to").value = ""; renderOnlineOrders(); });

function openOnlineOrderReturnModal(order) {
  const recorded = (data.onlineOrderReturns || []).filter(row => Number(row.online_order_id) === Number(order.id));
  const availableLines = (order.lines || []).map((line, index) => {
    const returned = recorded.filter(row => Number(row.order_line_index) === index).reduce((sum, row) => sum + Number(row.qty || 0), 0);
    const remaining = Math.max(0, Number(line.qty || 0) - returned);
    const fractional = /^(kgs?|kilos?|kilograms?|gm?s?|grams?|l|ltrs?|lit(re|er)s?|ml|m|meters?|metres?|ft|feet|foot|yards?|yd|inch(es)?|cm|mm)$/i.test(String(line.unit || "piece").trim());
    return { line, index, remaining, min: fractional ? "0.001" : "1", step: fractional ? "0.001" : "1" };
  }).filter(item => item.remaining > 0.000001);
  if (!availableLines.length) return toast("All items on this order already have return records.");
  const alreadyReturned = order.order_status === "Returned" && !order.stock_deducted;
  const paymentMethods = (data.paymentMethods || ["Cash", "bKash", "Nagad"]).filter(method => !/due|cash on delivery|paid in full/i.test(method));
  const itemRows = availableLines.map(({ line, index, remaining, min, step }, rowIndex) => {
    const detail = [line.size, line.color, line.brand, line.material].filter(Boolean).join(" · ");
    return `<tr><td><input class="order-return-selected" type="checkbox" name="lineIndex" value="${index}" ${rowIndex === 0 ? "checked" : ""} aria-label="Select ${esc(line.name)}"></td><td><b>${esc(line.name)}</b>${detail ? `<br><small>${esc(detail)}</small>` : ""}</td><td>${remaining} ${esc(line.unit || "piece")}</td><td><input class="order-return-qty" name="qty_${index}" type="number" min="${min}" max="${remaining}" step="${step}" value="${remaining}" ${rowIndex === 0 ? "required" : "disabled"} aria-label="Return quantity for ${esc(line.name)}"></td></tr>`;
  }).join("");
  openModal(`Record return · ${order.order_no}`, `
    ${alreadyReturned ? '<p class="notice">This order was already marked Returned. Saving records the return history without changing stock again.</p>' : ""}
    <p class="form-hint">Select one or more returned items and quantities. Unpaid balance is reduced first; refunds apply only to money already collected.</p>
    <div class="table-scroll bill-cart online-return-items"><table><thead><tr><th>Return</th><th>Item</th><th>Available</th><th>Quantity</th></tr></thead><tbody>${itemRows}</tbody></table></div>
    <div class="form-row"><label>Refund now (${esc(currencySymbol())})<input name="refundAmount" type="number" min="0" step="0.01" value="0"></label><label>Refund method<select name="refundMethod">${paymentMethods.map(method => `<option>${esc(method)}</option>`).join("") || "<option>Cash</option>"}</select></label></div>
    <label>Reason<input name="reason" maxlength="300" value="Customer return" placeholder="Reason for return"></label>
    <p class="form-hint">Set refund to 0 to apply the return as credit. Refunds above the paid balance will be rejected.</p>
  `, async form => {
    const lineIndexes = form.getAll("lineIndex").map(Number);
    if (!lineIndexes.length) throw new Error("Select at least one item to return.");
    const items = lineIndexes.map(lineIndex => ({ lineIndex, qty: Number(form.get(`qty_${lineIndex}`)) }));
    if (items.some(item => !(item.qty > 0))) throw new Error("Enter a valid quantity for every selected item.");
    const refundAmount = Number(form.get("refundAmount") || 0);
    if (refundAmount < 0 || !Number.isFinite(refundAmount)) throw new Error("Enter a valid refund amount.");
    const refundMethod = refundAmount > 0 ? String(form.get("refundMethod") || "Cash") : "";
    data = await api(`/api/online-orders/${order.id}/returns`, { method: "POST", body: JSON.stringify({ items, reason: String(form.get("reason") || "").trim(), refundAmount, refundMethod }) });
    render();
    toast(`Return recorded for ${order.order_no}`);
  });
  dialog.classList.add("wide");
  dialog.addEventListener("close", () => dialog.classList.remove("wide"), { once: true });
  document.querySelectorAll(".order-return-selected").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      const qty = document.querySelector(`input[name="qty_${checkbox.value}"]`);
      if (qty) { qty.disabled = !checkbox.checked; qty.required = checkbox.checked; }
    });
  });
}

function openOnlineOrderReturnsHistory() {
  const rows = data.onlineOrderReturns || [];
  openModal("Online order returns", `<div class="returns-search-row"><label class="search">⌕ <input type="search" id="online-returns-search" placeholder="Search customer, order, item, reason"></label><button class="button secondary" type="button" id="online-returns-clear">Clear filters</button></div><div class="returns-date-filters"><label>From<input type="date" id="online-returns-from"></label><label>To<input type="date" id="online-returns-to"></label></div><p class="form-hint" id="online-returns-count"></p><div class="table-scroll bill-cart" style="max-height:430px"><table><thead><tr><th>Date</th><th>Order / bill</th><th>Customer</th><th>Item</th><th>Qty</th><th>Value</th><th>Refund</th><th>Reason</th></tr></thead><tbody id="online-returns-body"></tbody></table></div><div class="empty hidden" id="online-returns-empty"></div>`, async () => {});
  dialog.classList.add("wide");
  $("#submit-modal").classList.add("hidden");
  $("#cancel-modal").textContent = "Close";
  dialog.addEventListener("close", () => { dialog.classList.remove("wide"); $("#submit-modal").classList.remove("hidden"); $("#cancel-modal").textContent = "Cancel"; }, { once: true });
  const renderRows = () => {
    const from = $("#online-returns-from").value, to = $("#online-returns-to").value;
    const query = $("#online-returns-search").value.trim().toLocaleLowerCase();
    const invalid = Boolean(from && to && from > to);
    const filtered = invalid ? [] : rows.filter(row => {
      if ((from && row.date < from) || (to && row.date > to)) return false;
      const order = (data.onlineOrders || []).find(item => Number(item.id) === Number(row.online_order_id));
      const haystack = [row.date, row.product, row.reason, row.actor, row.refund_method, row.qty, row.total, order?.order_no, order?.customer_name, row.bill_id ? billNo(row.bill_id) : ""].join(" ").toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
    $("#online-returns-body").innerHTML = filtered.map(row => {
      const order = (data.onlineOrders || []).find(item => Number(item.id) === Number(row.online_order_id));
      const reference = [order?.order_no, row.bill_id ? billNo(row.bill_id) : ""].filter(Boolean).join(" · ") || "—";
      return `<tr><td>${esc(dateLabel(row.date))}</td><td>${esc(reference)}</td><td>${esc(order?.customer_name || "—")}</td><td>${esc(row.product)}</td><td>${row.qty} ${esc(row.unit || "piece")}</td><td>${money(row.total)}</td><td>${Number(row.refund_amount) > 0 ? `${money(row.refund_amount)} · ${esc(row.refund_method)}` : "Credit"}</td><td>${esc(row.reason || "—")}<br><small>${esc(row.actor || "")}</small></td></tr>`;
    }).join("");
    $("#online-returns-count").textContent = invalid ? "The start date must be before the end date." : `Showing ${filtered.length} of ${rows.length} returns`;
    $("#online-returns-empty").classList.toggle("hidden", filtered.length > 0);
    $("#online-returns-empty").textContent = invalid ? "Choose a valid date range." : rows.length && !filtered.length ? "No returns match these filters." : "No return transactions yet. Use Return on a delivered order, or Record return on an order already marked Returned.";
  };
  $("#online-returns-search").oninput = renderRows;
  $("#online-returns-from").onchange = renderRows;
  $("#online-returns-to").onchange = renderRows;
  $("#online-returns-clear").onclick = () => { $("#online-returns-search").value = ""; $("#online-returns-from").value = ""; $("#online-returns-to").value = ""; renderRows(); };
  renderRows();
}

function openOnlineOrderCustomers() {
  const customers = data.onlineOrderCustomers || [], orders = data.onlineOrders || [];
  const customerKey = customer => customer.phone ? customer.phone.replace(/\s+/g, "") : customer.name.toLocaleLowerCase();
  const rollup = [...new Map(customers.map(customer => [customerKey(customer), customer])).values()].map(customer => {
    const key = customerKey(customer);
    const matching = orders.filter(order => customerKey({ name: order.customer_name || "", phone: order.customer_phone || "" }) === key);
    return { ...customer, count: matching.length, total: matching.reduce((sum, order) => sum + Number(order.total || 0), 0), latest: matching[0]?.date || "", search: customer.phone || customer.name };
  });
  openModal("Online order customers", `<label class="search">⌕ <input id="online-customer-search" placeholder="Search customer name or phone"></label><p class="form-hint" id="online-customer-count"></p><div class="table-scroll bill-cart" style="max-height:430px"><table><thead><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Order value</th><th>Latest order</th></tr></thead><tbody id="online-customer-body"></tbody></table></div><div class="empty hidden" id="online-customer-empty">No customers found.</div>`, async () => {});
  dialog.classList.add("wide");
  const renderCustomers = () => {
    const query = $("#online-customer-search").value.trim().toLocaleLowerCase();
    const filtered = rollup.filter(customer => !query || `${customer.name} ${customer.phone}`.toLocaleLowerCase().includes(query));
    $("#online-customer-body").innerHTML = filtered.map(customer => `<tr data-customer-search="${esc(customer.search)}"><td>${esc(customer.name)}</td><td>${esc(customer.phone || "—")}</td><td>${customer.count}</td><td>${money(customer.total)}</td><td>${customer.latest ? esc(dateLabel(customer.latest)) : "—"}</td></tr>`).join("");
    $("#online-customer-count").textContent = `${filtered.length} customer${filtered.length === 1 ? "" : "s"} · Select a row to filter orders`;
    $("#online-customer-empty").classList.toggle("hidden", filtered.length > 0);
    $("#online-customer-body").querySelectorAll("tr[data-customer-search]").forEach(row => row.onclick = () => { $("#online-order-search").value = row.dataset.customerSearch; closeModal(); renderOnlineOrders(); });
  };
  $("#online-customer-search").oninput = renderCustomers;
  renderCustomers();
}

document.querySelector("#online-order-customers")?.addEventListener("click", () => openOnlineOrderCustomers());
document.querySelector("#online-order-bills")?.addEventListener("click", () => { if (!data.permissions?.sales) return toast("Sales permission is required to view Bills."); openBills(false); });
document.querySelector("#online-order-returns")?.addEventListener("click", () => openOnlineOrderReturnsHistory());
document.querySelector("#download-online-orders")?.addEventListener("click", downloadOnlineOrdersExcel);
document.querySelector("#new-online-order")?.addEventListener("click", () => openOnlineOrderModal(0));
document.querySelector("#online-orders-table")?.addEventListener("click", async event => {
  const button = event.target.closest("[data-order-action]");
  if (!button) return;
  const orderId = Number(button.dataset.id);
  const order = (data.onlineOrders || []).find(o => Number(o.id) === orderId);
  if (!order) return toast("Order not found. Refresh and try again.");

  if (button.dataset.orderAction === "return") {
    openOnlineOrderReturnModal(order);
  } else if (button.dataset.orderAction === "create-bill") {
    const earlierReturns = (data.onlineOrderReturns || []).filter(row => Number(row.online_order_id) === Number(order.id));
    const returnedValue = earlierReturns.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const returnNote = earlierReturns.length ? ` ${earlierReturns.length} return record(s) worth ${money(returnedValue)} will be linked to the bill and deducted from its final total.` : "";
    if (!confirm(`Create a Sales bill for ${order.order_no}?${returnNote} The existing order stock deduction will be reused, so stock will not be deducted again. COD remains due until recorded as paid in Bills.`)) return;
    try { data = await api(`/api/online-orders/${order.id}/bill`, { method: "POST", body: JSON.stringify({}) }); render(); toast(`Sales bill created for ${order.order_no}`); }
    catch (error) { toast(error.message); }
  } else if (button.dataset.orderAction === "bill") {
    try { printBill(await api(`/api/bills/${order.bill_id}`)); } catch (error) { toast(error.message); }
  } else if (button.dataset.orderAction === "slip") {
    printOrderSlip(order, "packing-slip");
  } else if (button.dataset.orderAction === "invoice") {
    printOrderSlip(order, "invoice");
  } else if (button.dataset.orderAction === "status") {
    openOrderStatusModal(order);
  } else if (button.dataset.orderAction === "edit") {
    openOnlineOrderModal(order.id);
  } else if (button.dataset.orderAction === "delete") {
    const returnCount = (data.onlineOrderReturns || []).filter(row => Number(row.online_order_id) === Number(order.id)).length;
    const deleteNote = returnCount ? ` This will also remove ${returnCount} related return record${returnCount === 1 ? "" : "s"}.` : "";
    const stockNote = order.stock_deducted ? " Inventory for unreturned items will be restored; already returned items stay in stock." : " Inventory will not change.";
    if (!confirm(`Delete online order ${order.order_no} for ${order.customer_name}? This permanently removes the order.${deleteNote}${stockNote}`)) return;
    try {
      data = await api(`/api/online-orders/${order.id}`, { method: "DELETE" });
      render();
      toast(`Order ${order.order_no} deleted`);
    } catch (error) {
      toast(error.message);
    }
  }
});

function render() {
  const permissions = data.permissions || {};
  const canManageSalesRecords = signedInUser?.permissions?.records && permissions.sales;
  const canManageExpenseRecords = signedInUser?.permissions?.records && permissions.expenses;
  const todayKey = dateKey(new Date());
  const month = todayKey.slice(0, 7);
  const displayName = signedInUser?.displayName || signedInUser?.username || "Shopkeeper";
  $("#welcome-greeting").innerHTML = `${t("Good morning")}, ${esc(displayName)} <span>✳</span>`;
  $("#signed-in-as").textContent = displayName;
  $("#profile-initial").textContent = displayName.trim().charAt(0).toUpperCase() || "?";
  const profilePhoto = $("#profile-photo");
  if (signedInUser?.avatarData) {
    profilePhoto.src = signedInUser.avatarData;
    profilePhoto.classList.remove("hidden");
    $("#profile-initial").classList.add("hidden");
  } else {
    profilePhoto.removeAttribute("src");
    profilePhoto.classList.add("hidden");
    $("#profile-initial").classList.remove("hidden");
  }
  $("#shop-name").textContent = data.shopName || "Shop Desk";
  $("#footer-shop-name").textContent = data.shopName || "Shop Desk";
  document.title = `${data.shopName || "Shop Desk"} — Shop desk`;
  $("#workspace-name").textContent = data.workspace || "Set workspace";
  refreshTopbarClock();
  renderDashboardTrend();
  const dashboardReturns = permissions.sales ? (data.salesReturns || []).slice(0, 5) : [];
  $("#dashboard-returns").classList.toggle("hidden", !permissions.sales);
  $("#dashboard-returns-list").innerHTML = dashboardReturns.length ? dashboardReturns.map(row => `<div class="dashboard-return-row"><div class="dashboard-return-product">${esc(row.product)}<small class="dashboard-return-meta">${dateLabel(row.date)}${row.reason ? ` · ${esc(row.reason)}` : ""}</small></div><span class="dashboard-return-qty">${Number(row.qty)} ${esc(row.unit || "piece")}</span><b class="dashboard-return-amount">${money(row.total)}</b></div>`).join("") : '<div class="dashboard-returns-empty">No product returns have been recorded.</div>';
  const salesToday = data.sales.filter(item => item.date === todayKey);
  $("#today-sales").textContent = permissions.sales ? money(salesToday.reduce((sum, item) => sum + item.total, 0)) : "—";
  $("#today-count").textContent = permissions.sales ? `${salesToday.length} transactions` : "No access";
  $("#today-profit").textContent = permissions.sales ? money(salesToday.reduce((sum, item) => sum + item.total - item.cost, 0)) : "—";
  const monthlyExpenses = data.expenses.filter(item => item.date.startsWith(month));
  $("#month-expenses").textContent = permissions.expenses ? money(monthlyExpenses.reduce((sum, item) => sum + item.amount, 0)) : "—";
  $("#expense-count").textContent = permissions.expenses ? `${monthlyExpenses.length} recorded this month` : "No access";
  $("#stock-total").textContent = permissions.inventory ? data.products.length : "—";
  $("#nav-stock").textContent = permissions.inventory ? data.products.length : "";
  $(".stock-panel").classList.toggle("hidden", !permissions.inventory);
  $(".metrics article:last-child").classList.toggle("hidden", !permissions.inventory);

  $("#inventory-nav").classList.toggle("hidden", !permissions.inventory);
  $("#sales-nav").classList.toggle("hidden", !permissions.sales);
  $("#sale-shortcut").classList.toggle("hidden", data.shopType === "pharmacy" && featureEnabled("pharmacy"));
  $("#pharmacy-batches-button")?.classList.toggle("hidden", !(permissions.inventory && data.shopType === "pharmacy" && featureEnabled("pharmacy")));
  const onlineOrdersEnabled = !!permissions.online_orders;
  $("#online-orders-nav").classList.toggle("hidden", !onlineOrdersEnabled);
  const repairsEnabled = data.shopType === "mobile" && permissions.sales && featureEnabled("repairs");
  const devicesEnabled = data.shopType === "mobile" && permissions.sales && featureEnabled("devices");
  $("#repairs-nav").classList.toggle("hidden", !repairsEnabled);
  $("#devices-nav").classList.toggle("hidden", !devicesEnabled);
  $("#expenses-nav").classList.toggle("hidden", !permissions.expenses);
  $("#reports-nav").classList.toggle("hidden", !permissions.sales && !permissions.expenses);
  $("#inventory").classList.toggle("hidden", !permissions.inventory);
  const canBulkInventory = signedInUser?.role === "admin" && signedInUser?.permissions?.records && permissions.inventory;
  $("#bulk-inventory-tools").classList.toggle("hidden", !canBulkInventory);
  $("#bulk-inventory-help").classList.toggle("hidden", !canBulkInventory);
  $("#manage-categories").classList.toggle("hidden", !(signedInUser?.permissions?.records && permissions.inventory));
  $("#sales").classList.toggle("hidden", !permissions.sales);
  $("#online-orders")?.classList.toggle("hidden", !onlineOrdersEnabled);
  $("#repairs").classList.toggle("hidden", !repairsEnabled);
  $("#devices").classList.toggle("hidden", !devicesEnabled);
  $("#expenses").classList.toggle("hidden", !permissions.expenses);
  $("#reports").classList.toggle("hidden", !permissions.sales && !permissions.expenses);
  $("#users").classList.toggle("hidden", !(signedInUser?.permissions?.team || signedInUser?.permissions?.admins));
  const backupAccess = signedInUser?.role === "admin" && !!signedInUser?.permissions?.backups;
  $("#backup-tools-nav").classList.toggle("hidden", !backupAccess);
  $("#server-load").classList.toggle("hidden", !signedInUser?.permissions?.server_load);
  $("#fresh-start-tab").classList.toggle("hidden", !(signedInUser?.username?.toLowerCase() === "jahangir" && signedInUser?.role === "admin"));
  const canSettings = Boolean(permissions.settings);
  $("#edit-workspace-icon")?.classList.toggle("hidden", !canSettings);
  $("#edit-workspace")?.classList.toggle("readonly", !canSettings);
  if ($("#edit-workspace")) $("#edit-workspace").title = canSettings ? "Click to edit shop settings and location" : "Workspace location";
  const activeOrders = (data.onlineOrders || []).filter(o => ["Pending", "Confirmed", "Processing", "Shipped"].includes(o.order_status));
  if ($("#nav-online-orders")) $("#nav-online-orders").textContent = onlineOrdersEnabled && activeOrders.length ? activeOrders.length : "";
  $("#new-sale").classList.toggle("hidden", !permissions.sales || data.requireCustomer || data.taxMode !== "none" || !quickPaymentChoices().length);
  $("#sale-shortcut").classList.toggle("hidden", !permissions.sales || data.requireCustomer || data.taxMode !== "none" || !quickPaymentChoices().length);
  $("#low-count").textContent = permissions.inventory ? `${data.products.filter(item => item.qty <= item.min).length} low` : "—";

  const low = data.products.filter(item => item.qty <= item.min);
  $("#stock-watch-count").textContent = low.length ? `${low.length} low` : "";
  $("#stock-watch").innerHTML = low.length
    ? `<div class="table-scroll stock-watch-scroll"><table><thead><tr><th>PRODUCT</th><th>UNIT</th><th>IN STOCK</th><th>REORDER AT</th><th>STATUS</th></tr></thead><tbody>${low.map(item => `<tr><td class="product-cell" data-label="Product">${esc(item.icon || "📦")} &nbsp;${esc(productLabel(item))}</td><td data-label="Unit">${esc(item.unit || "piece")}</td><td class="qty" data-label="In stock">${item.qty} ${esc(item.unit || "piece")}</td><td data-label="Reorder at">${item.min} ${esc(item.unit || "piece")}</td><td data-label="Status"><span class="status ${item.qty === 0 ? "out" : "low"}">${item.qty === 0 ? "Out of stock" : "Low stock"}</span></td></tr>`).join("")}</tbody></table></div>`
    : '<div class="empty">Everything is stocked up. Nice work!</div>';
  renderInventoryProducts();
  renderOnlineOrders();
  renderRepairJobs();
  renderDevices();
  const canReturnSales = permissions.sales && permissions.inventory;
  $("#sales-actions-header").classList.toggle("hidden", !canManageSalesRecords && !canReturnSales);
  $("#sales").classList.toggle("sales-has-actions", canManageSalesRecords || canReturnSales);
  $("#sales-table").innerHTML = data.sales.map(item => {
    const returned = Number(item.returned_qty || 0) > 0;
    const isRepair = Number(item.service_job_id) > 0;
    const returnButton = !isRepair && canReturnSales && item.product_id && Number(item.original_remaining_qty) > 0
      ? `<button type="button" class="user-action" data-sale-action="return" data-id="${item.id}">Return</button>` : "";
    const actions = [
      canManageSalesRecords && !isRepair ? `<button class="user-action" data-sale-action="edit" data-id="${item.id}">Edit</button><button class="user-action danger" data-sale-action="delete" data-id="${item.id}">Delete</button>` : ""
    ].join("");
    return `<tr><td>${dateLabel(item.date)}</td><td class="product-cell">${esc(item.product)}${returned ? `<small class="form-hint">Returned ${Number(item.returned_qty)} ${esc(item.unit || "piece")}</small>` : ""}${returnButton}</td><td>${item.qty} ${esc(item.unit || "piece")}</td><td>${esc(item.payment)}</td><td><b>${money(item.total)}</b>${Number(item.tax_amount) > 0 ? `<small class="form-hint">+ ${money(item.tax_amount)} tax</small>` : ""}</td>${canManageSalesRecords || canReturnSales ? `<td>${actions || "—"}</td>` : ""}</tr>`;
  }).join("");
  $("#sales-empty").classList.toggle("hidden", data.sales.length > 0);
  const salesGross = data.sales.reduce((sum, item) => sum + Number(item.original_total ?? item.total ?? 0), 0);
  const salesNet = data.sales.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const returnsTotal = Math.max(0, salesGross - salesNet);
  $("#sales-summary").innerHTML = `<div class="list-summary-heading"><b>Sales totals</b><small>All-time totals across recorded sale lines</small></div><div class="list-summary-cards"><div><small>Sale lines</small><b>${data.sales.length}</b></div><div><small>Gross sales</small><b>${money(salesGross)}</b></div><div><small>Returned value</small><b>${money(returnsTotal)}</b></div><div><small>Net sales after returns</small><b>${money(salesNet)}</b></div></div>`;
  $("#expenses-actions-header").classList.toggle("hidden", !canManageExpenseRecords);
  $("#expenses").classList.toggle("expenses-has-actions", canManageExpenseRecords);
  $("#expenses-table").innerHTML = data.expenses.map(item => `<tr><td>${dateLabel(item.date)}</td><td>${esc(item.category)}</td><td>${esc(item.note || "—")}</td><td><b>${money(item.amount)}</b></td>${canManageExpenseRecords ? `<td><button class="user-action" data-expense-action="edit" data-id="${item.id}">Edit</button><button class="user-action danger" data-expense-action="delete" data-id="${item.id}">Delete</button></td>` : ""}</tr>`).join("");
  $("#expenses-empty").classList.toggle("hidden", data.expenses.length > 0);
  $("#add-product").classList.toggle("hidden", !permissions.inventory);
  $("#new-sale").classList.toggle("hidden", !permissions.sales || data.requireCustomer || data.taxMode !== "none" || !quickPaymentChoices().length);
  $("#sale-shortcut").classList.toggle("hidden", !permissions.sales || data.requireCustomer || data.taxMode !== "none" || !quickPaymentChoices().length);
  $("#add-expense").classList.toggle("hidden", !permissions.expenses);
  renderReport();
  localizeCurrencyLabels();
  renderLicenseBanner();
  renderBackupWarning();
  translateDom(document.body);
  if (!repairsEnabled && location.hash === "#repairs") showScreen("dashboard", true);
  if (!devicesEnabled && location.hash === "#devices") showScreen("dashboard", true);
  if (!onlineOrdersEnabled && location.hash === "#online-orders") showScreen("dashboard", true);
}

const dialog = $("#modal");
const bulkInventoryHeaders = ["Product ID", "Product Name", "SKU", "Selling Price", "Cost", "Quantity", "Low Stock Alert", "Unit", "Category", "Barcode", "Brand", "Color", "Size", "Material"];
function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[=+@\- \t\r]/.test(text)) text = "'" + text;
  return `"${text.split('"').join('""')}"`;
}
// Firefox (and older Safari) only start a download when the temporary link is in the document.
function downloadFile(filename, content, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("The CSV file has an unfinished quoted cell.");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(values => values.some(value => value.trim() !== ""));
}
// <dialog> is fairly new (Firefox 98+, Safari 15.4+). These helpers keep the same
// behaviour in older browsers by driving the open attribute and a manual backdrop.
const supportsNativeDialog = typeof dialog.showModal === "function" && typeof dialog.close === "function";
const modalIsOpen = () => dialog.hasAttribute("open");
function syncModalLayer() {
  const open = modalIsOpen(), fallback = open && !supportsNativeDialog;
  document.body.classList.toggle("modal-open", open);
  $("#modal-backdrop")?.classList.toggle("hidden", !fallback);
  dialog.classList.toggle("modal-fallback", fallback);
}
function closeDialogElement(element) {
  if (!element || !element.hasAttribute("open")) return;
  if (typeof element.close === "function") element.close();
  else {
    element.removeAttribute("open");
    element.dispatchEvent(new Event("close"));
  }
}
function openModal(title, markup, onSave) {
  $("#modal-title").textContent = t(title);
  const submit = $("#submit-modal");
  if (submit) submit.textContent = t("Save");
  const errorBanner = $("#modal-error-banner");
  if (errorBanner) {
    errorBanner.textContent = "";
    errorBanner.classList.add("hidden");
  }
  $("#modal-fields").innerHTML = markup;
  localizeCurrencyLabels($("#modal-fields"));
  translateDom($("#modal-fields"));
  $("#modal-fields").oninput = () => {
    if (errorBanner) errorBanner.classList.add("hidden");
  };
  $("#modal-form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    $("#submit-modal").disabled = true;
    try {
      const shouldClose = await onSave(new FormData(form));
      if (shouldClose !== false && modalIsOpen()) closeModal();
    } catch (error) {
      if (errorBanner) {
        errorBanner.textContent = error.message;
        errorBanner.classList.remove("hidden");
        errorBanner.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      }
      toast(error.message);
    }
    finally { $("#submit-modal").disabled = false; }
  };
  if (!modalIsOpen()) {
    if (supportsNativeDialog) {
      try { dialog.showModal(); }
      catch { dialog.setAttribute("open", ""); }
    } else dialog.setAttribute("open", "");
  }
  syncModalLayer();
  if (!markup.includes("autofocus")) {
    const firstField = $("#modal-fields input:not([type=hidden]), #modal-fields select, #modal-fields textarea");
    if (firstField && document.activeElement !== firstField) setTimeout(() => firstField.focus(), 30);
  }
}
function closeModal() {
  if (!modalIsOpen()) { syncModalLayer(); return; }
  closeDialogElement(dialog);
  syncModalLayer();
}
$("#cancel-modal").onclick = closeModal;
$("#modal-cancel").onclick = closeModal;
dialog.addEventListener("close", syncModalLayer);
dialog.addEventListener("cancel", event => {
  // Escape first closes an open item-search suggestion list, not the whole modal.
  if (closeItemSearches(dialog)) event.preventDefault();
});
$("#modal-backdrop")?.addEventListener("click", closeModal);
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  // Escape closes an open suggestion list first; a second Escape closes the modal.
  if (closeItemSearches(document)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (modalIsOpen() && !supportsNativeDialog) {
    event.preventDefault();
    closeModal();
  }
}, true);

$("#edit-workspace").onclick = () => {
  if (!data.permissions.settings) {
    toast("You do not have permission to change shop settings and location.");
    return;
  }
  const select = (name, values, current, disabled = false) => `<select name="${name}" ${disabled ? "disabled" : ""}>${values.map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${label}</option>`).join("")}</select>`;
  openModal("Shop settings", `<label>Shop name<input name="shopName" value="${esc(data.shopName)}" required></label><label>Workspace / location<input name="workspace" value="${esc(data.workspace)}" required></label><h3>Business contact details for printed orders</h3><div class="form-row"><label>Contact number<input name="contactNumber" maxlength="60" value="${esc(data.contactNumber || "")}"></label><label>WhatsApp number<input name="whatsappNumber" maxlength="60" value="${esc(data.whatsappNumber || "")}"></label></div><div class="form-row"><label>Email address<input name="email" type="email" maxlength="254" value="${esc(data.email || "")}"></label><label>Website<input name="website" maxlength="250" value="${esc(data.website || "")}" placeholder="www.example.com"></label></div><label>Facebook page<input name="facebookPage" maxlength="250" value="${esc(data.facebookPage || "")}" placeholder="Facebook page URL"></label><label>Contact / return address<input name="contactAddress" maxlength="300" value="${esc(data.contactAddress || "")}" placeholder="Office or shop return address"></label><div class="form-row"><label>Shop type${select("shopType", [["general","General retail"],["hardware","Hardware"],["grocery","Grocery"],["clothing","Clothing"],["pharmacy","Pharmacy"],["mobile","Mobile phone sales & service"]], data.shopType, data.shopTypeLocked)}<small class="form-hint">${data.shopTypeLocked ? "Set by your supplier-issued signed licence. Contact the supplier to change your package." : "Your supplier will set the final shop type when issuing your signed licence."}</small></label><label>Currency${select("currencyCode", [["BDT","Bangladeshi taka (BDT)"],["USD","US dollar (USD)"],["EUR","Euro (EUR)"],["GBP","Pound sterling (GBP)"],["INR","Indian rupee (INR)"],["PKR","Pakistani rupee (PKR)"],["NPR","Nepalese rupee (NPR)"],["LKR","Sri Lankan rupee (LKR)"],["AUD","Australian dollar (AUD)"],["CAD","Canadian dollar (CAD)"]], data.currencyCode)}<small class="form-hint">Changing currency changes display only; it does not convert existing amounts.</small></label></div><label>Number and date region${select("locale", [["en-BD","English · Bangladesh"],["bn-BD","বাংলা · বাংলাদেশ"],["en-US","English · United States"],["en-GB","English · United Kingdom"],["en-IN","English · India"],["en-PK","English · Pakistan"],["en-NP","English · Nepal"],["en-LK","English · Sri Lanka"],["en-AU","English · Australia"],["en-CA","English · Canada"]], data.locale)}</label><label>Language<select name="language"><option value="bn" ${data.language === "bn" ? "selected" : ""}>বাংলা</option><option value="en" ${data.language !== "bn" ? "selected" : ""}>English</option></select></label><label class="setting-check"><input type="checkbox" name="banglaDigits" ${data.banglaDigits ? "checked" : ""}> Bangla digits (০১২৩)</label></div><div class="form-row"><label>Tax mode${select("taxMode", [["none","No tax"],["inclusive","Tax included in prices"],["exclusive","Add tax at checkout"]], data.taxMode)}</label><label>Tax rate (%)<input name="taxRate" type="number" min="0" max="100" step="0.01" value="${Number(data.taxRate || 0)}"></label></div><label>Payment methods <small class="form-hint">Separate options with commas. Example: Cash, Card, Mobile pay, Due.</small><input name="paymentMethods" maxlength="400" value="${esc((data.paymentMethods || []).join(", "))}" required></label><label class="setting-check"><input type="checkbox" name="requireCustomer" ${data.requireCustomer ? "checked" : ""}> Require a customer name on every bill</label><label class="setting-check"><input type="checkbox" name="allowDiscounts" ${data.allowDiscounts ? "checked" : ""}> Allow bill discounts</label>`, async form => {
    const previousLanguage = data.language, previousDigits = data.banglaDigits;
    data = await api("/api/settings", { method: "PUT", body: JSON.stringify({ shopName: form.get("shopName").trim(), workspace: form.get("workspace").trim(), contactNumber: form.get("contactNumber").trim(), website: form.get("website").trim(), email: form.get("email").trim(), facebookPage: form.get("facebookPage").trim(), whatsappNumber: form.get("whatsappNumber").trim(), contactAddress: form.get("contactAddress").trim(), shopType: form.get("shopType") || data.shopType, currencyCode: form.get("currencyCode"), locale: form.get("locale"), taxMode: form.get("taxMode"), taxRate: Number(form.get("taxRate")), paymentMethods: String(form.get("paymentMethods")).split(",").map(value => value.trim()).filter(Boolean), requireCustomer: form.get("requireCustomer") === "on", allowDiscounts: form.get("allowDiscounts") === "on", language: form.get("language"), banglaDigits: form.get("banglaDigits") === "on" }) });
    if (data.language !== previousLanguage || data.banglaDigits !== previousDigits) { location.reload(); return; }
    render();
    toast("Shop details saved");
  });
  $("#open-license-settings")?.remove();
  $("#modal-fields")?.insertAdjacentHTML("beforeend", `<p class="settings-license-row"><button type="button" class="button secondary" id="open-license-settings">Licence & plan</button> <span class="form-hint">${esc(t("Installation ID"))}: <code title="${esc(data.license?.installShort || "")}">${esc(data.license?.installId || "")}</code></span></p>`);
  const licenseButton = $("#open-license-settings");
  if (licenseButton) licenseButton.onclick = () => { closeModal(); openLicenseModal(); };
  $("#settings-update-row")?.remove();
  $("#modal-fields")?.insertAdjacentHTML("beforeend", `<p class="settings-update-row" id="settings-update-row"><button type="button" class="button secondary" id="check-updates">${esc(t("Check for updates"))}</button> <span class="form-hint" id="update-status" role="status"></span></p>`);
  const updateButton = $("#check-updates");
  if (updateButton) updateButton.onclick = async () => {
    const note = $("#update-status");
    updateButton.disabled = true;
    note.textContent = t("Checking…");
    try {
      const result = await api("/api/update-check");
      if (!result.configured) note.textContent = t("Updates are not configured on this server.");
      else if (result.updateAvailable) note.innerHTML = `${esc(t("Version {version} is available.", { version: result.latest }))} ${result.url ? `<a href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">${esc(t("Download update"))}</a>` : esc(t("Ask your supplier for the update."))}`;
      else note.textContent = `${t("You are running the latest version.")} (${result.current})`;
    } catch (error) { note.textContent = `${t("Could not check for updates.")} ${error.message}`; }
    finally { updateButton.disabled = false; }
  };
};

function imageAsSmallJpeg(file) {
  return new Promise((resolve, reject) => {
    const supportedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!file || !supportedTypes.includes(file.type) || file.size > 5 * 1024 * 1024) {
      reject(new Error("Choose a JPG, PNG, WEBP, or GIF image smaller than 5 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("That image could not be opened."));
      image.onload = () => {
        try {
          const scale = Math.min(1, 256 / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        } catch { reject(new Error("Could not process that image.")); }
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
$("#profile-button").onclick = () => {
  if (!signedInUser) return;
  const oldPhoto = signedInUser.avatarData;
  openModal("Your profile", `<div class="profile-photo-picker"><img id="profile-preview" class="${oldPhoto ? "" : "hidden"}" src="${oldPhoto || ""}" alt="Current profile photo"><span id="profile-preview-initial" class="${oldPhoto ? "hidden" : ""}">${esc((signedInUser.displayName || signedInUser.username).charAt(0).toUpperCase())}</span></div><label>Display name<input name="displayName" maxlength="40" value="${esc(signedInUser.displayName || signedInUser.username)}" required></label><label>Profile photo<input id="profile-file" name="photo" type="file" accept="image/*"><small> Image is resized and stored with your account.</small></label><label class="clear-photo"><input name="clearPhoto" type="checkbox"> Remove current photo</label>`, async form => {
    const selectedPhoto = form.get("photo");
    const avatarData = form.get("clearPhoto") === "on" ? null : selectedPhoto?.size ? await imageAsSmallJpeg(selectedPhoto) : oldPhoto;
    const result = await api("/api/profile", { method: "PATCH", body: JSON.stringify({ displayName: form.get("displayName").trim(), avatarData }) });
    signedInUser = result.user;
    render();
    toast("Profile saved");
  });
  const passwordButton = document.createElement("button");
  passwordButton.type = "button";
  passwordButton.className = "user-action";
  passwordButton.textContent = "Change my password";
  passwordButton.style.marginTop = "12px";
  passwordButton.onclick = () => {
    openModal("Change your password", `<p class="form-hint">Changing your password signs out all sessions for this account.</p><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" required><small>Use at least 12 characters.</small></label><label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label>`, async form => {
      const password = form.get("password");
      if (password !== form.get("confirmPassword")) throw new Error("The new passwords do not match.");
      await api(`/api/users/${signedInUser.id}`, { method: "PATCH", body: JSON.stringify({ currentPassword: form.get("currentPassword"), password }) });
      toast("Password changed. Please sign in again with your new password.");
      closeModal();
      showAuth();
      $("#login-form").classList.remove("hidden");
    });
    $("#submit-modal").textContent = "Change password";
  };
  $("#modal-fields").append(passwordButton);
  const canManageRecoverySettings = signedInUser.role === "admin" || signedInUser.username?.toLowerCase() === "jahangir";
  if (canManageRecoverySettings) {
  const recoveryButton = document.createElement("button");
  recoveryButton.type = "button";
  recoveryButton.className = "user-action";
  recoveryButton.textContent = "Set up account recovery";
  recoveryButton.style.marginTop = "8px";
  recoveryButton.onclick = () => {
    openModal("Set up account recovery", `<p class="form-hint">A recovery code lets you reset your password if you are locked out. Store it offline. Generating a new code replaces any previous code.</p><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><div id="recovery-code-result" class="hidden"></div>`, async form => {
      const result = await api("/api/recovery-code", { method: "POST", body: JSON.stringify({ currentPassword: form.get("currentPassword") }) });
      const area = $("#recovery-code-result");
      area.innerHTML = `<p><b>Save this code now.</b> It will only be shown here once. Keep it somewhere private and offline.</p><label>Recovery code<input id="new-recovery-code" readonly></label><button class="button secondary" id="copy-new-recovery-code" type="button">Copy recovery code</button><p class="form-hint" id="recovery-copy-message" aria-live="polite"></p>`;
      $("#new-recovery-code").value = result.recoveryCode;
      $("#copy-new-recovery-code").onclick = async () => {
        try { await navigator.clipboard.writeText(result.recoveryCode); $("#recovery-copy-message").textContent = "Copied. Store it somewhere safe."; }
        catch { $("#new-recovery-code").select(); $("#recovery-copy-message").textContent = "Select and copy the code above, then store it somewhere safe."; }
      };
      area.classList.remove("hidden");
      $("#modal-fields [name=currentPassword]").value = "";
      $("#submit-modal").disabled = true;
      $("#submit-modal").textContent = "Recovery code created";
      return false;
    });
    $("#submit-modal").textContent = "Generate recovery code";
  };
  $("#modal-fields").append(recoveryButton);
  const emailButton = document.createElement("button");
  emailButton.type = "button";
  emailButton.className = "user-action";
  emailButton.textContent = signedInUser.emailVerified ? "Change verified recovery email" : "Add recovery email";
  emailButton.style.marginTop = "8px";
  emailButton.onclick = () => {
    const emailStatus = signedInUser.emailVerified ? `Current verified email: ${esc(signedInUser.email)}.` : "No verified recovery email is set for this account.";
    openModal("Set up email recovery", `<p class="form-hint">${emailStatus} Gmail sends a short-lived verification code. Only a verified email can receive password reset codes.</p><label>Email address<input name="email" type="email" maxlength="254" autocomplete="email" value="${esc(signedInUser.email || "")}" required></label><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label id="email-confirm-code-label" class="hidden">Email verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label><p class="form-hint" id="email-verification-status" aria-live="polite"></p>`, async form => {
      if (!emailButton.dataset.pendingVerification) {
        const result = await api("/api/profile/email-verification", { method: "POST", body: JSON.stringify({ email: form.get("email"), currentPassword: form.get("currentPassword") }) });
        emailButton.dataset.pendingVerification = "true";
        $("#email-confirm-code-label").classList.remove("hidden");
        $("#email-confirm-code-label input").required = true;
        $("#email-verification-status").textContent = result.message;
        const currentPasswordInput = $("#modal-fields [name=currentPassword]");
        currentPasswordInput.value = "";
        currentPasswordInput.required = false;
        currentPasswordInput.disabled = true;
        $("#modal-fields [name=email]").readOnly = true;
        $("#submit-modal").textContent = "Verify email";
        return false;
      }
      const result = await api("/api/profile/email-verification/confirm", { method: "POST", body: JSON.stringify({ code: form.get("code") }) });
      signedInUser = result.user;
      delete emailButton.dataset.pendingVerification;
      toast("Recovery email verified");
    });
    $("#submit-modal").textContent = "Send verification code";
  };
  $("#modal-fields").append(emailButton);
  }
  $("#profile-file").onchange = async event => {
    if (!event.target.files?.[0]) return;
    try {
      const preview = await imageAsSmallJpeg(event.target.files[0]);
      $("#profile-preview").src = preview;
      $("#profile-preview").classList.remove("hidden");
      $("#profile-preview-initial").classList.add("hidden");
    } catch (error) { toast(error.message); event.target.value = ""; }
  };
};

$("#add-product").onclick = () => {
  const categories = data.categories || [];
  const existingNames = [...new Map(data.products.map(item => [item.name.toLocaleLowerCase(), item])).values()];
  const clothing = clothingFormFields();
  const pharmacy = pharmacyFormFields({}, true);
  openModal("Add a product", `<label>Product name<input name="name" list="product-name-suggestions" autocomplete="off" required placeholder="Start typing an item name"><datalist id="product-name-suggestions">${existingNames.map(item => `<option value="${esc(item.name)}" label="${esc(item.name)}">${esc(item.name)}</option>`).join("")}</datalist><small class="suggestion-hint">Start typing to see existing item names.</small></label><label>Category<select name="category">${categories.map(item => `<option>${esc(item.name)}</option>`).join("")}</select></label><div class="form-row"><label>SKU / item code<input name="sku" placeholder="Optional"></label><label>Barcode<input name="barcode" maxlength="120" inputmode="numeric" placeholder="Scan or enter barcode"></label></div>${clothing}${pharmacy}<label>Unit of measure<input name="unit" value="piece" maxlength="30" placeholder="piece, box, kg, meter, roll" required></label><div class="form-row"><label>Selling price (${esc(currencySymbol())}) per unit<input name="price" type="number" min="0" step="0.01" required></label><label>Buying cost (${esc(currencySymbol())}) per unit<input name="cost" type="number" min="0" step="0.01" required></label></div><div class="form-row"><label>Quantity (<span class="unit-label">piece</span>)<input name="qty" type="number" min="0" required></label><label>Low-stock alert at (<span class="unit-label">piece</span>)<input name="min" type="number" min="0" value="5" required></label></div>`, async form => {
    await updateState("/api/products", { name: form.get("name").trim(), category: form.get("category"), sku: form.get("sku").trim(), barcode: form.get("barcode").trim(), brand: form.get("brand") || "", color: form.get("color") || "", size: form.get("size") || "", material: form.get("material") || "", genericName: form.get("genericName") || "", strength: form.get("strength") || "", dosageForm: form.get("dosageForm") || "", manufacturer: form.get("manufacturer") || "", batchNumber: form.get("batchNumber") || "", expiryDate: form.get("expiryDate") || "", unit: form.get("unit").trim(), price: Number(form.get("price")), cost: Number(form.get("cost")), qty: Number(form.get("qty")), min: Number(form.get("min")), pack_name: (form.get("pack_name") || "").trim(), pack_size: Number(form.get("pack_size") || 0) });
    toast("Product added");
  });
  attachClothingChipEvents();
  $("#modal-fields [name=unit]").oninput = event => {
    document.querySelectorAll("#modal-fields .unit-label").forEach(label => label.textContent = event.target.value.trim() || "unit");
  };
};
$("#manage-categories").onclick = () => {
  const categories = data.categories || [];
  const rows = categories.map(category => `<div class="category-row"><b>${esc(category.name)}</b>${category.name.toLowerCase() === "other" ? `<small>Fallback category</small>` : `<button class="user-action" data-category-action="edit" data-id="${category.id}" data-name="${esc(category.name)}">Edit</button><button class="user-action danger" data-category-action="delete" data-id="${category.id}" data-name="${esc(category.name)}">Delete</button>`}</div>`).join("");
  openModal("Manage product categories", `<div class="category-list">${rows}</div><label>Add category<input name="name" maxlength="80" placeholder="e.g. Hand tools"></label><p class="form-hint">Deleting a category moves its products to Other.</p>`, async form => {
    data = await api("/api/categories", { method: "POST", body: JSON.stringify({ name: form.get("name").trim() }) });
    render();
    toast("Category added");
  });
  $("#submit-modal").textContent = "Add category";
  $("#modal-fields").onclick = async event => {
    const button = event.target.closest("[data-category-action]");
    if (!button) return;
    const id = button.dataset.id;
    const name = button.dataset.name;
    if (button.dataset.categoryAction === "edit") {
      const replacement = prompt("Edit category name:", name);
      if (replacement === null || !replacement.trim()) return;
      try {
        data = await api(`/api/categories/${id}`, { method: "PATCH", body: JSON.stringify({ name: replacement.trim() }) });
        render();
        toast("Category updated");
        $("#manage-categories").click();
      } catch (error) { toast(error.message); }
    } else if (confirm(`Delete “${name}”? Its products will move to Other.`)) {
      try {
        data = await api(`/api/categories/${id}`, { method: "DELETE" });
        render();
        toast("Category deleted; products moved to Other");
        $("#manage-categories").click();
      } catch (error) { toast(error.message); }
    }
  };
  // Category actions are independent of the add-category form submission.
  $("#modal-form").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) { toast("Enter a category name to add."); return; }
    $("#submit-modal").disabled = true;
    try {
      data = await api("/api/categories", { method: "POST", body: JSON.stringify({ name }) });
      render();
      closeModal();
      toast("Category added");
    } catch (error) { toast(error.message); }
    finally { $("#submit-modal").disabled = false; }
  };
};
$("#new-sale").onclick = $("#sale-shortcut").onclick = () => {
  const available = data.products.filter(item => item.qty > 0);
  if (!available.length) return toast("No products in stock.");
  openModal("Record a sale", `<div class="item-search"><label for="sale-search">Search items <span class="form-hint">Pick a product to fill the form below.</span></label><div class="item-search-wrap"><input id="sale-search" type="search" autocomplete="off" placeholder="Type part of a name, SKU, or barcode"><button type="button" class="item-search-toggle" id="sale-search-toggle" aria-label="Show all products" title="Show all products">▾</button><div class="item-search-results hidden" id="sale-search-results" role="listbox" aria-label="Matching products"></div></div></div><label>Product<select id="sale-product" name="productId" required>${available.map(item => `<option value="${item.id}" data-unit="${esc(item.unit || "piece")}" data-price="${Number(item.price)}" data-cost="${Number(item.cost)}" data-search="${esc([productLabel(item),item.sku,item.unit,item.category].join(" ").toLocaleLowerCase())}">${esc(productLabel(item))} · ${item.qty} ${esc(item.unit || "piece")} available</option>`).join("")}</select></label><div class="form-row"><label>Quantity (<span id="sale-unit-label">${esc(available[0].unit || "piece")}</span>)<input name="qty" type="number" value="1" min="1" step="1" required></label><label>Sale price per unit (${esc(currencySymbol())})<input id="sale-price" name="price" type="number" min="0" step="0.01" value="${Number(available[0].price)}" required></label></div><p id="sale-margin" class="sale-margin"></p><label>Payment method<select name="payment">${paymentOptions(undefined, quickPaymentChoices())}</select></label><p class="form-hint">Sale price is entered per item unit. Purchase cost is shown to help you check your margin.</p>`, async form => {
    const selected = $("#sale-product").selectedOptions[0];
    const salePrice = Number(form.get("price"));
    const purchaseCost = Number(selected?.dataset.cost || 0);
    if (salePrice < purchaseCost && !confirm(`Warning: sale price (${money(salePrice)}) is below purchase cost (${money(purchaseCost)}) per unit. This sale will lose about ${money((purchaseCost - salePrice) * Number(form.get("qty")))} on the selected quantity. Continue anyway?`)) return false;
    await updateState("/api/sales", { productId: Number(form.get("productId")), qty: Number(form.get("qty")), price: salePrice, payment: form.get("payment") });
    toast("Sale recorded");
  });
  for (const option of $("#sale-product").options) {
    const item = available.find(product => Number(product.id) === Number(option.value));
    if (item?.barcode) option.dataset.search += ` ${item.barcode.toLocaleLowerCase()}`;
  }
  const updateSaleMargin = () => {
    const selected = $("#sale-product").selectedOptions[0];
    if (!selected) return;
    const price = Number($("#sale-price").value || 0);
    const cost = Number(selected.dataset.cost || 0);
    const quantity = Number($("#modal-fields [name=qty]").value || 0);
    const margin = (price - cost) * quantity;
    $("#sale-unit-label").textContent = selected.dataset.unit || "piece";
    const note = $("#sale-margin");
    note.textContent = margin < 0
      ? `⚠ Below cost · Purchase cost ${money(cost)} per unit · Estimated loss ${money(Math.abs(margin))}`
      : `Purchase cost ${money(cost)} per unit · Estimated gross profit ${money(margin)} for this sale`;
    note.classList.toggle("below-cost", margin < 0);
  };
  $("#sale-product").onchange = event => {
    const selected = event.target.selectedOptions[0];
    $("#sale-price").value = selected?.dataset.price || "0";
    updateSaleMargin();
  };
  $("#sale-price").oninput = updateSaleMargin;
  $("#modal-fields [name=qty]").oninput = updateSaleMargin;
  updateSaleMargin();
  initItemSearch({
    input: $("#sale-search"),
    results: $("#sale-search-results"),
    toggle: $("#sale-search-toggle"),
    getItems: () => available,
    onPick: item => {
      const select = $("#sale-product");
      if (!select) return;
      select.value = String(item.id);
      $("#sale-price").value = item.price;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      $("#sale-search")?.focus();
    },
    emptyText: "No in-stock product matches that name, SKU, or barcode."
  });
};
$("#add-expense").onclick = () => openModal("Add an expense", `<label>Category<select name="category"><option>Rent</option><option>Utilities</option><option>Wages</option><option>Transport</option><option>Supplies</option><option>Repairs</option><option>Other</option></select></label><label>Note<input name="note" placeholder="What was this cost for?"></label><div class="form-row"><label>Amount (৳)<input name="amount" type="number" min="0.01" step="0.01" required></label><label>Date<input name="date" type="date" value="${dateKey(new Date())}" required></label></div>`, async form => {
  await updateState("/api/expenses", { category: form.get("category"), note: form.get("note").trim(), amount: Number(form.get("amount")), date: form.get("date") });
  toast("Expense saved");
});
$("#expenses-table").onclick = async event => {
  const button = event.target.closest("[data-expense-action]");
  if (!button || !signedInUser?.permissions?.records || !data.permissions?.expenses) return;
  const expense = data.expenses.find(item => String(item.id) === button.dataset.id);
  if (!expense) return toast("Expense record not found. Refresh and try again.");
  if (button.dataset.expenseAction === "delete") {
    if (!confirm(`Delete this ${expense.category} expense of ${money(expense.amount)} from ${dateLabel(expense.date)}?`)) return;
    try {
      data = await api(`/api/expenses/${expense.id}`, { method: "DELETE" });
      render();
      toast("Expense deleted");
    } catch (error) { toast(error.message); }
    return;
  }
  if (button.dataset.expenseAction !== "edit") return;
  const knownCategories = ["Rent", "Utilities", "Wages", "Transport", "Supplies", "Repairs", "Other"];
  const categories = [...new Set([...knownCategories, expense.category])];
  openModal("Edit expense", `<label>Date<input name="date" type="date" value="${esc(expense.date)}" required></label><label>Category<select name="category">${categories.map(category => `<option ${category === expense.category ? "selected" : ""}>${esc(category)}</option>`).join("")}</select></label><label>Note<input name="note" maxlength="500" value="${esc(expense.note || "")}" placeholder="What was this cost for?"></label><label>Amount (৳)<input name="amount" type="number" min="0" step="0.01" value="${Number(expense.amount)}" required></label>`, async form => {
    data = await api(`/api/expenses/${expense.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        date: form.get("date"),
        category: form.get("category"),
        note: form.get("note").trim(),
        amount: Number(form.get("amount"))
      })
    });
    render();
    toast("Expense updated");
  });
};

$("#report-from").value = dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
$("#report-to").value = dateKey(new Date());
$("#report-from").onchange = renderReport;
$("#report-to").onchange = renderReport;
$("#download-report").onclick = () => {
  const permissions = data.permissions || {};
  const range = reportRange();
  if (range.start > range.end) return toast("The start date must be on or before the end date.");
  const sales = permissions.sales ? data.sales.filter(item => item.date >= range.start && item.date <= range.end) : [];
  const expenses = permissions.expenses ? data.expenses.filter(item => item.date >= range.start && item.date <= range.end) : [];
  const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const rows = [["SHOP REPORT", range.start + " to " + range.end], [], ["SUMMARY", "AMOUNT"]];
  if (permissions.sales) {
    const gross = sales.reduce((sum, item) => sum + Number(item.total || 0), 0);
    const profit = sales.reduce((sum, item) => sum + Number(item.total || 0) - Number(item.cost || 0), 0);
    const tax = sales.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0);
    rows.push(["Gross sales (excluding tax)", gross], ["Tax collected", tax], ["Gross profit", profit]);
    if (permissions.expenses) rows.push(["Expenses", expenseTotal], ["Net profit", profit - expenseTotal]);
    rows.push([], ["SALES", "Date", "Product", "Quantity", "Unit", "Payment", "Sales (ex tax)", "Tax", "Cost", "Profit"]);
    for (const item of sales) rows.push(["", item.date, item.product, item.qty, item.unit || "piece", item.payment, item.total, item.tax_amount || 0, item.cost, Number(item.total || 0) - Number(item.cost || 0)]);
  }
  if (permissions.expenses) {
    if (!permissions.sales) rows.push(["Expenses", expenseTotal]);
    rows.push([], ["EXPENSES", "Date", "Category", "Note", "Amount"]);
    for (const item of expenses) rows.push(["", item.date, item.category, item.note || "", item.amount]);
  }
  const csv = "\uFEFF" + rows.map(row => row.map(value => {
    let cell = String(value ?? "");
    if (typeof value === "string" && /^[=+@\- \t\r]/.test(cell)) cell = "'" + cell;
    return '"' + cell.split('"').join('""') + '"';
  }).join(",")).join("\r\n");
  downloadFile(`shop-report-${range.start}-to-${range.end}.csv`, csv);
  toast("Excel-compatible report downloaded");
};
$("#print-report").onclick = () => {
  const permissions = data.permissions || {}, range = reportRange();
  if (range.start > range.end) return toast("The start date must be on or before the end date.");
  const sales = permissions.sales ? data.sales.filter(item => item.date >= range.start && item.date <= range.end) : [];
  const expenses = permissions.expenses ? data.expenses.filter(item => item.date >= range.start && item.date <= range.end) : [];
  const rows = [];
  if (permissions.sales) for (const item of sales) rows.push(`<tr><td>${esc(item.date)}</td><td>${esc(item.product)}</td><td>${item.qty} ${esc(item.unit || "piece")}</td><td>${esc(item.payment)}</td><td>${money(item.total)}</td><td>${money(item.tax_amount || 0)}</td><td>${money(Number(item.total || 0) - Number(item.cost || 0))}</td></tr>`);
  if (permissions.expenses) for (const item of expenses) rows.push(`<tr><td>${esc(item.date)}</td><td>${esc(item.category)}${item.note ? ` · ${esc(item.note)}` : ""}</td><td></td><td>Expense</td><td>${money(item.amount)}</td><td></td><td></td></tr>`);
  const gross = sales.reduce((sum, item) => sum + Number(item.total || 0), 0), tax = sales.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0);
  const grossProfit = sales.reduce((sum, item) => sum + Number(item.total || 0) - Number(item.cost || 0), 0), spent = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const summary = [["Sales (ex tax)", gross], ["Tax collected", tax], ["Gross profit", grossProfit], ["Expenses", spent], ["Net profit", grossProfit - spent]].filter(([label]) => label !== "Sales (ex tax)" || permissions.sales).filter(([label]) => label !== "Expenses" || permissions.expenses).map(([label, amount]) => `<tr><th>${label}</th><td>${money(amount)}</td></tr>`).join("");
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Shop report</title><style>@page{margin:12mm}body{font:12px system-ui,"Segoe UI",sans-serif;color:#17212b}h1{margin:0}p{color:#66727d}table{border-collapse:collapse;width:100%;margin:14px 0}th,td{border:1px solid #d2d8dc;padding:6px;text-align:left}thead th{background:#eef2f3}.summary{width:auto;min-width:50%}.summary td{text-align:right}.summary th{background:#f5f6f7}</style></head><body><h1>${esc(data.shopName)}</h1><p>${esc(data.workspace)} · Report from ${esc(range.start)} to ${esc(range.end)}</p><table class="summary"><tbody>${summary}</tbody></table><table><thead><tr><th>Date</th><th>Item / category</th><th>Quantity</th><th>Payment</th><th>Amount</th><th>Tax</th><th>Profit</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="7">No records in this period.</td></tr>`}</tbody></table></body></html>`);
};
$("#download-stock-watch").onclick = () => {
  const low = data.products.filter(item => item.qty <= item.min);
  if (!low.length) return toast("No low-stock items to download.");
  const rows = [
    ["Stock watch — products that need attention", dateKey(new Date())],
    [],
    ["PRODUCT", "UNIT", "IN STOCK", "REORDER AT", "STATUS"]
  ];
  for (const item of low) rows.push([item.name, item.unit || "piece", item.qty, item.min, item.qty === 0 ? "Out of stock" : "Low stock"]);
  const csv = "﻿" + rows.map(row => row.map(value => {
    let cell = String(value ?? "");
    if (typeof value === "string" && /^[=+@\- \t\r]/.test(cell)) cell = "'" + cell;
    return '"' + cell.split('"').join('""') + '"';
  }).join(",")).join("\r\n");
  downloadFile(`stock-watch-${dateKey(new Date())}.csv`, csv);
  toast("Stock watch downloaded");
};
// ---- Team access: owner, administrators and staff, each with powers that can be given or taken away ----
const CAP_LABELS = [["inventory", "View and add inventory"], ["sales", "View and record sales and bills"], ["expenses", "View and add expenses"], ["online_orders", "Manage online orders"], ["delete_online_orders", "Delete online orders"], ["server_load", "View server load in the top bar"],
  ["records", "Correct or delete records and manage categories"], ["team", "Manage staff accounts (add, reset password, set access, disable)"],
  ["admins", "Manage administrators (create them, change roles, grant admin powers)"], ["settings", "Change shop name and shop address/location"],
  ["supplier_purchases", "Edit supplier purchase and payment records"], ["backups", "Manage backups and restore the database"],
  ["repair_records", "Edit and delete delivered repair jobs (mobile shop only)"]];
const CAP_SHORT = { inventory: "inventory", sales: "sales", expenses: "expenses", server_load: "view server load", records: "edit/delete", team: "manage staff", admins: "manage admins", settings: "shop settings", supplier_purchases: "edit supplier purchases", backups: "backups and restore", repair_records: "edit/delete delivered repair jobs", online_orders: "online orders", delete_online_orders: "delete online orders" };
const myCaps = () => signedInUser?.permissions || {};
const canGrantCap = cap => cap === "online_orders"
  ? signedInUser?.role === "admin"
  : cap === "delete_online_orders"
  ? signedInUser?.role === "admin"
  : cap === "backups"
  ? signedInUser?.username?.toLowerCase() === "jahangir" && signedInUser?.role === "admin"
  : cap === "server_load"
    ? signedInUser?.role === "admin"
  : cap === "repair_records"
    ? signedInUser?.role === "admin"
  : !!myCaps()[cap];
const accessFields = (perms, role) => `<fieldset class="permissions"><legend>Allow this ${role === "admin" ? "administrator" : "staff member"} to:</legend>${CAP_LABELS.filter(([cap]) => (role === "admin" || !["team", "admins", "backups"].includes(cap)) && (cap !== "repair_records" || (data.shopType === "mobile" && role !== "admin"))).map(([cap, label]) => { const grantable = canGrantCap(cap), reason = ["delete_online_orders", "online_orders", "server_load", "repair_records"].includes(cap) ? "only administrators can grant this access" : cap === "backups" ? "only Jahangir can grant this power" : "you do not hold this power"; return `<label><input type="checkbox" name="${cap}" ${perms[cap] ? "checked" : ""} ${grantable ? "" : "disabled"}> ${label}${grantable ? "" : ` <small>(${reason})</small>`}</label>`; }).join("")}${data.shopType !== "mobile" && role === "staff" ? `<input class="hidden" type="checkbox" name="repair_records" ${perms.repair_records ? "checked" : ""} hidden>` : ""}${role === "admin" && data.shopType === "mobile" ? `<small class="form-hint">Administrators always have access to delivered repair jobs. Use the staff access checkbox to grant or remove this power for a staff member.</small>` : ""}</fieldset>`;
const readCaps = () => Object.fromEntries(CAP_LABELS.map(([cap]) => [cap, !!document.querySelector(`#modal-fields input[name="${cap}"]`)?.checked]));
async function loadUsers() {
  if (!(myCaps().team || myCaps().admins)) return;
  try {
    const users = await api("/api/users");
    $("#users-table").innerHTML = users.map(u => {
      const access = u.owner ? "Owner · everything" : Object.entries(u.permissions).filter(([, on]) => on).map(([cap]) => CAP_SHORT[cap]).join(", ") || "No access";
      const btn = (action, label, cls = "") => `<button class="user-action ${cls}" data-action="${action}" data-id="${u.id}" data-name="${esc(u.username)}" data-role="${u.role}" data-perms="${esc(JSON.stringify(u.permissions))}" data-active="${u.active}">${label}</button>`;
      const actions = u.manageable ? [btn("permissions", "Access"), btn("password", "Reset password"), btn("toggle", u.active ? "Disable" : "Enable"), myCaps().admins ? btn("role", u.role === "admin" ? "Make staff" : "Make administrator") : "", btn("remove", "Remove", "danger")].join("") : `<small>${u.owner ? "Owner" : u.id === signedInUser?.id ? "This is you" : "No permission"}</small>`;
      return `<tr><td class="product-cell">${esc(u.username)}</td><td>${u.owner ? "Master owner" : u.fullAccess ? "Full-access admin" : u.role === "admin" ? "Administrator" : "Staff"}</td><td style="white-space:normal;min-width:180px">${esc(access)}</td><td><span class="status ${u.active ? "" : "out"}">${u.active ? "Active" : "Disabled"}</span></td><td>${actions}</td></tr>`;
    }).join("");
    $("#users-empty").classList.toggle("hidden", users.length > 0);
  } catch (error) { toast(error.message); }
}
$("#add-user").textContent = "Add team member";
$("#add-user").onclick = () => {
  const roles = [myCaps().team && ["staff", "Staff"], myCaps().admins && ["admin", "Administrator"]].filter(Boolean);
  if (!roles.length) return toast("You do not have permission to add accounts.");
  const defaults = role => role === "admin" ? Object.fromEntries(CAP_LABELS.map(([cap]) => [cap, !!myCaps()[cap]])) : { inventory: true, sales: true };
  openModal("Add team member", `<label>Username<input name="username" minlength="3" maxlength="32" required></label><label>Temporary password <small>(at least 12 characters; share privately)</small><input name="password" type="password" minlength="12" required></label><label>Role<select name="role">${roles.map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}</select></label><div id="access-box">${accessFields(defaults(roles[0][0]), roles[0][0])}</div>`, async form => {
    await api("/api/users", { method: "POST", body: JSON.stringify({ username: form.get("username").trim(), password: form.get("password"), role: form.get("role"), permissions: readCaps() }) });
    await loadUsers();
    toast("Account added");
  });
  document.querySelector('#modal-fields select[name="role"]').onchange = event => { $("#access-box").innerHTML = accessFields(defaults(event.target.value), event.target.value); };
};
$("#users-table").onclick = async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { id, name: username, role } = button.dataset;
  try {
    if (button.dataset.action === "permissions") {
      openModal(`Access for ${username}`, accessFields(JSON.parse(button.dataset.perms), role), async () => {
        await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ permissions: readCaps() }) });
        await loadUsers();
        toast("Access updated");
      });
    } else if (button.dataset.action === "password") {
      openModal(`Reset password · ${username}`, `<label>New password <small>(at least 12 characters)</small><input name="password" type="password" minlength="12" required></label>`, async form => {
        await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ password: form.get("password") }) });
        toast("Password changed; their other sessions were signed out");
      });
    } else if (button.dataset.action === "toggle") {
      const active = button.dataset.active !== "true";
      await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      await loadUsers();
      toast(active ? "User enabled" : "User disabled and signed out");
    } else if (button.dataset.action === "role") {
      const next = role === "admin" ? "staff" : "admin";
      if (!confirm(next === "admin" ? `Make ${username} an administrator? Use Access afterwards to choose their powers.` : `Make ${username} a staff member? Their team and administrator powers will be removed.`)) return;
      await api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
      await loadUsers();
      toast(`${username} is now ${next === "admin" ? "an administrator" : "staff"}`);
    } else if (button.dataset.action === "remove" && confirm(`Permanently remove ${username}'s account?`)) {
      await api(`/api/users/${id}`, { method: "DELETE" });
      await loadUsers();
      toast("User removed");
    }
  } catch (error) { toast(error.message); }
};
$("#products-table").onclick = event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  if (button.dataset.action === "delete-product") {
    if (!signedInUser?.permissions?.records || !data.permissions?.inventory) return;
    const { name, qty, unit } = button.dataset;
    if (!confirm(`Permanently remove “${name}” from inventory? The remaining stock (${qty} ${unit}) will be removed. Past sales records will be kept.`)) return;
    api(`/api/products/${id}`, { method: "DELETE" }).then(result => {
      data = result;
      render();
      toast("Inventory item deleted; sales history was kept");
    }).catch(error => toast(error.message));
    return;
  }
  const canEditItems = signedInUser?.permissions?.records && data.permissions?.inventory;
  if (button.dataset.action !== "rename-product" || !canEditItems) return;
  const product = data.products.find(item => String(item.id) === String(id));
  if (!product) return toast("Inventory item not found. Refresh and try again.");
  const oldCategory = product.category || "Other";
  const clothing = clothingFormFields(product);
  const pharmacy = pharmacyFormFields(product, false);
  openModal("Edit inventory item", `<label>Item name<input name="name" maxlength="200" value="${esc(product.name)}" required></label><div class="form-row"><label>SKU / item code<input name="sku" maxlength="100" value="${esc(product.sku || "")}"></label><label>Barcode<input name="barcode" maxlength="120" inputmode="numeric" value="${esc(product.barcode || "")}" placeholder="Scan or enter barcode"></label></div>${clothing}${pharmacy}<div class="form-row"><label>Unit of measure<input name="unit" maxlength="30" value="${esc(product.unit || "piece")}" required></label><label>Category<select name="category">${(data.categories || []).map(item => `<option ${item.name === oldCategory ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select></label></div><div class="form-row"><label>Selling price per unit (${esc(currencySymbol())})<input name="price" type="number" min="0" step="0.01" value="${Number(product.price)}" required></label><label>Purchase cost per unit (${esc(currencySymbol())})<input name="cost" type="number" min="0" step="0.01" value="${Number(product.cost)}" required></label></div><div class="form-row"><label>Stock quantity (${esc(product.unit || "piece")})<input name="qty" type="number" min="0" step="1" value="${Number(product.qty)}" required></label><label>Low-stock alert at<input name="min" type="number" min="0" step="1" value="${Number(product.min)}" required></label></div><p class="form-hint">Changing stock here sets the new stock total. Past sales keep their recorded cost and unit.</p>`, async form => {
    const details = Object.fromEntries(["name","sku","barcode","unit","category"].map(key => [key, (form.get(key) || "").trim()]));
    if (data.shopType === "clothing" && featureEnabled("clothing")) for (const key of ["brand", "color", "size", "material"]) details[key] = (form.get(key) || "").trim();
    if (data.shopType === "pharmacy" && featureEnabled("pharmacy")) Object.assign(details,{genericName:form.get("genericName")||"",strength:form.get("strength")||"",dosageForm:form.get("dosageForm")||"",manufacturer:form.get("manufacturer")||""});
    for (const key of ["price","cost","qty","min"]) details[key] = Number(form.get(key));
    details.pack_name = (form.get("pack_name") || "").trim(); details.pack_size = Number(form.get("pack_size") || 0);
    data = await api(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(details) });
    render();
    toast("Inventory item updated");
  });
  attachClothingChipEvents();
};
$("#sales-table").onclick = async event => {
  const button = event.target.closest("[data-sale-action]");
  if (!button || !data.permissions?.sales) return;
  const sale = data.sales.find(item => String(item.id) === button.dataset.id);
  if (!sale) return toast("Sales record not found. Refresh and try again.");
  if (button.dataset.saleAction === "return") {
    if (!data.permissions?.inventory) return toast("Inventory access is required to return stock.");
    const maxQty = Number(sale.original_remaining_qty || 0);
    if (!sale.product_id || maxQty <= 0) return toast("This sale has no returnable stock quantity.");
    const returnDevices = (data.devices || []).filter(device => Number(device.sale_id) === Number(sale.id) && device.status === "Sold");
    const methodOptions = (data.paymentMethods || ["Cash", "bKash", "Nagad", "Card"]).filter(method => method.toLowerCase() !== "due");
    if (!methodOptions.length) methodOptions.push("Cash");
    let bill = null;
    if (sale.bill_id) {
      try { bill = await api(`/api/bills/${sale.bill_id}`); } catch (error) { return toast(error.message); }
    }
    const originalQty = Number(sale.original_qty || sale.qty);
    const saleValuePerUnit = originalQty > 0 ? (Number(sale.original_total || 0) + Number(sale.original_tax_amount || 0)) / originalQty : 0;
    const returnValueFor = qty => Math.round(saleValuePerUnit * qty * 100) / 100;
    const refundableFor = qty => {
      const returnedValue = returnValueFor(qty);
      const oldRefunds = (data.salesReturns || []).filter(row => Number(row.sale_id) === Number(sale.id)).reduce((sum, row) => sum + Number(row.refund_amount || 0), 0);
      if (!bill) return Math.max(0, returnedValue - oldRefunds);
      const afterReturn = Math.max(0, Number(bill.total) - Number(bill.returned || 0) - returnedValue);
      return Math.max(0, Math.min(returnedValue, Number(bill.paid) - afterReturn - Number(bill.refunded || 0)));
    };
    const qtyStep = isFractional(sale.unit) ? "0.001" : "1";
    const initialQty = Math.min(maxQty, Number(qtyStep));
    const amountLimit = refundableFor(initialQty);
    openModal(`Return item · ${sale.product}`, `<p>Original sale: ${originalQty} ${esc(sale.unit || "piece")} · Remaining eligible: ${maxQty} ${esc(sale.unit || "piece")}${sale.bill_id ? ` · ${billNo(sale.bill_id)}` : ""}</p><div class="bill-total return-value"><span>Sale value per ${esc(sale.unit || "piece")} <b>${money(saleValuePerUnit)}</b></span><span>Value being returned <b id="return-value-amount">${money(returnValueFor(initialQty))}</b></span></div><label>Quantity to return (${esc(sale.unit || "piece")})<input name="qty" type="number" min="${qtyStep}" max="${maxQty}" step="${qtyStep}" value="${initialQty}" required></label>${returnDevices.length ? `<label>IMEI/serial to return (one per line)<textarea name="serials" rows="2" placeholder="Enter returned device IMEI/serials"></textarea></label>` : ""}<label>Reason (optional)<input name="reason" maxlength="300" placeholder="Damaged, wrong item, customer changed mind"></label><label>Refund paid now (৳)<input name="refundAmount" type="number" min="0" max="${amountLimit}" step="0.01" value="${amountLimit.toFixed(2)}"></label><label>Refund method<select name="refundMethod">${methodOptions.map(method => `<option>${esc(method)}</option>`).join("")}</select></label><p class="form-hint">The return first reduces any unpaid bill balance. You can leave the refund at ৳0 and settle customer credit later.</p>`, async form => {
      const qty = Number(form.get("qty")), refundAmount = Number(form.get("refundAmount") || 0), maxRefund = refundableFor(qty);
      const serials = String(form.get("serials") || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (returnDevices.length && (serials.length !== qty || new Set(serials.map(value => value.toUpperCase())).size !== serials.length)) throw new Error("Enter a different IMEI/serial for each returned device.");
      if (refundAmount > maxRefund + 0.001) throw new Error(`Refund cannot exceed ${money(maxRefund)} for this quantity. The bill balance is reduced first.`);
      if (!confirm(`Return ${qty} ${sale.unit || "piece"} of ${sale.product} to stock${refundAmount > 0 ? ` and refund ${money(refundAmount)}` : ""}?`)) return false;
      data = await api(`/api/sales/${sale.id}/returns`, { method: "POST", body: JSON.stringify({ qty, serials, refundAmount, refundMethod: form.get("refundMethod"), reason: form.get("reason") }) });
      render(); toast("Return recorded; stock and bill balance updated");
    });
    const qtyInput = $("#modal-fields [name=qty]"), refundInput = $("#modal-fields [name=refundAmount]");
    qtyInput.oninput = () => {
      const qty = Number(qtyInput.value) || 0, limit = refundableFor(qty);
      $("#return-value-amount").textContent = money(returnValueFor(qty));
      refundInput.max = limit.toFixed(2);
      if (Number(refundInput.value) > limit) refundInput.value = limit.toFixed(2);
    };
    return;
  }
  if (!signedInUser?.permissions?.records) return;
  if (button.dataset.saleAction === "delete") {
    if (!confirm(`Delete the sale of ${sale.qty} ${sale.unit || "piece"} “${sale.product}” for ${money(sale.total)}? If its inventory item still exists, the sold quantity will be returned to stock.`)) return;
    try {
      data = await api(`/api/sales/${sale.id}`, { method: "DELETE" });
      render();
      toast("Sales record deleted");
    } catch (error) { toast(error.message); }
    return;
  }
  if (button.dataset.saleAction !== "edit") return;
  const linkedToInventory = sale.product_id !== null && sale.product_id !== undefined;
  const productOptions = data.products.map(product => `<option value="${product.id}" ${Number(product.id) === Number(sale.product_id) ? "selected" : ""}>${esc(productLabel(product))} · ${product.qty} ${esc(product.unit || "piece")} available</option>`).join("");
  const payments = [...new Set([...(data.paymentMethods || ["Cash", "bKash", "Nagad", "Card", "Due"]), sale.payment])];
  const productFields = linkedToInventory
    ? `<label>Inventory item<select name="productId" required><option value="">Choose an active item</option>${productOptions}</select></label><label>Quantity (${esc(sale.unit || "piece")})<input name="qty" type="number" min="1" step="1" value="${Number(sale.qty)}" required></label>`
    : `<label>Item<input value="${esc(sale.product)}" disabled></label><label>Quantity<input value="${Number(sale.qty)} ${esc(sale.unit || "piece")}" disabled></label><p class="form-hint">This older sale is not linked to a specific inventory item, so its item and quantity are locked to protect stock accuracy.</p>`;
  openModal("Edit sales record", `<label>Sale date<input name="date" type="date" value="${esc(sale.date)}" required></label>${productFields}<label>Sale price per unit (৳)<input name="price" type="number" min="0" step="0.01" value="${(Number(sale.total) / Number(sale.qty)).toFixed(2)}" required></label><label>Payment method<select name="payment">${payments.map(payment => `<option ${payment === sale.payment ? "selected" : ""}>${esc(payment)}</option>`).join("")}</select></label><p class="form-hint">Changing the item or quantity updates inventory stock. For the same item, its original purchase-cost snapshot is kept.</p>`, async form => {
    const body = { date: form.get("date"), price: Number(form.get("price")), payment: form.get("payment") };
    if (linkedToInventory) {
      body.productId = Number(form.get("productId"));
      body.qty = Number(form.get("qty"));
    }
    data = await api(`/api/sales/${sale.id}`, { method: "PATCH", body: JSON.stringify(body) });
    render();
    toast("Sales record updated");
  });
};
$("#download-inventory-template").onclick = () => {
  const rows = [bulkInventoryHeaders, ...data.products.map(item => [
    item.id, item.name, item.sku, item.price, item.cost, item.qty, item.min, item.unit || "piece", item.category || "Other", item.barcode || "", item.brand || "", item.color || "", item.size || "", item.material || ""
  ])];
  const csv = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  downloadFile("shop-inventory-template.csv", csv);
  toast("Excel-compatible inventory template downloaded");
};
$("#bulk-inventory-file").onchange = async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 400000) throw new Error("Please keep the CSV file under 400 KB.");
    const csvRows = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
    const headers = csvRows.shift()?.map(value => value.trim().toLowerCase());
    const expected = bulkInventoryHeaders.map(value => value.toLowerCase());
    const barcodeHeaders = expected.slice(0, 10), categoryHeaders = expected.slice(0, 9);
    const unitHeaders = expected.slice(0, 8), legacyHeaders = expected.slice(0, 7);
    const matches = template => headers?.length === template.length && template.every((header, index) => headers[index] === header);
    const hasClothing = matches(expected);
    const hasBarcode = hasClothing || matches(barcodeHeaders);
    const hasCategory = hasBarcode || matches(categoryHeaders);
    const hasUnit = matches(unitHeaders);
    const isLegacyTemplate = matches(legacyHeaders);
    if (!hasCategory && !hasUnit && !isLegacyTemplate) {
      throw new Error(`Use the downloaded template without changing its columns: ${bulkInventoryHeaders.join(", ")}.`);
    }
    const rows = csvRows.map((values, index) => {
      if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${values.length} columns; expected ${headers.length}.`);
    const [id, name, sku, price, cost, qty, min, unit, category, barcode, brand, color, size, material] = values.map(value => value.trim());
      return { id, name, sku, price, cost, qty, min, unit: hasUnit || hasCategory ? unit : "", category: hasCategory ? category : "", barcode: hasBarcode ? barcode : null, brand: hasClothing ? brand : null, color: hasClothing ? color : null, size: hasClothing ? size : null, material: hasClothing ? material : null };
    });
    if (!rows.length) throw new Error("The template has no inventory rows to upload.");
    if (rows.length > 500) throw new Error("Upload no more than 500 rows at a time.");
    const updates = rows.filter(row => row.id).length;
    const additions = rows.length - updates;
    const summary = `${updates} existing item(s) will be updated and ${additions} new item(s) added. Quantity replaces the current stock count. Any new categories in the file will be created automatically. Continue?`;
    if (!confirm(summary)) return;
    data = await api("/api/inventory/bulk", { method: "POST", body: JSON.stringify({ rows }) });
    render();
    toast(`Inventory updated: ${updates} updated, ${additions} added`);
  } catch (error) {
    toast(error.message);
  } finally {
    event.target.value = "";
  }
};

// Refresh shared records periodically so other signed-in PCs see changes promptly.
setInterval(async () => {
  if (!signedInUser) return;
  try {
    const session = await api("/api/auth/me");
    signedInUser = session.user;
    data = await api("/api/state");
    render();
    refreshServerLoad();
  }
  catch { /* The API helper handles an expired session. */ }
}, 15000);
setInterval(refreshServerLoad, 30000);
// ---- Billing: several items for one customer, saved as one printable bill ----
const billNo = id => "B-" + String(id).padStart(8, "0");
// Weighed and measured items (kg, litre, metre...) can be sold in fractions; kg can be typed in gm, litre in ml, metre in cm.
const FRACTIONAL = /^(kgs?|kilos?|kilograms?|gm?s?|grams?|l|ltrs?|lit(re|er)s?|ml|m|meters?|metres?|ft|feet|foot|yards?|yd|inch(es)?|cm|mm)$/i;
const isFractional = unit => FRACTIONAL.test(String(unit || "").trim());
const smallUnit = unit => {
  const u = String(unit || "").trim().toLowerCase();
  if (/^(kgs?|kilos?|kilograms?)$/.test(u)) return { name: "gm", factor: 1000 };
  if (/^(l|ltrs?|lit(re|er)s?)$/.test(u)) return { name: "ml", factor: 1000 };
  if (/^(m|meters?|metres?)$/.test(u)) return { name: "cm", factor: 100 };
  return null;
};
const fmtQty = (qty, unit) => { const small = smallUnit(unit); return small && qty < 1 ? `${+(qty * small.factor).toFixed(1)} ${small.name}` : `${qty} ${unit}`; };
// Each bill line can be typed in its own unit: the item's unit, a smaller one (kg to gm), or a pack such as a coil.
const lineUnits = line => {
  const custom = line.packSize > 0, small = custom ? null : smallUnit(line.unit);
  const list = [{ key: "base", name: line.unit, f: 1 }];
  if (custom) list.push({ key: "custom", name: line.packName || "part", f: line.packSize });
  else if (small) list.push({ key: "small", name: small.name, f: small.factor });
  return list;
};
const unitOf = line => lineUnits(line).find(u => u.key === line.mode) || lineUnits(line)[0];
const qtyCell = (line, i) => {
  const units = lineUnits(line), u = unitOf(line), packed = line.packSize > 0, frac = isFractional(line.unit) || packed;
  const step = u.key === "small" ? 1 : packed ? "any" : frac ? "0.001" : 1;
  const box = units.length > 1 ? `<select class="bill-input qty-unit" data-i="${i}" data-f="mode">${units.map(x => `<option value="${x.key}" ${x.key === u.key ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : esc(line.unit);
  const min = u.key === "small" || u.key === "base" && !frac ? 1 : 0.0001;
  return `<input class="bill-input qty-input" data-i="${i}" data-f="qty" type="number" min="${min}" max="${+(line.max * u.f).toFixed(3)}" step="${step}" value="${+(line.qty * u.f).toFixed(3)}" required> ${box}`;
};
// Price is kept per stock unit (per coil); for a cut length it is shown and typed per metre/foot.
const priceCell = (line, i) => {
  const u = unitOf(line), custom = u.key === "custom", shown = custom ? line.price / u.f : line.price;
  return `<input class="bill-input" data-i="${i}" data-f="price" type="number" min="0" step="any" value="${+shown.toFixed(4)}" required>${custom ? `<br><small>per ${esc(u.name)}</small>` : ""}`;
};
const lineDetail = l => {
  if (l.packSize > 0) {
    const parts = +(l.qty * l.packSize).toFixed(2), name = l.packName || "part";
    return `${l.qty < 1 ? "" : `${+l.qty.toFixed(3)} ${l.unit} = `}${parts} ${name} × ${money(l.price / l.packSize)}/${name}`;
  }
  return `${fmtQty(l.qty, l.unit)} × ${money(l.price)}/${l.unit}`;
};
const baseRender = render;
render = function () {
  baseRender();
  $("#new-bill").classList.toggle("hidden", !data.permissions?.sales);
  [...$("#sales-table").rows].forEach((row, index) => {
    const sale = data.sales[index];
    if (sale?.bill_id && row.cells[1]) row.cells[1].insertAdjacentHTML("beforeend", ` <button type="button" class="user-action" data-print-bill="${sale.bill_id}">${billNo(sale.bill_id)}</button>`);
  });
};
function billHtml(bill) {
  const subtotal = bill.lines.reduce((sum, line) => sum + line.qty * line.price, 0);
  const when = new Date(bill.created_at.replace(" ", "T") + "Z").toLocaleString(data.locale || "en-BD");
  const rows = bill.lines.map(line => {
    const returnedQty = Number(line.returnedQty || 0), returnedValue = Number(line.returnedValue || 0);
    const returnNote = returnedQty > 0 ? `<br><small style="color:#a33;font-weight:700">Returned: ${esc(fmtQty(returnedQty, line.unit || "piece"))} · ${money(returnedValue)}</small>` : "";
    return `<tr><td>${esc(line.name)}<br><small>${esc(lineDetail(line))}</small>${returnNote}${line.serials?.length ? `<br><small>IMEI/serial: ${esc(line.serials.join(", "))}${Number(line.warrantyMonths) ? ` · Warranty ${Number(line.warrantyMonths)} months` : " · No warranty"}</small>` : ""}</td><td class="r">${money(line.qty * line.price)}</td></tr>`;
  }).join("");
  const clothingNotice = data.shopType === "clothing" && featureEnabled("clothing") ? `<p class="c" style="font-size:11px;color:#555">Exchanges accepted within 7 days with original tags and receipt.</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${billNo(bill.id)}</title><style>
@page{margin:6mm}body{font:13px/1.35 system-ui,"Segoe UI",sans-serif;color:#000;width:76mm;margin:0 auto}
h1{font-size:18px;margin:0;text-align:center}.c{text-align:center}small{color:#333}table{width:100%;border-collapse:collapse}td{padding:4px 0;vertical-align:top}.r{text-align:right;white-space:nowrap}
.line td{border-top:1px dashed #000}.total td{border-top:2px solid #000;font-size:16px;font-weight:700;padding-top:6px}</style></head><body>
<h1>${esc(data.shopName)}</h1><p class="c">${esc(data.workspace)}</p>
<p>Bill no: <b>${billNo(bill.id)}</b><br>${esc(when)}${bill.customer ? `<br>Customer: ${esc(bill.customer)}` : ""}${bill.phone ? `<br>Phone: ${esc(bill.phone)}` : ""}</p>
<table>${rows}<tr class="line"><td>Subtotal</td><td class="r">${money(subtotal)}</td></tr>${Number(bill.delivery_charge || 0) > 0 ? `<tr><td>Delivery</td><td class="r">${money(bill.delivery_charge)}</td></tr>` : ""}${bill.discount > 0 ? `<tr><td>Discount</td><td class="r">- ${money(bill.discount)}</td></tr>` : ""}${Number(bill.tax_amount) > 0 ? `<tr><td>Tax ${bill.tax_mode === "inclusive" ? "included" : ""} (${Number(bill.tax_rate)}%)</td><td class="r">${money(bill.tax_amount)}</td></tr>` : ""}${Number(bill.returned || 0) > 0 ? `<tr><td>Returns</td><td class="r">- ${money(bill.returned)}</td></tr>` : ""}<tr class="total"><td>${Number(bill.returned || 0) > 0 ? "Final total" : "Total"}</td><td class="r">${money(bill.netTotal ?? bill.total)}</td></tr>${bill.payments ? `<tr class="line"><td>Paid</td><td class="r">${money(bill.paid)}</td></tr>${bill.due > 0 ? `<tr class="total"><td>DUE</td><td class="r">${money(bill.due)}</td></tr>` : Number(bill.customerCredit) > 0 ? `<tr class="total" style="color:#dc2626"><td>REFUND DUE</td><td class="r">${money(bill.customerCredit)}</td></tr>` : ""}` : ""}</table>
<p>Payment: ${esc(bill.payments ? (bill.payments.map(p => `${p.method} ${money(p.amount)}`).join(", ") || "None yet") : bill.payment)}<br>Served by: ${esc(bill.cashier)}</p>${clothingNotice}<p class="c">Thank you for shopping with us!</p></body></html>`;
}
function printBill(bill) {
  printHtml(billHtml(bill));
}
$("#sales-table").addEventListener("click", async event => {
  const button = event.target.closest("[data-print-bill]");
  if (!button) return;
  try { printBill(await api("/api/bills/" + button.dataset.printBill)); } catch (error) { toast(error.message); }
});
function openBillEditor(editing) {
  const pid = l => l.productId || data.products.find(p => p.name === l.name)?.id;
  const extra = Object.fromEntries((editing?.lines || []).map(l => [pid(l), l.qty]));
  if (editing && data.shopType === "pharmacy") return toast("Pharmacy bills cannot be edited after saving. Process a return and create a corrected bill.");
  const stocked = data.products.filter(item => productSellableQty(item) > 0 || extra[item.id]);
  if (!stocked.length) return toast("No products in stock.");
  let cart = (editing?.lines || []).map(l => { const p = data.products.find(x => x.id === pid(l)); return p && { id: p.id, name: productLabel(p), category: l.category || p.category || "", unit: p.unit || "piece", packSize: p.pack_size || 0, packName: p.pack_name, price: l.price, cost: p.cost, qty: l.qty, max: +(p.qty + l.qty).toFixed(6), serials: l.serials || [], warrantyMonths: Number(l.warrantyMonths || 0) }; }).filter(Boolean);
  openModal(editing ? `Edit ${billNo(editing.id)}` : "New bill", `<div class="item-search"><label for="bill-search">Add item <span class="form-hint">Type part of a name, SKU, or barcode. Pick from the list or press Enter to add.</span></label><div class="item-search-wrap"><input id="bill-search" type="search" autocomplete="off" placeholder="Item name, SKU, or barcode"><button type="button" class="item-search-toggle" id="bill-search-toggle" aria-label="Show all in-stock items" title="Show all in-stock items">▾</button><div class="item-search-results hidden" id="bill-search-results" role="listbox" aria-label="Matching in-stock items"></div></div></div>
<div class="table-scroll bill-cart"><table><thead><tr><th>Item</th><th>Price / unit</th><th>Qty</th><th>Amount</th><th class="${data.shopType === "mobile" ? "" : "hidden"}">IMEI / serial &amp; warranty</th><th></th></tr></thead><tbody id="bill-lines"></tbody></table><div class="empty" id="bill-empty">No items yet. Search above to add the first one.</div></div>
<div class="form-row"><label>Customer name${data.requireCustomer ? "" : " (optional)"}<input name="customer" maxlength="80" value="${esc(editing?.customer || "")}" ${data.requireCustomer && !editing ? "required" : ""}></label><label>Phone (optional)<input name="phone" maxlength="30" inputmode="tel" value="${esc(editing?.phone || "")}"></label></div>
<div class="form-row"><label class="${editing ? "hidden" : ""}">Payment method<select name="payment">${paymentOptions(editing?.payment || "Cash")}</select></label>${data.allowDiscounts ? `<label>Discount (৳)<input id="bill-discount" name="discount" type="number" min="0" step="any" value="${editing ? editing.discount : 0}"></label>` : ""}</div>
${editing ? `<p class="form-hint">Paid so far: ${money(editing.paid)}. Receive further payments from the Bills list.</p><div id="refund-section" class="hidden" style="background:#fef2f2;padding:12px;border-radius:8px;border:1px solid #dc2626;margin:10px 0"><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="refund-checkbox" name="processRefund"><span style="font-weight:600;color:#dc2626">Process refund to customer</span></label><label>Refund amount (৳)<input id="refund-amount" name="refundAmount" type="number" min="0" step="any" value="0"><small class="form-hint">Auto-calculated but you can adjust if needed (e.g., customer agrees to store credit instead of full refund)</small></label></div>` : `<label>Paid now (৳)<span class="form-hint">Leave as the total if fully paid. A smaller amount becomes a due.</span><input id="bill-paid" name="paid" type="number" min="0" step="any"></label>`}
<div class="bill-total"><span>Subtotal <b id="bill-subtotal">৳0</b></span><span class="${data.taxMode === "none" ? "hidden" : ""}" id="bill-tax-row">Tax <b id="bill-tax">৳0</b></span><span>Total <b id="bill-total">৳0</b></span><span ${editing ? "" : ""}>Due <b id="bill-due">৳0</b></span>${editing ? `<span id="bill-refund-display" class="hidden" style="color:#dc2626">Refund <b id="bill-refund">৳0</b></span>` : ""}</div>`, async form => {
    if (!cart.length) throw new Error("Add at least one item to the bill.");
    if (cart.some(line => !(line.qty > 0))) throw new Error("Enter a quantity for every item.");
    for (const line of cart.filter(line => data.shopType === "mobile" && /smartphone|feature phone|tablet|mobile phone/i.test(line.category))) {
      const serials = (line.serials || []).map(value => String(value).trim()).filter(Boolean);
      if (!Number.isInteger(line.qty) || serials.length !== line.qty || serials.some(value => value.length < 4 || value.length > 60)) throw new Error("Enter one valid IMEI/serial for each " + line.name + " sold.");
      if (!Number.isInteger(line.warrantyMonths) || line.warrantyMonths < 0 || line.warrantyMonths > 120) throw new Error("Warranty period must be 0 to 120 months.");
    }
    const below = cart.filter(line => line.cost != null && line.price / (data.taxMode === "inclusive" ? 1 + Number(data.taxRate || 0) / 100 : 1) < line.cost);
    if (below.length && !confirm(`Warning: these items are priced below purchase cost: ${below.map(line => line.name).join(", ")}. Continue anyway?`)) return false;
    const payload = {
      paid: form.get("paid"),
      items: cart.map(line => ({ productId: line.id, qty: line.qty, price: line.price, serials: line.serials || [], warrantyMonths: line.warrantyMonths || 0 })),
      customer: form.get("customer"),
      phone: form.get("phone"),
      payment: form.get("payment"),
      discount: data.allowDiscounts ? Number(form.get("discount") || 0) : Number(editing?.discount || 0)
    };
    // Add refund data if editing and refund is being processed
    if (editing && form.get("processRefund") === "on") {
      payload.refundAmount = Number(form.get("refundAmount") || 0);
      payload.processRefund = true;
    }
    const result = await api(editing ? "/api/bills/" + editing.id : "/api/bills", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
    const { bill, ...state } = result;
    data = state; render();
    const refundMsg = payload.processRefund ? ` (Refund: ${money(payload.refundAmount)})` : "";
    toast(`${billNo(bill.id)} saved${refundMsg}`);
    if (!editing) printBill(bill);
  });
  dialog.classList.add("wide");
  dialog.classList.add("bill-editor");
  $("#submit-modal").classList.remove("hidden");
  $("#submit-modal").textContent = editing ? "Save changes" : "Save and print bill";
  dialog.addEventListener("close", () => { dialog.classList.remove("wide", "bill-editor"); $("#submit-modal").textContent = "Save"; }, { once: true });
  const totals = () => {
    const subtotal = cart.reduce((sum, line) => sum + line.price * line.qty, 0);
    const discountInput = $("#bill-discount");
    const discount = Math.min(Number(discountInput?.value) || 0, subtotal);
    const taxable = Math.max(0, subtotal - discount), rate = Number(data.taxRate || 0);
    const tax = data.taxMode === "exclusive" ? Math.round(taxable * rate) / 100 : data.taxMode === "inclusive" ? Math.round((taxable - taxable / (1 + rate / 100)) * 100) / 100 : 0;
    const total = data.taxMode === "exclusive" ? taxable + tax : taxable;
    $("#bill-subtotal").textContent = money(subtotal);
    if ($("#bill-tax")) $("#bill-tax").textContent = `${money(tax)}${data.taxMode === "inclusive" ? " included" : ""}`;
    $("#bill-total").textContent = money(total);
    const paidBox = $("#bill-paid");
    if (paidBox && !paidBox.dataset.t) paidBox.value = total;
    const paidAmount = editing ? editing.paid : Number(paidBox?.value) || 0;
    const due = Math.max(0, total - paidAmount);
    const refundCalc = Math.max(0, paidAmount - total - Number(editing?.refunded || 0));
    $("#bill-due").textContent = money(due);

    // Handle refund section for editing
    if (editing) {
      const refundSection = $("#refund-section");
      const refundAmountInput = $("#refund-amount");
      const refundCheckbox = $("#refund-checkbox");
      const refundDisplay = $("#bill-refund");
      const refundDisplayRow = $("#bill-refund-display");

      if (refundCalc > 0) {
        // Show refund section
        refundSection.classList.remove("hidden");
        // Auto-fill refund amount if not manually edited
        if (!refundAmountInput.dataset.edited) {
          refundAmountInput.value = refundCalc.toFixed(2);
        }
        // Update display
        const actualRefund = refundCheckbox.checked ? Number(refundAmountInput.value) || 0 : 0;
        refundDisplay.textContent = money(actualRefund);
        refundDisplayRow.classList.toggle("hidden", !refundCheckbox.checked || actualRefund === 0);
        $("#bill-due").closest("span").classList.toggle("hidden", refundCheckbox.checked && actualRefund > 0);
      } else {
        // Hide refund section when no refund needed
        refundSection.classList.add("hidden");
        refundDisplayRow.classList.add("hidden");
        $("#bill-due").closest("span").classList.remove("hidden");
      }
    }
  };
  const draw = () => {
    $("#bill-lines").innerHTML = cart.map((line, i) => `<tr><td class="product-cell">${esc(line.name)}</td><td>${priceCell(line, i)}</td><td>${qtyCell(line, i)}</td><td><b>${money(line.price * line.qty)}</b></td><td>${data.shopType === "mobile" && /smartphone|feature phone|tablet|mobile phone/i.test(line.category) ? `<label class="device-fields"><small>One IMEI/serial per unit</small><textarea data-i="${i}" data-f="serials" rows="2" placeholder="Enter each on a new line">${esc((line.serials || []).join("\n"))}</textarea><small>Warranty months</small><input class="bill-input" data-i="${i}" data-f="warranty" type="number" min="0" max="120" step="1" value="${Number(line.warrantyMonths || 0)}"></label>` : ""}</td><td><button type="button" class="user-action danger" data-remove="${i}">Remove</button></td></tr>`).join("");
    $("#bill-empty").classList.toggle("hidden", cart.length > 0);
    totals();
  };
  const addProduct = item => {
    if (!item) return;
    const existing = cart.find(line => line.id === item.id);
    if (!existing) cart.push({ id: item.id, name: productLabel(item), category: item.category || "", serials: [], warrantyMonths: 12, unit: item.unit || "piece", packSize: item.pack_size || 0, packName: item.pack_name, price: item.price, cost: item.cost, qty: 1, max: +(productSellableQty(item) + (extra[item.id] || 0)).toFixed(6) });
    else if (existing.qty < existing.max) existing.qty++;
    else { toast(`Only ${existing.max} ${existing.unit} of ${existing.name} in stock.`); return; }
    draw();
    $("#bill-search")?.focus();
  };
  initItemSearch({
    input: $("#bill-search"),
    results: $("#bill-search-results"),
    toggle: $("#bill-search-toggle"),
    getItems: () => stocked,
    onPick: addProduct,
    emptyText: "No in-stock item matches that name, SKU, or barcode."
  });
  $("#bill-lines").oninput = event => {
    const input = event.target, line = cart[input.dataset.i];
    if (!line) return;
    if (input.dataset.f === "mode") { line.mode = input.value; return draw(); }
    if (input.dataset.f === "serials") { line.serials = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean); return; }
    if (input.dataset.f === "warranty") { line.warrantyMonths = Number(input.value); return; }
    const f = unitOf(line).f, value = Number(input.value) || 0;
    if (input.dataset.f === "qty") {
      const prec = line.packSize > 0 ? 1e6 : 1e3;
      let qty = Math.round(value / f * prec) / prec;
      if (!isFractional(line.unit) && !(line.packSize > 0)) qty = Math.round(qty);
      if (qty > line.max) { qty = line.max; input.value = +(qty * f).toFixed(3); toast(`Only ${fmtQty(line.max, line.unit)} of ${line.name} in stock.`); }
      line.qty = qty;
    } else { const u = unitOf(line); line.price = u.key === "custom" ? value * u.f : value; }
    input.closest("tr").cells[3].innerHTML = `<b>${money(line.price * line.qty)}</b>`;
    totals();
  };
  $("#bill-lines").onclick = event => {
    const button = event.target.closest("[data-remove]");
    if (button) { cart.splice(Number(button.dataset.remove), 1); draw(); }
  };
  if ($("#bill-discount")) $("#bill-discount").oninput = totals;
  $("#bill-paid")?.addEventListener("input", e => { e.target.dataset.t = "1"; totals(); });
  $("#modal-fields [name=payment]")?.addEventListener("change", event => {
    const paid = $("#bill-paid");
    if (!paid) return;
    const subtotal = cart.reduce((sum, line) => sum + line.price * line.qty, 0), discount = Number($("#bill-discount")?.value) || 0;
    const base = Math.max(0, subtotal - discount), rate = Number(data.taxRate || 0);
    const tax = data.taxMode === "exclusive" ? Math.round(base * rate) / 100 : data.taxMode === "inclusive" ? Math.round((base - base / (1 + rate / 100)) * 100) / 100 : 0;
    paid.value = /due|credit|unpaid/i.test(event.target.value) ? 0 : data.taxMode === "exclusive" ? base + tax : base;
    paid.dataset.t = "1";
    totals();
  });
  // Refund section event listeners
  if (editing) {
    const refundCheckbox = $("#refund-checkbox");
    const refundAmountInput = $("#refund-amount");
    if (refundCheckbox) {
      refundCheckbox.addEventListener("change", totals);
    }
    if (refundAmountInput) {
      refundAmountInput.addEventListener("input", () => {
        refundAmountInput.dataset.edited = "1";
        totals();
      });
    }
  }
  draw();
  $("#bill-search").focus();
}
$("#new-bill").onclick = () => openBillEditor();
// ---- Extras: inventory download/print, sales search, customer history ----
document.head.insertAdjacentHTML("beforeend", `<style id="extras-css">
.sales-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}
.sales-filter input[type=date]{min-height:40px;padding:6px 10px;border:1px solid var(--line,#ccc);border-radius:8px;font:inherit}
.sales-filter .search input{width:220px}.sales-count{font-size:14px;color:var(--muted,#666)}
@media(max-width:680px){
  .sales-filter{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;width:100%;min-width:0}
  .sales-filter .search{grid-column:1/-1;min-width:0;width:100%;box-sizing:border-box}
  .sales-filter .search input{width:100%;min-width:0;box-sizing:border-box;font-size:16px}
  .sales-filter label:not(.search){min-width:0;margin:0}
  .sales-filter input[type=date]{display:block;width:100%;min-width:0;box-sizing:border-box;font-size:14px}
  .sales-filter #sales-clear{min-height:40px}
  .sales-count{align-self:center}
}
dialog.wide{width:min(900px,calc(100% - 28px));max-height:calc(100vh - 28px);overflow:auto}
.cust-list tbody tr{cursor:pointer}
.cust-summary{display:flex;gap:12px;flex-wrap:wrap;margin:6px 0 14px}
.cust-summary div{flex:1;min-width:130px;padding:10px 14px;border:1px solid var(--line,#ccc);border-radius:10px}
.cust-summary small{display:block;color:var(--muted,#666);font-size:13px}.cust-summary b{font-size:20px}
.cust-head{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}.cust-head .search{flex:1}.cust-head .search input{width:100%}
</style>`);
function printHtml(html) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  try {
    frame.contentDocument.open();
    frame.contentDocument.write(html);
    frame.contentDocument.close();
  } catch (error) {
    frame.remove();
    return toast("Could not prepare the print view. Please try again.");
  }
  if (hasBangla()) {
    try { translateDom(frame.contentDocument.body); } catch { /* printing still works in English */ }
  }
  setTimeout(() => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (error) {
      toast("The browser blocked printing. Use the downloaded copy or allow printing for this site.");
    } finally {
      setTimeout(() => frame.remove(), 2000);
    }
  }, 400);
}
const today10 = () => new Date().toISOString().slice(0, 10);

// Inventory: download (Excel/CSV) and print the list currently searched
$("#manage-categories").insertAdjacentHTML("beforebegin", `<button class="button secondary" id="inv-download" type="button">Download list</button><button class="button secondary" id="inv-print" type="button">Print list</button>`);
const inventoryRows = () => {
  const q = $("#search").value.trim().toLowerCase();
  return data.products.filter(p => !q || [p.name, p.sku, p.barcode, p.unit, p.category, p.brand, p.color, p.size, p.material].some(v => String(v || "").toLowerCase().includes(q)));
};
$("#inv-download").onclick = () => {
  const items = inventoryRows(), hasCost = items.some(p => p.cost !== undefined);
  const rows = [["Product", "SKU", "Category", "Brand", "Color", "Size", "Material", "Unit", "Quantity", "Minimum", "Selling price", ...(hasCost ? ["Purchase cost", "Stock value (cost)"] : [])],
    ...items.map(p => [p.name, p.sku, p.category || "Other", p.brand || "", p.color || "", p.size || "", p.material || "", p.unit || "piece", p.qty, p.min, p.price, ...(hasCost ? [p.cost, p.cost * p.qty] : [])])];
  downloadFile(`inventory-${today10()}.csv`, "\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\r\n"));
  toast(`${items.length} products downloaded`);
};
$("#inv-print").onclick = () => {
  const items = inventoryRows(), hasCost = items.some(p => p.cost !== undefined);
  if (!items.length) return toast("No products to print.");
  const value = items.reduce((sum, p) => sum + (p.cost || 0) * p.qty, 0);
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Inventory</title><style>
@page{margin:10mm}body{font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#000}h1{font-size:20px;margin:0}p{margin:2px 0 10px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:5px 7px;text-align:left}th{background:#eee}.r{text-align:right}tr{page-break-inside:avoid}</style></head><body>
<h1>${esc(data.shopName)} - Inventory list</h1><p>${esc(data.workspace)} · ${new Date().toLocaleString("en-BD")} · ${items.length} products${hasCost ? ` · Stock value at cost: ${money(value)}` : ""}</p>
<table><thead><tr><th>#</th><th>Product</th><th>Brand</th><th>Color</th><th>Size</th><th>Material</th><th>SKU</th><th>Category</th><th class="r">Qty</th><th class="r">Min</th><th class="r">Price</th>${hasCost ? '<th class="r">Cost</th>' : ""}</tr></thead><tbody>${items.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${esc(p.brand || "")}</td><td>${esc(p.color || "")}</td><td>${esc(p.size || "")}</td><td>${esc(p.material || "")}</td><td>${esc(p.sku)}</td><td>${esc(p.category || "Other")}</td><td class="r">${p.qty} ${esc(p.unit || "piece")}</td><td class="r">${p.min}</td><td class="r">${money(p.price)}</td>${hasCost ? `<td class="r">${money(p.cost)}</td>` : ""}</tr>`).join("")}</tbody></table></body></html>`);
};

// Sales history: search by item, payment, bill no, date range
$("#sales .table-scroll").insertAdjacentHTML("beforebegin", `<div class="sales-filter"><label class="search">⌕ <input id="sales-search" placeholder="Search item, payment, bill no, amount"></label><label>From <input type="date" id="sales-from"></label><label>To <input type="date" id="sales-to"></label><button class="button secondary" id="sales-clear" type="button">Clear</button><span class="sales-count" id="sales-count"></span><button class="button secondary" id="sales-print" type="button">Print</button></div>`);
let currentMatchingSales = [];
function filterSales() {
  const q = $("#sales-search").value.trim().toLowerCase(), from = $("#sales-from").value, to = $("#sales-to").value;
  const matchingSales = [];
  [...$("#sales-table").rows].forEach((row, i) => {
    const s = data.sales[i];
    if (!s) return;
    const hay = [s.product, s.payment, s.date, s.total, s.bill_id ? billNo(s.bill_id) : ""].join(" ").toLowerCase();
    const ok = (!q || hay.includes(q)) && (!from || s.date >= from) && (!to || s.date <= to);
    row.classList.toggle("hidden", !ok);
    if (ok) matchingSales.push(s);
  });
  currentMatchingSales = matchingSales;
  const shown = matchingSales.length, filtering = Boolean(q || from || to);
  const salesGross = matchingSales.reduce((sum, item) => sum + Number(item.original_total ?? item.total ?? 0), 0);
  const salesNet = matchingSales.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const returnsTotal = Math.max(0, salesGross - salesNet);
  $("#sales-count").textContent = filtering ? `${shown} of ${data.sales.length} sales` : `${shown} sales`;
  $("#sales-summary").innerHTML = `<div class="list-summary-heading"><b>Sales totals</b><small>${filtering ? "Totals for the sales currently shown" : "All-time totals across recorded sale lines"}</small></div><div class="list-summary-cards"><div><small>Sale lines</small><b>${shown}</b></div><div><small>Gross sales</small><b>${money(salesGross)}</b></div><div><small>Returned value</small><b>${money(returnsTotal)}</b></div><div><small>Net sales after returns</small><b>${money(salesNet)}</b></div></div>`;
  $("#sales-empty").textContent = filtering && !shown ? "No sales match your search." : "Your recorded sales will appear here.";
  $("#sales-empty").classList.toggle("hidden", !!shown || (!filtering && data.sales.length > 0));
}
["#sales-search", "#sales-from", "#sales-to"].forEach(id => $(id).addEventListener("input", filterSales));
$("#sales-clear").onclick = () => { $("#sales-search").value = $("#sales-from").value = $("#sales-to").value = ""; filterSales(); };
$("#sales-print").onclick = () => {
  if (!currentMatchingSales.length) return toast("No sales to print.");
  const from = $("#sales-from").value, to = $("#sales-to").value;
  const dateRange = from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Up to ${to}` : "All time";
  const salesGross = currentMatchingSales.reduce((sum, item) => sum + Number(item.original_total ?? item.total ?? 0), 0);
  const salesNet = currentMatchingSales.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const returnsTotal = Math.max(0, salesGross - salesNet);
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Sales History</title><style>
@page{margin:10mm}body{font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#000}h1{font-size:20px;margin:0}p{margin:2px 0 10px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:5px 7px;text-align:left}th{background:#eee}.r{text-align:right}tr{page-break-inside:avoid}
.summary{margin:15px 0;padding:10px;background:#f5f5f5;border:1px solid #ccc}.summary-row{display:flex;justify-content:space-between;margin:3px 0}</style></head><body>
<h1>${esc(data.shopName)} - Sales History</h1><p>${esc(data.workspace)} · ${new Date().toLocaleString("en-BD")} · ${dateRange}</p>
<div class="summary"><div class="summary-row"><span>Sale lines:</span><b>${currentMatchingSales.length}</b></div><div class="summary-row"><span>Gross sales:</span><b>${money(salesGross)}</b></div><div class="summary-row"><span>Returned value:</span><b>${money(returnsTotal)}</b></div><div class="summary-row"><span>Net sales after returns:</span><b>${money(salesNet)}</b></div></div>
<table><thead><tr><th>Date</th><th>Item</th><th>Qty / Unit</th><th>Payment</th><th>Bill No.</th><th class="r">Total</th></tr></thead><tbody>${currentMatchingSales.map((s) => `<tr><td>${esc(s.date)}</td><td>${esc(s.product)}${s.is_return ? ' <i>(Return)</i>' : ''}</td><td>${s.qty} ${esc(s.unit || "piece")}</td><td>${esc(s.payment)}</td><td>${s.bill_id ? billNo(s.bill_id) : "-"}</td><td class="r">${money(s.total)}</td></tr>`).join("")}</tbody></table></body></html>`);
};
const renderBeforeExtras = render;
render = function () {
  renderBeforeExtras();
  const sales = !!data.permissions?.sales, inventory = !!data.permissions?.inventory;
  $("#inv-download").classList.toggle("hidden", !inventory);
  $("#inv-print").classList.toggle("hidden", !inventory);
  $("#customer-history").classList.toggle("hidden", !sales);
  $("#returns-list").classList.toggle("hidden", !sales);
  $(".sales-filter").classList.toggle("hidden", !sales);
  $("#sales-print").classList.toggle("hidden", !sales);
  filterSales();
};

// Customer history: everyone billed with a name or phone number
$("#new-bill").insertAdjacentHTML("afterend", `<button class="button secondary" id="customer-history" type="button">Customers</button>`);
$("#customer-history").onclick = async () => {
  let bills;
  try { bills = (await api("/api/bills")).bills; } catch (error) { return toast(error.message); }
  const people = new Map();
  bills.filter(b => b.customer || b.phone).forEach(b => {
    const key = b.phone ? "p:" + b.phone.replace(/\s+/g, "") : "n:" + b.customer.toLowerCase();
    const person = people.get(key) || { key, name: b.customer, phone: b.phone, bills: [] };
    if (!person.name && b.customer) person.name = b.customer;
    if (!person.phone && b.phone) person.phone = b.phone;
    person.bills.push(b);
    people.set(key, person);
  });
  const list = [...people.values()];
  openModal("Customer history", `<div id="cust-body"></div>`, async () => {});
  dialog.classList.add("wide");
  const submit = $("#submit-modal"); submit.classList.add("hidden");
  dialog.addEventListener("close", () => { dialog.classList.remove("wide"); submit.classList.remove("hidden"); }, { once: true });
  const body = $("#cust-body");
  let customerQuery = "", customerFrom = "", customerTo = "";
  const showList = (q = customerQuery, from = customerFrom, to = customerTo) => {
    customerQuery = q; customerFrom = from; customerTo = to;
    const invalidRange = Boolean(from && to && from > to);
    const hits = invalidRange ? [] : list.map(person => {
      const matchingBills = person.bills.filter(b => (!from || b.date >= from) && (!to || b.date <= to));
      return { ...person, bills: matchingBills };
    }).filter(person => person.bills.length && (!q || `${person.name} ${person.phone}`.toLowerCase().includes(q.toLowerCase())));
    body.innerHTML = `<div class="cust-head"><label class="search">⌕ <input id="cust-search" placeholder="Search customer name or phone" value="${esc(q)}"></label></div><div class="returns-date-filters"><label>From<input type="date" id="cust-from" value="${esc(from)}"></label><label>To<input type="date" id="cust-to" value="${esc(to)}"></label><button type="button" class="button secondary" id="cust-clear-filters">Clear filters</button></div><p class="form-hint">${invalidRange ? "The start date must be before the end date." : `Showing ${hits.length} of ${list.length} customers${from || to ? " with bills in this date range" : ""}`}</p>` +
      (hits.length ? `<div class="table-scroll bill-cart"><table class="cust-list"><thead><tr><th>Customer</th><th>Phone</th><th>Bills</th><th>Total spent</th><th>Due</th><th>Last visit</th></tr></thead><tbody>${hits.map(p => { const spent = p.bills.reduce((n, b) => n + b.total, 0), due = p.bills.reduce((n, b) => n + b.due, 0); return `<tr data-key="${esc(p.key)}"><td class="product-cell">${esc(p.name || "-")}</td><td>${esc(p.phone || "-")}</td><td>${p.bills.length}</td><td>${money(spent)}</td><td>${due ? `<b>${money(due)}</b>` : "-"}</td><td>${esc(p.bills[0].date)}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty">${invalidRange ? "Choose a valid date range." : list.length ? "No customer matches these filters." : "No customers yet. Enter a name or phone on a bill and they will appear here."}</div>`);
    const input = $("#cust-search"); input.focus(); input.setSelectionRange(q.length, q.length);
    input.oninput = () => showList(input.value, $("#cust-from").value, $("#cust-to").value);
    $("#cust-from").onchange = () => showList(input.value, $("#cust-from").value, $("#cust-to").value);
    $("#cust-to").onchange = () => showList(input.value, $("#cust-from").value, $("#cust-to").value);
    $("#cust-clear-filters").onclick = () => showList("", "", "");
    body.querySelectorAll("tr[data-key]").forEach(tr => tr.onclick = () => showCustomer(hits.find(p => p.key === tr.dataset.key)));
  };
  const showCustomer = p => {
    const spent = p.bills.reduce((n, b) => n + b.total, 0), due = p.bills.reduce((n, b) => n + b.due, 0);
    body.innerHTML = `<div class="cust-head"><button type="button" class="button secondary" id="cust-back">← All customers</button><b>${esc(p.name || "-")}</b><span>${esc(p.phone || "")}</span></div>
<div class="cust-summary"><div><small>Bills</small><b>${p.bills.length}</b></div><div><small>Total spent</small><b>${money(spent)}</b></div><div><small>Still due</small><b>${money(due)}</b></div><div><small>Last visit</small><b>${esc(p.bills[0].date)}</b></div></div>
<div class="table-scroll bill-cart"><table><thead><tr><th>Bill</th><th>Date</th><th>Items bought</th><th>Payment</th><th>Total</th><th></th></tr></thead><tbody>${p.bills.map(b => `<tr><td>${billNo(b.id)}</td><td>${esc(b.date)}</td><td style="white-space:normal;min-width:200px">${b.lines.map(l => `${esc(l.name)} ×${l.qty}`).join(", ")}</td><td>${esc(b.payment)}</td><td><b>${money(b.total)}</b></td><td><button type="button" class="user-action" data-reprint="${b.id}">Print</button></td></tr>`).join("")}</tbody></table></div>`;
    $("#cust-back").onclick = () => showList(customerQuery, customerFrom, customerTo);
    body.querySelectorAll("[data-reprint]").forEach(btn => btn.onclick = () => printBill(p.bills.find(b => String(b.id) === btn.dataset.reprint)));
  };
  showList();
};
// ---- Bills list (edit, delete, receive payments), dues alert, stock and profit outlook ----
document.head.insertAdjacentHTML("beforeend", `<style id="dues-css">
.strip-title{margin:16px 0 0;font-weight:700}.strip-title small{font-weight:400;color:var(--muted,#666)}
#dues-alert{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 16px;padding:12px 16px;border-radius:10px;background:var(--warn-bg,#fff0d6);color:var(--warn,#8a5200);border:1px solid currentColor;font-weight:600}
.report-totals em{display:block;font:400 13px/1.3 inherit;font-style:normal;color:var(--muted,#666)}
</style>`);
$(".welcome").insertAdjacentHTML("afterend", `<div id="dues-alert" class="hidden"><span id="dues-text"></span><button type="button" class="button secondary" id="dues-view">View dues</button></div>`);
$(".report-totals").insertAdjacentHTML("afterend", `<div id="stock-report"></div>`);
$("#inventory .table-scroll").insertAdjacentHTML("beforebegin", `<div id="stock-inventory"></div>`);
function stockStrip(withDues) {
  if (!data.products.length || data.products[0].cost === undefined) return "";
  let cost = 0, retail = 0;
  data.products.forEach(p => { cost += p.cost * p.qty; retail += p.price * p.qty; });
  const profit = retail - cost, margin = retail ? (profit / retail * 100).toFixed(1) : "0.0", dues = data.dues || { count: 0, amount: 0 };
  return `<p class="strip-title">Stock and profit outlook <small>(updates after every sale)</small></p><div class="report-totals"><div><small>Stock asset value (cost)</small><b>${money(cost)}</b></div><div><small>Stock value at selling price</small><b>${money(retail)}</b></div><div><small>Profit if all stock is sold</small><b>${money(profit)}</b><em>${margin}% margin</em></div>${withDues ? `<div><small>Customer dues</small><b>${money(dues.amount)}</b><em>${dues.count} unpaid bill${dues.count === 1 ? "" : "s"}</em></div>` : `<div><small>Products in stock</small><b>${data.products.filter(p => p.qty > 0).length}</b></div>`}</div>`;
}
const renderBeforeDues = render;
render = function () {
  renderBeforeDues();
  $("#stock-inventory").innerHTML = stockStrip(false);
  $("#stock-report").innerHTML = stockStrip(true);
  const dues = data.dues, sales = !!data.permissions?.sales;
  $("#dues-alert").classList.toggle("hidden", !(sales && dues && dues.amount > 0));
  if (dues) $("#dues-text").textContent = `⚠ Customer dues: ${money(dues.amount)} unpaid across ${dues.count} bill${dues.count === 1 ? "" : "s"}`;
  $("#bills-list").classList.toggle("hidden", !sales);
};
$("#customer-history").insertAdjacentHTML("afterend", `<button class="button secondary" id="bills-list" type="button">Bills</button><button class="button secondary" id="returns-list" type="button">Returns</button>`);
$("#bills-list").onclick = () => openBills(false);
$("#dues-view").onclick = () => openBills(true);
$("#returns-list").onclick = () => {
  const rows = data.salesReturns || [];
  openModal("Sales returns", `<div class="returns-search-row"><label class="search">⌕ <input type="search" id="returns-search" placeholder="Search item, bill, reason, staff"></label><button class="button secondary" id="returns-clear-filters" type="button">Clear filters</button></div><div class="returns-date-filters"><label>From<input type="date" id="returns-from"></label><label>To<input type="date" id="returns-to"></label></div><p class="form-hint" id="returns-count"></p><div class="table-scroll bill-cart" style="max-height:430px"><table><thead><tr><th>Date</th><th>Item</th><th>Qty</th><th>Bill</th><th>Return value</th><th>Refund</th><th>Reason / by</th></tr></thead><tbody id="returns-body"></tbody></table></div><div class="empty hidden" id="returns-empty"></div>`, async () => {});
  dialog.classList.add("wide");
  const renderReturns = () => {
    const from = $("#returns-from").value;
    const to = $("#returns-to").value;
    const query = $("#returns-search").value.trim().toLocaleLowerCase();
    const invalidRange = Boolean(from && to && from > to);
    const filtered = invalidRange ? [] : rows.filter(row => {
      if ((from && row.date < from) || (to && row.date > to)) return false;
      if (!query) return true;
      const searchable = [row.date, row.product, row.unit, row.reason, row.actor, row.refund_method, row.qty, row.total, row.bill_id ? billNo(row.bill_id) : "", row.bill_id].join(" ").toLocaleLowerCase();
      return searchable.includes(query);
    });
    $("#returns-body").innerHTML = filtered.map(row => `<tr><td>${esc(row.date)}</td><td>${esc(row.product)}</td><td>${row.qty} ${esc(row.unit || "piece")}</td><td>${row.bill_id ? billNo(row.bill_id) : "—"}</td><td>${money(row.total)}</td><td>${Number(row.refund_amount) > 0 ? `${money(row.refund_amount)} · ${esc(row.refund_method)}` : "Credit"}</td><td>${esc(row.reason || "—")}<br><small>${esc(row.actor || "")}</small></td></tr>`).join("");
    $("#returns-count").textContent = invalidRange ? "The start date must be before the end date." : `Showing ${filtered.length} of ${rows.length} returns`;
    $("#returns-empty").classList.toggle("hidden", filtered.length > 0);
    $("#returns-empty").textContent = invalidRange ? "Choose a valid date range." : rows.length && !filtered.length ? query ? "No sales returns match your search." : "No returns in this date range." : "No sales returns recorded.";
  };
  $("#returns-from").onchange = renderReturns;
  $("#returns-to").onchange = renderReturns;
  $("#returns-search").oninput = renderReturns;
  $("#returns-clear-filters").onclick = () => { $("#returns-from").value = ""; $("#returns-to").value = ""; $("#returns-search").value = ""; renderReturns(); };
  renderReturns();
  const submit = $("#submit-modal"); submit.classList.add("hidden");
  dialog.addEventListener("close", () => { dialog.classList.remove("wide"); submit.classList.remove("hidden"); }, { once: true });
};
async function openBills(duesOnly, previousFilters = {}) {
  let bills;
  try { bills = (await api("/api/bills")).bills; } catch (error) { return toast(error.message); }
  openModal("Bills", `<div class="cust-head"><label class="search">⌕ <input id="bill-find" placeholder="Search bill no, customer, phone, item" value="${esc(previousFilters.query || "")}"></label><label><input type="checkbox" id="dues-only" ${duesOnly ? "checked" : ""}> Dues only</label></div><div class="bills-date-filters"><label>From<input type="date" id="bills-from" value="${esc(previousFilters.from || "")}"></label><label>To<input type="date" id="bills-to" value="${esc(previousFilters.to || "")}"></label><button type="button" class="button secondary" id="bills-clear-filters">Clear filters</button></div><p class="form-hint" id="bills-count"></p><div class="table-scroll bill-cart" style="max-height:430px"><table><thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th>Total</th><th>Paid</th><th>Due</th><th></th></tr></thead><tbody id="bills-body"></tbody></table></div><div class="empty hidden" id="bills-empty">No bills found.</div>`, async () => {});
  dialog.classList.add("wide");
  const submit = $("#submit-modal"); submit.classList.add("hidden");
  dialog.addEventListener("close", () => { dialog.classList.remove("wide"); submit.classList.remove("hidden"); }, { once: true });
  const draw = () => {
    const q = $("#bill-find").value.trim().toLowerCase(), dues = $("#dues-only").checked;
    const from = $("#bills-from").value, to = $("#bills-to").value;
    const invalidRange = Boolean(from && to && from > to);
    const hits = invalidRange ? [] : bills.filter(b => (!dues || b.due > 0) && (!from || b.date >= from) && (!to || b.date <= to) && (!q || `${billNo(b.id)} ${b.customer} ${b.phone} ${b.lines.map(l => l.name).join(" ")}`.toLowerCase().includes(q)));
    const btn = (a, label, cls = "") => `<button type="button" class="user-action ${cls}" data-a="${a}">${label}</button>`;
    $("#bills-body").innerHTML = hits.map(b => `<tr data-id="${b.id}"><td>${billNo(b.id)}</td><td>${esc(b.date)}</td><td>${esc(b.customer || "-")}${b.phone ? `<br><small>${esc(b.phone)}</small>` : ""}</td><td>${money(b.netTotal ?? b.total)}${b.returned > 0 ? `<small class="form-hint">${money(b.returned)} returned</small>` : ""}</td><td>${money(b.paid)}</td><td>${b.due > 0 ? `<b>${money(b.due)}</b>` : b.customerCredit > 0 ? `<small>Credit ${money(b.customerCredit)}</small>` : "-"}</td><td>${btn("print", "Print")}${b.due > 0 ? btn("pay", "Receive") : ""}${!b.returned ? `${btn("edit", "Edit")}${btn("delete", "Delete", "danger")}` : "Return history"}</td></tr>`).join("");
    $("#bills-count").textContent = invalidRange ? "The start date must be before the end date." : `Showing ${hits.length} of ${bills.length} bills`;
    $("#bills-empty").classList.toggle("hidden", hits.length > 0);
    $("#bills-empty").textContent = invalidRange ? "Choose a valid date range." : "No bills match your filters.";
  };
  const currentFilters = () => ({ query: $("#bill-find").value, from: $("#bills-from").value, to: $("#bills-to").value });
  $("#bill-find").oninput = draw; $("#dues-only").onchange = draw; $("#bills-from").onchange = draw; $("#bills-to").onchange = draw;
  $("#bills-clear-filters").onclick = () => { $("#bill-find").value = ""; $("#dues-only").checked = false; $("#bills-from").value = ""; $("#bills-to").value = ""; draw(); };
  $("#bills-body").onclick = async event => {
    const button = event.target.closest("[data-a]");
    if (!button) return;
    const bill = bills.find(b => String(b.id) === button.closest("tr").dataset.id), again = $("#dues-only").checked, filters = currentFilters();
    if (button.dataset.a === "print") return printBill(bill);
    if (button.dataset.a === "edit") return openBillEditor(bill);
    if (button.dataset.a === "delete") {
      if (!confirm(`Delete bill ${billNo(bill.id)} permanently? Its items go back into stock, and its sales and payment records are removed.`)) return;
      try { data = await api("/api/bills/" + bill.id, { method: "DELETE" }); render(); toast(`${billNo(bill.id)} deleted`); closeModal(); openBills(again, filters); } catch (error) { toast(error.message); }
      return;
    }
    openModal(`Receive payment · ${billNo(bill.id)}`, `<p>Due now: <b>${money(bill.due)}</b></p><label>Amount received (৳)<input name="amount" type="number" min="0.01" max="${bill.due}" step="any" value="${bill.due}" required></label><label>Method<select name="method"><option>Cash</option><option>bKash</option><option>Nagad</option><option>Card</option></select></label>`, async form => {
      const { bill: saved, ...state } = await api(`/api/bills/${bill.id}/payments`, { method: "POST", body: JSON.stringify({ amount: Number(form.get("amount")), method: form.get("method") }) });
      data = state; render(); toast("Payment saved"); setTimeout(() => openBills(again, filters), 50);
    });
    submit.classList.remove("hidden");
  };
  draw();
}
// Allow decimal stock in the product forms (e.g. 7.25 kg left after selling 250 gm).
const baseOpenModal = openModal;
openModal = function (...args) {
  baseOpenModal(...args);
  if (args[0] === "Add a product" || args[0] === "Edit inventory item") {
    const nameBox = document.querySelector('#modal-fields input[name="name"]'), skuBox = document.querySelector('#modal-fields input[name="sku"]');
    const item = args[0] === "Edit inventory item" ? data.products.find(p => p.name === nameBox?.value && (p.sku || "") === (skuBox?.value || "")) : null;
    document.querySelector("#modal-fields").insertAdjacentHTML("beforeend", `<div class="form-row"><label>Smaller unit to sell in (optional)<input name="pack_name" maxlength="20" placeholder="meter, feet, gm" value="${esc(item?.pack_name || "")}"></label><label>How many in one unit<input name="pack_size" type="number" min="0" step="any" value="${item?.pack_size || ""}"><span class="form-hint">Example: unit = coil, smaller unit = meter, 305 here. Keep stock, price and cost per coil (stock 1, cost 1500). In billing you can sell by coil or type meters, and the price is worked out for you.</span></label></div>`);
  }
  document.querySelectorAll('#modal-fields input[name="qty"], #modal-fields input[name="min"]').forEach(input => { if (input.type === "number") input.step = "any"; });
};
// Everything Record sale did is covered by New bill. Set to false to show the old button again.
const HIDE_RECORD_SALE = true;
const renderBeforeFractions = render;
render = function () {
  renderBeforeFractions();
  const cut = data.products.filter(p => p.pack_size > 0);
  if (cut.length) $("#stock-inventory").insertAdjacentHTML("beforeend", `<p class="strip-title">Cut-length stock</p><p>${cut.map(p => `${esc(p.name)}: ${+p.qty.toFixed(3)} ${esc(p.unit)} = <b>${+(p.qty * p.pack_size).toFixed(1)} ${esc(p.pack_name || "part")}</b> left`).join("<br>")}</p>`);
  if (HIDE_RECORD_SALE) document.querySelectorAll("button").forEach(button => { if (/record sale/i.test(button.textContent)) button.classList.add("hidden"); });
};
// ---- Shop tools: cash closing, reports, reorder list, due reminders, activity log, backups ----
const OFFLINE_FONTS = true; // removes the Google Fonts link so screens look the same without internet
if (OFFLINE_FONTS) document.querySelector('link[href*="fonts.googleapis.com"]')?.remove();
const saveCsv = (filename, rows) => downloadFile(filename, "\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\r\n"));
const toolTable = (head, rows) => `<div class="table-scroll bill-cart" style="max-height:380px"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const stamp = at => new Date(at.replace(" ", "T") + "Z").toLocaleString("en-BD");
let toolDays = 90;
const periodPicker = `<p><label>Period <select id="tool-period">${[30, 90, 180, 365].map(d => `<option value="${d}" ${d === toolDays ? "selected" : ""}>Last ${d} days</option>`).join("")}</select></label></p>`;
const wirePeriod = reload => () => { $("#tool-period").onchange = e => { toolDays = Number(e.target.value); reload(); }; };
const hasPerm = name => () => !!data.permissions?.[name];
const isTeam = () => !!(signedInUser?.permissions?.team || signedInUser?.permissions?.admins);
const tools = {
  cash: { label: "Cash closing", show: hasPerm("sales"), render: async reload => {
    const c = await api("/api/cash?date=" + (tools.cash.date || today10()));
    return { csv: [["Method", "Net received"], ...c.receipts.map(r => [r.method, r.amount])],
      html: `<p><label>Date <input type="date" id="cash-date" value="${esc(c.date)}"></label></p><div class="cust-summary"><div><small>Net received</small><b>${money(c.totalReceived)}</b></div><div><small>Sold on this day</small><b>${money(c.billed)}</b></div><div><small>Returns</small><b>${money(c.returns || 0)}</b></div><div><small>New dues</small><b>${money(c.newDue)}</b></div><div><small>Old dues collected</small><b>${money(c.dueCollected)}</b></div>${c.expenses === null ? "" : `<div><small>Expenses</small><b>${money(c.expenses)}</b></div>`}</div>${c.receipts.length ? toolTable(["Method", "Net received"], c.receipts.map(r => [esc(r.method), money(r.amount)])) : "<p>No payments were received on this day.</p>"}`,
      after: () => { $("#cash-date").onchange = e => { tools.cash.date = e.target.value; reload(); }; } };
  } },
  monthly: { label: "Monthly profit", show: hasPerm("sales"), render: async () => {
    const by = {}, row = key => (by[key] = by[key] || { sales: 0, cost: 0, spent: 0 });
    data.sales.forEach(s => { const r = row(s.date.slice(0, 7)); r.sales += s.total; r.cost += s.cost; });
    data.expenses.forEach(e => { row(e.date.slice(0, 7)).spent += e.amount; });
    const head = ["Month", "Sales", "Cost of goods", "Gross profit", "Expenses", "Net profit"];
    const rows = Object.keys(by).sort().reverse().map(k => { const r = by[k], gross = r.sales - r.cost; return [k, r.sales, r.cost, gross, r.spent, gross - r.spent]; });
    return { csv: [head, ...rows], html: rows.length ? toolTable(head, rows.map(r => [r[0], ...r.slice(1).map(money)])) : "<p>No sales yet.</p>" };
  } },
  best: { label: "Best sellers", show: hasPerm("sales"), render: async reload => {
    const since = new Date(Date.now() - toolDays * 864e5).toISOString().slice(0, 10), by = {};
    data.sales.filter(s => s.date >= since).forEach(s => { const r = (by[s.product] = by[s.product] || { qty: 0, sales: 0, profit: 0 }); r.qty += s.qty; r.sales += s.total; r.profit += s.total - s.cost; });
    const list = Object.entries(by).sort((a, b) => b[1].profit - a[1].profit).slice(0, 25), head = ["Item", "Quantity sold", "Sales", "Profit"];
    return { csv: [head, ...list.map(([n, r]) => [n, r.qty, r.sales, r.profit])], html: periodPicker + (list.length ? toolTable(head, list.map(([n, r]) => [esc(n), +r.qty.toFixed(3), money(r.sales), money(r.profit)])) : "<p>No sales in this period.</p>"), after: wirePeriod(reload) };
  } },
  slow: { label: "Slow movers", show: hasPerm("inventory"), render: async reload => {
    const since = new Date(Date.now() - toolDays * 864e5).toISOString().slice(0, 10), last = {};
    data.sales.forEach(s => { if (!last[s.product] || s.date > last[s.product]) last[s.product] = s.date; });
    const list = data.products.filter(p => p.qty > 0 && !(last[p.name] >= since)).map(p => ({ p, value: (p.cost ?? p.price) * p.qty })).sort((a, b) => b.value - a.value);
    const head = ["Item", "In stock", "Last sold", "Money tied up"];
    return { csv: [head, ...list.map(({ p, value }) => [p.name, p.qty, last[p.name] || "never", value])], html: periodPicker + (list.length ? toolTable(head, list.map(({ p, value }) => [esc(p.name), `${+p.qty.toFixed(3)} ${esc(p.unit || "piece")}`, last[p.name] || "never", money(value)])) : "<p>Everything in stock has sold recently.</p>"), after: wirePeriod(reload) };
  } },
  reorder: { label: "Reorder list", show: hasPerm("inventory"), render: async () => {
    const low = data.products.filter(p => p.qty <= p.min).sort((a, b) => a.qty - b.qty), head = ["Item", "SKU", "In stock", "Alert level", "Suggested order"];
    const rows = low.map(p => [p.name, p.sku || "", `${+p.qty.toFixed(3)} ${p.unit || "piece"}`, p.min, Math.max(1, Math.ceil(p.min * 2 - p.qty))]);
    return { csv: [head, ...rows], html: rows.length ? toolTable(head, rows.map(r => [esc(r[0]), esc(r[1]), esc(r[2]), r[3], `<b>${r[4]}</b>`])) + "<p><small>Suggested order brings stock up to twice the alert level.</small></p>" : "<p>Nothing is low on stock.</p>" };
  } },
  reminders: { label: "Due reminders", show: hasPerm("sales"), render: async () => {
    const { bills } = await api("/api/bills"), by = new Map();
    bills.filter(b => b.due > 0).forEach(b => {
      const key = b.phone ? "p" + b.phone.replace(/\D/g, "") : "n" + (b.customer || "").toLowerCase();
      const r = by.get(key) || { name: b.customer || "(no name)", phone: b.phone, due: 0, oldest: b.date, count: 0 };
      r.due += b.due; r.count++; if (b.date < r.oldest) r.oldest = b.date; by.set(key, r);
    });
    const list = [...by.values()].sort((a, b) => a.oldest.localeCompare(b.oldest)), head = ["Customer", "Phone", "Unpaid bills", "Oldest", "Due"];
    const link = r => {
      if (!r.phone) return "-";
      let digits = r.phone.replace(/\D/g, ""); if (digits.startsWith("0")) digits = "880" + digits.slice(1);
      const text = `Dear ${r.name}, your due balance at ${data.shopName} is ${money(r.due)}. Please pay when convenient. Thank you.`;
      return `<a class="user-action" target="_blank" rel="noopener" href="https://wa.me/${digits}?text=${encodeURIComponent(text)}">WhatsApp</a>`;
    };
    return { csv: [head, ...list.map(r => [r.name, r.phone, r.count, r.oldest, r.due])], html: list.length ? toolTable([...head, ""], list.map(r => [esc(r.name), esc(r.phone || "-"), r.count, esc(r.oldest), `<b>${money(r.due)}</b>`, link(r)])) + "<p><small>WhatsApp opens a ready message for you to send. Customers need a phone number on the bill.</small></p>" : "<p>No customer owes money.</p>" };
  } },
  activity: { label: "Activity log", show: isTeam, render: async () => {
    const { rows } = await api("/api/activity"), head = ["When", "Who", "What"];
    return { csv: [head, ...rows.map(r => [stamp(r.at), r.username, r.action])], html: rows.length ? toolTable(head, rows.map(r => [esc(stamp(r.at)), esc(r.username), esc(r.action)])) : "<p>Nothing recorded yet. New changes will appear here.</p>" };
  } },
};
function setBackupView(tab) {
  const freshStart = tab === "fresh-start";
  $("#backup-manager").classList.toggle("hidden", freshStart);
  $("#fresh-start-panel").classList.toggle("hidden", !freshStart);
  document.querySelectorAll("[data-backup-view]").forEach(button => {
    const active = button.dataset.backupView === tab;
    button.classList.toggle("primary", active);
    button.classList.toggle("secondary", !active);
    button.setAttribute("aria-selected", String(active));
  });
  if (!freshStart) renderBackupManager();
}
$("#backup-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-backup-view]");
  if (button && !button.classList.contains("hidden")) setBackupView(button.dataset.backupView);
});
async function renderOffsitePanel() {
  const panel = $("#offsite-panel");
  if (!panel) return;
  let status;
  try { status = await api("/api/backups/offsite"); }
  catch (error) { panel.innerHTML = `<p class="backup-status">${esc(error.message)}</p>`; return; }
  const heading = `<div class="offsite-heading"><div><h3>Offsite backup</h3><p>Keep an encrypted copy outside this computer with Google Drive.</p></div><span class="offsite-pill ${status.connected ? "on" : ""}">${esc(status.connected ? t("Connected") : t("Not connected"))}</span></div>`;
  if (!status.configured) {
    panel.innerHTML = heading + `<p class="backup-status">Offsite backup is not configured on this server yet.</p><p class="form-hint">Set SHOP_GOOGLE_CLIENT_ID and SHOP_GOOGLE_CLIENT_SECRET on the server, then restart Shop Desk.</p>`;
    translateDom(panel);
    return;
  }
  const lastSuccess = status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "";
  const stale = status.lastSuccessAt ? (Date.now() - new Date(status.lastSuccessAt).getTime() > 48 * 3600 * 1000) : true;
  const warning = status.connected && status.enabled && stale
    ? `<p class="offsite-warning">${esc(t("Your last offsite backup is more than 48 hours old."))}</p>` : "";
  if (!status.connected) {
    panel.innerHTML = heading + `<p class="backup-status">Connect Google Drive so this shop can be restored even if the server PC is lost, stolen, or damaged. The backup is encrypted before it leaves this computer.</p>
      <div class="backup-actions"><button type="button" class="button primary" id="offsite-connect">Connect Google Drive</button></div>
      <p class="form-hint">Google will return to: <code>${esc(status.redirectUri)}</code></p>${status.redirectUri.includes("localhost") || status.redirectUri.includes("127.0.0.1") ? `<p class="form-hint">Open the Google link on the shop server PC.</p>` : ""}`;
    translateDom(panel);
    const connect = $("#offsite-connect");
    if (connect) connect.onclick = async () => {
      connect.disabled = true;
      try {
        const result = await api("/api/backups/offsite/connect", { method: "POST" });
        window.open(result.url, "_blank", "noopener");
        toast("Complete the Google sign-in, then return to this screen.");
      } catch (error) { toast(error.message); }
      finally { connect.disabled = false; }
    };
    return;
  }
  panel.innerHTML = heading + warning + `
    <div class="offsite-summary">
      <div><small>Google account</small><b>${esc(status.email || "Connected")}</b></div>
      <div><small>Last successful upload</small><b>${esc(lastSuccess || t("Never"))}</b></div>
      <div><small>Files kept on Drive</small><b>${Number(status.keep) || 14}</b></div>
    </div>
    ${status.lastFile ? `<p class="form-hint">Latest file: <code>${esc(status.lastFile)}</code></p>` : ""}
    ${status.lastError ? `<p class="backup-status offsite-error" role="status">${esc(status.lastError)}</p>` : ""}
    <form id="offsite-config" class="offsite-config">
      <label class="backup-schedule-toggle"><input type="checkbox" name="enabled" ${status.enabled ? "checked" : ""}> Upload a backup every day</label>
      <label>Backup folder name<input name="folderName" maxlength="60" value="${esc(status.folderName)}"></label>
      <label>Keep on Google Drive<input name="keep" type="number" min="1" max="90" value="${Number(status.keep) || 14}"></label>
      <button type="submit" class="button secondary">Save offsite settings</button><span id="offsite-status" role="status"></span>
    </form>
    <div class="backup-actions"><button type="button" class="button primary" id="offsite-run">Back up now</button><button type="button" class="button secondary" id="offsite-test">Test connection</button><button type="button" class="button secondary" id="offsite-disconnect">Disconnect</button></div>
    <p class="form-hint">Backups are encrypted with the key stored on this server.</p>
    <p class="form-hint">Keep a copy of the offsite.key file from the data folder: without it, downloaded backups cannot be opened.</p>`;
  translateDom(panel);
  const testButton = $("#offsite-test");
  if (testButton) testButton.onclick = async () => {
    testButton.disabled = true;
    try {
      const result = await api("/api/backups/offsite/test", { method: "POST" });
      toast(`${t("Google Drive connection works.")} ${result.email || ""}`.trim());
    } catch (error) { toast(error.message); }
    finally { testButton.disabled = false; }
  };
  $("#offsite-config").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget), note = $("#offsite-status");
    note.textContent = "Saving…";
    try {
      await api("/api/backups/offsite/config", { method: "POST", body: JSON.stringify({ enabled: form.has("enabled"), folderName: form.get("folderName"), keep: Number(form.get("keep")) }) });
      note.textContent = "Saved.";
      renderOffsitePanel();
    } catch (error) { note.textContent = error.message; }
  };
  $("#offsite-run").onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = "Uploading…";
    try {
      const result = await api("/api/backups/offsite/run", { method: "POST" });
      toast(`${t("Backup uploaded")}: ${result.result.file}`);
      renderOffsitePanel();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = t("Back up now"); }
  };
  $("#offsite-disconnect").onclick = async () => {
    if (!confirm(t("Disconnect Google Drive? Existing backups will stay on Drive."))) return;
    await api("/api/backups/offsite/disconnect", { method: "POST" });
    renderOffsitePanel();
  };
}

async function renderBackupManager() {
  const container = $("#backup-manager");
  container.innerHTML = `<p class="backup-status">Loading backups…</p>`;
  try {
    const [{ files }, schedule] = await Promise.all([api("/api/backups"), api("/api/backups/schedule")]);
    const lastBackup = schedule.lastBackupAt ? new Date(schedule.lastBackupAt).toLocaleString() : "No scheduled backup has completed yet.";
    container.innerHTML = `<section id="offsite-panel" class="offsite-panel"><p class="backup-status">Loading offsite backup…</p></section><p class="backup-intro">Create a dated SQLite copy and choose where to save it on this computer. To restore, select a Shop Desk backup file. Restoring replaces current shop data; a safety copy is made first.</p><section class="backup-schedule"><div><h3>Automatic backup schedule</h3><p>Choose a folder on the shop server PC. The server must be running at the selected time. Uses the server PC’s local time; keeps the newest 14 backups.</p><p class="backup-last-run">Last scheduled backup: <b>${esc(lastBackup)}</b></p></div><form id="backup-schedule-form"><label class="backup-schedule-toggle"><input type="checkbox" name="enabled" ${schedule.enabled ? "checked" : ""}> Enable daily backup</label><label>Backup time<input type="time" name="time" value="${esc(schedule.time)}" required></label><label class="backup-schedule-directory">Server backup folder<span class="backup-folder-choice"><input type="text" id="backup-schedule-directory" name="directory" value="${esc(schedule.directory)}" readonly required><button type="button" class="button secondary" id="browse-backup-folder">Choose folder…</button></span></label><button type="submit" class="button secondary">Save schedule</button><span id="backup-schedule-status" role="status"></span></form></section><dialog id="backup-folder-dialog" class="backup-folder-dialog" aria-labelledby="backup-folder-title"><div class="backup-folder-dialog-content"><div class="backup-folder-heading"><h3 id="backup-folder-title">Choose server backup folder</h3><button type="button" class="user-action" id="close-backup-folder">Close</button></div><p>Browse folders on the server PC, then choose the folder for scheduled backups.</p><div class="backup-folder-current"><button type="button" class="user-action" id="backup-folder-up">Up one folder</button><button type="button" class="user-action" id="backup-folder-drives">Drives</button><strong id="backup-folder-current"></strong></div><p id="backup-folder-error" class="backup-folder-error" role="status"></p><div id="backup-folder-list" class="backup-folder-list"></div><div class="backup-folder-actions"><button type="button" class="button primary" id="use-backup-folder">Use this folder</button><button type="button" class="button secondary" id="cancel-backup-folder">Cancel</button></div></div></dialog><div class="backup-actions"><button type="button" class="button primary" id="create-save-backup">Create and save backup</button><button type="button" class="button secondary" id="restore-from-file">Restore from file…</button></div><p class="backup-status" id="backup-status" role="status"></p>${files.length ? `<h3>Backups stored on the shop server</h3><div class="table-scroll"><table><thead><tr><th>Backup file</th><th>Size</th><th>Actions</th></tr></thead><tbody>${files.map(file => `<tr><td>${esc(file.name)}</td><td>${(file.size / 1048576).toFixed(2)} MB</td><td><button type="button" class="user-action" data-save-backup="${esc(file.name)}">Save to location…</button><button type="button" class="user-action danger" data-restore-server-backup="${esc(file.name)}">Restore</button><button type="button" class="user-action danger" data-delete-backup="${esc(file.name)}" aria-label="Delete backup ${esc(file.name)}">Delete</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No backups are stored on the shop server yet.</p>`}`;
    $("#backup-schedule-form").onsubmit = async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget), button = event.currentTarget.querySelector('[type="submit"]'), status = $("#backup-schedule-status");
      button.disabled = true; status.textContent = "Saving…";
      try {
        await api("/api/backups/schedule", { method: "POST", body: JSON.stringify({ enabled: form.has("enabled"), time: form.get("time"), directory: form.get("directory") }) });
        status.textContent = "Schedule saved.";
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    const folderDialog = $("#backup-folder-dialog");
    let selectedServerFolder = schedule.directory;
    const loadServerFolders = async folderPath => {
      const list = $("#backup-folder-list"), error = $("#backup-folder-error");
      list.innerHTML = `<p class="backup-folder-empty">Loading folders…</p>`; error.textContent = "";
      try {
        const result = await api(`/api/backups/folders?path=${encodeURIComponent(folderPath)}`);
        selectedServerFolder = result.current;
        $("#backup-folder-current").textContent = result.current;
        $("#backup-folder-up").disabled = !result.parent;
        $("#backup-folder-up").dataset.parentPath = result.parent || "";
        list.innerHTML = result.folders.length ? result.folders.map(folder => `<button type="button" class="backup-folder-entry" data-folder-path="${esc(folder.path)}"><span aria-hidden="true">📁</span><span>${esc(folder.name)}</span><span aria-hidden="true">›</span></button>`).join("") : `<p class="backup-folder-empty">No subfolders here.</p>`;
      } catch (loadError) { list.innerHTML = ""; error.textContent = loadError.message; }
    };
    $("#backup-folder-drives").onclick = async () => {
      const list = $("#backup-folder-list"), error = $("#backup-folder-error");
      list.innerHTML = `<p class="backup-folder-empty">Loading locations…</p>`; error.textContent = "";
      try {
        const result = await api("/api/backups/folders?roots=1");
        list.innerHTML = result.roots.map(root => `<button type="button" class="backup-folder-entry" data-folder-path="${esc(root)}"><span aria-hidden="true">💽</span><span>${esc(root)}</span><span aria-hidden="true">›</span></button>`).join("");
      } catch (loadError) { list.innerHTML = ""; error.textContent = loadError.message; }
    };
    $("#browse-backup-folder").onclick = async () => {
      await loadServerFolders($("#backup-schedule-directory").value);
      if (!folderDialog.hasAttribute("open")) { if (typeof folderDialog.showModal === "function") folderDialog.showModal(); else folderDialog.setAttribute("open", ""); }
    };
    $("#backup-folder-list").onclick = event => {
      const entry = event.target.closest("[data-folder-path]");
      if (entry) loadServerFolders(entry.dataset.folderPath);
    };
    $("#backup-folder-up").onclick = () => { const parent = $("#backup-folder-up").dataset.parentPath; if (parent) loadServerFolders(parent); };
    $("#use-backup-folder").onclick = () => { $("#backup-schedule-directory").value = selectedServerFolder; closeDialogElement(folderDialog); };
    $("#close-backup-folder").onclick = $("#cancel-backup-folder").onclick = () => closeDialogElement(folderDialog);
    $("#create-save-backup").onclick = createAndSaveBackup;
    renderOffsitePanel();
    $("#restore-from-file").onclick = restoreFromChosenFile;
    container.onclick = async event => {
      const saveButton = event.target.closest("[data-save-backup]");
      if (saveButton) return saveStoredBackup(saveButton.dataset.saveBackup);
      const restoreButton = event.target.closest("[data-restore-server-backup]");
      if (restoreButton) await restoreStoredBackup(restoreButton.dataset.restoreServerBackup);
      const deleteButton = event.target.closest("[data-delete-backup]");
      if (deleteButton) await deleteStoredBackup(deleteButton.dataset.deleteBackup);
    };
  } catch (error) { container.innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}
async function downloadBackupResponse(name) {
  const response = await fetch(`/api/backups/download/${encodeURIComponent(name)}`, { credentials: "same-origin" });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "Could not read the backup file."); }
  return response.blob();
}
async function saveStoredBackup(name) {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Shop Desk SQLite backup", accept: { "application/vnd.sqlite3": [".sqlite3"] } }] });
      const writable = await handle.createWritable(); await writable.write(await downloadBackupResponse(name)); await writable.close();
    } else {
      const link = document.createElement("a"); link.href = `/api/backups/download/${encodeURIComponent(name)}`; link.download = name; link.style.display = "none"; document.body.appendChild(link); link.click(); link.remove();
    }
    toast("Backup saved");
  } catch (error) { if (error.name !== "AbortError") toast(error.message); }
}
async function createAndSaveBackup() {
  let handle;
  try {
    if (window.showSaveFilePicker) handle = await window.showSaveFilePicker({ suggestedName: `shop-${today10()}.sqlite3`, types: [{ description: "Shop Desk SQLite backup", accept: { "application/vnd.sqlite3": [".sqlite3"] } }] });
    const result = await api("/api/backups", { method: "POST", body: "{}" });
    const name = result.created || result.files?.[0]?.name;
    if (!name) throw new Error("The server created no backup file.");
    if (handle) { const writable = await handle.createWritable(); await writable.write(await downloadBackupResponse(name)); await writable.close(); }
    else { const link = document.createElement("a"); link.href = `/api/backups/download/${encodeURIComponent(name)}`; link.download = name; link.style.display = "none"; document.body.appendChild(link); link.click(); link.remove(); }
    toast("Backup created and saved");
    renderBackupManager();
  } catch (error) { if (error.name !== "AbortError") toast(error.message); }
}
function chooseBackupFile() {
  if (window.showOpenFilePicker) return window.showOpenFilePicker({ multiple: false, types: [{ description: "Shop Desk SQLite backup", accept: { "application/vnd.sqlite3": [".sqlite3", ".db"] } }] }).then(handles => handles[0].getFile());
  return new Promise((resolve, reject) => {
    const input = document.createElement("input"); input.type = "file"; input.accept = ".sqlite3,.db,application/vnd.sqlite3"; input.style.display = "none";
    input.onchange = () => { const file = input.files?.[0]; input.remove(); file ? resolve(file) : reject(new DOMException("File selection cancelled", "AbortError")); };
    input.oncancel = () => { input.remove(); reject(new DOMException("File selection cancelled", "AbortError")); };
    document.body.appendChild(input); input.click();
  });
}
async function restoreFromChosenFile() {
  try {
    const file = await chooseBackupFile();
    if (!file.name.toLowerCase().endsWith(".sqlite3") && !file.name.toLowerCase().endsWith(".db")) return toast("Choose a .sqlite3 or .db Shop Desk backup file.");
    if (!confirm(`Restore from “${file.name}”? This replaces the current shop database. The server will make a safety copy first.`)) return;
    const response = await fetch("/api/backups/restore-upload", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: file });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Restore failed.");
    toast("Backup restored. Reloading shop data…"); setTimeout(() => location.reload(), 700);
  } catch (error) { if (error.name !== "AbortError") toast(error.message); }
}
async function restoreStoredBackup(name) {
  if (!confirm(`Restore ${name}? This replaces the current shop database. The server will make a safety copy first.`)) return;
  try { await api("/api/backups/restore", { method: "POST", body: JSON.stringify({ name }) }); toast("Backup restored. Reloading shop data…"); setTimeout(() => location.reload(), 700); }
  catch (error) { toast(error.message); }
}
async function deleteStoredBackup(name) {
  if (!confirm(`Permanently delete backup ${name}? This cannot be undone. Download it first if you may need it later.`)) return;
  try {
    await api(`/api/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
    toast(`Backup ${name} deleted`);
    renderBackupManager();
  } catch (error) { toast(error.message); }
}
$("#fresh-start-button").onclick = async () => {
  if (signedInUser?.username?.toLowerCase() !== "jahangir" || signedInUser?.role !== "admin") return toast("Only the Jahangir administrator can start a fresh setup.");
  if (!confirm("This removes trial products, customers, suppliers, bills, sales, expenses, purchase history, and team accounts. Jahangir’s login is kept. A backup will be created first. Continue?")) return;
  if (prompt("Type FRESH START to confirm clearing this shop’s trial data.") !== "FRESH START") return toast("Fresh start cancelled. The confirmation text did not match.");
  try {
    const result = await api("/api/fresh-start", { method: "POST", body: JSON.stringify({ confirmation: "FRESH START" }) });
    toast(`Fresh setup is ready. Safety backup: ${result.backup}`);
    setTimeout(() => location.reload(), 900);
  } catch (error) { toast(error.message); }
};
async function openTool(key) {
  openModal("Shop tools", `<div class="tool-tabs" id="tool-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div><div id="tool-body"></div><div class="modal-actions" id="tool-actions" style="justify-content:flex-start"></div>`, async () => {});
  dialog.classList.add("wide");
  const submit = $("#submit-modal"); submit.classList.add("hidden");
  dialog.addEventListener("close", () => { dialog.classList.remove("wide"); submit.classList.remove("hidden"); }, { once: true });
  const show = async k => {
    $("#tool-tabs").innerHTML = Object.entries(tools).filter(([, t]) => t.show()).map(([id, t]) => `<button type="button" class="button ${id === k ? "primary" : "secondary"}" data-tool="${id}">${t.label}</button>`).join("");
    $("#tool-body").innerHTML = "<p>Loading…</p>"; $("#tool-actions").innerHTML = "";
    try {
      const out = await tools[k].render(() => show(k));
      $("#tool-body").innerHTML = `<div id="tool-print"><h3>${esc(tools[k].label)}</h3>${out.html}</div>`;
      $("#tool-actions").innerHTML = `${out.csv ? '<button type="button" class="button secondary" id="tool-csv">Download</button>' : ""}<button type="button" class="button secondary" id="tool-print-btn">Print</button>${out.extra || ""}`;
      if (out.csv) $("#tool-csv").onclick = () => saveCsv(`${k}-${today10()}.csv`, out.csv);
      $("#tool-print-btn").onclick = () => printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(tools[k].label)}</title><style>@page{margin:10mm}body{font:12px system-ui,"Segoe UI",sans-serif}table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:5px 7px;text-align:left}th{background:#eee}input,select,a{display:none}</style></head><body><h2>${esc(data.shopName)}</h2>${$("#tool-print").innerHTML}</body></html>`);
      out.after?.();
    } catch (error) { $("#tool-body").innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
  };
  $("#tool-tabs").onclick = event => { const button = event.target.closest("[data-tool]"); if (button) show(button.dataset.tool); };
  show(key);
}
$("#dues-alert").insertAdjacentHTML("afterend", `<div class="table-tools" id="tools-bar" style="margin-bottom:16px">${[["cash", "Cash closing"], ["monthly", "Reports"], ["reorder", "Reorder list"], ["reminders", "Due reminders"], ["activity", "Activity log"]].map(([id, label]) => `<button type="button" class="button secondary" data-tool="${id}">${label}</button>`).join("")}</div>`);
$("#tools-bar").onclick = event => { const button = event.target.closest("[data-tool]"); if (button) openTool(button.dataset.tool); };
const renderBeforeTools = render;
render = function () {
  renderBeforeTools();
  document.querySelectorAll("#tools-bar [data-tool]").forEach(button => button.classList.toggle("hidden", !tools[button.dataset.tool].show()));
};
const supplierMoney = value => {
  try { return new Intl.NumberFormat(data.locale || "en-BD", { style: "currency", currency: data.currencyCode || "BDT", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0)); }
  catch { return `${data.currencyCode || "BDT"} ${Number(value || 0).toFixed(2)}`; }
};
const supplierDate = () => dateKey(new Date());
const canEditSupplierHistory = () => !!signedInUser?.permissions?.supplier_purchases;
function printSupplierRows(title, headers, rows) {
  const tableRows = rows.map(row => `<tr>${row.map(value => `<td>${esc(value)}</td>`).join("")}</tr>`).join("");
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px Arial,sans-serif;color:#222;padding:24px}h1{font-size:20px;margin:0 0 6px}p{color:#555;margin:0 0 18px}table{width:100%;border-collapse:collapse}th,td{text-align:left;border:1px solid #bbb;padding:8px}th{background:#eee}tfoot{font-weight:bold}@media print{body{padding:0}}</style></head><body><h1>${esc(title)}</h1><p>${esc(data.shopName || "Shop Desk")} · Printed ${new Date().toLocaleString("en-BD")}</p>${rows.length ? `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table>` : "<p>No records to print.</p>"}</body></html>`);
}
function supplierModal(title, markup, onSave) {
  openModal(title, markup, onSave);
  dialog.classList.add("wide", "supplier-editor");
  $("#submit-modal").classList.remove("hidden");
  dialog.addEventListener("close", () => { dialog.classList.remove("wide", "supplier-editor"); $("#submit-modal").classList.remove("hidden"); $("#submit-modal").textContent = "Save"; }, { once: true });
}
async function openSupplierHub() {
  if (!data.permissions?.inventory && !data.permissions?.supplier_purchases) return toast("Supplier history access is required.");
  try {
    const [{ suppliers }, { purchases, movements, payments }] = await Promise.all([api("/api/suppliers"), api("/api/purchases")]);
    const canEdit = canEditSupplierHistory();
    const canRecord = !!data.permissions?.inventory;
    const supplierRows = suppliers.length ? suppliers.map(s => `<tr><td><b>${esc(s.name)}</b>${s.phone ? `<br><small>${esc(s.phone)}</small>` : ""}</td><td>${supplierMoney(s.opening_balance)}</td><td>${supplierMoney(s.total_bought)}</td><td>${supplierMoney(s.total_paid)}</td><td><b>${supplierMoney(s.balance)}</b></td><td>${canRecord && Number(s.balance) > 0 ? `<button type="button" class="user-action" data-supplier-pay="${s.id}" data-supplier-name="${esc(s.name)}" data-balance="${s.balance}">Pay supplier</button>` : "—"}${canEdit ? `<button type="button" class="user-action" data-edit-supplier="${s.id}">Edit</button>` : ""}</td></tr>`).join("") : '<tr><td colspan="6" class="empty">Add a supplier to start recording purchases.</td></tr>';
    const purchaseRows = purchases.length ? purchases.map(p => `<tr data-history-supplier="${p.supplier_id}"><td><input type="checkbox" aria-label="Select purchase P-${String(p.id).padStart(8, "0")}" data-select-purchase="${p.id}"></td><td>P-${String(p.id).padStart(8, "0")}</td><td>${esc(p.date)}</td><td>${esc(p.supplier_name)}</td><td>${p.line_count} items <button type="button" class="user-action" aria-expanded="false" data-toggle-purchase="${p.id}">View products</button></td><td><b>${supplierMoney(p.total)}</b></td><td>${esc(p.reference || "—")}</td><td>${esc(p.created_by || "")}</td><td><button type="button" class="user-action" data-print-purchase="${p.id}">Print list</button>${canEdit ? `<button type="button" class="user-action" data-edit-purchase="${p.id}">Edit</button>` : ""}</td></tr><tr class="purchase-detail-row hidden" data-history-supplier="${p.supplier_id}" data-purchase-detail="${p.id}"><td colspan="9"><div class="purchase-detail"><b>Products bought from ${esc(p.supplier_name)}</b>${p.items?.length ? `<div class="table-scroll"><table><thead><tr><th>Product</th><th>Quantity</th><th>Unit cost</th><th>Line total</th>${data.shopType === "pharmacy" && featureEnabled("pharmacy") ? "<th>Batch / lot</th><th>Expiry</th>" : ""}</tr></thead><tbody>${p.items.map(item => `<tr><td>${esc(item.productName)}</td><td>${Number(item.qty)} ${esc(item.unit || "piece")}</td><td>${supplierMoney(item.cost)}</td><td>${supplierMoney(Number(item.qty) * Number(item.cost))}</td>${data.shopType === "pharmacy" && featureEnabled("pharmacy") ? `<td>${esc(item.batchNumber || "Not recorded")}</td><td>${esc(item.expiryDate || "Not recorded")}</td>` : ""}</tr>`).join("")}</tbody></table></div>` : `<p class="form-hint">Product details are unavailable for this older purchase.</p>`}</div></td></tr>`).join("") : '<tr><td colspan="9" class="empty">No purchases recorded yet.</td></tr>';
    const movementRows = movements.length ? movements.map(m => `<tr><td>${esc(m.at)}</td><td>${esc(m.product_name)}</td><td>${esc(m.kind)}</td><td>${Number(m.quantity_change) > 0 ? "+" : ""}${Number(m.quantity_change)} ${esc(m.unit)}</td><td>${Number(m.quantity_after)} ${esc(m.unit)}</td><td>${esc(m.reference || "—")}</td><td>${esc(m.actor || "")}</td></tr>`).join("") : '<tr><td colspan="7" class="empty">New stock movements will appear here.</td></tr>';
    const paymentRows = payments.length ? payments.map(p => `<tr data-history-supplier="${p.supplier_id}"><td><input type="checkbox" aria-label="Select supplier payment ${p.id}" data-select-payment="${p.id}"></td><td>${esc(p.date)}</td><td>${esc(p.supplier_name)}</td><td>${esc(p.method)}</td><td><b>${supplierMoney(p.amount)}</b></td><td>${esc(p.note || "—")}</td><td>${esc(p.received_by || "")}</td><td><button type="button" class="user-action" data-print-payment="${p.id}">Print</button>${canEdit ? `<button type="button" class="user-action" data-edit-payment="${p.id}">Edit</button>` : ""}</td></tr>`).join("") : '<tr><td colspan="8" class="empty">No supplier payments recorded yet.</td></tr>';
    supplierModal("Suppliers & purchases", `<div class="supplier-actions">${canRecord ? `<button type="button" class="button secondary" id="supplier-add">＋ Add supplier</button><button type="button" class="button primary" id="purchase-add" ${suppliers.length ? "" : "disabled"}>＋ Record purchase</button>` : ""}</div>
      <h3>Supplier balances</h3><div class="table-scroll supplier-table"><table><thead><tr><th>Supplier</th><th>Opening due</th><th>Purchases</th><th>Paid</th><th>Balance due</th><th></th></tr></thead><tbody>${supplierRows}</tbody></table></div>
      <label class="supplier-history-filter">Filter history by supplier<select id="supplier-history-filter"><option value="all">All suppliers</option>${suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label>
      <h3>Purchase history</h3><div class="supplier-actions"><button type="button" class="button secondary" data-print-selected="purchase">Print selected</button><button type="button" class="button secondary" data-print-all="purchase">Print all shown</button></div><div class="table-scroll supplier-table"><table><thead><tr><th><input type="checkbox" id="select-all-purchases" aria-label="Select all purchases"></th><th>Purchase</th><th>Date</th><th>Supplier</th><th>Lines</th><th>Total</th><th>Reference</th><th>Recorded by</th><th>Actions</th></tr></thead><tbody id="supplier-purchase-history">${purchaseRows}</tbody></table></div>
      <h3>Supplier payment history</h3><div class="supplier-actions"><button type="button" class="button secondary" data-print-selected="payment">Print selected</button><button type="button" class="button secondary" data-print-all="payment">Print all shown</button></div><div class="table-scroll supplier-table"><table><thead><tr><th><input type="checkbox" id="select-all-payments" aria-label="Select all supplier payments"></th><th>Date</th><th>Supplier</th><th>Method</th><th>Amount</th><th>Note</th><th>Recorded by</th><th>Actions</th></tr></thead><tbody id="supplier-payment-history">${paymentRows}</tbody></table></div>
      <h3>Stock movement history</h3><p class="form-hint">New purchases, sales, and stock corrections are recorded here. Older activity is not reconstructed.</p><div class="table-scroll supplier-table movement-table"><table><thead><tr><th>When</th><th>Product</th><th>Reason</th><th>Change</th><th>Stock after</th><th>Reference</th><th>By</th></tr></thead><tbody>${movementRows}</tbody></table></div>`, async () => {});
    $("#submit-modal").classList.add("hidden");
    if (canRecord) $("#supplier-add").onclick = () => supplierModal("Add supplier", `<label>Supplier name<input name="name" maxlength="120" required></label><label>Phone<input name="phone" maxlength="40" inputmode="tel"></label><label>Address or market location<input name="address" maxlength="300"></label><label>Existing balance owed (৳)<input name="openingBalance" type="number" min="0" step="0.01" value="0" required><small class="form-hint">Use this for an unpaid balance from before you started using the app.</small></label>`, async form => {
      await api("/api/suppliers", { method: "POST", body: JSON.stringify({ name: form.get("name"), phone: form.get("phone"), address: form.get("address"), openingBalance: Number(form.get("openingBalance")) }) });
      toast("Supplier added"); await openSupplierHub(); return false;
    });
    if (canRecord) $("#purchase-add").onclick = () => openPurchaseEntry(suppliers);
    dialog.querySelectorAll("[data-edit-supplier]").forEach(button => button.onclick = () => {
      const supplier = suppliers.find(item => item.id === Number(button.dataset.editSupplier));
      supplierModal("Edit supplier", `<label>Supplier name<input name="name" maxlength="120" value="${esc(supplier.name)}" required></label><label>Phone<input name="phone" maxlength="40" inputmode="tel" value="${esc(supplier.phone || "")}"></label><label>Address or market location<input name="address" maxlength="300" value="${esc(supplier.address || "")}"></label><label>Opening balance still owed (৳)<input name="openingBalance" type="number" min="0" step="0.01" value="${Number(supplier.opening_balance)}" required></label>`, async form => {
        await api(`/api/suppliers/${supplier.id}`, { method: "PATCH", body: JSON.stringify({ name: form.get("name"), phone: form.get("phone"), address: form.get("address"), openingBalance: Number(form.get("openingBalance")) }) });
        toast("Supplier updated"); await openSupplierHub(); return false;
      });
    });
    document.querySelectorAll("[data-supplier-pay]").forEach(button => button.onclick = () => {
      const supplier = suppliers.find(item => item.id === Number(button.dataset.supplierPay));
      if (!supplier) return;
      supplierModal(`Pay ${supplier.name}`, `<p>Outstanding balance: <b>${supplierMoney(supplier.balance)}</b></p><label>Date<input name="date" type="date" value="${supplierDate()}" required></label><label>Amount (৳)<input name="amount" type="number" min="0.01" max="${Number(supplier.balance)}" step="0.01" required></label><label>Payment method<select name="method"><option>Cash</option><option>bKash</option><option>Nagad</option><option>Bank</option><option>Other</option></select></label><label>Note<input name="note" maxlength="500"></label>`, async form => {
        await api(`/api/suppliers/${supplier.id}/payments`, { method: "POST", body: JSON.stringify({ date: form.get("date"), amount: Number(form.get("amount")), method: form.get("method"), note: form.get("note") }) });
        toast("Supplier payment recorded"); await openSupplierHub(); return false;
      });
    });
    $("#supplier-history-filter").onchange = event => document.querySelectorAll("[data-history-supplier]").forEach(row => { row.classList.toggle("supplier-filtered-out", event.target.value !== "all" && row.dataset.historySupplier !== event.target.value); });
    $("#select-all-purchases").onchange = event => document.querySelectorAll("[data-select-purchase]").forEach(box => { if (!box.closest("tr").classList.contains("supplier-filtered-out")) box.checked = event.target.checked; });
    $("#select-all-payments").onchange = event => document.querySelectorAll("[data-select-payment]").forEach(box => { if (!box.closest("tr").classList.contains("supplier-filtered-out")) box.checked = event.target.checked; });
    dialog.querySelectorAll("[data-toggle-purchase]").forEach(button => button.onclick = () => {
      const details = dialog.querySelector(`[data-purchase-detail="${button.dataset.togglePurchase}"]`);
      const opening = details.classList.contains("hidden");
      details.classList.toggle("hidden", !opening);
      button.setAttribute("aria-expanded", String(opening));
      button.textContent = opening ? "Hide products" : "View products";
    });
    const purchasePrintRows = list => list.flatMap(p => (p.items || []).length
      ? p.items.map(item => [`P-${String(p.id).padStart(8, "0")}`, p.date, p.supplier_name, item.productName, `${item.qty} ${item.unit}`, supplierMoney(item.cost), supplierMoney(Number(item.qty) * Number(item.cost)), p.reference || "—"])
      : [[`P-${String(p.id).padStart(8, "0")}`, p.date, p.supplier_name, "Item details unavailable", "—", "—", supplierMoney(p.total), p.reference || "—"]]);
    const paymentPrintRows = list => list.map(p => [p.date, p.supplier_name, p.method, supplierMoney(p.amount), p.note || "—", p.received_by || ""]);
    const printRecord = (type, records) => type === "purchase"
      ? printSupplierRows("Supplier purchase history", ["Purchase", "Date", "Supplier", "Product", "Quantity", "Unit cost", "Line total", "Reference"], purchasePrintRows(records))
      : printSupplierRows("Supplier payment history", ["Date", "Supplier", "Method", "Amount", "Note", "Recorded by"], paymentPrintRows(records));
    dialog.querySelectorAll("[data-print-selected], [data-print-all]").forEach(button => button.onclick = () => {
      const type = button.dataset.printSelected || button.dataset.printAll;
      const records = type === "purchase" ? purchases : payments;
      const selector = type === "purchase" ? "[data-select-purchase]" : "[data-select-payment]";
      const selected = button.hasAttribute("data-print-selected");
      const checkboxes = [...dialog.querySelectorAll(selector)].filter(box => !box.closest("tr").classList.contains("supplier-filtered-out"));
      const ids = selected ? checkboxes.filter(box => box.checked).map(box => Number(box.dataset[type === "purchase" ? "selectPurchase" : "selectPayment"])) : checkboxes.map(box => Number(box.dataset[type === "purchase" ? "selectPurchase" : "selectPayment"]));
      if (selected && !ids.length) return toast("Select at least one history row to print.");
      printRecord(type, records.filter(record => ids.includes(record.id)));
    });
    dialog.querySelectorAll("[data-print-purchase]").forEach(button => button.onclick = () => printRecord("purchase", purchases.filter(p => p.id === Number(button.dataset.printPurchase))));
    dialog.querySelectorAll("[data-print-payment]").forEach(button => button.onclick = () => printRecord("payment", payments.filter(p => p.id === Number(button.dataset.printPayment))));
    dialog.querySelectorAll("[data-edit-purchase]").forEach(button => button.onclick = () => {
      const purchase = purchases.find(p => p.id === Number(button.dataset.editPurchase));
      if (!(data.shopType === "pharmacy" && featureEnabled("pharmacy")) && purchase.items?.length && purchase.items.every(item => item.productId && data.products.some(product => product.id === item.productId))) return openPurchaseEntry(suppliers, purchase);
      supplierModal(`Edit purchase P-${String(purchase.id).padStart(8, "0")}`, `<label>Purchase date<input name="date" type="date" value="${esc(purchase.date)}" required></label><label>Invoice / reference<input name="reference" maxlength="100" value="${esc(purchase.reference || "")}"></label><label>Note<input name="note" maxlength="500" value="${esc(purchase.note || "")}"></label><p class="form-hint">${data.shopType === "pharmacy" && featureEnabled("pharmacy") ? "The Pharmacy receipt and its batch/expiry history are preserved. Only date, reference, and note can be corrected here." : "The original item was removed or cannot be matched, so only purchase details can be edited."}</p>`, async form => {
        await api(`/api/purchases/${purchase.id}`, { method: "PATCH", body: JSON.stringify({ date: form.get("date"), reference: form.get("reference"), note: form.get("note") }) });
        toast("Purchase details updated"); await openSupplierHub(); return false;
      });
    });
    dialog.querySelectorAll("[data-edit-payment]").forEach(button => button.onclick = () => {
      const payment = payments.find(p => p.id === Number(button.dataset.editPayment));
      const supplier = suppliers.find(s => s.id === payment.supplier_id);
      const maxAmount = Number(payment.amount) + Number(supplier?.balance || 0);
      supplierModal("Edit supplier payment", `<label>Date<input name="date" type="date" value="${esc(payment.date)}" required></label><label>Amount (৳)<input name="amount" type="number" min="0.01" max="${maxAmount}" step="0.01" value="${Number(payment.amount)}" required></label><label>Payment method<select name="method">${["Cash", "bKash", "Nagad", "Bank", "Other", payment.method].filter((v, i, a) => a.indexOf(v) === i).map(m => `<option ${m === payment.method ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label><label>Note<input name="note" maxlength="500" value="${esc(payment.note || "")}"></label>`, async form => {
        await api(`/api/supplier-payments/${payment.id}`, { method: "PATCH", body: JSON.stringify({ date: form.get("date"), amount: Number(form.get("amount")), method: form.get("method"), note: form.get("note") }) });
        toast("Supplier payment updated"); await openSupplierHub(); return false;
      });
    });
  } catch (error) { toast(error.message); }
}
function openPurchaseEntry(suppliers, editing = null) {
  const supplierOptions = suppliers.map(s => `<option value="${s.id}">${esc(s.name)} · due ${supplierMoney(s.balance)}</option>`).join("");
  const productOptions = (selectedId = 0) => data.products.map(p => `<option value="${p.id}" data-cost="${Number(p.cost)}" ${p.id === Number(selectedId) ? "selected" : ""}>${esc(productLabel(p))} · ${esc(p.unit || "piece")} · stock ${Number(p.qty)}</option>`).join("");
  const row = (item = {}) => `<tr><td><select class="purchase-product" required><option value="">Select product</option>${productOptions(item.productId)}</select>${data.shopType === "pharmacy" && featureEnabled("pharmacy") ? `<div class="pharmacy-purchase-batch"><label>Batch / lot<input class="purchase-batch" maxlength="80" value="${esc(item.batchNumber || "")}" required></label><label>Expiry<input class="purchase-expiry" type="date" value="${esc(item.expiryDate || "")}" required></label></div>` : ""}</td><td><input class="purchase-qty" type="number" min="0.001" step="any" value="${Number(item.qty ?? 1)}" required></td><td><input class="purchase-cost" type="number" min="0" step="0.01" value="${Number(item.cost ?? 0)}" required></td><td class="purchase-line-total">৳0.00</td><td><button type="button" class="user-action danger purchase-remove">Remove</button></td></tr>`;
  const lines = editing?.items?.length ? editing.items : [{}];
  const supplierField = editing
    ? `<label>Supplier<input value="${esc(editing.supplier_name)}" disabled></label>`
    : `<label>Supplier<select name="supplierId" required><option value="">Choose supplier</option>${supplierOptions}</select></label>`;
  const paymentFields = editing
    ? `<p class="form-hint">Existing payments are kept in payment history. Stock is adjusted for item changes, and the item's current average cost is recalculated where enough stock remains.</p>`
    : `<div class="form-row supplier-purchase-payment"><label>Paid now (৳)<input name="paid" type="number" min="0" step="0.01" value="0" required></label><label>Payment method<select name="method"><option>Cash</option><option>bKash</option><option>Nagad</option><option>Bank</option><option>Other</option></select></label></div>`;
  supplierModal(editing ? `Edit purchase P-${String(editing.id).padStart(8, "0")}` : "Record supplier purchase", `${supplierField}<div class="form-row"><label>Purchase date<input name="date" type="date" value="${esc(editing?.date || supplierDate())}" required></label><label>Invoice / reference<input name="reference" maxlength="100" value="${esc(editing?.reference || "")}"></label></div><div class="table-scroll purchase-lines"><table><thead><tr><th>Product ${data.shopType === "pharmacy" && featureEnabled("pharmacy") ? "· Batch / expiry" : ""}</th><th>Quantity</th><th>Cost per unit (৳)</th><th>Line total</th><th></th></tr></thead><tbody id="purchase-lines">${lines.map(row).join("")}</tbody></table></div><button type="button" class="button secondary" id="purchase-line-add">＋ Add item</button>${paymentFields}<label>Note<input name="note" maxlength="500" value="${esc(editing?.note || "")}"></label><div class="bill-total"><span>Purchase total <b id="purchase-total">৳0.00</b></span>${editing ? "" : `<span>Due added <b id="purchase-due">৳0.00</b></span>`}</div>`, async form => {
    const items = [...document.querySelectorAll("#purchase-lines tr")].map(tr => ({ productId: Number(tr.querySelector(".purchase-product").value), qty: Number(tr.querySelector(".purchase-qty").value), cost: Number(tr.querySelector(".purchase-cost").value), batchNumber: tr.querySelector(".purchase-batch")?.value.trim() || "", expiryDate: tr.querySelector(".purchase-expiry")?.value || "" }));
    if (items.some(i => !i.productId || !(i.qty > 0) || !(i.cost >= 0))) throw new Error("Choose each product and enter a valid quantity and cost.");
    if (data.shopType === "pharmacy" && featureEnabled("pharmacy") && items.some(i => !i.batchNumber || !i.expiryDate)) throw new Error("Every Pharmacy purchase needs a batch number and expiry date.");
    const payload = { date: form.get("date"), reference: form.get("reference"), note: form.get("note"), items };
    const result = await api(editing ? `/api/purchases/${editing.id}` : "/api/purchases", { method: editing ? "PATCH" : "POST", body: JSON.stringify(editing ? payload : { ...payload, supplierId: Number(form.get("supplierId")), paid: Number(form.get("paid")), method: form.get("method") }) });
    data = await api("/api/state"); render(); toast(editing ? "Purchase and stock updated" : `Purchase P-${String(result.id).padStart(8, "0")} saved; stock updated`); await openSupplierHub(); return false;
  });
  if (editing) $("#submit-modal").textContent = "Save changes";
  const updateTotals = () => {
    let total = 0;
    document.querySelectorAll("#purchase-lines tr").forEach(tr => {
      const qty = Number(tr.querySelector(".purchase-qty").value) || 0, cost = Number(tr.querySelector(".purchase-cost").value) || 0, line = qty * cost;
      tr.querySelector(".purchase-line-total").textContent = supplierMoney(line); total += line;
    });
    const paid = Number($("[name=paid]")?.value) || 0;
    $("#purchase-total").textContent = supplierMoney(total);
    if ($("#purchase-due")) $("#purchase-due").textContent = supplierMoney(Math.max(0, total - paid));
  };
  $("#purchase-line-add").onclick = () => { $("#purchase-lines").insertAdjacentHTML("beforeend", row()); updateTotals(); };
  $("#purchase-lines").oninput = event => { if (event.target.matches(".purchase-qty,.purchase-cost")) updateTotals(); };
  $("#purchase-lines").onchange = event => {
    if (event.target.matches(".purchase-product")) { const cost = event.target.selectedOptions[0]?.dataset.cost; if (cost !== undefined) event.target.closest("tr").querySelector(".purchase-cost").value = cost; updateTotals(); }
  };
  $("#purchase-lines").onclick = event => { if (event.target.closest(".purchase-remove")) { if (document.querySelectorAll("#purchase-lines tr").length > 1) event.target.closest("tr").remove(); else toast("A purchase needs at least one item."); updateTotals(); } };
  const paidInput = $("[name=paid]");
  if (paidInput) paidInput.oninput = updateTotals;
  updateTotals();
}
async function openPharmacyBatchManager() {
  if (data.shopType !== "pharmacy" || !featureEnabled("pharmacy")) return toast("Pharmacy batches require a Pharmacy licence.");
  if (!data.permissions?.inventory) return toast("Inventory access is required to manage medicine batches.");
  try {
    data = await api("/api/state");
    const { today: dateToday, cutoff } = await api("/api/pharmacy/expiry");
    const todayValue = dateToday || dateKey(new Date());
    const batches = data.pharmacyBatches || [];
    const expiryState = batch => {
      if (!batch.expiry_date) return { label: "Expiry needs review", css: "out" };
      if (batch.expiry_date < todayValue) return { label: "Expired", css: "out" };
      if (batch.expiry_date <= cutoff) return { label: "Expiring soon", css: "low" };
      return { label: "In date", css: "" };
    };
    const unknown = batches.filter(batch => !batch.expiry_date && Number(batch.quantity_remaining) > 0).length;
    const expired = batches.filter(batch => batch.expiry_date && batch.expiry_date < todayValue && Number(batch.quantity_remaining) > 0).length;
    const soon = batches.filter(batch => batch.expiry_date && batch.expiry_date >= todayValue && batch.expiry_date <= cutoff && Number(batch.quantity_remaining) > 0).length;
    const rows = batches.length ? batches.map(batch => {
      const status = expiryState(batch);
      return `<tr><td><b>${esc(batch.product_name)}</b><small class="form-hint">${esc(batch.generic_name || "")}</small></td><td>${esc(batch.batch_number)}</td><td>${batch.expiry_date ? esc(batch.expiry_date) : "Unknown — review lot label"}</td><td>${Number(batch.quantity_remaining)} ${esc(batch.product_unit || "piece")}</td><td>${Number(batch.sellable_quantity || 0)} ${esc(batch.product_unit || "piece")}</td><td><span class="status ${status.css}">${status.label}</span></td><td><button type="button" class="user-action" data-edit-pharmacy-batch="${batch.id}">Correct batch / expiry</button></td></tr>`;
    }).join("") : '<tr><td colspan="7" class="empty">No medicine batches recorded. Add a medicine or receive the first batch.</td></tr>';
    openModal("Medicine batches & expiry", `<div class="pharmacy-batch-toolbar"><div><b>${batches.length} recorded batches</b><p class="form-hint">Sales use earliest-expiring eligible stock first. Expired, unknown-expiry, and returned/quarantined units are not sellable.</p></div><button type="button" class="button primary" id="pharmacy-receive-batch">＋ Receive batch</button></div><div class="pharmacy-expiry-summary"><div><b>${expired}</b><span>Expired lots with stock</span></div><div><b>${soon}</b><span>Expiring within 90 days</span></div><div><b>${unknown}</b><span>Need expiry verification</span></div></div><div class="table-scroll supplier-table"><table><thead><tr><th>Medicine</th><th>Batch / lot</th><th>Expiry date</th><th>Remaining</th><th>Sellable</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>`, async () => {});
    $("#submit-modal").classList.add("hidden");
    $("#pharmacy-receive-batch").onclick = () => { closeModal(); openPharmacyReceiveBatch(); };
    dialog.querySelectorAll("[data-edit-pharmacy-batch]").forEach(button => button.onclick = () => {
      const batch = batches.find(item => Number(item.id) === Number(button.dataset.editPharmacyBatch));
      if (!batch) return toast("Medicine batch not found. Refresh and try again.");
      closeModal();
      openPharmacyEditBatch(batch);
    });
  } catch (error) { toast(error.message); }
}
function openPharmacyReceiveBatch() {
  const products = (data.products || []).filter(product => product.id);
  if (!products.length) return toast("Add a medicine before receiving stock.");
  const options = products.map(product => `<option value="${product.id}">${esc(product.name)} · ${esc(product.unit || "piece")} · current ${Number(product.qty || 0)}</option>`).join("");
  openModal("Receive medicine batch", `<label>Medicine<select name="productId" required><option value="">Choose medicine</option>${options}</select></label><div class="form-row"><label>Batch / lot number<input name="batchNumber" maxlength="80" required placeholder="As printed on the pack"></label><label>Expiry date<input name="expiryDate" type="date" required></label></div><div class="form-row"><label>Quantity received<input name="quantity" type="number" min="0.001" step="any" required></label><label>Unit purchase cost (${esc(currencySymbol())})<input name="unitCost" type="number" min="0" step="0.01" required></label></div><p class="form-hint">Use the exact batch number and expiry printed by the manufacturer. For repeated receipts of the same batch, use the same batch number and expiry.</p>`, async form => {
    const result = await api("/api/pharmacy/batches", { method: "POST", body: JSON.stringify({ productId: Number(form.get("productId")), batchNumber: form.get("batchNumber").trim(), expiryDate: form.get("expiryDate"), quantity: Number(form.get("quantity")), unitCost: Number(form.get("unitCost")) }) });
    data = result;
    render();
    toast("Medicine batch received; stock and expiry are recorded.");
  });
}
function openPharmacyEditBatch(batch) {
  openModal("Correct medicine batch / expiry", `<p><b>${esc(batch.product_name)}</b></p><label>Batch / lot number<input name="batchNumber" maxlength="80" value="${esc(batch.batch_number)}" required></label><label>Expiry date<input name="expiryDate" type="date" value="${esc(batch.expiry_date || "")}" required></label><p class="form-hint">Confirm the value against the manufacturer's packaging before saving. Unknown-expiry legacy stock stays unavailable until verified.</p>`, async form => {
    const result = await api(`/api/pharmacy/batches/${batch.id}`, { method: "PATCH", body: JSON.stringify({ batchNumber: form.get("batchNumber").trim(), expiryDate: form.get("expiryDate") }) });
    data = result;
    render();
    toast("Medicine batch details updated.");
  });
}

const renderBeforeSupplierTools = render;
render = function () {
  renderBeforeSupplierTools();
  $("#supplier-tools").classList.toggle("hidden", !data.permissions?.inventory && !data.permissions?.supplier_purchases);
};
$("#supplier-tools").onclick = openSupplierHub;
$("#pharmacy-batches-button").onclick = openPharmacyBatchManager;
// ---- Installable app (PWA) and the "connect a phone" page ----
let installPrompt = null;
function setupInstallButton() {
  const actions = document.querySelector(".top-actions");
  if (!actions || $("#install-app")) return;
  const button = document.createElement("button");
  button.type = "button"; button.id = "install-app";
  button.className = "button secondary hidden"; button.textContent = t("Install app");
  actions.prepend(button);
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    button.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.classList.add("hidden");
    toast("Shop Desk was added to this device.");
  });
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch { /* the user dismissed the prompt */ }
    installPrompt = null;
    button.classList.add("hidden");
  });
}
function setupJoinLink() {
  const bottom = document.querySelector(".sidebar-bottom");
  if (!bottom || $("#join-link")) return;
  const link = document.createElement("a");
  link.id = "join-link"; link.className = "join-link";
  link.href = "/join"; link.target = "_blank"; link.rel = "noopener";
  link.innerHTML = `<span aria-hidden="true">▦</span> ${esc(t("Connect a phone"))}`;
  bottom.appendChild(link);
}
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const secure = location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!secure) return; // browsers only allow service workers on HTTPS or localhost
  navigator.serviceWorker.register("/sw.js").catch(() => { /* offline caching is optional */ });
}
setupInstallButton();
setupJoinLink();
registerServiceWorker();

startApp();
