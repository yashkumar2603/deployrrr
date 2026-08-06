import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import type S3 from "aws-sdk/clients/s3";
import mime from "mime-types";
import crypto from "crypto";
import path from "path";


process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE ??= "1";
const S3Client = require("aws-sdk/clients/s3") as typeof S3;
const DEFAULT_PUBLIC_PREFIX = "sites";
const METADATA_PREFIX = "_deployrrr/sites";
const RESERVED_SUBDOMAINS: Record<string, true> = {
  www: true,
  api: true,
  deployrrr: true,
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

type HandlerConfig = {
  port: number;
  baseDomain?: string;
  publicBucket?: string;
  publicRegion?: string;
  publicEndpoint?: string;
  publicAccessKeyId?: string;
  publicSecretAccessKey?: string;
  publicPrefix: string;
  forcePathStyle: boolean;
  uploadUrlTtlSeconds: number;
};

type ResolvedRequest = {
  siteId: string;
  assetPath: string;
};

type StoredObject = {
  body: S3.Body;
  contentType?: string;
  cacheControl?: string;
};

const app = express();
const config = loadConfig();
const s3 = createS3Client(config);
const memoryDeployments = new Map<string, DeploymentRecord>();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }
  sendError(res, error);
});


app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/api/deployments", async (req: Request, res: Response) => {
  try {
    const mode = req.body?.mode;
    if (mode !== "public" && mode !== "custom") {
      res.status(400).json({ error: "mode must be public or custom" });
      return;
    }

    const id = normalizeDeploymentId(req.body?.id) ?? randomDeploymentId();

    if (mode === "public") {
      const files = readManifest(req.body?.files);
      ensurePublicBucketConfigured();
      const publicBucket = config.publicBucket;
      if (!publicBucket) {
        throw new HttpError(500, "public bucket is not configured");
      }



      const uploads = await Promise.all(files.map(async (file) => {
        const key = objectKeyFor(config.publicPrefix, id, file.path);
        const contentType = file.contentType || mime.lookup(file.path) || "application/octet-stream";
        const url = await s3.getSignedUrlPromise("putObject", {
          Bucket: publicBucket,
          Key: key,
          ContentType: contentType,
          CacheControl: cacheControlFor(file.path),
          Expires: config.uploadUrlTtlSeconds,
        });

        return {
          path: file.path,
          url,
          headers: {
            "Cache-Control": cacheControlFor(file.path),
          },
        };
      }));

      await saveDeployment({ id, mode: "public", createdAt: new Date().toISOString() });
      res.status(201).json({ id, url: publicUrlFor(id), uploads });
      return;
    }

    const originBaseUrl = normalizeOriginBaseUrl(req.body?.originBaseUrl);
    await saveDeployment({ id, mode: "custom", originBaseUrl, createdAt: new Date().toISOString() });
    res.status(201).json({ id, url: publicUrlFor(id) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/deployments/:id/complete", async (req: Request, res: Response) => {
  try {
    const id = normalizeDeploymentId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "invalid deployment id" });
      return;
    }

    const current = await loadDeployment(id);
    await saveDeployment({
      ...(current ?? { id, mode: "public" as const, createdAt: new Date().toISOString() }),
      completedAt: new Date().toISOString(),
    });
    res.json({ ok: true, id });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("*", async (req: Request, res: Response) => {
  try {
    const resolved = resolveSiteRequest(req);
    if (!resolved) {
      res.status(404).type("text/plain").send("Deployment not found");
      return;
    }

    const deployment = await loadDeployment(resolved.siteId);
    const object = await loadAsset(deployment, resolved.siteId, resolved.assetPath);
    if (!object) {
      res.status(404).type("text/plain").send("File not found");
      return;
    }

    res.setHeader("Content-Type", object.contentType || mime.lookup(resolved.assetPath) || "application/octet-stream");
    res.setHeader("Cache-Control", object.cacheControl || cacheControlFor(resolved.assetPath));
    res.setHeader("Content-Disposition", "inline");
    res.send(object.body);
  } catch (error) {
    sendError(res, error);
  }
});

app.listen(config.port, () => {
  console.log(`Deployrrr request handler listening on ${config.port}`);
});

function loadConfig(): HandlerConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    baseDomain: process.env.DEPLOYRRR_BASE_DOMAIN?.toLowerCase(),
    publicBucket: process.env.DEPLOYRRR_PUBLIC_BUCKET,
    publicRegion: process.env.DEPLOYRRR_PUBLIC_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    publicEndpoint: process.env.DEPLOYRRR_PUBLIC_ENDPOINT,
    publicAccessKeyId: process.env.DEPLOYRRR_PUBLIC_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
    publicSecretAccessKey: process.env.DEPLOYRRR_PUBLIC_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
    publicPrefix: trimSlashes(process.env.DEPLOYRRR_PUBLIC_PREFIX ?? DEFAULT_PUBLIC_PREFIX),
    forcePathStyle: process.env.DEPLOYRRR_PUBLIC_FORCE_PATH_STYLE === "true",
    uploadUrlTtlSeconds: Number(process.env.DEPLOYRRR_UPLOAD_URL_TTL_SECONDS ?? 900),
  };
}

function createS3Client(handlerConfig: HandlerConfig) {
  return new S3Client({
    accessKeyId: handlerConfig.publicAccessKeyId,
    secretAccessKey: handlerConfig.publicSecretAccessKey,
    region: handlerConfig.publicRegion,
    endpoint: handlerConfig.publicEndpoint,
    s3ForcePathStyle: handlerConfig.forcePathStyle,
    signatureVersion: "v4",
  });
}

function ensurePublicBucketConfigured() {
  const missing = [
    ["DEPLOYRRR_PUBLIC_BUCKET", config.publicBucket],
    ["DEPLOYRRR_PUBLIC_ACCESS_KEY_ID", config.publicAccessKeyId],
    ["DEPLOYRRR_PUBLIC_SECRET_ACCESS_KEY", config.publicSecretAccessKey],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new HttpError(500, `public bucket is not configured: ${missing.map(([name]) => name).join(", ")}`);
  }
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

async function saveDeployment(record: DeploymentRecord) {
  memoryDeployments.set(record.id, record);

  if (!config.publicBucket) {
    return;
  }

  await s3.putObject({
    Bucket: config.publicBucket,
    Key: metadataKeyFor(record.id),
    Body: JSON.stringify(record),
    ContentType: "application/json",
    CacheControl: "no-store",
  }).promise();
}

async function loadDeployment(id: string): Promise<DeploymentRecord | undefined> {
  const cached = memoryDeployments.get(id);
  if (cached) {
    return cached;
  }

  if (!config.publicBucket) {
    return undefined;
  }

  try {
    const object = await s3.getObject({ Bucket: config.publicBucket, Key: metadataKeyFor(id) }).promise();
    if (!object.Body) {
      return undefined;
    }

    const record = JSON.parse(object.Body.toString("utf8")) as DeploymentRecord;
    memoryDeployments.set(id, record);
    return record;
  } catch (error) {
    if (isS3NotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function loadAsset(deployment: DeploymentRecord | undefined, siteId: string, requestedPath: string): Promise<StoredObject | undefined> {
  const assetPath = toIndexPath(requestedPath);
  const candidates = assetPath === "index.html" ? [assetPath] : [assetPath, "index.html"];

  if (deployment?.mode === "custom" && deployment.originBaseUrl) {
    for (const candidate of candidates) {
      const object = await fetchCustomAsset(deployment.originBaseUrl, candidate);
      if (object) {
        return object;
      }
    }
    return undefined;
  }

  ensurePublicBucketConfigured();
  const publicBucket = config.publicBucket;
  if (!publicBucket) {
    throw new HttpError(500, "public bucket is not configured");
  }

  for (const candidate of candidates) {
    const object = await fetchPublicAsset(publicBucket, siteId, candidate);
    if (object) {
      return object;
    }
  }
  return undefined;
}

async function fetchPublicAsset(publicBucket: string, siteId: string, assetPath: string): Promise<StoredObject | undefined> {
  try {
    const object = await s3.getObject({
      Bucket: publicBucket,
      Key: objectKeyFor(config.publicPrefix, siteId, assetPath),
    }).promise();

    if (!object.Body) {
      return undefined;
    }

    return {
      body: object.Body,
      contentType: object.ContentType,
      cacheControl: object.CacheControl,
    };
  } catch (error) {
    if (isS3NotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function fetchCustomAsset(originBaseUrl: string, assetPath: string): Promise<StoredObject | undefined> {
  const url = `${originBaseUrl}/${assetPath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new HttpError(502, `custom bucket fetch failed: ${response.status}`);
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? undefined,
    cacheControl: response.headers.get("cache-control") ?? undefined,
  };
}

function resolveSiteRequest(req: Request): ResolvedRequest | undefined {
  const pathParts = req.path.split("/").filter(Boolean);
  const host = req.hostname.toLowerCase();
  const idFromHost = deploymentIdFromHost(host);

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

function deploymentIdFromHost(host: string): string | undefined {
  const hostname = host.split(":")[0];
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return undefined;
  }

  const baseDomain = config.baseDomain;
  if (baseDomain && hostname.endsWith(`.${baseDomain}`)) {
    const subdomain = hostname.slice(0, -(baseDomain.length + 1)).split(".")[0];
    if (!RESERVED_SUBDOMAINS[subdomain]) {
      return normalizeDeploymentId(subdomain);
    }
  }

  const firstLabel = hostname.split(".")[0];
  if (!RESERVED_SUBDOMAINS[firstLabel]) {
    return normalizeDeploymentId(firstLabel);
  }

  return undefined;
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

  const decoded = decodeURIComponent(value).replace(/^\/+/, "");
  if (decoded.length === 0) {
    return undefined;
  }

  const normalized = path.posix.normalize(decoded);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
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

function objectKeyFor(prefix: string, siteId: string, assetPath: string): string {
  return [prefix, siteId, assetPath].map(trimSlashes).filter(Boolean).join("/");
}

function metadataKeyFor(siteId: string): string {
  return `${METADATA_PREFIX}/${siteId}.json`;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function randomDeploymentId(): string {
  return crypto.randomBytes(5).toString("hex");
}

function publicUrlFor(id: string): string {
  if (config.baseDomain) {
    return `https://${id}.${config.baseDomain}`;
  }
  return `/${id}/`;
}

function cacheControlFor(assetPath: string): string {
  if (assetPath.endsWith(".html")) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function isS3NotFound(error: unknown): boolean {
  const s3Error = error as { code?: string; statusCode?: number };
  return s3Error.code === "NoSuchKey" || s3Error.code === "NotFound" || s3Error.statusCode === 404;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  console.error(error);
  res.status(500).json({ error: "internal server error" });
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
