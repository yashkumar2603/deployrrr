type Env = {
  PUBLIC_BUCKET: R2Bucket;
  BASE_DOMAIN?: string;
  PUBLIC_PREFIX?: string;
  METADATA_PREFIX?: string;
  MAX_FILE_SIZE_BYTES?: string;
  UPLOAD_TOKEN?: string;
};

type DeploymentMode = "public" | "custom";

type DeploymentRecord = {
  id: string;
  mode: DeploymentMode;
  originBaseUrl?: string;
  createdAt: string;
  completedAt?: string;
};

type FileManifestItem = {
  path: string;
  contentType?: string;
  size?: number;
};

type ResolvedRequest = {
  siteId: string;
  assetPath: string;
};

const DEFAULT_PUBLIC_PREFIX = "sites";
const DEFAULT_METADATA_PREFIX = "_deployrrr/sites";
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const RESERVED_SUBDOMAINS: Record<string, true> = {
  api: true,
  deployrrr: true,
  www: true,
};
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webp: "image/webp",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/deployments") {
        return await createDeployment(request, env, ctx);
      }

      const completionMatch = url.pathname.match(/^\/api\/deployments\/([^/]+)\/complete\/?$/);
      if (request.method === "POST" && completionMatch) {
        return await completeDeployment(request, env, ctx, completionMatch[1]);
      }

      const fileUploadMatch = url.pathname.match(/^\/api\/deployments\/([^/]+)\/files\/(.+)$/);
      if (request.method === "PUT" && fileUploadMatch) {
        return await uploadDeploymentFile(request, env, fileUploadMatch[1], fileUploadMatch[2]);
      }

      if (request.method === "GET" || request.method === "HEAD") {
        return await serveAsset(request, env);
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

async function createDeployment(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  requireWriteAuth(request, env);

  const payload = await readJsonBody(request);
  const mode = payload.mode;
  if (mode !== "public" && mode !== "custom") {
    throw new HttpError(400, "mode must be public or custom");
  }

  const id = normalizeDeploymentId(payload.id) ?? randomDeploymentId();
  if (mode === "public") {
    const files = readManifest(payload.files);
    const maxFileSize = Number(env.MAX_FILE_SIZE_BYTES ?? DEFAULT_MAX_FILE_SIZE_BYTES);
    const oversized = files.find((file) => typeof file.size === "number" && file.size > maxFileSize);
    if (oversized) {
      throw new HttpError(413, `${oversized.path} exceeds the ${maxFileSize} byte upload limit`);
    }

    ctx.waitUntil(saveDeployment(env, { id, mode: "public", createdAt: new Date().toISOString() }));
    return json({ id, url: publicUrlFor(id, env), directUpload: true, maxFileSizeBytes: maxFileSize }, 201);
  }

  const originBaseUrl = normalizeOriginBaseUrl(payload.originBaseUrl);
  await saveDeployment(env, { id, mode: "custom", originBaseUrl, createdAt: new Date().toISOString() });
  return json({ id, url: publicUrlFor(id, env) }, 201);
}

async function uploadDeploymentFile(request: Request, env: Env, rawId: string, rawPath: string): Promise<Response> {
  requireWriteAuth(request, env);

  const id = normalizeDeploymentId(rawId);
  const assetPath = normalizeAssetPath(rawPath);
  if (!id || !assetPath) {
    throw new HttpError(400, "invalid deployment id or file path");
  }

  const contentLength = request.headers.get("content-length");
  const maxFileSize = Number(env.MAX_FILE_SIZE_BYTES ?? DEFAULT_MAX_FILE_SIZE_BYTES);
  if (contentLength && Number(contentLength) > maxFileSize) {
    throw new HttpError(413, `${assetPath} exceeds the ${maxFileSize} byte upload limit`);
  }

  const deployment = await loadDeployment(env, id);
  if (!deployment || deployment.mode !== "public") {
    throw new HttpError(404, "public deployment not found");
  }

  const body = request.body;
  if (!body) {
    throw new HttpError(400, "file body is required");
  }

  await env.PUBLIC_BUCKET.put(objectKeyFor(env, id, assetPath), body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") ?? contentTypeFor(assetPath),
      cacheControl: cacheControlFor(assetPath),
    },
  });

  return json({ ok: true, path: assetPath });
}

async function completeDeployment(request: Request, env: Env, ctx: ExecutionContext, rawId: string): Promise<Response> {
  requireWriteAuth(request, env);

  const id = normalizeDeploymentId(rawId);
  if (!id) {
    throw new HttpError(400, "invalid deployment id");
  }

  const current = await loadDeployment(env, id);
  if (!current) {
    throw new HttpError(404, "deployment not found");
  }

  ctx.waitUntil(saveDeployment(env, { ...current, completedAt: new Date().toISOString() }));
  return json({ ok: true, id });
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const resolved = resolveSiteRequest(request, env);
  if (!resolved) {
    return new Response("Deployment not found", { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  }

  const deployment = await loadDeployment(env, resolved.siteId);
  const object = await loadAsset(env, deployment, resolved.siteId, resolved.assetPath);
  if (!object) {
    return new Response("File not found", { status: 404, headers: responseHeaders("text/plain; charset=utf-8") });
  }

  if (object instanceof Response) {
    const headers = responseHeaders(object.headers.get("content-type") ?? contentTypeFor(resolved.assetPath));
    headers.set("Cache-Control", object.headers.get("cache-control") ?? cacheControlFor(resolved.assetPath));
    headers.set("Content-Disposition", "inline");
    return new Response(request.method === "HEAD" ? null : object.body, { status: object.status, headers });
  }

  const headers = responseHeaders(object.httpMetadata?.contentType ?? contentTypeFor(resolved.assetPath));
  headers.set("Cache-Control", object.httpMetadata?.cacheControl ?? cacheControlFor(resolved.assetPath));
  headers.set("Content-Disposition", "inline");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function loadAsset(env: Env, deployment: DeploymentRecord | undefined, siteId: string, requestedPath: string): Promise<R2ObjectBody | Response | undefined> {
  const assetPath = toIndexPath(requestedPath);
  const candidates = assetPath === "index.html" ? [assetPath] : [assetPath, "index.html"];

  if (deployment?.mode === "custom" && deployment.originBaseUrl) {
    for (const candidate of candidates) {
      const customResponse = await fetchCustomAsset(deployment.originBaseUrl, candidate);
      if (customResponse) {
        return customResponse;
      }
    }
    return undefined;
  }

  for (const candidate of candidates) {
    const object = await env.PUBLIC_BUCKET.get(objectKeyFor(env, siteId, candidate));
    if (object) {
      return object;
    }
  }
  return undefined;
}

async function fetchCustomAsset(originBaseUrl: string, assetPath: string): Promise<Response | undefined> {
  const response = await fetch(`${originBaseUrl}/${assetPath.split("/").map(encodeURIComponent).join("/")}`);
  if (response.status === 404) {
    response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    response.body?.cancel();
    throw new HttpError(502, `custom bucket fetch failed: ${response.status}`);
  }
  return response;
}

async function saveDeployment(env: Env, record: DeploymentRecord): Promise<void> {
  await env.PUBLIC_BUCKET.put(metadataKeyFor(env, record.id), JSON.stringify(record), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
  });
}

async function loadDeployment(env: Env, id: string): Promise<DeploymentRecord | undefined> {
  const object = await env.PUBLIC_BUCKET.get(metadataKeyFor(env, id));
  if (!object) {
    return undefined;
  }
  return object.json<DeploymentRecord>();
}

function resolveSiteRequest(request: Request, env: Env): ResolvedRequest | undefined {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const pathParts = url.pathname.split("/").filter(Boolean);
  const idFromHost = deploymentIdFromHost(host, env);

  if (idFromHost) {
    const assetPath = normalizeAssetPath(pathParts.join("/")) ?? "index.html";
    return { siteId: idFromHost, assetPath };
  }

  const [siteIdCandidate, ...rest] = pathParts;
  const siteId = normalizeDeploymentId(siteIdCandidate);
  if (!siteId) {
    return undefined;
  }

  const assetPath = normalizeAssetPath(rest.join("/")) ?? "index.html";
  return { siteId, assetPath };
}

function deploymentIdFromHost(host: string, env: Env): string | undefined {
  if (host === "localhost" || host === "127.0.0.1") {
    return undefined;
  }

  const baseDomain = env.BASE_DOMAIN?.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (baseDomain && host.endsWith(`.${baseDomain}`)) {
    const subdomain = host.slice(0, -(baseDomain.length + 1)).split(".")[0];
    if (!RESERVED_SUBDOMAINS[subdomain]) {
      return normalizeDeploymentId(subdomain);
    }
  }

  return undefined;
}

function readManifest(value: unknown): FileManifestItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "files must be a non-empty array");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new HttpError(400, "each file must be an object");
    }

    const candidate = item as Record<string, unknown>;
    const filePath = normalizeAssetPath(candidate.path);
    if (!filePath) {
      throw new HttpError(400, "file path is invalid");
    }

    return {
      path: filePath,
      contentType: typeof candidate.contentType === "string" ? candidate.contentType : undefined,
      size: typeof candidate.size === "number" ? candidate.size : undefined,
    };
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "JSON body must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid JSON body");
  }
}

function requireWriteAuth(request: Request, env: Env): void {
  if (!env.UPLOAD_TOKEN) {
    return;
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = bearer ?? request.headers.get("x-deployrrr-token");
  if (token !== env.UPLOAD_TOKEN) {
    throw new HttpError(401, "invalid upload token");
  }
}

function normalizeDeploymentId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) {
    return undefined;
  }
  return id;
}

function normalizeAssetPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value).replace(/^\/+/, "");
  } catch {
    return undefined;
  }

  if (decoded.length === 0) {
    return undefined;
  }

  const normalized = decoded.split("/").filter(Boolean).join("/");
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return undefined;
  }

  return normalized;
}

function normalizeOriginBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "originBaseUrl is required for custom deployments");
  }

  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "originBaseUrl must be http or https");
  }

  return value.trim().replace(/\/+$/, "");
}

function toIndexPath(assetPath: string): string {
  if (assetPath.length === 0 || assetPath.endsWith("/")) {
    return `${assetPath}index.html`.replace(/^\/+/, "");
  }
  return assetPath;
}

function objectKeyFor(env: Env, siteId: string, assetPath: string): string {
  const prefix = (env.PUBLIC_PREFIX ?? DEFAULT_PUBLIC_PREFIX).replace(/^\/+|\/+$/g, "");
  return [prefix, siteId, assetPath].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function metadataKeyFor(env: Env, siteId: string): string {
  const prefix = (env.METADATA_PREFIX ?? DEFAULT_METADATA_PREFIX).replace(/^\/+|\/+$/g, "");
  return `${prefix}/${siteId}.json`;
}

function publicUrlFor(id: string, env: Env): string {
  const baseDomain = env.BASE_DOMAIN?.replace(/^\.+|\.+$/g, "");
  if (baseDomain) {
    return `https://${id}.${baseDomain}/`;
  }
  return `/${id}/`;
}

function randomDeploymentId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentTypeFor(assetPath: string): string {
  const extension = assetPath.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function cacheControlFor(assetPath: string): string {
  if (assetPath.endsWith(".html")) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function responseHeaders(contentType: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-deployrrr-token",
    "Content-Type": contentType,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders("application/json; charset=utf-8") });
}

function withCors(response: Response): Response {
  const headers = responseHeaders(response.headers.get("Content-Type") ?? "text/plain; charset=utf-8");
  response.headers.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status);
  }

  console.error(error);
  return json({ error: "internal server error" }, 500);
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
