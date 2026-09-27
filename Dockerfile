FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data
ENV KILL_SWITCH_FILE=/app/data/STOP
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
