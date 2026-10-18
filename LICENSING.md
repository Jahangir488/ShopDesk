# Licence keys — the USB kit

Shop Desk is sold as a yearly plan. Every installation starts with a **30-day trial**,
and a **licence key** unlocks it for 365 days. This page explains how to make those keys
on a shop PC with the portable **licence kit** on a USB stick — and how to keep the
private signing key away from customers.

Bengali instructions: [নিচে দেখুন](#বাংলা).

---

## 1. How the licence works

| State | What the shop sees |
| --- | --- |
| **Trial** | 30 days from the first start. Everything works. A banner appears in the last 7 days. |
| **Active** | The key is valid: plan name, shop name and days left in **Shop settings → Licence & plan**. |
| **Expiring** | Last 7 days before expiry: yellow banner with the date, on every screen. |
| **Expired / read-only** | New bills and edits are blocked (HTTP 402). Viewing, reports, exports, local backups and Google Drive backups keep working. Enter a new key to unlock. |

A key can be:

- **Locked** (default) — works only on the PC whose **Installation ID** was used when it
  was made. The Installation ID is shown in **Shop settings → Licence & plan** and can be
  copied with the **Copy** button. The short form (`abcd-1234-5678`) is enough.
- **Not locked** (`--no-lock`) — works on any PC. Use it only when you cannot reach the
  shop PC, for example by sending the key on WhatsApp.

Keys are **Ed25519-signed** and checked offline. Nothing is sent to a server, so the shop
works without internet.

---

## 2. Build the kit once, on your own PC

Double-click **`3 - Build Licence Kit.bat`** in the Shop Desk source folder on your supplier PC. If no signing key exists yet, the one-click file asks you to confirm that you are on the supplier PC and have issued no paid keys, creates the key pair, and opens the public-key file. Send only `lib/license-public.mjs` to Shop Desk support and wait for the matching app update before building or issuing keys. Never send `vendor/license-private-key.pem`.

After the matching public-key app update is installed at the shop, double-click **`3 - Build Licence Kit.bat`** again. It builds `releases/ShopDesk-Licence-Kit`. Or from a terminal:

```bash
npm run license:keygen     # only the first time, on the supplier PC
npm run licence:kit        # creates releases/ShopDesk-Licence-Kit
```

`npm run licence:kit` copies the parts a shop PC needs into
`releases/ShopDesk-Licence-Kit`:

```
ShopDesk-Licence-Kit\
  Make Licence Key.bat        <- double-click this at the shop
  Make License Key.bat        <- same, US spelling
  Licence Kit Check.bat       <- confirms the kit matches the installed app
  licence-kit.mjs
  lib\license.mjs
  lib\license-public.mjs
  private\license-private-key.pem   <- SECRET, never leave this behind
  licences\                   <- receipts are written here
  README.txt
```

Copy that **whole folder** to an encrypted USB stick (BitLocker To Go on Windows).
You can also build it straight onto the stick:

```bash
npm run licence:kit -- --usb E:\
```

The builder refuses to run if `vendor/license-private-key.pem` is missing, or if the
private key does not match `lib/license-public.mjs` — keys made with a mismatched key
would be rejected by every installation.

> If you create a **new** key pair, every Shop Desk installed earlier will reject the new
> keys. Only do it when starting a fresh deployment, and rebuild the installer too.

---

## 3. At the shop (the usual way)

1. Plug the USB stick into the shop PC.
2. Open `X:\ShopDesk-Licence-Kit` and double-click **`Make Licence Key.bat`**.
3. Answer the prompts:

   ```
   Shop name: Karim Hardware
   Days [365]:        <- press Enter
   Lock this key to THIS PC only? (Y/n) [Y]:   <- press Enter
   ```

   The tool finds Shop Desk automatically, reads the **Installation ID** from its
   database, signs the key, saves a receipt in `licences\`, appends a row to
   `licences.csv`, copies the key to the clipboard and opens Shop Desk in the browser.
4. In Shop Desk go to **Shop settings → Licence & plan**, paste with **Ctrl+V** and press
   **Activate**. The screen shows **Activated** with the expiry date.
5. Close the app window, then **unplug the USB stick**.

Nothing is installed on the shop PC. The only trace is the licence row inside the shop's
own database — the private key never leaves the stick.

### If Shop Desk is not found

The kit looks at `%ProgramData%\ShopDesk\install.json` (written by the installer), then
the `SHOP_INSTALL_DIR` variable, then `C:\ShopDesk` … `Z:\ShopDesk`. If the shop folder
has a different name, pass it:

```bat
Make Licence Key.bat --install "E:\ShopDesk"
```

### Check the kit before you travel

```bat
Licence Kit Check.bat
```

It verifies the private key, the public key inside the kit and the Shop Desk installed on
that PC. A `MISMATCH` line means the kit and the installed app come from different
versions — rebuild the kit from the same folder that built the installer.

---

## 4. Renewal

Seven days before expiry a banner appears on every screen. At the shop:

1. Run **`Make Licence Key.bat`** again with the same shop name.
2. Paste the new key into **Licence & plan** and press **Activate**. It replaces the old
   key; the new expiry date appears immediately.

If you want the renewal to end on a fixed date (for example, every January), use:

```bat
Make Licence Key.bat --expires 2027-01-31
```

`licences.csv` lists every key you have made: date, shop, plan, days, expiry, the
installation it is locked to, and the receipt file. Open it in Excel to see who expires
next month.

---

## 5. Remote keys (no USB visit)

```bat
Make Licence Key.bat --no-lock
```

or answer **n** to the lock question. The key works on any PC, so you can send it to the
shop. The trade-off: if the shop copies their `data` folder to another PC, that copy is
also licensed. Use locked keys whenever you can visit.

---

## 6. Safety rules

- The kit contains your **private signing key**: anyone who copies it can make unlimited
  licence keys. Keep the stick with you or locked away, and keep a second, offline backup.
- **Never** put the kit inside a Shop Desk folder, a release zip or a Git repository.
  The tool refuses to run when it finds itself inside an installation folder.
- Never email or WhatsApp the folder. Send only the `SD1.…` key text.
- The Windows and Linux installers skip `vendor\`, `private\`, `licences\`, `*.pem` and
  `licences.csv`, so a build folder can be installed without copying the secret.
- If the stick is lost: stop using that key pair. Run `npm run license:keygen` on your PC,
  rebuild the installer and the kit, and reissue keys — old keys will no longer validate.

---

## 7. Commands

```bat
Make Licence Key.bat                         ask for the shop name, 365 days, locked
Make Licence Key.bat --no-lock               key that works on any PC
Make Licence Key.bat --days 365              length in days (default 365)
Make Licence Key.bat --expires 2027-01-31    renew to a fixed date
Make Licence Key.bat --install-id 1234-abcd-5678
Make Licence Key.bat --install "E:\ShopDesk" find the shop folder by hand
Make Licence Key.bat --list                  show every key issued from this kit
Make Licence Key.bat --check                 check the kit and the installed app
Make Licence Key.bat --shop "X" --yes        no prompts (scripts)
```

Exit codes: `0` success, `1` missing input or key file, `2` wrong kit for this PC
(kit inside the installation, different public key, private key does not match).

---

## বাংলা

### লাইসেন্স কী কীভাবে কাজ করে

- নতুন ইনস্টলে **৩০ দিনের ট্রায়াল**। শেষ ৭ দিনে সতর্কবার্তা দেখায়।
- মেয়াদ শেষে অ্যাপ **রিড-অনলি**: নতুন বিল বা পরিবর্তন বন্ধ, কিন্তু দেখা, রিপোর্ট, এক্সপোর্ট
  ও ব্যাকআপ চলতে থাকে। নতুন কী দিলেই আবার চালু।
- কী **Ed25519** দিয়ে সাইন করা, ইন্টারনেট ছাড়াই যাচাই হয়।
- **লক করা কী** (ডিফল্ট) শুধু ওই পিসিতে চলে, Installation ID মিললে। **আনলকড** কী যেকোনো
  পিসিতে চলে — দোকানে যেতে না পারলে ব্যবহার করুন।

### ইউএসবি কিট বানানো (নিজের পিসিতে, একবার)

```bash
npm run license:keygen     # জীবনে একবারই
npm run licence:kit        # releases\ShopDesk-Licence-Kit তৈরি হয়
```

পুরো ফোল্ডারটি একটি **এনক্রিপ্ট করা ইউএসবি**-তে কপি করুন, বা সরাসরি:

```bash
npm run licence:kit -- --usb E:\
```

### দোকানে কী করতে হবে

১. ইউএসবি লাগান।
২. `ShopDesk-Licence-Kit` খুলে **`Make Licence Key.bat`** ডাবল-ক্লিক করুন।
৩. দোকানের নাম লিখুন → Enter (৩৬৫ দিন) → Lock প্রশ্নে Enter (Y)।
৪. কী নিজেই কপি হবে এবং Shop Desk ব্রাউজারে খুলবে।
৫. **Shop settings → Licence & plan**-এ Ctrl+V দিয়ে পেস্ট করে **Activate** চাপুন।
৬. অ্যাপে **Activated** দেখলে ইউএসবি খুলে ফেলুন। দোকানের পিসিতে কিছু রাখবেন না।

### নবায়ন

মেয়াদ শেষের ৭ দিন আগে ব্যানার দেখাবে। দোকানে গিয়ে একইভাবে নতুন কী বানিয়ে পেস্ট করুন —
পুরোনো কী স্বয়ংক্রিয়ভাবে বদলে যাবে। নির্দিষ্ট তারিখে শেষ করতে চাইলে:
`Make Licence Key.bat --expires 2027-01-31`

### নিরাপত্তা

- কিটে আপনার **প্রাইভেট কী** আছে। এটি হাতে পেলে যে কেউ যত খুশি লাইসেন্স বানাতে পারবে।
  ইউএসবি সবসময় নিজের কাছে রাখুন, একটি ব্যাকআপ রাখুন।
- কিট **কখনো** Shop Desk ফোল্ডার, রিলিজ জিপ বা গিটে রাখবেন না। টুল নিজেই এটি আটকে দেয়।
- শুধু `SD1.…` কী-টেক্সট পাঠান, পুরো ফোল্ডার নয়।
- ইউএসবি হারালে `npm run license:keygen` দিয়ে নতুন কী-পেয়ার বানিয়ে ইনস্টলার ও কিট
  আবার বানান, তারপর সব দোকানে নতুন কী দিন।

### সমস্যা হলে

| যা দেখছেন | সমাধান |
| --- | --- |
| `Shop Desk was not found` | `Make Licence Key.bat --install "E:\ShopDesk"` |
| `No Installation ID found` | আগে একবার Shop Desk চালু করুন, তারপর আবার চেষ্টা করুন |
| `MISMATCH` / `different public key` | ইনস্টলার ও কিট একই ফোল্ডার থেকে বানিয়ে আবার চেষ্টা করুন |
| `private key does not match` | `private\license-private-key.pem` ভুল বা পুরোনো — সঠিক কী দিন |
| `inside the Shop Desk installation folder` | কিট ইউএসবি-তে সরান, দোকানের ফোল্ডারে রাখবেন না |
| কী পেস্ট করার পর `different installation` | কী অন্য পিসির জন্য — Installation ID মিলিয়ে নতুন কী বানান |
