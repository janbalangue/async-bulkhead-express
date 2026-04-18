# async-bulkhead-express

Express middleware for fail-fast admission control on overloaded routes.

`async-bulkhead-express` wraps a bulkhead primitive in Express-native middleware so expensive or slow routes can reject overload early instead of quietly dragging down the rest of the app.

## What this package is

- Route-level and router-level admission control for Express
- Local overload isolation with bounded active work
- Shared-capacity protection for related routes
- Fail-fast rejection when protected capacity is full

## What this package is not

- A rate limiter
- A retry library
- A circuit breaker
- A request timeout library
- A distributed quota or cross-instance coordination system

## Why 503 instead of 429?

This package models service overload, not client abuse or per-user quota exhaustion. When a protected route is full, the default response is `503 Service Unavailable` with a small JSON body.

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

## API

`createBulkheadMiddleware(options)`

Creates a single Express middleware function backed by an internal bulkhead instance.

`createExpressBulkhead(options)`

Creates a reusable bulkhead wrapper with:

- `middleware()`: RequestHandler
- `stats()`: ExpressBulkheadStats

Use this form when multiple routes should share one capacity pool.

### `ExpressBulkheadOptions`

```ts
interface ExpressBulkheadOptions {
  name?: string;
  maxConcurrent: number;
  maxQueue?: number;
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

## Lifecycle behavior

- Admission happens before downstream route work begins.
- Rejected requests do not call downstream handlers.
- Admitted requests hold capacity until the HTTP lifecycle ends.
- Capacity is released on finish or close, whichever happens first.
- Duplicate lifecycle events do not double-release capacity.

## Hooks

`v0.1.0` includes synchronous fire-and-forget hooks:

- `onAdmit`
- `onReject`
- `onRelease`

Hook exceptions are swallowed so observability code does not break request flow.

## Current scope for v0.1.0

### Included

- `createExpressBulkhead()`
- `createBulkheadMiddleware()`
- default `503` rejection
- shared bulkhead instances
- `stats()`
- basic hooks
- release-once lifecycle wiring for `finish` and `close`

### Deferred

- custom reject handlers
- metadata attachment
- `skip(req)` support
- queue wait timeout configuration
- reusable instance shutdown passthrough

## Development

```bash
npm test
npm run verify
```
