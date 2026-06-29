# Deployment & Operations

Squawkie-Talkie is one self-hosted Bun process. This covers running it for real, the
non-obvious gotchas, and the security posture you **must** read first.

## ⚠️ Security posture — read before deploying

**There is no authentication.** Initials are a label, not an identity, and any viewer can
edit or delete any list; concurrent edits are last-write-wins (silent overwrite).

**Deploy on a trusted internal network only. Do not expose to the public internet.**
There is no authorization model, rate limiting, or audit trail. (See
[`architecture.md`](architecture.md#security-posture).)

## Prerequisites

- [Bun](https://bun.sh) 1.3.x (CI pins `1.3.11`).
- A writable directory for the SQLite database file.

## Run

```bash
bun install --production    # or: bun install
bun run build               # bundle the client → public/dist/app.js  (REQUIRED before serving)
PORT=8080 SQUAWK_DB=/var/lib/squawkie/squawk.db bun run src/server/index.ts
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `SQUAWK_DB` | `squawk.db` (cwd) | SQLite file path; `:memory:` for ephemeral/test |

The process logs `squawkie-talkie listening on http://localhost:<port>` and handles
`SIGINT`/`SIGTERM` gracefully (closes SSE streams + heartbeat).

> **Build step is mandatory.** The server serves `public/dist/app.js`; if you skip
> `bun run build`, the client shell loads but the app bundle 404s.

## Reverse proxy — the SSE gotcha

Realtime uses Server-Sent Events on `GET /api/stream`. Most proxies **buffer** responses
by default, which holds events until the buffer fills — realtime appears broken with no
error. **Disable buffering for the stream** (and don't let the proxy time the connection
out below the ~25s heartbeat).

**nginx:**
```nginx
location /api/stream {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # ← load-bearing: stream events immediately
    proxy_read_timeout 1h;        # outlive idle gaps (heartbeat is ~25s)
}
location / {
    proxy_pass http://127.0.0.1:8080;
}
```

(Caddy streams SSE correctly by default; for others, find the equivalent
"disable response buffering" setting.)

## Persistence & backup

`squawk.db` **is** the instance — all lists and squawks live in that one file (plus
SQLite's `-wal`/`-shm` siblings). To back up, copy the file while the process is stopped,
or use `sqlite3 squawk.db ".backup '/backups/squawk-$(date +%F).db'"` for a hot backup.
Deleting a list is permanent (cascade delete); there is no soft-delete or undo.

Single-process, single-writer SQLite is ample for team-scale concurrency. There is no
horizontal scale-out story (one process owns the file and the in-memory SSE subscriber
set); run a single instance.

## Health & smoke check

```bash
curl -fsS http://localhost:8080/healthz            # {"ok":true}
curl -fsS -X POST http://localhost:8080/api/lists \
  -H 'content-type: application/json' -d '{"name":"smoke"}'
```

For a realtime check, open `GET /api/stream` (`curl -N`) in one shell and create a list in
another — you should see a `data: {"type":"list.created",…}` frame.

## Upgrades

Pull, `bun install`, `bun run build`, restart the process. The schema is created with
`CREATE TABLE IF NOT EXISTS`; there is no migration framework yet, so additive schema
changes are safe but destructive ones need a manual migration.
