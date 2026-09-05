# Users and products refactoring

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
