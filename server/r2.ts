// ============================================================
// server/r2.ts — R28 Cloudflare R2 storage adapter
// ============================================================
//
// Hand-rolled SigV4 over fetch (CF Workers compatible — the
// @aws-sdk/client-s3 SDK has had recurring issues with Workers'
// fetch implementation, so per brief 6.0 decision authority we use
// a tiny SigV4 implementation instead).
//
// Activates only when all four R2_ env vars are set; otherwise the
// caller must fall back to in-memory storage. R2 setup steps live
// in server/cloudflare/README.md.
//
// Endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
// Region:   auto    (R2 ignores region but SigV4 needs a string)
// Service:  s3
// ============================================================

interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function readR2Config(): R2Config | null {
  // Bun.env in dev; in CF Workers these come from `env` bindings
  const accountId       = Bun.env.R2_ACCOUNT_ID || '';
  const bucket          = Bun.env.R2_BUCKET || '';
  const accessKeyId     = Bun.env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = Bun.env.R2_SECRET_ACCESS_KEY || '';
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

// ------------------------------------------------------------
// SigV4 helpers (compact, Workers-fetch compatible)
// ------------------------------------------------------------

async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data)
            : data instanceof Uint8Array ? data
            : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
}

async function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate    = await hmac(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion  = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  return kSigning;
}

async function signV4(req: { method: string; url: URL; headers: Record<string, string>; body?: Uint8Array }, cfg: R2Config) {
  const region  = 'auto';
  const service = 's3';
  const now     = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');     // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);                              // YYYYMMDD

  const payloadHash = await sha256Hex(req.body || new Uint8Array());
  const headers: Record<string, string> = {
    ...req.headers,
    host:           req.url.host,
    'x-amz-date':   amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  // Canonical request
  const sortedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)!].trim()}\n`).join('');
  const signedHeaders    = sortedHeaderKeys.join(';');
  const canonicalRequest = [
    req.method,
    req.url.pathname,
    req.url.search.slice(1),    // query string without leading ?
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign    = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey      = await deriveSigningKey(cfg.secretAccessKey, dateStamp, region, service);
  const signatureBuf    = await hmac(signingKey, stringToSign);
  const signature       = [...new Uint8Array(signatureBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { ...headers, authorization };
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/** Upload a buffer to R2 at <bucket>/<key>. Returns true on 2xx. */
export async function r2Put(cfg: R2Config, key: string, body: Uint8Array, metadata?: Record<string, string>): Promise<boolean> {
  const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`);
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  // R2 metadata must be x-amz-meta-* headers
  if (metadata) for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k.toLowerCase()}`] = v;
  const signed = await signV4({ method: 'PUT', url, headers, body }, cfg);
  const r = await fetch(url.toString(), { method: 'PUT', headers: signed, body });
  if (!r.ok) console.warn('[r2Put]', r.status, await r.text().catch(() => ''));
  return r.ok;
}

/** Download a buffer from R2. Returns null on 404 or signing failure. */
export async function r2Get(cfg: R2Config, key: string): Promise<Uint8Array | null> {
  const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`);
  const signed = await signV4({ method: 'GET', url, headers: {} }, cfg);
  const r = await fetch(url.toString(), { method: 'GET', headers: signed });
  if (r.status === 404) return null;
  if (!r.ok) { console.warn('[r2Get]', r.status); return null; }
  return new Uint8Array(await r.arrayBuffer());
}

/** Delete a key from R2. Used by the daily TTL sweep. Returns true on 204. */
export async function r2Delete(cfg: R2Config, key: string): Promise<boolean> {
  const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key}`);
  const signed = await signV4({ method: 'DELETE', url, headers: {} }, cfg);
  const r = await fetch(url.toString(), { method: 'DELETE', headers: signed });
  return r.ok || r.status === 204 || r.status === 404;
}
