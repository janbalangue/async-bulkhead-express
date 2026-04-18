# Concepts

## Bulkheading vs rate limiting

Rate limiting answers a different question:

> How often may requests arrive?

Bulkheading answers:

> How much work may be active right now?

`async-bulkhead-express` protects route capacity under current load. It does not enforce fairness, abuse prevention, or quota policies.

## Fail-fast over queue-first

For `v0.1.0`, the core story is fail-fast admission control: reject work honestly when a protected lane is full instead of hiding overload behind growing latency. Keep `maxQueue` explicit and small when you configure it.

## Shared vs isolated capacity

Use one shared bulkhead when several routes depend on the same constrained downstream resource.

Example:

- `/charge`
- `/refund`
- `/capture`

Use isolated bulkheads when workloads differ in importance or cost.

Example:

- `/search` should stay responsive
- `/reports/export` should fail first under load
