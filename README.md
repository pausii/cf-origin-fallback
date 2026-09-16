# cf-origin-fallback

A small Cloudflare Worker that keeps your site readable when the origin goes down.

It sits in front of your domain, lets every request pass through as usual, and quietly stores a copy of each successful response in Workers KV. If the origin later returns an error (5xx, 4xx, timeout, connection refused), the Worker serves the last good copy instead of an error page.

That's it. No TTLs to tune, no cache invalidation to think about. When the origin is healthy, visitors always get the live response.

## How it works

Normal day, origin is healthy:

```
visitor ──GET /about──> Worker ──> origin
visitor <──200 OK────── Worker <── 200 OK
                          │
                          └──> KV.put("/about", body + headers)   (background, only if changed)
```

Origin is down:

```
visitor ──GET /about──> Worker ──> origin
                        Worker <── 502 / timeout / refused
                          │
                          └──> KV.get("/about")  ──> found
visitor <──200 OK──────── Worker      (X-Cache-Fallback: true)
```

If nothing is in KV for that path yet, the visitor gets the origin's error as-is.

- **Origin OK** → response goes straight to the visitor, and a copy is written to KV in the background. Writes are skipped when the body hasn't changed (compared by SHA-256), so KV write quota stays low.
- **Origin error** → the Worker looks up the same path in KV. If found, it's served with an extra `X-Cache-Fallback: true` header. If not, the origin error is passed through with an `X-Workers-Message` header describing what happened.
- Only `GET` responses are stored. Requests with an `Authorization` header and responses marked `Cache-Control: private` or `no-store` are never stored. `Set-Cookie` is stripped before saving.
- Static assets (images, fonts, archives, etc.) and admin paths are bypassed entirely. Both lists are configurable.

## Setup

You need a Cloudflare account with your domain already on it, plus Node.js and pnpm.

```sh
git clone https://github.com/pausii/cf-origin-fallback
cd cf-origin-fallback
pnpm install
```

**1. Create a KV namespace** and put its ID into `wrangler.toml`:

```sh
pnpm exec wrangler kv namespace create WEB_CACHE_INDEX
```

```toml
[[kv_namespaces]]
binding = "WEB_CACHE_INDEX"
id = "<paste the id here>"
```

**2. Set the admin password.** This protects the `/__cache-*` endpoints below.

```sh
pnpm exec wrangler secret put PASSWORD_ACCESS
```

**3. Deploy:**

```sh
pnpm deploy
```

**4. Attach it to your domain.** In the Cloudflare dashboard go to *Workers & Pages → cf-origin-fallback → Settings → Domains & Routes* and add a route like `example.com/*`. Until you do this the Worker has no origin behind it, and opening the `workers.dev` URL just shows a short reminder page.

Alternatively, add the route to `wrangler.toml` and redeploy:

```toml
routes = [
  { pattern = "example.com/*", zone_name = "example.com" }
]
```

## Configuration

All non-secret settings live under `[vars]` in `wrangler.toml`:

| Variable | Default | What it does |
|---|---|---|
| `IGNORED_EXTENSIONS` | images, fonts, media, archives | Comma-separated list of file extensions that are never cached. |
| `BYPASS_PATHS` | `/admin,/clientarea,/api/service` | Path prefixes that skip the Worker completely and go straight to origin. |
| `MAX_BODY_SIZE` | `2097152` (2 MB) | Responses larger than this (in bytes) are not stored. |
| `STRIP_QUERY` | `true` | Ignore the query string when building the cache key, so `/page?x=1` and `/page` share one entry. Set to `false` if your pages depend on query params. |
| `CACHE_PREFIX`, `HASH_PREFIX`, `CACHE_STATUS_KEY` | – | KV key prefixes. You normally don't need to touch these. |

## Admin endpoints

These are handled by the Worker itself and never reach your origin. Every call needs the password as a bearer token:

```sh
# list what's currently stored, plus whether fallback is enabled
curl -H "Authorization: Bearer $PASSWORD_ACCESS" https://example.com/__cache-list

# wipe every stored page (the toggle state is kept)
curl -H "Authorization: Bearer $PASSWORD_ACCESS" https://example.com/__cache-clear

# turn fallback off or on
curl -H "Authorization: Bearer $PASSWORD_ACCESS" "https://example.com/__cache-toggle?enable=false"
curl -H "Authorization: Bearer $PASSWORD_ACCESS" "https://example.com/__cache-toggle?enable=true"
```

A missing or wrong token gets a `401`. These endpoints also work on the `workers.dev` URL, which is handy when you don't want to touch the production domain.

Note that the toggle only affects *serving* from KV. Successful responses keep being stored even while fallback is off, so the copy stays fresh for when you turn it back on.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in PASSWORD_ACCESS
pnpm dev
```

`wrangler dev` rewrites the request host to `localhost`, which makes the Worker fetch itself in a loop. Pass a real host so it has somewhere to go:

```sh
pnpm exec wrangler dev --host example.com
```

Type-check with `pnpm exec tsc --noEmit`, and stream production logs with `pnpm tail`.

## License

MIT © 2026 Ahmad Pausi
