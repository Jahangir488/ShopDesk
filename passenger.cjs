// Startup file for cPanel "Setup Node.js App" / Phusion Passenger hosts.
// Passenger loads CommonJS, so this small wrapper loads the real ES-module server.
import("./server.mjs").catch(error => { console.error(error); process.exit(1); });
