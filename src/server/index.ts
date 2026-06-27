/**
 * Squawkie-Talkie server entrypoint.
 *
 * Routes:
 *   GET /healthz        -> 200 { ok: true }
 *   GET /api/stream     -> Server-Sent Events stream (see sse.ts)
 *   /api/...            -> JSON REST API (see api.ts), checked before static
 *   GET <public asset>  -> the matching file under public/ (e.g. /styles.css,
 *                          /dist/app.js), content-type inferred from extension
 *   *                   -> public/index.html (SPA shell fallback)
 *
 * The route logic is exported as `routeRequest` (and `fetch`) so tests can
 * exercise it without binding a port.
 */

import { handleApi } from "./api.ts";
import { shutdown, subscribe } from "./sse.ts";

const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;
const INDEX_HTML_PATH = `${PUBLIC_DIR}index.html`;

export async function routeRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return Response.json({ ok: true });
  }

  // Server-Sent Events stream. Checked before handleApi (which would 404 it).
  if (req.method === "GET" && url.pathname === "/api/stream") {
    return subscribe();
  }

  // JSON REST API. Returns null for non-/api paths so static serving still
  // works; must run before the static/SPA fallback.
  const apiResponse = handleApi(req, url);
  if (apiResponse) {
    return apiResponse;
  }

  // Serve static assets out of public/ (styles, built client bundle, etc.).
  if (req.method === "GET" && url.pathname !== "/") {
    const assetPath = resolveAsset(url.pathname);
    if (assetPath) {
      const asset = Bun.file(assetPath);
      if (await asset.exists()) {
        return new Response(asset);
      }
    }
  }

  // Fallback: serve the SPA shell.
  const file = Bun.file(INDEX_HTML_PATH);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Not Found", { status: 404 });
}

/** Map a URL path to an absolute file under public/, or null if it escapes. */
function resolveAsset(pathname: string): string | null {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\0")) {
    return null;
  }
  const resolved = new URL(clean, `file://${PUBLIC_DIR}`).pathname;
  return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
}

export const fetch = routeRequest;

// Only start the listener when run directly (not when imported by tests).
if (import.meta.main) {
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: routeRequest,
  });
  console.log(`squawkie-talkie listening on http://localhost:${server.port}`);

  // Graceful shutdown: close SSE streams + heartbeat, then stop the listener.
  const stop = (): void => {
    shutdown();
    void server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
