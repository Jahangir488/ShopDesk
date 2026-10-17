FROM node:22-slim
WORKDIR /app
COPY package.json server.mjs app.js index.html styles.css join.html manifest.webmanifest sw.js offline.html ./
COPY lib ./lib
COPY i18n ./i18n
COPY icons ./icons
COPY fonts ./fonts
ENV NODE_ENV=production PORT=8765 SHOP_TRUST_PROXY=1 SHOP_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8765
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
