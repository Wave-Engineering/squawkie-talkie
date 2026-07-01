FROM oven/bun:1.3.11-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ src/
COPY public/ public/
RUN bun run build

RUN mkdir -p /data

ENV PORT=3000
ENV SQUAWK_DB=/data/squawk.db

EXPOSE 3000

CMD ["bun", "run", "src/server/index.ts"]
