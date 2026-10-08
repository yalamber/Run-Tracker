FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV PORT=3000 DATA_FILE=/data/runs.json
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
