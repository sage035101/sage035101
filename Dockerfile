FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY data/kb.jsonl ./data/kb.jsonl
COPY data/uploads.jsonl ./data/uploads.jsonl
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
