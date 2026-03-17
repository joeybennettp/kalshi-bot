/**
 * Shared Kalshi API client with RSA-PSS authentication.
 * All API calls go through this module.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

const KALSHI_BASE_URLS: Record<string, string> = {
  prod: "https://api.elections.kalshi.com/trade-api/v2",
  demo: "https://demo-api.kalshi.co/trade-api/v2",
};

const MIN_API_INTERVAL_MS = 500;
let lastApiCallTime = 0;

function getEnv(): string {
  return process.env["KALSHI_ENV"] ?? "demo";
}

function getBaseUrl(): string {
  return KALSHI_BASE_URLS[getEnv()] ?? KALSHI_BASE_URLS["demo"]!;
}

function getApiKeyId(): string {
  const key = process.env["KALSHI_API_KEY"] ?? "";
  if (!key) throw new Error("KALSHI_API_KEY is not set");
  return key;
}

let cachedPrivateKey: string | null = null;

function getPrivateKey(): string {
  if (cachedPrivateKey) return cachedPrivateKey;

  const keyPath = process.env["KALSHI_PRIVATE_KEY_PATH"] ?? "";
  if (!keyPath) throw new Error("KALSHI_PRIVATE_KEY_PATH is not set");

  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Private key file not found: ${resolved}`);
  }

  cachedPrivateKey = fs.readFileSync(resolved, "utf-8");
  return cachedPrivateKey;
}

function createSignature(
  timestamp: string,
  method: string,
  requestPath: string,
): string {
  const privateKey = getPrivateKey();

  // Strip query parameters from path
  const cleanPath = requestPath.split("?")[0]!;

  // Message = timestamp + METHOD + path
  const message = `${timestamp}${method.toUpperCase()}${cleanPath}`;

  const signature = crypto.sign("RSA-SHA256", Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString("base64");
}

function getAuthHeaders(method: string, requestPath: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = createSignature(timestamp, method, requestPath);

  return {
    "KALSHI-ACCESS-KEY": getApiKeyId(),
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type": "application/json",
  };
}

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < MIN_API_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_API_INTERVAL_MS - elapsed));
  }
  lastApiCallTime = Date.now();
}

export async function kalshiGet(
  apiPath: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  await rateLimitWait();

  const baseUrl = getBaseUrl();
  const url = new URL(`${baseUrl}${apiPath}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  // Sign with the path (without query params, but with base path)
  const fullPath = `/trade-api/v2${apiPath}`;

  let retries = 0;
  while (retries < 3) {
    const headers = getAuthHeaders("GET", fullPath);
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.status === 429) {
      const wait = 2 ** retries * 1000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      retries++;
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Kalshi API auth error: ${resp.status} — ${body}`);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Kalshi API error: ${resp.status} ${resp.statusText} — ${body}`);
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  throw new Error("Kalshi API rate limit exceeded after retries");
}

export async function kalshiPost(
  apiPath: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await rateLimitWait();

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${apiPath}`;
  const fullPath = `/trade-api/v2${apiPath}`;

  const backoff = [1000, 2000, 4000];
  let retries = 0;

  while (retries <= 3) {
    const headers = getAuthHeaders("POST", fullPath);
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.status === 429) {
      if (retries >= 3) {
        throw new Error("Rate limit exceeded after retries — HALT required");
      }
      await new Promise((resolve) => setTimeout(resolve, backoff[retries] ?? 4000));
      retries++;
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Kalshi API auth error: ${resp.status} — ${body} — HALT required`);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Kalshi API error: ${resp.status} ${resp.statusText} — ${body}`);
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  throw new Error("Unexpected retry exhaustion");
}

export async function kalshiDelete(
  apiPath: string,
): Promise<Record<string, unknown>> {
  await rateLimitWait();

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${apiPath}`;
  const fullPath = `/trade-api/v2${apiPath}`;

  const headers = getAuthHeaders("DELETE", fullPath);
  const resp = await fetch(url, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Kalshi DELETE error: ${resp.status} — ${body}`);
  }

  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

export function getKalshiEnv(): string {
  return getEnv();
}
