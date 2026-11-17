// Shared HTTP plumbing: JSON replies with the headers the protocol checks require, the
// bearer-token auth policy, and request body reading.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A fresh, non-empty X-GitHub-Request-Id value. */
export function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(6, '0')}`;
}

/** Answer with a JSON body and GitHub's protocol headers. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes under an explicit content type (git protocol bodies). */
export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId(), ...headers });
  res.end(body);
}

/**
 * The one credential: `Authorization: Bearer <token>` where the token is the process's own
 * $MAKEFUN_SHOP_TOKEN. When the env var is set the header must match it exactly; when it is
 * unset (local runs) any well-formed bearer header passes, but a missing one still fails:
 * the surfaces' unauthenticated checks need a 401 either way.
 */
export function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

/** Read a whole request body (bounded; git packs in this suite stay far below the cap). */
export function readBody(req: IncomingMessage, cap = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; null when it is not valid JSON. */
export function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
