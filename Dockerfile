FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /app/data
# Sem diretiva VOLUME: o Railway rejeita-a — a persistência é feita com um Railway Volume
# montado em /app/data (ver railway.toml). Em Docker local, mapeia com `docker run -v`.
ENV DATA_DIR=/app/data
ENV KILL_SWITCH_FILE=/app/data/STOP
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
