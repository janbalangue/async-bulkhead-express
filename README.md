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

Queued acquisition is aborted by default if the client disconnects before admission. Set `abortOnClientClose: false` only if you have a specific reason to keep queued acquisition alive after disconnect.

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
  onAdmit?: (event: ExpressBulkheadAdmitEvent) => void;
  onReject?: (event: ExpressBulkheadRejectEvent) => void;
  onRelease?: (event: ExpressBulkheadReleaseEvent) => void;
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

- Admission happens before downstream route work begins.
- Rejected requests do not call downstream handlers.
- `maxQueue: 0` gives fail-fast behavior with no queueing.
- `maxQueue > 0` enables bounded waiting.
- `queueWaitTimeoutMs` applies only while waiting for admission.
- Queued acquisition is aborted on client disconnect by default.
- Admitted requests hold capacity until the HTTP lifecycle ends.
- Capacity is released on `finish` or `close`, whichever happens first.
- Duplicate lifecycle events do not double-release capacity.

## Hooks

Hooks are synchronous fire-and-forget observability callbacks:

- `onAdmit`
- `onReject`
- `onRelease`

Hook exceptions are swallowed so observability code does not break request flow.

## Development

```bash
npm test
npm run verify
```
