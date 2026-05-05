import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import http from "node:http";
import {
  createBulkheadMiddleware,
  createExpressBulkhead,
} from "../dist/src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion, timeoutMs = 500) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await sleep(5);
    }
  }
  if (lastError) throw lastError;
  assertion();
}

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

async function textResponse(response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers,
  };
}

function startRawRequest(baseUrl, path) {
  const { port } = new URL(baseUrl);
  let settled = false;
  let req;
  const promise = new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      () => {
        settle(reject, new Error("queued request unexpectedly received a response"));
      },
    );
    req.on("error", (err) => {
      if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED") {
        settle(resolve);
      } else {
        settle(reject, err);
      }
    });
    req.on("close", () => settle(resolve));
    req.end();
  });
  return { req, promise };
}

test("admits and releases on normal completion", async () => {
  const bulkhead = createExpressBulkhead({
    name: "search",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/search", bulkhead.middleware(), async (_req, res) => {
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await fetch(`${baseUrl}/search`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const stats = bulkhead.stats();
    assert.equal(stats.name, "search");
    assert.equal(stats.inFlight, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.maxConcurrent, 1);
    assert.equal(stats.maxQueue, 0);
    assert.equal(stats.closed, false);
    assert.equal(stats.totalAdmitted, 1);
    assert.equal(stats.totalReleased, 1);
    assert.equal(stats.rejected, 0);
    assert.deepEqual(stats.rejectedByReason, {});
    assert.equal(stats.hookErrors, 0);
  } finally {
    await closeServer(server);
  }
});

test("rejects when saturated and does not call the handler twice", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "reports",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  let calls = 0;
  const app = express();
  app.get("/reports", bulkhead.middleware(), async (_req, res) => {
    calls += 1;
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/reports`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/reports`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.deepEqual(second.body, {
      error: "service_unavailable",
      reason: "bulkhead_rejected",
    });
    assert.equal(calls, 1);
    const stats = bulkhead.stats();
    assert.equal(stats.inFlight, 0);
    assert.equal(stats.totalAdmitted, 1);
    assert.equal(stats.totalReleased, 1);
    assert.equal(stats.rejected, 1);
    assert.equal(stats.rejectedByReason.bulkhead_rejected, 1);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("shared routes contend for one pool", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "payments",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/charge", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ route: "charge" });
  });
  app.get("/refund", bulkhead.middleware(), async (_req, res) => {
    res.json({ route: "refund" });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/charge`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/refund`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "bulkhead_rejected");
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    releaseFirst.resolve();
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
  const releaseHandler = deferred();
  const bulkhead = createExpressBulkhead({
    name: "disconnect",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/stream", bulkhead.middleware(), async (_req, res) => {
    res.write("chunk");
    await releaseHandler.promise;
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

    await waitFor(() => assert.equal(bulkhead.stats().inFlight, 0));
  } finally {
    releaseHandler.resolve();
    await closeServer(server);
  }
});

test("convenience middleware behaves like the reusable instance", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const app = express();
  const middleware = createBulkheadMiddleware({
    name: "single-route",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  app.get("/single", middleware, async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/single`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/single`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "bulkhead_rejected");
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("hooks fire and hook exceptions do not break request flow", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
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
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/hooks`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/hooks`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.deepEqual(
      events.map(([name]) => name),
      ["admit", "reject", "release"],
    );
    assert.equal(bulkhead.stats().hookErrors, 3);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("async hook rejections do not break request flow", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "async-hooks",
    maxConcurrent: 1,
    maxQueue: 0,
    async onAdmit() {
      throw new Error("ignore async admit hook failure");
    },
    async onReject() {
      throw new Error("ignore async reject hook failure");
    },
    async onRelease() {
      throw new Error("ignore async release hook failure");
    },
  });

  const app = express();
  app.get("/async-hooks", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/async-hooks`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/async-hooks`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "bulkhead_rejected");
    await waitFor(() => assert.equal(bulkhead.stats().hookErrors, 3));
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("queued request is admitted after earlier request releases", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
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
    if (calls === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    res.json({ call: calls });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/queued`);
    await firstStarted.promise;
    const secondPromise = fetch(`${baseUrl}/queued`);
    await waitFor(() => assert.equal(bulkhead.stats().pending, 1));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);
    const second = await jsonResponse(await secondPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 2);
    assert.equal(admits.length, 2);
    assert.equal(admits[0].queued, false);
    assert.equal(admits[1].queued, true);
    assert.ok(admits[1].waitMs >= 0);
    assert.equal(bulkhead.stats().pending, 0);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("queued request times out before capacity is available", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
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
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/timeout`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/timeout`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "queue_timeout");
    assert.equal(calls, 1);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].reason, "queue_timeout");
    assert.equal(bulkhead.stats().pending, 0);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("queued request aborts on client disconnect before admission", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
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
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/queued-disconnect`);
    await firstStarted.promise;
    const queued = startRawRequest(baseUrl, "/queued-disconnect");
    await waitFor(() => assert.equal(bulkhead.stats().pending, 1));
    queued.req.destroy();
    await queued.promise;
    await waitFor(() => assert.equal(bulkhead.stats().pending, 0));

    assert.equal(calls, 1);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].reason, "request_aborted");

    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);
    assert.equal(first.status, 200);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("abortOnClientClose false keeps queued acquisition alive after client close", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const rejects = [];
  const bulkhead = createExpressBulkhead({
    name: "queued-no-abort",
    maxConcurrent: 1,
    maxQueue: 1,
    abortOnClientClose: false,
    onReject(event) {
      rejects.push(event);
    },
  });
  let calls = 0;
  const app = express();
  app.get("/queued-no-abort", bulkhead.middleware(), async (_req, res) => {
    calls += 1;
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/queued-no-abort`);
    await firstStarted.promise;
    const queued = startRawRequest(baseUrl, "/queued-no-abort");
    await waitFor(() => assert.equal(bulkhead.stats().pending, 1));
    queued.req.destroy();
    await queued.promise;
    assert.equal(bulkhead.stats().pending, 1);
    assert.equal(rejects.length, 0);

    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);
    await waitFor(() => assert.equal(bulkhead.stats().pending, 0));
    assert.equal(first.status, 200);

    // After the queued client disconnects, admission can race with Node/Express
    // surfacing the close event. If the close is observed before admission, the
    // wrapper releases the token without calling the handler. If admission wins
    // the race, Express may call the handler for an already-closing request. The
    // stable contract for abortOnClientClose: false is that queued acquisition is
    // not rejected as request_aborted and capacity is cleaned up afterward.
    assert.ok(calls === 1 || calls === 2, `expected 1 or 2 calls, got ${calls}`);
    assert.equal(bulkhead.stats().totalAdmitted, 2);
    assert.equal(bulkhead.stats().totalReleased, 2);
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("custom reject response can shape overload errors", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
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
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/custom`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/custom`));
    releaseFirst.resolve();
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
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("custom reject response falls back to default when it sends nothing", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let customCalled = false;
  const bulkhead = createExpressBulkhead({
    name: "custom-noop",
    maxConcurrent: 1,
    maxQueue: 0,
    rejectResponse() {
      customCalled = true;
    },
  });
  const app = express();
  app.get("/custom-noop", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/custom-noop`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/custom-noop`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(customCalled, true);
    assert.deepEqual(second.body, {
      error: "service_unavailable",
      reason: "bulkhead_rejected",
    });
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("custom reject response that partially writes is ended", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "custom-partial",
    maxConcurrent: 1,
    maxQueue: 0,
    rejectResponse(context) {
      context.res.status(503).write("busy");
    },
  });
  const app = express();
  app.get("/custom-partial", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/custom-partial`);
    await firstStarted.promise;
    const second = await textResponse(await fetch(`${baseUrl}/custom-partial`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body, "busy");
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("skip bypasses admission for selected requests", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "skip",
    maxConcurrent: 1,
    maxQueue: 0,
    skip: (req) => req.path === "/healthz",
  });
  const app = express();
  app.get("/slow", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });
  app.get("/healthz", bulkhead.middleware(), (_req, res) => {
    res.json({ status: "ok" });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/slow`);
    await firstStarted.promise;
    const health = await jsonResponse(await fetch(`${baseUrl}/healthz`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok" });
    assert.equal(first.status, 200);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("skip errors are passed to Express error handling", async () => {
  const bulkhead = createExpressBulkhead({
    name: "skip-error",
    maxConcurrent: 1,
    maxQueue: 0,
    skip() {
      throw new Error("skip failed");
    },
  });
  const app = express();
  app.get("/skip-error", bulkhead.middleware(), (_req, res) => {
    res.json({ ok: true });
  });
  app.use((err, _req, res, _next) => {
    res.status(500).json({ message: err.message });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await jsonResponse(await fetch(`${baseUrl}/skip-error`));
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: "skip failed" });
    assert.equal(bulkhead.stats().inFlight, 0);
  } finally {
    await closeServer(server);
  }
});

test("route labels, path mode, and metadata are attached to events", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
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
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/users/1?debug=true`);
    await firstStarted.promise;
    const second = await jsonResponse(
      await fetch(`${baseUrl}/users/2?debug=false`, {
        headers: { "x-request-id": "req-123" },
      }),
    );
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].path, "/users/2?debug=false");
    assert.equal(rejects[0].route, "GET /users/:id");
    assert.deepEqual(rejects[0].metadata, { requestId: "req-123" });
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("routeLabel and metadata errors are omitted from events", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const rejects = [];
  const bulkhead = createExpressBulkhead({
    name: "label-errors",
    maxConcurrent: 1,
    maxQueue: 0,
    pathMode: "route",
    routeLabel() {
      throw new Error("route label failed");
    },
    metadata() {
      throw new Error("metadata failed");
    },
    onReject(event) {
      rejects.push(event);
    },
  });
  const app = express();
  app.get("/label-errors/:id", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/label-errors/1`);
    await firstStarted.promise;
    const second = await jsonResponse(await fetch(`${baseUrl}/label-errors/2`));
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].path, "/label-errors/2");
    assert.equal(rejects[0].route, undefined);
    assert.equal(rejects[0].metadata, undefined);
  } finally {
    releaseFirst.resolve();
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

test("close rejects queued requests", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "close-queued",
    maxConcurrent: 1,
    maxQueue: 1,
  });
  const app = express();
  app.get("/close-queued", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const firstPromise = fetch(`${baseUrl}/close-queued`);
    await firstStarted.promise;
    const secondPromise = fetch(`${baseUrl}/close-queued`);
    await waitFor(() => assert.equal(bulkhead.stats().pending, 1));
    bulkhead.close();
    const second = await jsonResponse(await secondPromise);
    releaseFirst.resolve();
    const first = await jsonResponse(await firstPromise);

    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.equal(second.body.reason, "bulkhead_closed");
    assert.equal(bulkhead.stats().closed, true);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("event stats snapshots are post-transition", async () => {
  const events = [];
  const bulkhead = createExpressBulkhead({
    name: "stats-snapshot",
    maxConcurrent: 1,
    maxQueue: 0,
    onAdmit(event) {
      events.push(["admit", event.inFlight, event.pending, event.totalAdmitted, event.totalReleased]);
    },
    onRelease(event) {
      events.push(["release", event.inFlight, event.pending, event.totalAdmitted, event.totalReleased]);
    },
  });
  const app = express();
  app.get("/stats-snapshot", bulkhead.middleware(), (_req, res) => {
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const response = await jsonResponse(await fetch(`${baseUrl}/stats-snapshot`));
    assert.equal(response.status, 200);
    assert.deepEqual(events, [
      ["admit", 1, 0, 1, 0],
      ["release", 0, 0, 1, 1],
    ]);
  } finally {
    await closeServer(server);
  }
});

test("drain resolves after in-flight work completes", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const bulkhead = createExpressBulkhead({
    name: "drain",
    maxConcurrent: 1,
    maxQueue: 0,
  });
  const app = express();
  app.get("/drain", bulkhead.middleware(), async (_req, res) => {
    firstStarted.resolve();
    await releaseFirst.promise;
    res.json({ ok: true });
  });

  const { server, baseUrl } = await listen(app);
  try {
    const responsePromise = fetch(`${baseUrl}/drain`);
    await firstStarted.promise;

    let drained = false;
    const drainPromise = bulkhead.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    assert.equal(drained, false);

    releaseFirst.resolve();
    const response = await jsonResponse(await responsePromise);
    await drainPromise;

    assert.equal(response.status, 200);
    assert.equal(drained, true);
  } finally {
    releaseFirst.resolve();
    await closeServer(server);
  }
});

test("invalid options fail fast with clear errors", () => {
  assert.throws(
    () => createExpressBulkhead(null),
    /options must be an object/,
  );
  assert.throws(
    () => createExpressBulkhead({ maxConcurrent: 0, maxQueue: 0 }),
    /maxConcurrent must be a positive integer/,
  );
  assert.throws(
    () => createExpressBulkhead({ maxConcurrent: 1, maxQueue: -1 }),
    /maxQueue must be an integer >= 0/,
  );
  assert.throws(
    () =>
      createExpressBulkhead({
        maxConcurrent: 1,
        maxQueue: 0,
        queueWaitTimeoutMs: Number.NaN,
      }),
    /queueWaitTimeoutMs must be a finite number >= 0/,
  );
  assert.throws(
    () =>
      createExpressBulkhead({
        maxConcurrent: 1,
        maxQueue: 0,
        pathMode: "bad-mode",
      }),
    /pathMode must be one of: path, originalUrl, route/,
  );
});
