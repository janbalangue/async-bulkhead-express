# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.
This project adheres to Semantic Versioning.

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
