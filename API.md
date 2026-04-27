# API reference

## Exports

- `createBulkheadMiddleware(options)`
- `createExpressBulkhead(options)`

```ts
interface ExpressBulkhead {
  middleware(): RequestHandler;
  stats(): ExpressBulkheadStats;
  close(): void;
  drain(): Promise<void>;
}
```

Use this when multiple routes should share one capacity pool or when the application needs explicit shutdown/drain handling.

## `createBulkheadMiddleware(options)`

Returns an Express request handler backed by an internal bulkhead instance.

## `createExpressBulkhead(options)`

Returns a reusable object with:

- `middleware(): RequestHandler`
- `stats(): ExpressBulkheadStats`

## Options

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

### `name`

Optional logical bulkhead name attached to stats and hook events.

### `maxConcurrent`

Maximum number of admitted requests that can be in flight at one time.

### `maxQueue`

Maximum number of requests that may wait for capacity. Defaults to `0`, which means fail fast with no queueing.

### `queueWaitTimeoutMs`

Maximum time a queued request may wait for capacity. Applies to queue wait only; it is not a downstream handler timeout.

Timed-out queued requests are rejected with `queue_timeout`.

### `abortOnClientClose`

Whether a queued request should abandon acquisition when the client disconnects before admission. Defaults to `true`.

Aborted queued requests are rejected internally with `request_aborted`; the default response is not written because the client is already gone.

### `skip(req)`

Returns `true` to bypass admission and call the downstream handler immediately.

Typical uses:

- health checks
- CORS preflight
- cheap metadata endpoints
- trusted internal probes

### `pathMode`

Controls the `event.path` value attached to hook events.

- `path`: use `req.path`; default, avoids query-string cardinality
- `originalUrl`: use `req.originalUrl`; includes mounted path and query string
- `route`: use the route label or Express route pattern when available

### `routeLabel`

Adds a stable low-cardinality route label to hook events.

```ts
routeLabel: 'GET /users/:id'
```

or:

```ts
routeLabel: (req) => `${req.method} ${req.route?.path}`
```

If no `routeLabel` is provided, the middleware attempts to infer an Express route pattern.

### `metadata(req)`

Returns request-scoped metadata to attach to `onAdmit`, `onReject`, `onRelease`, and `rejectResponse` context.

Metadata exceptions are swallowed and omitted from the event.

### `rejectResponse(context)`

Custom overload response hook.

```ts
rejectResponse({ res, reason }) {
  res.status(503).json({ code: 'BUSY', reason });
}
```

If `rejectResponse` does not send a response, the default `503` JSON response is used. If it throws, the error is passed to Express `next(err)`.

### Hooks

Hooks are synchronous fire-and-forget callbacks:

```ts
onAdmit?: (event: ExpressBulkheadAdmitEvent) => void;
onReject?: (event: ExpressBulkheadRejectEvent) => void;
onRelease?: (event: ExpressBulkheadReleaseEvent) => void;
```

Hook exceptions are swallowed so observability code does not break request flow.

## Stats

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

## Events

```ts
interface ExpressBulkheadAdmitEvent extends ExpressBulkheadStats {
  method: string;
  path: string;
  route?: string;
  metadata?: Record<string, unknown>;
  admittedAt: number;
  queued: boolean;
  waitMs: number;
}

interface ExpressBulkheadRejectEvent extends ExpressBulkheadStats {
  method: string;
  path: string;
  route?: string;
  metadata?: Record<string, unknown>;
  rejectedAt: number;
  reason: ExpressBulkheadRejectReason;
}

interface ExpressBulkheadReleaseEvent extends ExpressBulkheadStats {
  method: string;
  path: string;
  route?: string;
  metadata?: Record<string, unknown>;
  releasedAt: number;
  durationMs: number;
  releaseCause: 'finish' | 'close';
}
```

## Reject reasons

```ts
type ExpressBulkheadRejectReason =
  | 'bulkhead_rejected'
  | 'bulkhead_closed'
  | 'queue_timeout'
  | 'request_aborted';
```

- `bulkhead_rejected`: concurrency or queue capacity was full
- `bulkhead_closed`: the reusable bulkhead was closed
- `queue_timeout`: the request waited longer than `queueWaitTimeoutMs`
- `request_aborted`: the client disconnected before queued admission

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

## Shutdown behavior

- `close()` closes the underlying bulkhead, rejects pending queued waiters, and prevents future admission.
- `drain()` resolves once in-flight and pending work have reached zero.
