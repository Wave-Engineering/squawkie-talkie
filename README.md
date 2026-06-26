# squawkie-talkie
Lightweight, purpose built squawk list manager.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install          # install dependencies
bun run typecheck    # tsc --noEmit
bun test             # run the test suite
bun run build        # bundle the client: src/client/app.ts -> public/dist/app.js
bun run dev          # start the server on http://localhost:3000
```

The client is a static SPA shell (`public/index.html` + `public/styles.css`)
whose entrypoint is built from `src/client/app.ts`. The build output lands in
`public/dist/` (gitignored) and is served by the dev/prod server alongside the
other files in `public/`.
