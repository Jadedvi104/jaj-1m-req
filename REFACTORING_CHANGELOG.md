# Security and reliability audit — 2026-09-06

- Bound order idempotency to a canonical request fingerprint and the originating table session, including concurrent unique-conflict recovery. Expired public access also blocks reservation extensions and replays.
- Replaced per-item menu queries with one parameterized batch query using deterministic inventory lock order and a Map lookup. Added an order/product unique index for inventory joins.
- Extracted pure order validation, fingerprinting, and integer-money calculation functions; separated table-session row types from menu row types.
- Made payment confirmations immutable once recorded, acknowledged identical review/refund retries without duplicate events, and removed the extra duplicate-payment lookup. Reservation eligibility uses the database clock.
- Enabled certificate verification, prevented connection-URL TLS overrides, validated pool configuration, preserved original transaction errors, discarded failed-rollback clients, and released connections before retry delays.
- Blocked unauthenticated process-local CRUD routes by default and in production. Explicit opt-in is limited to development mode.
- Added request-size, quantity, integer-money, optional-field, and identifier-length boundaries. Empty webhook configuration now fails closed.
- Coalesced expiry work, drained active worker batches before shutdown, validated Redis TTLs, and handled shutdown during a pending Redis connection.
- Enabled TypeScript strict mode and documented fields populated by DTO transformation using definite-assignment declarations. Hardened generic updates against inherited/prototype-control fields.
- Pinned patched transitive Fastify 5.12.1 and qs 6.16.0 via npm overrides, preserving NestJS 11. Regenerated the lockfile; npm reported zero vulnerabilities after installation.
- Expanded Jest and isolated Fastify HTTP coverage, plus PostgreSQL regression cases for replay ownership, payment evidence preservation, public access expiry, and reversed inventory requests.

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) for findings, verification, migration requirements, and remaining release gates.

## Previous users and products refactoring

- Replaced service inheritance from `CrudService` with explicit feature services and injectable repository contracts. Nest modules bind each contract to its in-memory adapter.
- Confined storage, numeric ID allocation, and copy isolation to a shared map-backed repository; individual lookups, updates, and deletes no longer scan an array.
- Kept missing-record handling in services. Repositories return `null` for absence, and unexpected storage errors propagate unchanged.
- Explicitly select create and update fields so extra runtime properties cannot overwrite IDs or become stored fields. Undefined PATCH values preserve existing data; zero and empty optional descriptions remain valid updates.
- Added explicit controller return types and separate Jest coverage for service delegation, missing resources, dependency failures, adapter isolation, field selection, partial updates, and ID allocation.
- Preserved HTTP routes, response shapes, validation rules, synchronous service signatures, and existing CRUD behavior.

## Scope and deployment limitation

This change refactors the users/products CRUD code identified by CODE_REFACTORING_REVIEW.md. It does not implement the document's entire infrastructure roadmap. Users/products remain process-local and non-durable; their numeric-ID contracts are separate from the existing UUID-based ordering database. A production persistence migration requires an explicit schema and API compatibility decision. The repository contracts currently remain synchronous and will need asynchronous signatures when a remote persistence adapter is introduced.

The installed ts-jest 29.4.12 explicitly supports Jest 30; a major-version downgrade was unnecessary. Provider bindings follow Nest's documented custom-provider pattern: https://docs.nestjs.com/fundamentals/custom-providers.

## Verification

Run `npm run check` for ESLint, TypeScript, unit and isolated HTTP tests with coverage thresholds, and the production build. Live database integration and load tests are separate commands and are not part of this refactor's verification.
