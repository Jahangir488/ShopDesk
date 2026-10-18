#!/usr/bin/env node
// The historical USB licence kit copied the supplier private key to a customer device.
// It is intentionally disabled for commercial safety. Issue licences only on the supplier PC.
console.error("The portable USB licence kit has been retired because it could copy the private signing key to a customer computer.");
console.error("Use `npm run license:supplier` or double-click `4 - Issue Customer Licence.bat` on your supplier PC.");
process.exitCode = 1;
