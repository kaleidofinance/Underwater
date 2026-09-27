# The Underwater ZEC API: engine + rails + HTTP, one process, one writer.
# Zero runtime dependencies, so the image is just Node and the source.
# The command log lives on the /data volume and is the whole database.
FROM node:24-slim
WORKDIR /app
COPY engine ./engine
COPY rails ./rails
COPY server ./server
COPY package.json tsconfig.json ./
ENV NODE_ENV=production
ENV ZEC_LOG=/data/engine.jsonl
CMD ["node", "server/main.ts"]
