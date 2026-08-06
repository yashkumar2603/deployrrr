# Deployrrr

Deployrrr is a CLI-first localhost/share workflow:

1. The user's machine builds the project locally.
2. The CLI uploads the build output to either:
   - the public Cloudflare R2 bucket behind your Worker, or
   - the user's own S3/R2 bucket, using credentials that never leave the user's machine.
3. The Cloudflare Worker request handler serves the shared site from `https://<share-id>.<your-domain>` or from `/<share-id>/` during local testing.

No server-side build worker is required. Build work happens on the CLI only.

## Current Cloudflare target

The Worker config is ready for this R2 bucket:

```text
bucket: deployrrr-2
account S3 API endpoint: https://18868704cdbef5dc6099232fd4aa8158.r2.cloudflarestorage.com
```

The S3 API endpoint includes the account id only. If you use these credentials in custom CLI mode, set:

```text
endpoint=https://18868704cdbef5dc6099232fd4aa8158.r2.cloudflarestorage.com
bucket=deployrrr-2
region=auto
```

Do not commit R2 keys. For Worker public mode, Wrangler uses an R2 binding and does not need the R2 S3 access key or secret in the repo.

## Repo layout

```text
src/cli.ts                   CLI used by end users
worker/src/index.ts          Cloudflare Worker request handler
worker/wrangler.toml         Worker + R2 binding config
request-handler-service/     Old Express handler, kept for non-Cloudflare hosting only
```

## CLI usage

Install and build the CLI from this repo:

```bash
npm install
npm run build
npm link
```

Configure once per project:

```bash
deployrrr configure
```

Share the current project through your public Worker/R2 bucket:

```bash
deployrrr share --mode public --server-url https://api.deployrrr.example.com
```

If you set `UPLOAD_TOKEN` on the Worker, pass the token:

```bash
deployrrr share --mode public \
  --server-url https://api.deployrrr.example.com \
  --server-token '<same-token>'
```

Share through a user's own bucket instead:

```bash
deployrrr share --mode custom --server-url https://api.deployrrr.example.com
```

Useful flags:

```bash
deployrrr share ./my-app --build-command "pnpm build" --dist dist
deployrrr share --no-build --dist dist --id demo-123
deployrrr share --mode public --server-url http://localhost:8787
```

The CLI looks for `.deployrrr.json` in the project directory, then `~/.deployrrr.json`. The config file is gitignored.

### `.deployrrr.json` for public Worker/R2 mode

```json
{
  "serverUrl": "https://api.deployrrr.example.com",
  "serverToken": "<optional-upload-token>",
  "mode": "public",
  "buildCommand": "npm run build",
  "distDir": "dist"
}
```

### `.deployrrr.json` for custom R2 mode

```json
{
  "serverUrl": "https://api.deployrrr.example.com",
  "serverToken": "<optional-upload-token>",
  "mode": "custom",
  "buildCommand": "npm run build",
  "distDir": "dist",
  "customBucket": {
    "provider": "r2",
    "bucket": "deployrrr-2",
    "region": "auto",
    "endpoint": "https://18868704cdbef5dc6099232fd4aa8158.r2.cloudflarestorage.com",
    "accessKeyId": "<r2-access-key>",
    "secretAccessKey": "<r2-secret-key>",
    "prefix": "sites",
    "publicUrl": "https://<public-r2-domain-or-custom-domain>",
    "forcePathStyle": true
  }
}
```

### `.deployrrr.json` for custom S3 mode

```json
{
  "serverUrl": "https://api.deployrrr.example.com",
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

Custom bucket mode requires uploaded objects to be readable by the Worker through `publicUrl`. Credentials stay on the user's CLI; the Worker stores only the share id and public origin URL.

## Worker API

Health check:

```bash
curl http://localhost:8787/healthz
```

Create a public-bucket deployment:

```bash
curl -X POST http://localhost:8787/api/deployments \
  -H 'content-type: application/json' \
  -d '{"mode":"public","id":"demo-123","files":[{"path":"index.html","contentType":"text/html","size":12}]}'
```

Upload a public-bucket file:

```bash
curl -X PUT http://localhost:8787/api/deployments/demo-123/files/index.html \
  -H 'content-type: text/html' \
  --data '<h1>Deployrrr OK</h1>'
```

Complete the deployment:

```bash
curl -X POST http://localhost:8787/api/deployments/demo-123/complete
```

Create a custom-bucket deployment:

```bash
curl -X POST http://localhost:8787/api/deployments \
  -H 'content-type: application/json' \
  -d '{"mode":"custom","id":"demo-123","originBaseUrl":"https://preview-bucket.example.com/sites/demo-123"}'
```

Serve locally by path:

```bash
curl http://localhost:8787/demo-123/
curl http://localhost:8787/demo-123/assets/app.js
```

Serve in production by wildcard DNS:

```bash
curl https://demo-123.deployrrr.example.com/
```

## Cloudflare deployment guide

### 1. Install Cloudflare Worker dependencies

```bash
cd worker
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

Make sure this account owns the `deployrrr-2` R2 bucket.

### 3. Configure `worker/wrangler.toml`

Current bucket binding:

```toml
[[r2_buckets]]
binding = "PUBLIC_BUCKET"
bucket_name = "deployrrr-2"
preview_bucket_name = "deployrrr-2"
```

Set your real domain before production deploy:

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

If you do not have a domain yet, leave routes commented and deploy to the default `workers.dev` URL. Path-mode serving still works there: `https://<worker>.<account>.workers.dev/<share-id>/`.

### 4. Add an upload token secret

Recommended for demos so random users cannot fill your bucket:

```bash
cd worker
npx wrangler secret put UPLOAD_TOKEN
```

Paste any strong random token. Store the same value locally in `.deployrrr.json` as `serverToken`, or pass `--server-token`.

### 5. Deploy Worker

```bash
cd worker
npm run build
npm run deploy
```

### 6. Configure DNS

In Cloudflare DNS, create proxied records for:

```text
api.deployrrr.example.com  proxied target for Worker route
*.deployrrr.example.com    proxied target for Worker route
```

If you use Worker routes, the DNS records only need to exist and be orange-cloud proxied. Cloudflare routes the matching requests to the Worker.

### 7. Configure CLI

Public mode:

```json
{
  "serverUrl": "https://api.deployrrr.example.com",
  "serverToken": "<same-token-as-UPLOAD_TOKEN>",
  "mode": "public",
  "buildCommand": "npm run build",
  "distDir": "dist"
}
```

Then run:

```bash
deployrrr share --mode public
```

## Local verification checklist

Use these before pushing or deploying:

1. Build the CLI:

   ```bash
   npm run build
   node dist/cli.js --help
   ```

2. Build the Worker:

   ```bash
   cd worker
   npm run build
   ```

3. Run the Worker locally:

   ```bash
   cd worker
   npm run dev
   ```

4. In another terminal, create and serve a deployment through local R2:

   ```bash
   curl -X POST http://localhost:8787/api/deployments \
     -H 'content-type: application/json' \
     -d '{"mode":"public","id":"demo-123","files":[{"path":"index.html","contentType":"text/html","size":24}]}'

   curl -X PUT http://localhost:8787/api/deployments/demo-123/files/index.html \
     -H 'content-type: text/html' \
     --data '<h1>Worker local OK</h1>'

   curl -X POST http://localhost:8787/api/deployments/demo-123/complete
   curl http://localhost:8787/demo-123/
   ```

   Expected body contains `Worker local OK`.

5. Verify the CLI against the local Worker:

   ```bash
   mkdir -p /tmp/deployrrr-app/dist
   printf '<h1>CLI Worker OK</h1>' > /tmp/deployrrr-app/dist/index.html
   node dist/cli.js share /tmp/deployrrr-app --no-build --dist dist --mode public --server-url http://localhost:8787 --id cli-worker-demo
   curl http://localhost:8787/cli-worker-demo/
   ```

   Expected body contains `CLI Worker OK`.

## Notes on the provided R2 keys

The R2 access key and secret are intentionally not committed. They are S3 API credentials, not Wrangler login credentials. Use them only for CLI custom R2 mode if you want to test direct user-bucket uploads.

For the Worker public bucket path, Cloudflare's R2 binding handles access internally.
