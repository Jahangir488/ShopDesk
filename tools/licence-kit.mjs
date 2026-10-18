#!/usr/bin/env node
// The historical portable licence kit is retired. It carried the supplier private key.
console.error("This legacy licence-kit issuer is disabled. Never copy your signing key to a customer PC.");
console.error("Issue customer keys only from your supplier PC: npm run license:supplier");
process.exitCode = 1;
