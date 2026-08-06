# Deployrrr

Deployrrr is a CLI for sharing a local static web app quickly. The build runs on the user's machine, files are uploaded to S3-compatible object storage, and a lightweight Cloudflare Worker serves the preview URL.

```text
local project -> deployrrr CLI -> Cloudflare Worker -> R2/S3 objects -> preview URL
```

## What it does

- Builds locally with your existing command, for example `npm run build` or `pnpm build`.
- Uploads the output directory, usually `dist`, `build`, or `out`.
- Supports two storage modes:
  - `public`: upload to the R2 bucket configured by the Deployrrr Worker.
  - `custom`: upload directly to your own S3/R2 bucket, then register the public origin URL with the Worker.
- Serves previews by path during local/dev usage: `https://<worker>/<share-id>/`.
- Serves previews by wildcard subdomain when DNS is configured: `https://<share-id>.<your-domain>/`.

## Repository layout

```text
src/cli.ts                   CLI used by end users
worker/src/index.ts          Cloudflare Worker request handler
worker/wrangler.toml         Worker + R2 binding config
request-handler-service/     Legacy Express handler for non-Cloudflare hosting
```

## Use the CLI

### Install from source

```bash
git clone https://github.com/yashkumar2603/deployrrr.git
cd deployrrr
npm install
npm run build
npm link
```

Check it:

```bash
deployrrr --help
```

### Configure a project

From the project you want to share:

```bash
deployrrr configure
```

This writes `.deployrrr.json`. Keep it local; it may contain an upload token or bucket credentials and is gitignored.

### Share a project

```bash
deployrrr share
```

Useful overrides:

```bash
deployrrr share ./my-app --build-command "pnpm build" --dist dist
deployrrr share --no-build --dist dist --id demo-123
deployrrr share --mode public --server-url https://your-worker.workers.dev --server-token '<upload-token>'
```

## CLI config examples

### Public Worker/R2 mode

Use this when you own or were given access to a Deployrrr Worker.

```json
{
  "serverUrl": "https://your-worker.workers.dev",
  "serverToken": "<optional-upload-token>",
  "mode": "public",
  "buildCommand": "npm run build",
  "distDir": "dist"
}
```

### Custom Cloudflare R2 mode

Use this when each user uploads to their own R2 bucket. The Worker receives only the share id and public origin URL; the bucket credentials stay on the user's machine.

```json
{
  "serverUrl": "https://your-worker.workers.dev",
  "serverToken": "<optional-upload-token>",
  "mode": "custom",
  "buildCommand": "npm run build",
  "distDir": "dist",
  "customBucket": {
    "provider": "r2",
    "bucket": "my-preview-bucket",
    "region": "auto",
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "accessKeyId": "<r2-access-key>",
    "secretAccessKey": "<r2-secret-key>",
    "prefix": "sites",
    "publicUrl": "https://<public-r2-domain-or-custom-domain>",
    "forcePathStyle": true
  }
}
```

### Custom AWS S3 mode

```json
{
  "serverUrl": "https://your-worker.workers.dev",
  "serverToken": "<optional-upload-token>",
  "mode": "custom",
  "buildCommand": "npm run build",
  "distDir": "dist",
  "customBucket": {
    "provider": "s3",
    "bucket": "my-preview-bucket",
    "region": "us-east-1",
    "accessKeyId": "<aws-access-key>",
    "secretAccessKey": "<aws-secret-key>",
    "prefix": "sites",
    "publicUrl": "https://my-preview-bucket.s3.amazonaws.com"
  }
}
```

## Self-host the Worker on Cloudflare

### 1. Create or choose an R2 bucket

Create an R2 bucket for public-mode uploads. The default local config expects:

```toml
[[r2_buckets]]
binding = "PUBLIC_BUCKET"
bucket_name = "deployrrr-2"
preview_bucket_name = "deployrrr-2"
```

Change `bucket_name` in `worker/wrangler.toml` if your bucket has a different name.

### 2. Install Worker dependencies

```bash
cd worker
npm install
```

### 3. Log in to Cloudflare

```bash
npx wrangler login
```

Use the Cloudflare account that owns the R2 bucket.

### 4. Add an upload token

Recommended. Without this, anyone who can reach your Worker can upload files.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npx wrangler secret put UPLOAD_TOKEN
```

Paste the generated token. Put the same token in your local `.deployrrr.json` as `serverToken`.

For local Worker development, create `worker/.dev.vars`:

```text
UPLOAD_TOKEN=<same-token>
```

`worker/.dev.vars` is gitignored.

### 5. Deploy to workers.dev

```bash
cd worker
npm run build
npm run deploy
```

Wrangler prints a URL like:

```text
https://deployrrr-handler.<account-subdomain>.workers.dev
```

Use that as `serverUrl`.

### 6. Optional: use your own domain

Edit `worker/wrangler.toml`:

```toml
routes = [
  { pattern = "api.deployrrr.example.com/*", zone_name = "deployrrr.example.com" },
  { pattern = "*.deployrrr.example.com/*", zone_name = "deployrrr.example.com" }
]

[vars]
BASE_DOMAIN = "deployrrr.example.com"
PUBLIC_PREFIX = "sites"
METADATA_PREFIX = "_deployrrr/sites"
MAX_FILE_SIZE_BYTES = "104857600"
```

In Cloudflare DNS, create proxied placeholder records:

```text
api.deployrrr.example.com   AAAA  100::   Proxied
*.deployrrr.example.com     AAAA  100::   Proxied
```

Then redeploy:

```bash
cd worker
npm run deploy
```

Now use this CLI config:

```json
{
  "serverUrl": "https://api.deployrrr.example.com",
  "serverToken": "<same-token-as-UPLOAD_TOKEN>",
  "mode": "public",
  "buildCommand": "npm run build",
  "distDir": "dist"
}
```

## Local development and verification

### Build everything

```bash
npm run build
cd worker
npm run build
```

### Run Worker locally

```bash
cd worker
npm run dev
```

### Manual API smoke test

```bash
curl http://localhost:8787/healthz

curl -X POST http://localhost:8787/api/deployments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <UPLOAD_TOKEN>' \
  -d '{"mode":"public","id":"demo-123","files":[{"path":"index.html","contentType":"text/html","size":24}]}'

curl -X PUT http://localhost:8787/api/deployments/demo-123/files/index.html \
  -H 'content-type: text/html' \
  -H 'authorization: Bearer <UPLOAD_TOKEN>' \
  --data '<h1>Worker local OK</h1>'

curl -X POST http://localhost:8787/api/deployments/demo-123/complete \
  -H 'authorization: Bearer <UPLOAD_TOKEN>'

curl http://localhost:8787/demo-123/
```

Expected body:

```html
<h1>Worker local OK</h1>
```

### CLI smoke test

```bash
mkdir -p /tmp/deployrrr-app/dist
printf '<h1>CLI Worker OK</h1>' > /tmp/deployrrr-app/dist/index.html

node dist/cli.js share /tmp/deployrrr-app \
  --no-build \
  --dist dist \
  --mode public \
  --server-url http://localhost:8787 \
  --server-token '<UPLOAD_TOKEN>' \
  --id cli-worker-demo

curl http://localhost:8787/cli-worker-demo/
```

## Worker API

```text
GET  /healthz
POST /api/deployments
PUT  /api/deployments/:id/files/:path
POST /api/deployments/:id/complete
GET  /:id/*
GET  https://:id.<BASE_DOMAIN>/*
```

### Create public deployment

```json
{
  "mode": "public",
  "id": "demo-123",
  "files": [
    { "path": "index.html", "contentType": "text/html", "size": 24 }
  ]
}
```

Response:

```json
{
  "id": "demo-123",
  "url": "/demo-123/",
  "directUpload": true,
  "maxFileSizeBytes": 104857600
}
```

### Create custom-origin deployment

```json
{
  "mode": "custom",
  "id": "demo-123",
  "originBaseUrl": "https://preview-bucket.example.com/sites/demo-123"
}
```

## Security notes

- Do not commit `.deployrrr.json`, `.env`, `worker/.dev.vars`, or bucket credentials.
- Use `UPLOAD_TOKEN` for any public Worker.
- Rotate keys if they were pasted into chat, logs, screenshots, or issue trackers.
- Public mode stores files and metadata in your R2 bucket under `sites/*` and `_deployrrr/sites/*`.
- Custom mode requires the user's bucket objects to be readable through `publicUrl`.

## Cloudflare free-tier fit

This is designed for demos and low-traffic preview sharing:

- Workers Free has a large daily request allowance for demo traffic.
- R2 has a free monthly storage/operation allowance.
- R2 egress is free.
- Worker direct uploads are limited by Cloudflare request body limits; keep individual files under `MAX_FILE_SIZE_BYTES`.
