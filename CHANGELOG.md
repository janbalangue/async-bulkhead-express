# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.
This project adheres to Semantic Versioning.

## [0.3.0] - 2026-05-04

### Added

- Express 4-compatible async error forwarding around middleware execution
- Runtime validation for `options`, `maxConcurrent`, `maxQueue`, and `pathMode`
- Async hook rejection swallowing for `onAdmit`, `onReject`, and `onRelease`
- Richer `stats()` counters, including total admitted/released/rejected counts, Express-mapped rejection reasons, and hook error counts
- JSDoc guidance for route-label cardinality, sub-router mount semantics, local process scope, and HTTP lifecycle scope
- README deployment and observability guidance
- Regression tests for custom reject fallbacks, partial custom responses, async hooks, skipped-route errors, route/metadata callback failures, queued close behavior, `abortOnClientClose: false`, event stats snapshots, and stats counters

### Changed

- `express` is now declared as a peer dependency supporting Express 4.18+ and Express 5.x
- `manual-verify.mjs` is treated as a smoke test via `npm run smoke`; `npm run verify` runs tests and smoke verification
- Timing-sensitive tests now use request latches instead of fixed startup sleeps
- Request wait and hold durations now use monotonic `performance.now()` timing while event timestamps remain wall-clock milliseconds

### Fixed

- Custom reject handlers that partially write a response are now ended instead of leaving clients hanging
- Removed accidental trailing Markdown fence text from the TypeScript source
- Removed deprecated request `aborted` event listener usage in favor of response `close` lifecycle handling
- Removed unreachable route-path handling branch from internal observed-path logic

## [0.2.0] - 2026-04-27

### Added

- `queueWaitTimeoutMs` option for bounding how long queued requests may wait before rejection
- Client-disconnect cancellation while requests are waiting in the bulkhead queue
- `skip(req)` option for bypassing bulkhead admission on selected requests
- `rejectResponse(context)` option for custom overload responses
- `metadata(req)` option for attaching request metadata to hook events
- `routeLabel` option for stable low-cardinality route labels
- `pathMode` option for choosing how request paths are reported in events
- `close()` passthrough on reusable Express bulkhead instances
- `drain()` passthrough on reusable Express bulkhead instances
- `request_aborted` reject reason for queued requests cancelled by client disconnect
- Integration tests for:
  - queued request admission after capacity is released
  - queue wait timeout rejection
  - queued request cancellation on client disconnect
  - accurate queued admit events and wait duration
  - custom reject response handling
  - skipped requests
  - custom route labels
  - metadata propagation
  - path reporting modes
  - reusable instance close behavior
  - reusable instance drain behavior
  
### Changed

- `onAdmit` events now report whether a request waited in queue and how long it waited
- Overload rejection events now include richer request context for custom observability
- Reusable bulkhead instances now expose lifecycle controls in addition to `middleware()` and `stats()`

### Fixed

- Queued requests can no longer wait indefinitely when `queueWaitTimeoutMs` is configured
- Queued requests no longer continue waiting after the client disconnects
- Queued requests no longer report misleading zero wait time after delayed admission
- Client disconnect handling now covers both admitted requests and requests still waiting for admission

## [0.1.0] - 2026-04-17

### Added

- Initial `async-bulkhead-express` release
- `createExpressBulkhead(options)` reusable bulkhead instance API
- `createBulkheadMiddleware(options)` convenience middleware factory
- Route-level fail-fast admission control for Express
- Shared-capacity support across multiple routes using one bulkhead instance
- Default overload rejection with HTTP `503` and JSON response
- `stats()` with minimal Express-facing bulkhead state
- Synchronous `onAdmit`, `onReject`, and `onRelease` hooks
- Release-once lifecycle handling for `finish` and `close`
- Integration tests for:
  - normal admit and release
  - saturation rejection
  - shared-pool contention
  - downstream error-path release
  - client disconnect release
  - convenience wrapper behavior
  - hook execution with swallowed hook errors
- Initial documentation:
  - `README.md`
  - `API.md`
  - `CONCEPTS.md`
- Apache License 2.0
- `NOTICE`

### Deferred

- Custom reject handlers
- Metadata attachment
- `skip(req)` support
- Queue wait timeout configuration
- Reusable instance shutdown passthrough
