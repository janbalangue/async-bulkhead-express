import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import http from "node:http";
import {
  createBulkheadMiddleware,
  createExpressBulkhead,
} from "../dist/src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function jsonResponse(response) {
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
}

function abortRawRequest(baseUrl, path) {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      () => {
        reject(new Error("queued request unexpectedly received a response"));
      },
    );
    req.on("error", (err) => {
      if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED") resolve();
      else reject(err);
    });
    req.on("close", resolve);
    req.end();
    setTimeout(() => req.destroy(), 20);
  });
}

test("admits and releases on normal completion", async () => {
  const bulkhead = createExpressBulkhead({
    name: "search",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/search", bulkhead.middleware(), async (_req, res) => {
    await sleep(20);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/search`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(bulkhead.stats(), {
      name: "search",
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

test("rejects when saturated and does not call the handler twice", async () => {
  const bulkhead = createExpressBulkhead({
    name: "reports",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  let calls = 0;
  const app = express();
  app.get("/reports", bulkhead.middleware(), async (_req, res) => {
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
      error: "service_unavailable",
      reason: "bulkhead_rejected",
    });
    assert.equal(calls, 1);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test("shared routes contend for one pool", async () => {
  const bulkhead = createExpressBulkhead({
    name: "payments",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/charge", bulkhead.middleware(), async (_req, res) => {
    await sleep(150);
    res.json({ route: "charge" });
  });
  app.get("/refund", bulkhead.middleware(), async (_req, res) => {
    res.json({ route: "refund" });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/charge`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/refund`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "bulkhead_rejected");
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test("releases on downstream error path", async () => {
  const bulkhead = createExpressBulkhead({
    name: "error-path",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/boom", bulkhead.middleware(), async () => {
    throw new Error("boom");
  });
  app.use((err, _req, res, _next) => {
    res.status(500).json({ message: err.message });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await jsonResponse(await fetch(`${baseUrl}/boom`));
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: "boom" });
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test("releases on client disconnect after admission", async () => {
  const bulkhead = createExpressBulkhead({
    name: "disconnect",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/stream", bulkhead.middleware(), async (_req, res) => {
    res.write("chunk");
    await sleep(200);
    if (!res.writableEnded) res.end("done");
  });

  const { server, baseUrl } = await listen(app);
  try {
    const { port } = new URL(baseUrl);
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/stream", method: "GET" },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", (err) => {
        if (err.code === "ECONNRESET") resolve();
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

test("convenience middleware behaves like the reusable instance", async () => {
  const app = express();
  const middleware = createBulkheadMiddleware({
    name: "single-route",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  app.get("/single", middleware, async (_req, res) => {
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
    assert.equal(second.body.reason, "bulkhead_rejected");
  } finally {
    await closeServer(server);
  }
});

test("hooks fire and hook exceptions do not break request flow", async () => {
  const events = [];
  const bulkhead = createExpressBulkhead({
    name: "hooks",
    maxConcurrent: 1,
    maxQueue: 0,
    onAdmit(event) {
      events.push(["admit", event.path]);
      throw new Error("ignore admit hook failure");
    },
    onReject(event) {
      events.push(["reject", event.reason]);
      throw new Error("ignore reject hook failure");
    },
    onRelease(event) {
      events.push(["release", event.releaseCause]);
      throw new Error("ignore release hook failure");
    },
  });

  const app = express();
  app.get("/hooks", bulkhead.middleware(), async (_req, res) => {
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
    assert.deepEqual(
      events.map(([name]) => name),
      ["admit", "reject", "release"],
    );
  } finally {
    await closeServer(server);
  }
});

test("queued request is admitted after earlier request releases", async () => {
  const admits = [];
  const bulkhead = createExpressBulkhead({
    name: "queue-admit",
    maxConcurrent: 1,
    maxQueue: 1,
    onAdmit(event) {
      admits.push(event);
    },
  });
  let calls = 0;
  const app = express();
  app.get("/queued", bulkhead.middleware(), async (_req, res) => {
    calls += 1;
    await sleep(calls === 1 ? 100 : 0);
    res.json({ call: calls });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/queued`);
    await sleep(20);
    const secondPromise = fetch(`${baseUrl}/queued`);
    const first = await jsonResponse(await firstPromise);
    const second = await jsonResponse(await secondPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 2);
    assert.equal(admits.length, 2);
    assert.equal(admits[0].queued, false);
    assert.equal(admits[1].queued, true);
    assert.ok(admits[1].waitMs >= 50);
    assert.equal(bulkhead.stats().pending, 0);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test("queued request times out before capacity is available", async () => {
  const rejects = [];
  const bulkhead = createExpressBulkhead({
    name: "queue-timeout",
    maxConcurrent: 1,
    maxQueue: 1,
    queueWaitTimeoutMs: 25,
    onReject(event) {
      rejects.push(event);
    },
  });
  let calls = 0;
  const app = express();
  app.get("/timeout", bulkhead.middleware(), async (_req, res) => {
    calls += 1;
    await sleep(150);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/timeout`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/timeout`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "queue_timeout");
    assert.equal(calls, 1);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].reason, "queue_timeout");
    assert.equal(bulkhead.stats().pending, 0);
  } finally {
    await closeServer(server);
  }
});

test("queued request aborts on client disconnect before admission", async () => {
  const rejects = [];
  const bulkhead = createExpressBulkhead({
    name: "queued-disconnect",
    maxConcurrent: 1,
    maxQueue: 1,
    onReject(event) {
      rejects.push(event);
    },
  });
  let calls = 0;
  const app = express();
  app.get("/queued-disconnect", bulkhead.middleware(), async (_req, res) => {
    calls += 1;
    await sleep(150);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/queued-disconnect`);
    await sleep(20);
    await abortRawRequest(baseUrl, "/queued-disconnect");
    await sleep(50);

    assert.equal(calls, 1);
    assert.equal(bulkhead.stats().pending, 0);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].reason, "request_aborted");

    const first = await jsonResponse(await firstPromise);
    assert.equal(first.status, 200);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test("custom reject response can shape overload errors", async () => {
  const bulkhead = createExpressBulkhead({
    name: "custom-reject",
    maxConcurrent: 1,
    maxQueue: 0,
    rejectResponse(context) {
      context.res
        .status(503)
        .set("Retry-After", "1")
        .json({ code: "BUSY", bulkhead: context.name, reason: context.reason });
    },
  });
  const app = express();
  app.get("/custom", bulkhead.middleware(), async (_req, res) => {
    await sleep(100);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/custom`);
    await sleep(20);
    const second = await jsonResponse(await fetch(`${baseUrl}/custom`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.headers.get("retry-after"), "1");
    assert.deepEqual(second.body, {
      code: "BUSY",
      bulkhead: "custom-reject",
      reason: "bulkhead_rejected",
    });
  } finally {
    await closeServer(server);
  }
});

test("skip bypasses admission for selected requests", async () => {
  const bulkhead = createExpressBulkhead({
    name: "skip",
    maxConcurrent: 1,
    maxQueue: 0,
    skip: (req) => req.path === "/healthz",
  });
  const app = express();
  app.get("/slow", bulkhead.middleware(), async (_req, res) => {
    await sleep(100);
    res.json({ ok: true });
  });
  app.get("/healthz", bulkhead.middleware(), (_req, res) => {
    res.json({ status: "ok" });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/slow`);
    await sleep(20);
    const health = await jsonResponse(await fetch(`${baseUrl}/healthz`));
    const first = await jsonResponse(await firstPromise);

    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok" });
    assert.equal(first.status, 200);
  } finally {
    await closeServer(server);
  }
});

test("route labels, path mode, and metadata are attached to events", async () => {
  const rejects = [];
  const bulkhead = createExpressBulkhead({
    name: "labels",
    maxConcurrent: 1,
    maxQueue: 0,
    pathMode: "originalUrl",
    routeLabel: "GET /users/:id",
    metadata: (req) => ({ requestId: req.header("x-request-id") }),
    onReject(event) {
      rejects.push(event);
    },
  });
  const app = express();
  app.get("/users/:id", bulkhead.middleware(), async (_req, res) => {
    await sleep(100);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/users/1?debug=true`);
    await sleep(20);
    const second = await jsonResponse(
      await fetch(`${baseUrl}/users/2?debug=false`, {
        headers: { "x-request-id": "req-123" },
      }),
    );
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].path, "/users/2?debug=false");
    assert.equal(rejects[0].route, "GET /users/:id");
    assert.deepEqual(rejects[0].metadata, { requestId: "req-123" });
  } finally {
    await closeServer(server);
  }
});

test("close stops new admission and exposes closed stats", async () => {
  const bulkhead = createExpressBulkhead({
    name: "closed",
    maxConcurrent: 1,
    maxQueue: 1,
  });
  const app = express();
  app.get("/closed", bulkhead.middleware(), (_req, res) => {
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    bulkhead.close();
    const response = await jsonResponse(await fetch(`${baseUrl}/closed`));

    assert.equal(response.status, 503);
    assert.equal(response.body.reason, "bulkhead_closed");
    assert.equal(bulkhead.stats().closed, true);
  } finally {
    await closeServer(server);
  }
});

test("drain resolves after in-flight work completes", async () => {
  const bulkhead = createExpressBulkhead({
    name: "drain",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/drain", bulkhead.middleware(), async (_req, res) => {
    await sleep(80);
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const responsePromise = fetch(`${baseUrl}/drain`);
    await sleep(20);

    let drained = false;
    const drainPromise = bulkhead.drain().then(() => {
      drained = true;
    });

    await sleep(20);
    assert.equal(drained, false);

    const response = await jsonResponse(await responsePromise);
    await drainPromise;

    assert.equal(response.status, 200);
    assert.equal(drained, true);
  } finally {
    await closeServer(server);
  }
});
