// Entry point: trial lifecycle (register -> serve -> wait for /done) or
// standalone mode for local testing when MAKEFUN_ENV_URL is unset.
//
// Trial contract: bind an ephemeral port (never 8080), POST {"port": n}
// to $MAKEFUN_ENV_URL/register, then long-poll GET /done until
// {"done": true}, then exit 0. Crashing or never registering scores 0.

import { Forge } from './forge.ts';
import { createForgeServer } from './httpd.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerWithRetry(envUrl: string, port: number): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
    } catch {
      // Retry below.
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) return;
      }
    } catch {
      // Retry below.
    }
    await sleep(delay);
    delay = Math.min(2000, delay * 2);
  }
}

async function main(): Promise<void> {
  const forge = new Forge();
  const server = createForgeServer(forge);
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    // Fall back to a hard exit if connections linger.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  if (ENV_URL) {
    // Trial mode: ephemeral port, register, wait for completion.
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await registerWithRetry(ENV_URL, port);
    await waitForDone(ENV_URL);
    server.close();
    process.exit(0);
    return;
  }

  // Standalone mode: PORT env or ephemeral; print the URL for harnesses.
  const requested = Number(process.env.PORT ?? '0');
  const port = Number.isFinite(requested) && requested >= 0 ? requested : 0;
  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  console.error(`[forge-v3] listening on http://127.0.0.1:${actual}`);
}

main().catch((e: unknown) => {
  console.error('[forge-v3] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
