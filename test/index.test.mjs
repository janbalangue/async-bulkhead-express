import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { createBulkheadMiddleware, createExpressBulkhead } from '../dist/src/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

test('admits and releases on normal completion', async () => {
  const bulkhead = createExpressBulkhead({ name: 'search', maxConcurrent: 1, maxQueue: 0 });
  const app = express();
  app.get('/search', bulkhead.middleware(), async (_req, res) => {
    await sleep(20);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/search`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(bulkhead.stats(), {
      name: 'search',
      inFlight: 0,
      pending: 0,
      maxConcurrent: 1,
      maxQueue: 0,
      closed: false,
    });
  } finally {
    await closeServer(server);
  }
});

test('rejects when saturated and does not call the handler twice', async () => {
  const bulkhead = createExpressBulkhead({ name: 'reports', maxConcurrent: 1, maxQueue: 0 });
  let calls = 0;
  const app = express();
  app.get('/reports', bulkhead.middleware(), async (_req, res) => {
    calls += 1;
    await sleep(150);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/reports`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/reports`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.deepEqual(second.body, {
      error: 'service_unavailable',
      reason: 'bulkhead_rejected',
    });
    assert.equal(calls, 1);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test('shared routes contend for one pool', async () => {
  const bulkhead = createExpressBulkhead({ name: 'payments', maxConcurrent: 1, maxQueue: 0 });
  const app = express();
  app.get('/charge', bulkhead.middleware(), async (_req, res) => {
    await sleep(150);
    res.json({ route: 'charge' });
  });
  app.get('/refund', bulkhead.middleware(), async (_req, res) => {
    res.json({ route: 'refund' });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/charge`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/refund`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, 'bulkhead_rejected');
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test('releases on downstream error path', async () => {
  const bulkhead = createExpressBulkhead({ name: 'error-path', maxConcurrent: 1, maxQueue: 0 });
  const app = express();
  app.get('/boom', bulkhead.middleware(), async () => {
    throw new Error('boom');
  });
  app.use((err, _req, res, _next) => {
    res.status(500).json({ message: err.message });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await jsonResponse(await fetch(`${baseUrl}/boom`));
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: 'boom' });
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test('releases on client disconnect', async () => {
  const bulkhead = createExpressBulkhead({ name: 'disconnect', maxConcurrent: 1, maxQueue: 0 });
  const app = express();
  app.get('/stream', bulkhead.middleware(), async (_req, res) => {
    res.write('chunk');
    await sleep(200);
    if (!res.writableEnded) res.end('done');
  });

  const { server, baseUrl } = await listen(app);
  try {
    const { port } = new URL(baseUrl);
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/stream', method: 'GET' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNRESET') resolve();
        else reject(err);
      });
      req.end();
    });

    await sleep(50);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test('convenience middleware behaves like the reusable instance', async () => {
  const app = express();
  const middleware = createBulkheadMiddleware({ name: 'single-route', maxConcurrent: 1, maxQueue: 0 });
  app.get('/single', middleware, async (_req, res) => {
    await sleep(150);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/single`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/single`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, 'bulkhead_rejected');
  } finally {
    await closeServer(server);
  }
});

test('hooks fire and hook exceptions do not break request flow', async () => {
  const events = [];
  const bulkhead = createExpressBulkhead({
    name: 'hooks',
    maxConcurrent: 1,
    maxQueue: 0,
    onAdmit(event) {
      events.push(['admit', event.path]);
      throw new Error('ignore admit hook failure');
    },
    onReject(event) {
      events.push(['reject', event.reason]);
      throw new Error('ignore reject hook failure');
    },
    onRelease(event) {
      events.push(['release', event.releaseCause]);
      throw new Error('ignore release hook failure');
    },
  });

  const app = express();
  app.get('/hooks', bulkhead.middleware(), async (_req, res) => {
    await sleep(100);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/hooks`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/hooks`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.deepEqual(events.map(([name]) => name), ['admit', 'reject', 'release']);
  } finally {
    await closeServer(server);
  }
});