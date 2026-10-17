// PM2 process file for a VPS:  pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [{
    name: "shop-desk",
    script: "server.mjs",
    env: {
      PORT: 8765,
      SHOP_HOST: "127.0.0.1",          // only the reverse proxy (Nginx/Caddy) talks to the app
      SHOP_TRUST_PROXY: "1",
      SHOP_PUBLIC_URL: "https://shop.yourdomain.com",
      SHOP_DATA_DIR: "/var/lib/shop-desk" // keep data outside the code folder
    },
    max_restarts: 10
  }]
};
