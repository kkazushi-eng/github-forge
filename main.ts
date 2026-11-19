// Process entry point for the forge.
//
// Everything HTTP-shaped lives behind createApp() in app.ts. This file
// only owns the lifecycle of the process itself: choose a port, bind
// the server, report the bound port back to the make.fun harness when
// one is present, wait for the harness to say the run is over, and
// then close down without leaving handles behind.

import { createApp } from './app.ts';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The harness base URL, normalised once so the rest of the file can
// just concatenate paths onto it. A trailing slash in the env value
// would otherwise produce "//register" style URLs.
const harnessBase: string = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const underHarness: boolean = harnessBase.length > 0;

/** Pause for `ms` milliseconds; used between retry attempts. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Print a fatal problem to stderr and give the process a failing code. */
function fatal(reason: string): never {
  process.stderr.write(`main: ${reason}\n`);
  process.exit(1);
}

/**
 * Decide which port to ask the OS for. An explicit PORT environment
 * variable wins; otherwise 0 lets the kernel pick a free ephemeral
 * port, which is what the harness expects (it learns the real port
 * from the register call below). A malformed PORT is a hard error
 * rather than a silent fallback, since binding the wrong port would
 * fail the run in a much less obvious way.
 */
function requestedPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    fatal(`PORT value "${raw}" is not a usable port number`);
  }
  return parsed;
}

/**
 * Bind the server and resolve with the port it actually ended up on.
 * The resolved value matters when we asked for port 0: only after
 * 'listening' fires does the kernel-assigned port exist.
 */
function bindServer(server: Server, want: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address() as AddressInfo | null;
      if (addr === null || typeof addr.port !== 'number') {
        reject(new Error('server is listening but reports no address'));
        return;
      }
      resolve(addr.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(want);
  });
}

/**
 * Tell the harness which port we bound: POST {"port": N} to
 * "<base>/register". The harness gives the whole boot a 20 second
 * budget, so this runs immediately after listen and retries only
 * briefly — a short growing backoff, giving up well inside the
 * budget so the failure is reported instead of timing out silently.
 */
async function announcePort(port: number): Promise<void> {
  const target = `${harnessBase}/register`;
  const payload = JSON.stringify({ port });
  let delayMs = 200;
  let lastProblem = 'no attempt made';
  // Roughly: attempts at 0, .2, .6, 1.4, 3, 5, 7 ... seconds, capped
  // so the total stays comfortably below the 20s boot budget.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
      lastProblem = `harness answered HTTP ${res.status}`;
      // Drain the body so the connection can be reused/closed cleanly.
      await res.text().catch(() => '');
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 8) {
      await pause(delayMs);
      delayMs = Math.min(delayMs * 2, 2000);
    }
  }
  fatal(`could not register with harness at ${target}: ${lastProblem}`);
}

/**
 * Long-poll "<base>/done" until the harness says the run is finished.
 *
 * The harness holds this request open, so a single GET normally
 * blocks for the whole trial and returns only at the end. Defensive
 * cases are handled anyway: a 2xx whose JSON body explicitly says
 * {"done": false} means "not yet", and transport errors or non-2xx
 * answers are retried after a short wait rather than killing a run
 * that is otherwise healthy.
 */
async function waitForFinish(): Promise<void> {
  const target = `${harnessBase}/done`;
  for (;;) {
    let finished = false;
    try {
      const res = await fetch(target, { method: 'GET' });
      if (res.ok) {
        const text = await res.text();
        finished = true;
        if (text.trim().length > 0) {
          try {
            const parsed: unknown = JSON.parse(text);
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              (parsed as { done?: unknown }).done === false
            ) {
              finished = false;
            }
          } catch {
            // A non-JSON 2xx body still counts as the finish signal.
          }
        }
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(400);
  }
}

// Guards against double shutdown (e.g. /done and SIGTERM racing).
let closing = false;

/**
 * Close the HTTP server and exit with `code`. createApp() already
 * destroys live sockets on close(), so this normally completes at
 * once; the unref'd timer is only a backstop so a stuck close can
 * never hang the process forever.
 */
function shutdown(server: Server, code: number): void {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => {
    process.exit(code);
  }, 3000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    process.exit(code);
  });
}

/** Local runs (and harness runs being interrupted) end on signals. */
function watchSignals(server: Server): void {
  const onSignal = () => {
    shutdown(server, 0);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

/**
 * Bring everything up. Under the harness: bind, register the real
 * port straight away, then sit in the /done poll until told to stop.
 * Without a harness: bind and simply serve until a signal arrives.
 */
async function start(): Promise<void> {
  const server = createApp();
  const boundPort = await bindServer(server, requestedPort());
  process.stdout.write(`forge: listening on port ${boundPort}\n`);
  watchSignals(server);

  if (!underHarness) return;

  await announcePort(boundPort);
  process.stdout.write(`forge: registered with harness at ${harnessBase}\n`);
  await waitForFinish();
  process.stdout.write('forge: harness signalled done, shutting down\n');
  shutdown(server, 0);
}

start().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`main: startup failed: ${detail}\n`);
  process.exit(1);
});
