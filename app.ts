// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and
// MCP over a single in-memory store. main.ts owns the env lifecycle (register, /done);
// this file is only the request surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { readBody, sendJson } from './http-util.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = (req.method ?? 'GET').toUpperCase();

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);
  const url = new URL(req.url ?? '/', 'http://entry');

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, url, body);
    return;
  }
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    await handleGraphQL(req, res, body);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(req, res, body);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repo = decodeURIComponent(gitMatch[2] as string);
    const sub = gitMatch[3] ?? '';
    await handleGit(req, res, url, body, owner, repo, sub);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      // Last-resort guard: a request must never take the process down.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  // Track sockets so close() can end the process promptly even with keep-alive clients.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    for (const socket of sockets) socket.destroy();
    return originalClose(callback);
  }) as typeof server.close;
  return server;
}
