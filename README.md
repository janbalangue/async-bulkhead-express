# async-bulkhead-express

Express middleware for fail-fast admission control on overloaded routes.

`async-bulkhead-express` wraps a bulkhead primitive in Express-native middleware so expensive or slow routes can reject overload early instead of quietly dragging down the rest of the app.

## What this package is

- Route-level and router-level admission control for Express
- Local overload isolation with bounded active work
- Shared-capacity protection for related routes
- Fail-fast rejection when protected capacity is full
- Optional bounded queueing with queue wait timeouts
- Express-friendly hooks and custom overload responses

## What this package is not

- A rate limiter
- A retry library
- A circuit breaker
- A downstream request timeout library
- A distributed quota or cross-instance coordination system

## Why 503 instead of 429?

This package models service overload, not client abuse or per-user quota exhaustion. When a protected route is full, the default response is `503 Service Unavailable` with a small JSON body.

```json
{ "error": "service_unavailable", "reason": "bulkhead_rejected" }
```

## Install

```bash
npm i async-bulkhead-express express
```

## Compatibility

This package supports Express 4.18+ and Express 5.x. The middleware does not rely on Express 5-only promise handling; asynchronous middleware failures are forwarded with `next(err)` for compatibility with both major Express lines.

## Quick start

### Protect a single route

```ts
import express from 'express';
import { createBulkheadMiddleware } from 'async-bulkhead-express';

const app = express();

const searchBulkhead = createBulkheadMiddleware({
  name: 'search',
  maxConcurrent: 20,
  maxQueue: 0,
});

app.get('/search', searchBulkhead, async (_req, res) => {
  const results = await search();
  res.json(results);
});
```

### Share one capacity pool across multiple routes

Use a reusable instance when related routes should contend for the same protected capacity.

```ts
import express from 'express';
import { createExpressBulkhead } from 'async-bulkhead-express';

const app = express();

const payments = createExpressBulkhead({
  name: 'payments',
  maxConcurrent: 10,
  maxQueue: 0,
});

app.post('/charge', payments.middleware(), chargeHandler);
app.post('/refund', payments.middleware(), refundHandler);
```

### Use bounded queueing

`maxQueue` allows a small number of requests to wait for capacity. `queueWaitTimeoutMs` bounds how long a queued request can wait.

```ts
const reports = createExpressBulkhead({
  name: 'reports',
  maxConcurrent: 4,
  maxQueue: 8,
  queueWaitTimeoutMs: 250,
});
```

Queued acquisition is aborted by default if the client disconnects before admission. Set `abortOnClientClose: false` only if you have a specific reason to keep queued acquisition alive after disconnect. When a close is observed before admission, the wrapper releases the acquired token without calling downstream handlers. Because Node/Express close events can race with admission, applications should not rely on `abortOnClientClose: false` as a guarantee that a disconnected queued request will never reach the handler.

### Customize overload responses

```ts
const search = createExpressBulkhead({
  name: 'search',
  maxConcurrent: 20,
  maxQueue: 0,
  rejectResponse({ res, reason }) {
    res
      .status(503)
      .set('Retry-After', '1')
      .json({ code: 'BUSY', reason });
  },
});
```

If `rejectResponse` does not send a response, the default `503` JSON response is used.

### Skip selected requests

`skip(req)` lets you apply a bulkhead at router level while bypassing cheap routes such as health checks or CORS preflight.

```ts
const apiBulkhead = createExpressBulkhead({
  name: 'api',
  maxConcurrent: 50,
  maxQueue: 0,
  skip: (req) => req.path === '/healthz' || req.method === 'OPTIONS',
});

app.use('/api', apiBulkhead.middleware(), apiRouter);
```

### Add observability labels and metadata

Use `routeLabel` to keep metrics low-cardinality and `metadata(req)` to attach request-scoped details to hook events.

```ts
const users = createExpressBulkhead({
  name: 'users',
  maxConcurrent: 15,
  maxQueue: 5,
  routeLabel: 'GET /users/:id',
  metadata: (req) => ({ requestId: req.header('x-request-id') }),
  onReject(event) {
    metrics.increment('bulkhead.reject', {
      bulkhead: event.name,
      route: event.route,
      reason: event.reason,
    });
  },
});
```

## API

`createBulkheadMiddleware(options)`

Creates a single Express middleware function backed by an internal bulkhead instance.

`createExpressBulkhead(options)`

Creates a reusable bulkhead wrapper with:

- `middleware()`: RequestHandler
- `stats()`: ExpressBulkheadStats
- `close()`: void
- `drain()`: Promise<void>

Use this form when multiple routes should share one capacity pool or when the app needs explicit shutdown/drain behavior.

### `ExpressBulkheadOptions`

```ts
interface ExpressBulkheadOptions {
  name?: string;
  maxConcurrent: number;
  maxQueue?: number;
  queueWaitTimeoutMs?: number;
  abortOnClientClose?: boolean;
  skip?: (req: Request) => boolean;
  pathMode?: 'path' | 'originalUrl' | 'route';
  routeLabel?: string | ((req: Request) => string | undefined);
  metadata?: (req: Request) => Record<string, unknown> | undefined;
  rejectResponse?: (context: ExpressBulkheadRejectResponseContext) => void | Promise<void>;
  onAdmit?: (event: ExpressBulkheadAdmitEvent) => void | Promise<void>;
  onReject?: (event: ExpressBulkheadRejectEvent) => void | Promise<void>;
  onRelease?: (event: ExpressBulkheadReleaseEvent) => void | Promise<void>;
}
```

### `ExpressBulkheadStats`

```ts
interface ExpressBulkheadStats {
  name?: string;
  inFlight: number;
  pending: number;
  maxConcurrent: number;
  maxQueue: number;
  closed: boolean;
  totalAdmitted: number;
  totalReleased: number;
  rejected: number;
  rejectedByReason: Partial<Record<ExpressBulkheadRejectReason, number>>;
  aborted?: number;
  timedOut?: number;
  doubleRelease?: number;
  inFlightUnderflow?: number;
  hookErrors: number;
}
```

### Reject reasons

```ts
type ExpressBulkheadRejectReason =
  | 'bulkhead_rejected'
  | 'bulkhead_closed'
  | 'queue_timeout'
  | 'request_aborted';
```

## Lifecycle behavior

- `maxConcurrent` must be a positive integer.
- `maxQueue` must be a non-negative integer.
- `queueWaitTimeoutMs`, when set, must be a finite number greater than or equal to zero.
- Admission happens before downstream route work begins.
- Rejected requests do not call downstream handlers.
- `maxQueue: 0` gives fail-fast behavior with no queueing.
- `maxQueue > 0` enables bounded waiting.
- `queueWaitTimeoutMs` applies only while waiting for admission.
- Queued acquisition is aborted on client disconnect by default.
- Admitted requests hold capacity until the HTTP lifecycle ends.
- Capacity is released on `finish` or `close`, whichever happens first.
- Duplicate lifecycle events do not double-release capacity.
- Hook event stats are post-transition snapshots: admit events report stats after admission, release events report stats after release, and reject events report stats after rejection.

## Hooks

Hooks are fire-and-forget observability callbacks:

- `onAdmit`
- `onReject`
- `onRelease`

Synchronous hook exceptions and asynchronous hook rejections are swallowed so observability code does not break request flow. Hooks are not awaited by request handling.


## Deployment and observability guidance

### Size limits per process

Bulkheads are local to the Node.js process that creates them. If an app runs four worker processes, containers, or pods, each process gets its own independent `maxConcurrent` and `maxQueue` capacity. For example, `maxConcurrent: 10` on four pods can allow up to forty concurrent protected requests across the deployment.

Pick initial values from the constrained resource you are protecting, such as database connections, CPU-heavy work, downstream concurrency, or expensive queue consumers. Start with `maxQueue: 0` for fail-fast behavior when latency matters. Use a small queue only when brief bursts are normal and a bounded wait is better than immediate rejection.

### Alert on sustained rejection, not isolated bursts

Use `stats().rejected`, `stats().rejectedByReason`, and hook events to distinguish overload causes:

- `bulkhead_rejected`: capacity and queue are full
- `queue_timeout`: a queued request waited longer than `queueWaitTimeoutMs`
- `request_aborted`: the client disconnected before queued admission
- `bulkhead_closed`: new work was rejected because the bulkhead was closed

`totalAdmitted`, `totalReleased`, `inFlight`, and `pending` are useful for dashboards. `doubleRelease`, `inFlightUnderflow`, and `hookErrors` are diagnostic counters; non-zero values are worth investigating.

### Keep metric labels low-cardinality

Prefer `name` and `routeLabel` values such as `search`, `payments`, `GET /users/:id`, or `API router`. Avoid raw paths that contain user IDs, request IDs, search terms, tenant IDs, or query strings as metric labels. Put those values in logs or tracing metadata instead.

When middleware is mounted before a sub-router, Express may not know the final leaf route yet. In that setup, set `routeLabel` explicitly if you need stable route-level metrics:

```ts
app.use(
  '/api',
  createBulkheadMiddleware({
    name: 'api',
    maxConcurrent: 50,
    maxQueue: 0,
    routeLabel: 'API router',
  }),
  apiRouter,
);
```

### HTTP lifecycle scope

Admitted requests hold capacity until Express emits `finish` or `close` on the response, whichever happens first. Queued request cancellation uses the request/response/socket `close` lifecycle for client disconnect detection. This package does not cancel downstream work, enforce application-level request timeouts, or coordinate capacity across machines.


## License

Apache-2.0. See [LICENSE](LICENSE).

## Development

```bash
npm test
npm run smoke
npm run verify
```
