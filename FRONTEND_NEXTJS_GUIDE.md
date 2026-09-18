# Next.js Frontend Build Guide

## 1. Baseline and purpose

This guide describes how to build a web frontend for the restaurant ordering API in this repository. It is an implementation plan, not an existing frontend or a statement that the backend is production-ready.

- Baseline: latest **local `main`** commit inspected, `ef75378afd1296850348ab18763d9df02b83ecf1`.
- Commit: `Merge testing into main`, September 8, 2026, 15:06:06, Asia/Bangkok.
- Prepared: September 8, 2026. Remote `main` was not fetched for this document.
- Existing application: NestJS API, PostgreSQL, transactional outbox, Kafka-compatible messaging, and Docker Compose.
- Proposed addition: an independently built Next.js application under `frontend/`; preserve the existing backend structure.

Earlier requirements mentioned Supabase Cloud. The baseline [README](./README.md) now identifies Azure Database for PostgreSQL Flexible Server for cloud development. The frontend should depend on the NestJS API, not on either database provider. Staff authentication remains unimplemented and its provider is not selected in this commit.

The earlier native iOS/Android requirement remains separate. This plan proposes a responsive guest web experience and staff web screens; it does not claim that Next.js replaces native apps, Bluetooth printing, or device synchronization.

### Source of truth

The contracts below were checked against these files at the baseline commit. Links open the checked-out versions, which may change after that commit:

- [HTTP setup and validation](./src/app.setup.ts).
- [Table-session controller](./src/table-sessions/table-sessions.controller.ts), [request DTO](./src/table-sessions/dto/create-table-session.dto.ts), and [service](./src/table-sessions/table-sessions.service.ts).
- [Order controller](./src/orders/orders.controller.ts), [request DTO](./src/orders/dto/create-order.dto.ts), [policy](./src/orders/order-policy.ts), [service](./src/orders/orders.service.ts), and [response type](./src/orders/order.types.ts).
- [Payment confirmation service](./src/payments/payments.service.ts).
- [Initial schema](./database/migrations/001_initial_schema.sql) and [idempotency migration](./database/migrations/002_order_request_fingerprint.sql).
- [Local deployment](./compose.yaml), [security release gates](./SECURITY_AUDIT.md), and [test guidance](./TESTING.md).

## 2. What to build first

Start with one narrow flow: validate a table code, select menu items, reserve an order, show its payment-pending state, and retrieve its status. Menu selection initially needs explicit development fixtures because a production menu-reading endpoint does not exist. Real-money checkout must remain disabled until the bank integration and payment-status contract are ready.

### Guest screens

1. **Table entry:** open the permanent table QR link, enter the rotating code displayed at the table, and create a short-lived session. Display the verified branch/table when a backend context endpoint becomes available; URL values alone are not verification.
2. **Menu:** show Thai/English names, VAT-inclusive THB prices, size choices, spice choices, and daily availability. Make branch context prominent. Actual menu data requires a new backend contract.
3. **Cart:** adjust quantities before submission, collect customer name and phone, and show a final review. A size price replaces the base price in the current backend; it is not an additional surcharge.
4. **Reserved order/payment:** display the authoritative total, public reference, sequential display number, and reservation countdown. Show the one-time extension when eligible. A genuine bank QR is a later backend dependency.
5. **Order status:** distinguish payment pending, paid/awaiting staff acceptance, processing, delivered, failed, expired, and temporarily unreachable states. Never interpret a network error as a failed payment.
6. **Expired access/help:** explain that the link is no longer available and direct the customer to staff with the order reference. Do not infer that an inaccessible order was cancelled.

Customer edits stop after order creation. A new cart is a separate purchase, not an edit to an existing reservation. Each device places its own order; do not implement a shared table bill.

### Staff screens: design now, connect later

- Sign-in and assigned-branch selection.
- Branch queue ordered by confirmed payment time, with staff acceptance moving an order to processing.
- Kitchen display and whole-order completion to delivered.
- Equal-value substitutions and manual partial-refund records, with mandatory audit reasons and customer coordination.
- Menu, branch prices, sizes, daily availability, and branch-specific promotions.
- Staff assignments, order reporting, popular products, and audit history.

The schema defines `corporation_admin`, `branch_manager`, `cashier`, `kitchen_staff`, and `service_staff`. It does **not** implement their authentication or permissions. Proposed defaults are corporation-wide administration for corporation administrators, assigned-branch management for branch managers, payment operations for cashiers, preparation for kitchen staff, and service/completion for service staff. Confirm and enforce a complete action-permission policy in the backend before enabling these screens. Hiding a button is not authorization.

Bluetooth printing, POS integration, native push setup, and device-side/offline synchronization remain deferred. A browser prototype must not present those features as working integrations.

## 3. Application architecture

Use Next.js App Router with TypeScript. Keep NestJS responsible for prices, inventory locks, idempotency, payments, tenant permissions, and audit records.

```text
Guest browser / staff browser
    -> HTTPS -> Next.js pages and same-origin /api/* route handlers
                    -> private NestJS /api/* endpoints
                            -> PostgreSQL + transactional outbox
                            -> Kafka-compatible broker
                                    -> future consumers / real-time gateway
```

Next.js is a presentation layer plus a thin backend-for-frontend (BFF), not a second order-processing backend. Its Route Handlers are public HTTP endpoints and need their own validation and access checks. Server Components should call the internal NestJS API directly rather than making a loopback request to their own Route Handlers. See the official [backend-for-frontend guidance](https://nextjs.org/docs/app/guides/backend-for-frontend).

Use Server Components for layouts and initial reads; use focused Client Components for cart interactions, forms, countdowns, and live status. Keep privileged API helpers behind `import 'server-only'`; pass only safe, serializable data into Client Components. See [Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components).

The browser must never connect directly to PostgreSQL or Kafka, receive bank webhook credentials, or import backend services. Do not add a Supabase database client as a shortcut around the existing transaction and reservation rules.

### Proposed directory layout

```text
frontend/
  package.json
  package-lock.json
  next.config.ts
  .env.example
  src/
    app/
      layout.tsx
      [locale]/
        layout.tsx
        (guest)/
          table/[branchId]/[tablePublicId]/page.tsx
          menu/page.tsx
          cart/page.tsx
          orders/[reference]/page.tsx
        (staff)/
          staff/login/page.tsx
          staff/branches/[branchId]/orders/page.tsx
          staff/branches/[branchId]/menu/page.tsx
      api/
        table-sessions/route.ts
        orders/route.ts
        orders/[reference]/route.ts
        orders/[reference]/extend/route.ts
    features/
      table-session/
      menu/
      cart/
      orders/
      staff/
    components/ui/
    lib/
      server/backend.ts
      server/session.ts
      contracts/
      money.ts
      time.ts
    messages/
      th.json
      en.json
  tests/
    unit/
    integration/
    e2e/
```

These are proposed frontend routes, not existing backend routes. Route groups organize layouts without changing URLs. Use locale values `th` and `en`, with Thai as the initial default. Add loading, error, and not-found boundaries around guest and staff flows.

## 4. Initial setup

Run these commands from the repository root **when implementing the frontend**; this documentation change does not run them:

```bash
npx create-next-app@latest frontend --ts --eslint --tailwind --app --src-dir --use-npm --import-alias "@/*" --disable-git
cd frontend
npm run dev -- --port 3001
```

Use Node.js 22 or a newer supported LTS release, consistent with the backend. At scaffold time, select a stable Next.js release, review its generated dependencies, and commit the frontend lockfile. Use `npm ci` in CI rather than resolving `latest` on every build. The official [installation guide](https://nextjs.org/docs/app/getting-started/installation) describes the supported setup and generator options.

The backend already occupies host port 3000. Run the frontend on `http://localhost:3001` and put this server-only value in `frontend/.env.local`:

```dotenv
BACKEND_API_BASE_URL=http://localhost:3000/api
```

Commit a placeholder `.env.example`, not `.env.local`. Do not prefix this internal setting or any secret with `NEXT_PUBLIC_`. In a frontend container on the existing Compose network, the value becomes `http://api:3000/api`; `localhost` inside that container would point to itself.

The existing API does not enable browser CORS. The proposed browser-to-Next.js-to-NestJS path is same-origin from the browser's perspective and avoids needing broad CORS permissions. A future direct-browser API deployment must configure an explicit origin policy instead.

### Repository integration checklist

- Keep frontend dependencies, TypeScript settings, ESLint configuration, and tests separate from the NestJS package.
- Narrow the root TypeScript project to backend sources or explicitly exclude `frontend/`. Its current broad configuration can otherwise include nested frontend TypeScript during backend checks.
- Exclude frontend build output and dependencies from backend lint discovery and Docker build context; retain a dedicated frontend Docker build context.
- Add frontend dependency, build, test, and type-check steps to CI without replacing `npm run check` for the API.
- Use development-only fixtures with matching database IDs. The current schema needs a corporation, branch, active table/code, products, branch prices, and today's Bangkok inventory before a real reservation can succeed. There is no complete seed workflow supplied by this guide.

## 5. Existing API contracts

All paths below are **NestJS** paths. A BFF may wrap them, but must document any changed response shape. JSON dates arrive as strings, despite the backend's internal `Date` type. Unknown request fields are rejected; do not send cart UI state, client-calculated prices, or unimplemented promotion fields.

### Create a table session

`POST /api/table-sessions` — HTTP 201 on success.

```json
{
  "branchId": "00000000-0000-4000-8000-000000000001",
  "tablePublicId": "00000000-0000-4000-8000-000000000002",
  "rotatingCode": "current-code-from-the-table"
}
```

Response shape:

```ts
type TableSessionResponse = {
  sessionId: string;
  expiresAt: string; // ISO timestamp; schema default is 30 minutes after creation
};
```

IDs must be UUIDs. The code must be a nonblank string, at most 128 characters. Invalid/expired codes return HTTP 400. This endpoint validates a code; it does not issue or rotate codes, return a table label, or prove that a code has never been copied remotely.

For the web app, prefer a secure, HttpOnly, SameSite session cookie containing an opaque handle to server-side table context. Bind that context to the branch/table session and enforce its expiry in the BFF. This is new frontend-server work, not existing authentication. If using a session store, make it shared across frontend replicas. Support multiple tabs with explicit flow IDs or reject branch-context changes visibly; a single silently overwritten branch cookie can misroute a cart.

### Create an order

`POST /api/orders` — HTTP 201 on success, including successful idempotent replays.

Required header: `Idempotency-Key`, containing 1–128 visible ASCII characters with no spaces. A generated UUID is suitable.

```json
{
  "branchId": "00000000-0000-4000-8000-000000000001",
  "tableSessionId": "00000000-0000-4000-8000-000000000004",
  "customerName": "Guest",
  "customerPhone": "+66812345678",
  "items": [
    {
      "productId": "00000000-0000-4000-8000-000000000003",
      "quantity": 2,
      "sizeCode": "large",
      "spiceLevel": "medium"
    }
  ]
}
```

Frontend wire type for order responses:

```ts
type OrderResponse = {
  id: string;
  publicReference: string;
  displayNumber: string;
  status: string;
  totalSatang: number;
  currency: 'THB';
  reservationExpiresAt: string;
  extensionUsed: boolean;
  paymentReference?: string;
};
```

Contract rules:

- Customer name and phone are required, nonblank strings, with maximum lengths 100 and 30 respectively. The current phone validation is not OTP verification or a complete phone-format validator.
- An order contains 1–100 distinct products; each quantity is an integer from 1–1,000. Duplicate product IDs are rejected even if their size or spice differs. Until the backend supports distinct variant lines, allow only one size/spice selection per product in an order and explain this limitation in the cart.
- Optional `sizeCode` and `spiceLevel` values must be nonblank strings of at most 30 characters. Omit unused fields; do not send `null`. The backend checks size availability but currently does not validate spice values against a menu-option catalogue.
- Money is integer satang: `12050` means THB 120.50. The order total cannot exceed `2147483647` satang. The server calculates the payable amount and reserves all requested items atomically.
- The reservation lasts ten minutes. A successful response means **reserved**, not paid or accepted by staff.
- `displayNumber` is a string representing a branch-local, Bangkok-business-day sequence. It is neither globally unique nor an access credential; use `publicReference` for the public order URL.
- `paymentReference` is currently a synthetic `KB-<publicReference>` reference. It is **not** a PromptPay QR payload or proof that a bank payment request exists.
- Responses do not include order items, table number, customer details, payment-review state, `paidAt`, or public-link expiry. A local cart snapshot is not a server-issued receipt.

### Read status and extend a reservation

`GET /api/orders/:publicReference` — HTTP 200 with `OrderResponse`; HTTP 404 for missing or expired public access. The schema defaults public access to 30 minutes after order creation. The response does not expose that expiry or renew access.

`PATCH /api/orders/:publicReference/extend` — no body; HTTP 200 with `OrderResponse` when the order is still pending payment, both access and reservation are unexpired, and the extension has not been used. It adds five minutes to the **existing deadline**, not five minutes from the click. Ineligible requests return HTTP 409. The extension response currently omits `paymentReference`; preserve it from earlier state or retrieve the order again.

The extension call is not replay-idempotent: after a successful but lost response, another extension attempt returns 409. Retrieve the order and check `extensionUsed`/the deadline before reporting failure.

### Error handling

- **400:** validation failure, invalid session, unavailable product, or unavailable size. Preserve the cart and show a useful next action.
- **404:** unavailable public order; show expired/not-found access without leaking whether another order exists.
- **409:** inventory conflict, conflicting/expired idempotency replay, or rejected extension. Recover according to the operation; never treat all conflicts as permission to place another order.
- **429, if added by the deployment:** respect `Retry-After` and avoid repeated automatic submissions.
- **Timeout/network/5xx:** the outcome of a write may be unknown. Retry order creation only with the original key and unchanged payload.

NestJS validation errors can have a `message` array, while service exceptions generally have a string. Normalize both in the client. Stable machine-readable error codes are a recommended backend addition; avoid building permanent business logic around English error text. Unexpected statuses should render a safe fallback rather than crash the page.

### Endpoints that must not power the frontend

`/api/users` and `/api/products` are in-memory development CRUD examples. They return 404 unless explicitly enabled in development and are always blocked in production. They are not staff authentication or the database-backed restaurant menu.

`POST /api/webhooks/kbank/payments` is an interim bank-confirmation adapter. Never expose its secret to the browser, proxy it through a public BFF handler, or provide a customer-facing “mark as paid” action. Test payment transitions using server-side test fixtures only.

## 6. Checkout correctness and recovery

Implement an explicit client flow: editing cart → submitting → reserved/payment pending → confirmed paid. Treat staff processing and delivery as server-reported later states.

1. On the first submit, freeze the normalized request payload and generate one idempotency key. Persist the attempt before sending it, preferably in a short-lived server-side flow record so customer details do not need durable browser storage.
2. Disable duplicate clicks for usability, but rely on backend idempotency for correctness. The BFF forwards the same key, not a fresh key per request.
3. After a timeout, retain the same key, payload, and table session. Provide “Check/retry this order,” not “Create another order.” Reordering items or changing UUID letter case is tolerated by the backend; other payload changes are not.
4. On success, store the public reference in the active flow and navigate to status. Clear the editable cart only after the order response has been recorded.
5. If replay returns 409, do not silently generate a new key. A session mismatch, changed request, old order without a fingerprint, or expired public access may be the cause. Escalate unresolved outcomes to staff rather than risking a duplicate purchase.
6. A browser reload or BFF restart must not lose an unresolved attempt. Test recovery from shared flow storage. Once the backend's replay access window expires, a staff reconciliation workflow is needed; the current API has no public lookup by idempotency key.

A pending/expired countdown is advisory. Derive remaining time from the returned deadline, recompute after tab focus, and refresh state at zero. Do not free inventory, declare payment failure, or create a replacement reservation in the browser. Request a server-time field in a future contract to reduce clock-skew confusion.

The payment service can record late or mismatched payments as `review_required` without exposing that payment state through the public order response. Until a safe payment-status endpoint exists, the frontend cannot reliably distinguish “not paid yet” from “money received but needs reconciliation.” Real-money launch is blocked on this gap.

## 7. Data fetching, freshness, and real-time updates

Use explicit `cache: 'no-store'` for server-side session/order/payment/staff reads and private, no-store response headers for their BFF responses. Never place references, customer-specific HTML, or staff data in shared CDN caches. Public menu descriptions may later be cached by branch and locale with deliberate invalidation; cached availability remains advisory because inventory is checked again at reservation time.

For an initial development status screen, use one non-overlapping polling loop per visible order, for example every 3–5 seconds with jitter and exponential backoff on transient failures. Pause while hidden/offline, refresh on focus/reconnect, and stop on inaccessible or terminal orders. An optional client query library can manage these concerns, but avoid multiple independent polls in child components.

This polling interval does **not** meet the requested under-one-second update target. Production needs an authenticated/scoped SSE or WebSocket gateway backed by backend events, plus a snapshot read after reconnect. Kafka publication alone does not push anything to a browser. Consumers must tolerate duplicated events; a future client protocol should include event IDs and order versions to prevent stale updates from moving state backward.

Polling also consumes the traffic budget: 100,000 active clients polling every five seconds produce roughly 20,000 status requests/second before menu reads or writes. Include this load, BFF overhead, connection fan-out, and reconnect storms in capacity tests. Do not advertise 50,000 RPS, 99.99% availability, zero data loss, or five-minute recovery as achieved by choosing Next.js; these remain system-wide goals requiring measurement and operational design.

## 8. Security, privacy, and accessible UX

- Treat public order references as bearer capabilities: redact them from access logs, analytics, error reports, and session replay. Avoid third-party scripts on checkout/status pages; use a no-referrer policy and exclude these routes from indexing and link previews containing order data.
- Keep table codes out of permanent URLs and logs. A rotating code can still be copied while valid; it limits the access window but does not technically prove physical proximity. Add rate limiting and code/session abuse controls before public rollout.
- Cookie-backed BFF mutations need strict allowed-Origin checks and a CSRF protection strategy in addition to SameSite cookies. Validate payloads, UUIDs, and request size; permit only known upstream routes and methods, not an arbitrary URL proxy.
- Backend authorization must independently enforce corporation, assigned branch, role, and action for staff operations. Never trust a branch ID, claimed role, or hidden UI control from the browser.
- Use HTTPS, secure production cookies, an appropriate Content Security Policy, safe error responses, request deadlines, and bounded retries. Avoid unescaped HTML from menu descriptions.
- Do not store phone numbers, codes, staff tokens, or payment details in durable local storage. Expire temporary server-side checkout/session records promptly; clear UI query caches on logout and branch-context changes.
- The requested one-year, first-anniversary retention rule belongs in a reviewed backend retention process, including backups and logs. This guide does not certify legal compliance. Display an appropriate privacy notice and keep customer details off public kitchen/receipt views unless explicitly needed and authorized.
- Format THB from integer satang using locale-aware display; keep calculations in integers. Prices must be VAT-inclusive, but the current response does not provide a tax breakdown or implement promotions. Do not calculate an unofficial discount or tax invoice in the browser.
- Use `Asia/Bangkok` for business-day labels and staff reporting. Keep transport timestamps as ISO strings and do not derive order sequence dates from the user's device timezone.
- Make Thai and English translations explicit, with large touch targets, keyboard support, associated form labels, visible focus, and screen-reader status announcements. Do not announce a countdown every second or communicate status by colour alone.
- Keep the reference and last-known status visible during a connection problem. Never show a fake success state. Kitchen sounds require browser audio permission/user interaction and must have a visual equivalent.

## 9. Backend contracts needed before full integration

The following are **proposals, not existing endpoints**. Final route names can be agreed during implementation.

1. **Guest context/menu:** verified branch/table labels, localized products, allowed spices, size prices, prep estimates, VAT-inclusive pricing, availability, and a menu version. Suggested routes: `GET /api/table-sessions/current` and `GET /api/branches/:branchId/menu`; define session credentials explicitly.
2. **Bank payment intent/status:** actual KBank QR payload or image, exact payable amount, expiry, reconciliation/review status, and safe recovery instructions. Reference-only payment lookup must not expose bank-sensitive data. Complete official webhook verification and reconciliation before enabling payments.
3. **Order detail/access:** immutable line snapshots, table label, server time, public-access deadline, safe payment state, and a version. Define how a customer gets assistance when access expires before fulfillment completes.
4. **Staff identity and permissions:** sign-in, session refresh/logout, current identity, branch assignments, and enforced per-action authorization. Provider selection is still open.
5. **Staff fulfillment:** paginated/filterable branch queue, confirmed payment time, accept/process/deliver transitions, audited equal-value substitutions, and manual partial-refund recording. Add concurrency/version checks so two staff devices cannot silently overwrite one another.
6. **Administration:** database-backed corporation/branch/menu/size/inventory management, promotions, staff assignments, reports, and audit access. A table existing in PostgreSQL is not an API contract.
7. **Live delivery:** scoped subscriptions, snapshot/version recovery, duplicate handling, and later notification-token registration. Browser push and native push need separate capability and permission design.

Do not ship dummy controls that appear to complete any of these operations. Mark mock screens visibly as demonstrations and gate them out of production.

## 10. Docker and release plan

Add a separate `frontend/Dockerfile` and a `web` service in a later implementation change; do not merge frontend dependencies into the API image. Use a multi-stage build, locked dependencies, a non-root runtime, and Next.js standalone output. Include the generated standalone server, `.next/static`, and `public/` assets in the runtime image. A Node.js runtime is required by this BFF design; static export is not suitable. Follow the official [self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting).

For local Compose, the proposed web service listens on container port 3000, maps host `3001:3000`, and sets `BACKEND_API_BASE_URL=http://api:3000/api`. Keep the existing API host mapping intact. Add a web health endpoint; validate upstream readiness separately and show graceful failure if NestJS is unavailable. No Compose change is included in this document.

For production, use a TLS reverse proxy/CDN, a private API connection, and independent frontend/API scaling. Place dynamic services close to the database region to reduce latency. Share any BFF flow/session store across replicas; process memory is not sufficient for restart recovery. Cache only public content intentionally and test replica consistency if shared Next.js caching is introduced.

Keep bank/database/Kafka credentials out of the web image. Add redacted request correlation and metrics for checkout latency, ambiguous outcomes, errors, status freshness, and reconnects. Deploy backward-compatible API contracts before frontend code that requires them; retain an independently deployable previous frontend image for rollback.

## 11. Implementation sequence and acceptance criteria

### Phase 1 — Foundation and clearly marked prototype

- Scaffold `frontend/`, isolate build configuration, add Thai/English layout and reusable accessible controls.
- Implement typed contract validation, safe API forwarding, expiring flow storage, error normalization, and fixtures.
- Build table entry, menu/cart prototype, reservation, extension, and status screens.
- Acceptance: a seeded local order reserves once, survives a lost response/reload without duplication, and displays server-confirmed status. No real-money or operational staff controls are enabled.

### Phase 2 — Complete guest ordering

- Add verified table context and real menu contracts, then bank intent/status and reconciliation support.
- Replace fixtures and synthetic payment presentation with real integration data.
- Acceptance: exact payment succeeds once; mismatch/late payment produces a clear help/review state; sold-out items cannot oversell; expired access cannot leak an order.

### Phase 3 — Staff operations

- Implement authentication, branch authorization, queue, acceptance, processing/delivery, and audited substitutions/manual refunds.
- Add protected menu/inventory administration and branch promotions when their backend rules are ready.
- Acceptance: an unassigned staff user cannot read or change another branch, including by calling endpoints directly; conflicting staff updates are detected.

### Phase 4 — Reliability and release gate

- Add event-driven status, reconnect recovery, production rate limits, monitoring, privacy controls, and representative sustained peak tests.
- Acceptance: measured end-to-end status freshness meets the under-one-second target under agreed load; latency/error targets are defined and measured across BFF, API, database, and event delivery.
- Keep printing/offline/native-device work separate unless explicitly brought back into scope.

### Test checklist

- Unit: satang formatting, size-price replacement, duplicate-product limitation, request freezing, retry keys, countdown/extension logic, and Thai/English labels.
- Contract: actual serialized response types, missing optional `paymentReference`, string/array errors, strict DTO rejection, and future unknown statuses.
- Integration: valid/expired codes, branch mismatch, all-or-nothing stock reservation, same-key replay, changed-payload conflicts, and extension response loss.
- Browser end-to-end: guest checkout on mobile widths, keyboard-only flow, reload during submission, offline/reconnect, multiple-tab branch isolation, expired links, and both languages.
- Security: CSRF rejection, no secret values in client bundles, no private shared caching, redacted logs, and direct cross-branch authorization tests when staff APIs exist.
- Payment: server-side fixtures for duplicate/exact/late/mismatched confirmations; never test by exposing webhook credentials to browser automation.
- Deployment: independent frontend/backend builds, container smoke test, session recovery across replicas, rollback compatibility, and planned load test including polling or live connections.

Run frontend lint, type checks, unit/contract tests, browser tests, and a production build in CI alongside the existing backend checks. This document has been checked against the baseline source; none of the proposed frontend functionality or capacity targets has been implemented or benchmarked by this documentation change.
