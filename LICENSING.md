# ShopDesk Commercial Licensing

ShopDesk uses an **offline, digitally signed licence key**. You sell the software and decide the shop type, enabled modules, installation, and expiry date for each customer. Customers only receive the signed key; they must never receive your private signing key or your supplier source folder.

## How a customer licence works

A new installation starts with the existing 30-day trial. A supplier-issued key contains the customer/shop name, licence plan, expiry date, installation ID, shop type, and selected feature entitlements. ShopDesk verifies the Ed25519 signature locally, so day-to-day use does not require internet access.

The supplier-signed package is authoritative:
- Customers can manage their normal shop operations and staff accounts.
- Shop type is read-only in Shop settings.
- A package change requires you to issue a new signed licence for that installation.
- Pharmacy batch and expiry controls are available only to a Pharmacy package.
- Existing keys without shop-type/module fields remain verifiable for backwards compatibility.

## One-time supplier setup

Perform all licence issuing on **your own supplier PC**.

1. Keep your matching private key at `vendor/license-private-key.pem` (or use the `SHOP_LICENSE_PRIVATE_KEY` environment variable). The key is git-ignored and must never be committed, uploaded to a customer computer, included in a release, or sent to anyone.
2. Keep an encrypted offline backup of the private key. **Do not generate a replacement key pair if you have already sold licences.** Every app build must trust the corresponding public key in `lib/license-public.mjs`; replacing that public key can invalidate issued customer keys.
3. Install Node.js 22.13 or newer on the supplier PC and keep the supplier source tree restricted to you.

If the private key is missing, stop and check your existing key backup and the public key shipped by the installed ShopDesk version before issuing any licences. Do not create a new key pair just to make the wizard start.

## Issue a new customer's licence

### 1. Get the customer's Installation ID

Install ShopDesk at the customer's shop, open **Settings → Licence & plan**, and copy the full **Installation ID**. Ask the customer to send you that ID and the exact shop/company name for the licence.

### 2. Run the supplier wizard on your PC

From your own ShopDesk source folder, double-click **`4 - Issue Customer Licence.bat`**, or run:

```bash
npm run license:supplier
```

The wizard asks you for:
- Customer/shop name.
- Licensed shop type: general, hardware, grocery, clothing, pharmacy, or mobile.
- Customer's full Installation ID.
- Plan name and licence duration.
- Optional modules to include, such as online orders, Pharmacy, Clothing, Repairs, and Devices.

It writes a `.txt` key into `releases/licences/` and copies the key to the supplier PC's clipboard on Windows. The key is signed using your private key and bound to that customer's Installation ID.

### 3. Send only the signed key

Send the one-line key to the customer. Do **not** send `vendor/license-private-key.pem`, the source folder, or a supplier USB kit containing private-key material.

The customer opens **Settings → Licence & plan**, pastes the key, and presses **Activate**. The app applies the shop type from the signed key and locks the shop-type selector. If the key is bound to a different Installation ID, ask the customer to copy the correct ID; do not remove installation binding simply to bypass a mismatch.

### Renew or change a package

Run the same wizard on your supplier PC and issue a new key for the same Installation ID. Select the new duration, shop type, and modules. The customer activates the replacement key inside ShopDesk. A key cannot be revoked instantly while the customer remains offline; set a suitable expiry date and retain your own issuance records.

## Pharmacy package

A Pharmacy licence must include the **Pharmacy** feature. The Pharmacy workflow tracks batch/lot numbers, expiry dates, received quantities, sellable quantities, supplier purchases, earliest-expiry-first sales allocations, expiry alerts (including the next 90 days), and batch-linked sale records. Expired, unknown-expiry, and customer-returned/quarantined medicine is not eligible for sale. Customer returns are quarantined rather than automatically put back into sellable stock.

When an existing database is first switched to Pharmacy, ShopDesk preserves the old product quantities as `LEGACY-` batches with unknown expiry. Verify each medicine's actual batch and expiry from the package before correcting those entries; the software deliberately does not guess an expiry date.

Pharmacy bills keep their batch audit trail: saved bills cannot be edited or deleted directly. Use a return and create a corrected bill instead. Online-order stock handling and the old quick-sale route are blocked for Pharmacy until they can use the same batch-aware workflow.

## What offline signing protects—and what it does not

The private signing key prevents customers from creating valid licence tokens merely by editing the key text. Keep that private key secret. Because activation is offline, the seller cannot remotely revoke a key before its expiry date.

**Commercial distribution caution:** an offline signature is not complete copy-protection against somebody who can modify the application itself. The ShopDesk repository is currently public, and the local server code is inspectable; a technically capable user could modify local licence checks. For commercial sales, keep unreleased source and signing material private, distribute only the intended customer build, and consider a private repository/build pipeline. If you need remote revocation or stronger enforcement, that requires an online entitlement service, which is a different design from the offline-only approach chosen here.

## Key safety checklist

- [ ] Private key stays only on your supplier PC and in an encrypted offline backup.
- [ ] Every paid licence is created by you, with the exact customer ID and package.
- [ ] Only the signed key is sent to a customer.
- [ ] New builds continue to trust the same public key unless you deliberately plan a key migration.
- [ ] Test a new key, a wrong-installation key, an expired key, and each customer package before commercial release.
