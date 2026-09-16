// src/main.ts
export interface Env {
    WEB_CACHE_INDEX: KVNamespace;
    // Non-secret config: wrangler.toml [vars]
    IGNORED_EXTENSIONS?: string;   // comma-separated, e.g. ".jpg,.png"
    BYPASS_PATHS?: string;         // comma-separated path prefixes, e.g. "/admin,/api/service"
    MAX_BODY_SIZE?: string;        // bytes
    CACHE_PREFIX?: string;
    HASH_PREFIX?: string;
    CACHE_STATUS_KEY?: string;
    STRIP_QUERY?: string;          // "true" (default) = query string diabaikan saat membentuk cache key
    // Secret: .dev.vars (local) / `wrangler secret put PASSWORD_ACCESS` (production)
    // Dipakai sebagai bearer token untuk endpoint /__cache-*
    PASSWORD_ACCESS?: string;
}
interface Config {
    ignoredExtensions: string[];
    bypassPaths: string[];
    maxBodySize: number;
    passwordAccess: string | undefined;
    cachePrefix: string;
    hashPrefix: string;
    cacheStatusKey: string;
    stripQuery: boolean;
}

const DEFAULT_IGNORED_EXTENSIONS = [
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
    ".ico", ".mp4", ".mp3", ".pdf", ".zip", ".rar", ".7z",
    ".woff", ".woff2", ".ttf"
];

const DEFAULT_BYPASS_PATHS = ["/admin", "/clientarea", "/api/service"];

function parseList(value: string | undefined, fallback: string[]): string[] {
    if (!value) return fallback;
    return value.split(",").map(v => v.trim()).filter(Boolean);
}

function loadConfig(env: Env): Config {
    const exts = parseList(env.IGNORED_EXTENSIONS, DEFAULT_IGNORED_EXTENSIONS).map(e => e.toLowerCase());
    const maxBody = Number(env.MAX_BODY_SIZE);
    return {
        ignoredExtensions: exts,
        bypassPaths: parseList(env.BYPASS_PATHS, DEFAULT_BYPASS_PATHS),
        maxBodySize: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : 2 * 1024 * 1024, // 2MB
        passwordAccess: env.PASSWORD_ACCESS,
        cachePrefix: env.CACHE_PREFIX || "__CACHE_DATA_",
        hashPrefix: env.HASH_PREFIX || "__CACHE_HASH_",
        cacheStatusKey: env.CACHE_STATUS_KEY || "__CACHE_STATUS_78XUN81YP",
        stripQuery: env.STRIP_QUERY === undefined ? true : env.STRIP_QUERY.toLowerCase() === "true",
    };
}


function isIgnoredPath(cfg: Config, url: string): boolean {
    const lower = url.toLowerCase();
    return cfg.ignoredExtensions.some(ext => lower.endsWith(ext));
}

async function hashSHA256(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isCacheActive(env: Env, cfg: Config): Promise<boolean> {
    const status = await env.WEB_CACHE_INDEX.get(cfg.cacheStatusKey);
    return status === "true" || status === null; // default aktif
}

// simpan status cache
async function saveCacheStatus(env: Env, cfg: Config, active: boolean) {
    await env.WEB_CACHE_INDEX.put(cfg.cacheStatusKey, active ? "true" : "false");
}

// Header yang tidak boleh ikut tersimpan:
// - set-cookie: cookie sesi milik pengunjung yang memicu simpan, jangan dibagikan ke pengunjung lain
// - content-encoding / content-length: body di KV sudah didekompresi, nilai lama tidak cocok lagi
const STRIP_HEADERS = ["set-cookie", "content-encoding", "content-length"];

// Boleh disimpan ke KV?
// - Request dengan header Authorization: hasilnya milik pemegang token, jangan disimpan (RFC 9111 §3.5)
// - Response dengan Cache-Control private / no-store: origin menandai per-pengguna / tidak boleh disimpan
function isCacheable(request: Request, response: Response): boolean {
    // HEAD tidak punya body; kalau disimpan akan menimpa entri GET dengan body kosong
    if (request.method !== "GET") return false;
    if (request.headers.has("authorization")) return false;
    const cc = (response.headers.get("cache-control") || "").toLowerCase();
    return !/(?:^|[\s,])(private|no-store)(?:$|[\s,=])/.test(cc);
}

async function saveToKV(env: Env, cfg: Config, key: string, request: Request, response: Response) {
    try {
        if (!isCacheable(request, response)) return;

        const body = await response.text();
        if (body.length > cfg.maxBodySize) return;

        const cacheKey = cfg.cachePrefix + key;
        const hashKey = cfg.hashPrefix + key;

        const newHash = await hashSHA256(body);

        // Cek hash lama tanpa baca body cache
        const oldHash = await env.WEB_CACHE_INDEX.get(hashKey);
        if (oldHash === newHash) {
            // Tidak ada perubahan → skip tulis ulang
            return;
        }

        // Hash berbeda → simpan body dan hash baru
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
            if (!STRIP_HEADERS.includes(k.toLowerCase())) headers[k] = v;
        });

        await Promise.all([
            env.WEB_CACHE_INDEX.put(cacheKey, JSON.stringify({
                v: 1,                       // versi format record, naikkan kalau strukturnya berubah
                url: request.url,           // URL asli (key hanya path, jadi ini buat referensi)
                savedAt: new Date().toISOString(),
                size: body.length,
                status: response.status,
                headers,
                body
            })),
            env.WEB_CACHE_INDEX.put(hashKey, newHash)
        ]);
    } catch {
        // Abaikan error saat simpan
    }
}

async function getFromKV(env: Env, cfg: Config, key: string, method: string = "GET"): Promise<Response | null> {
    try {
        const cacheKey = cfg.cachePrefix + key;   // harus identik dengan saveToKV
        const data = await env.WEB_CACHE_INDEX.get(cacheKey);
        if (!data) return null;

        const parsed = JSON.parse(data);
        const headers = new Headers(parsed.headers);
        headers.set("X-Cache-Fallback", "true");

        return new Response(method === "HEAD" ? null : parsed.body, {
            status: parsed.status,
            headers
        });
    } catch {
        return null;
    }
}

// Password admin wajib di-set; kalau kosong, semua endpoint admin ditolak.
// Dikirim via header `Authorization: Bearer <PASSWORD_ACCESS>` supaya tidak nyangkut di log/history browser.
function isAuthorized(cfg: Config, request: Request): boolean {
    if (!cfg.passwordAccess) return false;
    const auth = request.headers.get("authorization") || "";
    const [scheme, token] = auth.split(" ", 2);
    return scheme?.toLowerCase() === "bearer" && token === cfg.passwordAccess;
}

function unauthorized(): Response {
    return new Response(JSON.stringify({ message: "Unauthorized" }, null, 2), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" }
    });
}

// Clear semua cache
async function clearKV(env: Env, cfg: Config) {
    let cursor: string | undefined = undefined;

    do {
        const list: KVNamespaceListResult<unknown> = await env.WEB_CACHE_INDEX.list({ cursor, limit: 25 });
        if (list.keys.length > 0) {
            const deletes = list.keys
                .filter(k => k.name.startsWith(cfg.cachePrefix) || k.name.startsWith(cfg.hashPrefix))
                .map(k => env.WEB_CACHE_INDEX.delete(k.name));

            await Promise.all(deletes);
        }
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
}

// Halaman petunjuk kalau Worker diakses langsung via *.workers.dev.
// Tanpa route/custom domain tidak ada origin di belakangnya, fetch(request) cuma memanggil diri sendiri.
function setupGuideResponse(url: URL): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cf-origin-fallback — setup required</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
  code { background: #f2f2f2; padding: .1em .35em; border-radius: 4px; }
  ol li { margin-bottom: .5rem; }
</style>
</head>
<body>
<h1>cf-origin-fallback is running</h1>
<p>This Worker is a caching proxy in front of your website. It is deployed and reachable at <code>${url.hostname}</code>, but there is no origin behind this address, so it has nothing to serve yet.</p>
<p>To use it, attach the Worker to the domain you want to protect:</p>
<ol>
  <li>Open Cloudflare Dashboard &rarr; <strong>Workers &amp; Pages</strong> &rarr; <code>cf-origin-fallback</code> &rarr; <strong>Settings</strong> &rarr; <strong>Domains &amp; Routes</strong>.</li>
  <li>Add a <strong>Route</strong> such as <code>example.com/*</code> (the zone must already be on Cloudflare).</li>
  <li>Set the admin secret: <code>wrangler secret put PASSWORD_ACCESS</code>.</li>
</ol>
<p>Once routed, requests to your domain pass through this Worker and successful responses are stored in KV as a fallback for when the origin goes down.</p>
</body>
</html>`;
    return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const cfg = loadConfig(env);
        const url = new URL(request.url);
        // Key dipakai apa adanya (sudah dinormalisasi & percent-encoded oleh URL parser),
        // tanpa decodeURIComponent: decode bisa melempar error pada "%" yang tidak valid
        // dan sebelumnya hanya dilakukan saat simpan sehingga key baca tidak pernah cocok.
        const cacheKey = cfg.stripQuery ? url.pathname : url.pathname + url.search;

        // Akses langsung ke workers.dev → tampilkan petunjuk binding domain
        // (endpoint admin /__cache-* tetap bisa dipakai dari sini)
        if (url.hostname.endsWith(".workers.dev") && !url.pathname.startsWith("/__cache-")) {
            return setupGuideResponse(url);
        }

        // Exclude certain paths (BYPASS_PATHS di wrangler.toml)
        if (cfg.bypassPaths.some(prefix => url.pathname.startsWith(prefix))) {
            // biarkan permintaan dilanjutkan ke origin, tidak diproses oleh Worker
            return fetch(request);
        }

        // Endpoint daftar cache + status cache
        if (url.pathname === "/__cache-list") {
            if (!isAuthorized(cfg, request)) return unauthorized();

            const list = await env.WEB_CACHE_INDEX.list();
            const active = await isCacheActive(env, cfg);
            return new Response(
                JSON.stringify({ 
                    keys: list.keys.map(k => k.name), 
                    count: list.keys.length,
                    cacheActive: active 
                }, null, 2),
                { headers: { "Content-Type": "application/json" } }
            );
        }

        // Endpoint clear cache
        if (url.pathname === "/__cache-clear") {
            if (!isAuthorized(cfg, request)) return unauthorized();
            await clearKV(env, cfg);
            return new Response(
                JSON.stringify({ message: "All cache cleared" }, null, 2),
                { headers: { "Content-Type": "application/json" } }
            );
        }

        // Endpoint toggle cache on/off
        if (url.pathname === "/__cache-toggle") {
            if (!isAuthorized(cfg, request)) return unauthorized();
            const enable = url.searchParams.get("enable");
            const active = enable === "true";
            await saveCacheStatus(env, cfg, active);
            return new Response(
                JSON.stringify({ message: `Cache ${active ? "enabled" : "disabled"}` }, null, 2),
                { headers: { "Content-Type": "application/json" } }
            );
        }

        // Abaikan selain GET/HEAD (HEAD hanya boleh membaca fallback, tidak menyimpan)
        if (request.method !== "GET" && request.method !== "HEAD") {
            return fetch(request);
        }

        // Abaikan file tertentu
        if (isIgnoredPath(cfg, url.pathname)) {
            return fetch(request);
        }

        const cacheActive = await isCacheActive(env, cfg);

        try {
            const originResponse = await fetch(request);

            if (originResponse.ok) {
                // always cache if response ok from origin; toggle cuma mempengaruhi fallback
                const clone = originResponse.clone();
                ctx.waitUntil(saveToKV(env, cfg, cacheKey, request, clone));
                return originResponse;
            }

            // Jika origin error dan cache aktif → fallback
            if (cacheActive) {
                const fallback = await getFromKV(env, cfg, cacheKey, request.method);
                if (fallback) return fallback;
            }

            // Cache off, atau cache aktif tapi belum ada entri KV untuk path ini
            // → kembalikan response origin apa adanya, plus header info
            const headers = new Headers(originResponse.headers);
            headers.set("X-Workers-Message", JSON.stringify({
                message: "Origin error",
                originStatus: originResponse.status,
                originStatusText: originResponse.statusText
            }));

            return new Response(await originResponse.arrayBuffer(), {
                status: originResponse.status,
                statusText: originResponse.statusText,
                headers,
            });

        } catch (err) {
            if (cacheActive) {
                const fallback = await getFromKV(env, cfg, cacheKey, request.method);
                if (fallback) return fallback;
            }
            return new Response(
                JSON.stringify({
                    message: "Fetch failed and no cache available",
                    error: (err as Error).message
                }, null, 2),
                { status: 504, headers: { "Content-Type": "application/json" } }
            );
        }
    }
};
