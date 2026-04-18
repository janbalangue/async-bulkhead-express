# API reference

## Exports

- `createBulkheadMiddleware(options)`
- `createExpressBulkhead(options)`

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
  onAdmit?: (event: ExpressBulkheadAdmitEvent) => void;
  onReject?: (event: ExpressBulkheadRejectEvent) => void;
  onRelease?: (event: ExpressBulkheadReleaseEvent) => void;
}
```

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

## Lifecycle behavior

- Admission happens before downstream route work begins.
- Rejected requests do not call downstream handlers.
- Admitted requests hold capacity until the HTTP lifecycle ends.
- Capacity is released on `finish` or `close`, whichever happens first.
- Duplicate lifecycle events do not double-release capacity.

## v0.1.0 deferred

- custom reject handlers
- metadata attachment
- `skip(req)` support
- queue wait timeout configuration
- reusable instance shutdown passthrough
