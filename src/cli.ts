#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import type S3Constructor from "aws-sdk/clients/s3";
import mime from "mime-types";

const CONFIG_FILE_NAME = ".deployrrr.json";
const DEFAULT_BUILD_COMMAND = "npm run build";
const DEFAULT_PREFIX = "sites";

type BucketMode = "public" | "custom";
type Provider = "s3" | "r2";

type CustomBucketConfig = {
  provider: Provider;
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  publicUrl: string;
  forcePathStyle?: boolean;
};

type DeployrrrConfig = {
  serverUrl?: string;
  mode?: BucketMode;
  buildCommand?: string;
  distDir?: string;
  serverToken?: string;
  customBucket?: CustomBucketConfig;
};

type CliOptions = {
  command: string;
  projectDir: string;
  configPath?: string;
  serverUrl?: string;
  mode?: BucketMode;
  buildCommand?: string;
  distDir?: string;
  id?: string;
  serverToken?: string;
  skipBuild: boolean;
};

type LocalFile = {
  absolutePath: string;
  relativePath: string;
  contentType: string;
  size: number;
};

type PublicDeploymentResponse = {
  id: string;
  url: string;
  directUpload?: boolean;
  maxFileSizeBytes?: number;
  uploads?: Array<{
    path: string;
    url: string;
    headers?: Record<string, string>;
  }>;
};

type CustomDeploymentResponse = {
  id: string;
  url: string;
};

function printUsage(exitCode = 0): never {
  const text = `Deployrrr CLI

Usage:
  deployrrr configure [--config .deployrrr.json]
  deployrrr share [projectDir] [options]

Options:
  --mode public|custom          Use the server public bucket or your own S3/R2 bucket.
  --server-url <url>            Request handler base URL, for example https://deployrrr.example.com.
  --server-token <token>         Optional upload token when the handler requires one.
  --build-command <command>     Build command to run in projectDir. Default: npm run build.
  --dist <dir>                  Build output directory. Default: auto-detect dist, build, or out.
  --id <id>                     Optional share id. Uses a random id when omitted.
  --config <path>               Config file. Default: ./.deployrrr.json then ~/.deployrrr.json.
  --no-build                    Upload an existing dist/build/out directory without running a build.
  --help                        Show this help.

Examples:
  deployrrr configure
  deployrrr share --mode public --server-url http://localhost:3000
  deployrrr share ../my-app --mode custom --dist dist
`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printUsage(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);
  let projectDir = process.cwd();
  const options: CliOptions = { command, projectDir, skipBuild: false };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];

    if (!arg.startsWith("--")) {
      projectDir = path.resolve(arg);
      options.projectDir = projectDir;
      continue;
    }

    switch (arg) {
      case "--mode":
        assertValue(arg, next);
        if (next !== "public" && next !== "custom") {
          throw new Error("--mode must be public or custom");
        }
        options.mode = next;
        index += 1;
        break;
      case "--server-url":
        assertValue(arg, next);
        options.serverUrl = next;
        index += 1;
        break;
      case "--server-token":
        assertValue(arg, next);
        options.serverToken = next;
        index += 1;
        break;
      case "--build-command":
        assertValue(arg, next);
        options.buildCommand = next;
        index += 1;
        break;
      case "--dist":
        assertValue(arg, next);
        options.distDir = next;
        index += 1;
        break;
      case "--id":
        assertValue(arg, next);
        options.id = next;
        index += 1;
        break;
      case "--config":
        assertValue(arg, next);
        options.configPath = path.resolve(next);
        index += 1;
        break;
      case "--no-build":
        options.skipBuild = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function assertValue(flag: string, value: string | undefined): asserts value is string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.command === "configure") {
      await configure(options);
      return;
    }

    if (options.command === "share") {
      await share(options);
      return;
    }

    throw new Error(`Unknown command: ${options.command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`deployrrr: ${message}`);
    process.exit(1);
  }
}

async function configure(options: CliOptions) {
  const configPath = options.configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME);
  const existing = loadConfig(configPath, false) ?? {};

  const serverUrl = await prompt("Request handler URL", existing.serverUrl ?? "http://localhost:3000");
  const serverToken = await prompt("Upload token (optional)", existing.serverToken ?? "");
  const modeAnswer = await prompt("Bucket mode: public or custom", existing.mode ?? "public");
  const mode = parseMode(modeAnswer);
  const buildCommand = await prompt("Build command", existing.buildCommand ?? DEFAULT_BUILD_COMMAND);
  const distDir = await prompt("Build output directory", existing.distDir ?? "dist");

  const nextConfig: DeployrrrConfig = {
    serverUrl: normalizeBaseUrl(serverUrl),
    mode,
    buildCommand,
    distDir,
  };
  if (serverToken) {
    nextConfig.serverToken = serverToken;
  }


  if (mode === "custom") {
    const current = existing.customBucket;
    const provider = parseProvider(await prompt("Provider: s3 or r2", current?.provider ?? "r2"));
    const bucket = await prompt("Bucket name", current?.bucket ?? "");
    const regionDefault = provider === "r2" ? "auto" : "us-east-1";
    const region = await prompt("Region", current?.region ?? regionDefault);
    const endpoint = await prompt("Endpoint URL (required for R2, optional for S3)", current?.endpoint ?? "");
    const accessKeyId = await prompt("Access key id", current?.accessKeyId ?? "");
    const secretAccessKey = await prompt("Secret access key", current?.secretAccessKey ?? "");
    const prefix = await prompt("Object prefix", current?.prefix ?? DEFAULT_PREFIX);
    const publicUrl = await prompt("Public bucket URL or custom domain", current?.publicUrl ?? "");

    nextConfig.customBucket = {
      provider,
      bucket,
      region,
      endpoint: endpoint || undefined,
      accessKeyId,
      secretAccessKey,
      prefix: prefix || DEFAULT_PREFIX,
      publicUrl: normalizeBaseUrl(publicUrl),
      forcePathStyle: provider === "r2" || current?.forcePathStyle,
    };
  }

  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote ${configPath}`);
}

async function share(options: CliOptions) {
  const config = resolveConfig(options);
  const serverUrl = normalizeBaseUrl(requireString(options.serverUrl ?? config.serverUrl, "Missing server URL. Pass --server-url or run deployrrr configure."));
  const mode = options.mode ?? config.mode ?? "public";
  const buildCommand = options.buildCommand ?? config.buildCommand ?? DEFAULT_BUILD_COMMAND;
  const id = options.id ? normalizeId(options.id) : undefined;
  const serverToken = options.serverToken ?? config.serverToken;

  if (!options.skipBuild) {
    await runBuild(options.projectDir, buildCommand);
  }

  const distDir = resolveDistDir(options.projectDir, options.distDir ?? config.distDir);
  const files = collectFiles(distDir);
  if (files.length === 0) {
    throw new Error(`No files found in ${distDir}`);
  }

  if (mode === "public") {
    const deployment = await createPublicDeployment(serverUrl, files, serverToken, id);
    if (deployment.uploads) {
      await uploadSignedFiles(files, deployment);
    } else {
      await uploadDirectFiles(serverUrl, files, deployment, serverToken);
    }
    await completeDeployment(serverUrl, deployment.id, serverToken);
    console.log(`Shared ${files.length} files through the public bucket.`);
    const shareUrl = deployment.url.startsWith("/") ? `${serverUrl}${deployment.url}` : deployment.url;
    console.log(`URL: ${shareUrl}`);
    return;
  }

  const bucket = requireCustomBucket(config);
  const deploymentId = id ?? randomId();
  await uploadCustomBucket(files, bucket, deploymentId);
  const originBaseUrl = buildOriginBaseUrl(bucket, deploymentId);
  const deployment = await registerCustomDeployment(serverUrl, deploymentId, originBaseUrl, serverToken);
  console.log(`Shared ${files.length} files through your ${bucket.provider.toUpperCase()} bucket.`);
  const shareUrl = deployment.url.startsWith("/") ? `${serverUrl}${deployment.url}` : deployment.url;
  console.log(`URL: ${shareUrl}`);
}

function resolveConfig(options: CliOptions): DeployrrrConfig {
  if (options.configPath) {
    return loadConfig(options.configPath, true) ?? {};
  }

  const projectConfig = path.join(options.projectDir, CONFIG_FILE_NAME);
  const homeConfig = path.join(os.homedir(), CONFIG_FILE_NAME);
  return loadConfig(projectConfig, false) ?? loadConfig(homeConfig, false) ?? {};
}

function loadConfig(configPath: string, required: boolean): DeployrrrConfig | undefined {
  if (!fs.existsSync(configPath)) {
    if (required) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return undefined;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as DeployrrrConfig;
}

function requireCustomBucket(config: DeployrrrConfig): CustomBucketConfig {
  const bucket = config.customBucket;
  if (!bucket) {
    throw new Error("Missing custom bucket config. Run deployrrr configure or switch to --mode public.");
  }

  const missing = [
    ["bucket", bucket.bucket],
    ["accessKeyId", bucket.accessKeyId],
    ["secretAccessKey", bucket.secretAccessKey],
    ["publicUrl", bucket.publicUrl],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Custom bucket config is incomplete: ${missing.map(([name]) => name).join(", ")}`);
  }

  if (bucket.provider === "r2" && !bucket.endpoint) {
    throw new Error("R2 custom bucket config requires endpoint.");
  }

  return bucket;
}

function requireString(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function parseMode(value: string): BucketMode {
  if (value !== "public" && value !== "custom") {
    throw new Error("Bucket mode must be public or custom");
  }
  return value;
}

function parseProvider(value: string): Provider {
  if (value !== "s3" && value !== "r2") {
    throw new Error("Provider must be s3 or r2");
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("URL cannot be empty");
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(id)) {
    throw new Error("Share id must be 3-63 chars: lowercase letters, numbers, and dashes only.");
  }
  return id;
}

function randomId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let index = 0; index < 8; index += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

async function runBuild(projectDir: string, command: string) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }

  console.log(`Running build in ${projectDir}: ${command}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: projectDir,
      shell: true,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Build failed with exit code ${code}`));
    });
  });
}

function resolveDistDir(projectDir: string, configured?: string): string {
  if (configured) {
    const configuredPath = path.isAbsolute(configured) ? configured : path.join(projectDir, configured);
    if (!fs.existsSync(configuredPath) || !fs.statSync(configuredPath).isDirectory()) {
      throw new Error(`Build output directory not found: ${configuredPath}`);
    }
    return configuredPath;
  }

  for (const candidate of ["dist", "build", "out"]) {
    const candidatePath = path.join(projectDir, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      return candidatePath;
    }
  }

  throw new Error("Build output directory not found. Pass --dist or set distDir in config.");
}

function collectFiles(rootDir: string): LocalFile[] {
  const files: LocalFile[] = [];
  walk(rootDir, files, rootDir);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function walk(currentDir: string, files: LocalFile[], rootDir: string) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, files, rootDir);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = toPosix(path.relative(rootDir, absolutePath));
    files.push({
      absolutePath,
      relativePath,
      contentType: mime.lookup(relativePath) || "application/octet-stream",
      size: fs.statSync(absolutePath).size,
    });
  }
}

async function createPublicDeployment(serverUrl: string, files: LocalFile[], serverToken?: string, id?: string): Promise<PublicDeploymentResponse> {
  const response = await postJson<PublicDeploymentResponse>(`${serverUrl}/api/deployments`, {
    mode: "public",
    id,
    files: files.map((file) => ({
      path: file.relativePath,
      contentType: file.contentType,
      size: file.size,
    })),
  }, serverToken);

  if (response.uploads && response.uploads.length !== files.length) {
    throw new Error("Request handler returned an invalid upload manifest.");
  }
  if (!response.uploads && !response.directUpload) {
    throw new Error("Request handler must return either signed uploads or directUpload=true.");
  }

  return response;
}

async function uploadSignedFiles(files: LocalFile[], deployment: PublicDeploymentResponse) {
  if (!deployment.uploads) {
    throw new Error("Request handler did not return signed upload URLs.");
  }

  const uploadByPath = new Map(deployment.uploads.map((upload) => [upload.path, upload]));

  for (const file of files) {
    const upload = uploadByPath.get(file.relativePath);
    if (!upload) {
      throw new Error(`Request handler did not return an upload URL for ${file.relativePath}`);
    }

    const body = fs.readFileSync(file.absolutePath);
    const response = await fetch(upload.url, {
      method: "PUT",
      headers: {
        "Content-Type": file.contentType,
        ...(upload.headers ?? {}),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Upload failed for ${file.relativePath}: ${response.status} ${await response.text()}`);
    }
  }
}

async function uploadDirectFiles(serverUrl: string, files: LocalFile[], deployment: PublicDeploymentResponse, serverToken?: string) {
  for (const file of files) {
    const encodedPath = file.relativePath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${serverUrl}/api/deployments/${deployment.id}/files/${encodedPath}`, {
      method: "PUT",
      headers: requestHeaders(serverToken, { "Content-Type": file.contentType }),
      body: fs.readFileSync(file.absolutePath),
    });

    if (!response.ok) {
      throw new Error(`Upload failed for ${file.relativePath}: ${response.status} ${await response.text()}`);
    }
  }
}

async function completeDeployment(serverUrl: string, id: string, serverToken?: string) {
  await postJson(`${serverUrl}/api/deployments/${id}/complete`, {}, serverToken);
}

async function uploadCustomBucket(files: LocalFile[], config: CustomBucketConfig, deploymentId: string) {
  process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE ??= "1";
  const S3 = require("aws-sdk/clients/s3") as typeof S3Constructor;
  const s3 = new S3({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region ?? (config.provider === "r2" ? "auto" : "us-east-1"),
    endpoint: config.endpoint,
    s3ForcePathStyle: config.forcePathStyle ?? config.provider === "r2",
    signatureVersion: "v4",
  });

  const prefix = trimSlashes(config.prefix ?? DEFAULT_PREFIX);
  for (const file of files) {
    const key = joinKey(prefix, deploymentId, file.relativePath);
    await s3.upload({
      Bucket: config.bucket,
      Key: key,
      Body: fs.createReadStream(file.absolutePath),
      ContentType: file.contentType,
      CacheControl: cacheControlFor(file.relativePath),
    }).promise();
  }
}

function buildOriginBaseUrl(config: CustomBucketConfig, deploymentId: string): string {
  const prefix = trimSlashes(config.prefix ?? DEFAULT_PREFIX);
  const encodedPath = [prefix, deploymentId]
    .filter(Boolean)
    .flatMap((part) => part.split("/").filter(Boolean))
    .map(encodeURIComponent)
    .join("/");
  return `${normalizeBaseUrl(config.publicUrl)}/${encodedPath}`;
}

async function registerCustomDeployment(serverUrl: string, id: string, originBaseUrl: string, serverToken?: string): Promise<CustomDeploymentResponse> {
  return postJson<CustomDeploymentResponse>(`${serverUrl}/api/deployments`, {
    mode: "custom",
    id,
    originBaseUrl,
  }, serverToken);
}

async function postJson<T = unknown>(url: string, body: unknown, serverToken?: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(serverToken, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

function requestHeaders(serverToken: string | undefined, headers: Record<string, string>): Record<string, string> {
  if (serverToken) {
    return { ...headers, Authorization: `Bearer ${serverToken}` };
  }
  return headers;
}

function cacheControlFor(relativePath: string): string {
  if (relativePath.endsWith(".html")) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function joinKey(...parts: string[]): string {
  return parts.map(trimSlashes).filter(Boolean).join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function prompt(label: string, defaultValue: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${label}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

void main();
