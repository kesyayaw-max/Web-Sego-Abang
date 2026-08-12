# Phase 6 — Production & Owner Table Management

## New
- Owner-only table CRUD: add/edit/delete tables.
- Table photo URL + preview + public reservation display.
- QR regeneration per table.
- Reservation arrival flow: CONFIRMED -> ARRIVED; linked preorder starts COOKING.
- Provider-neutral payment webhook with HMAC signature.
- Print job table prepared for Railway -> local print agent architecture.
- Consolidated schema remains a single `database/schema.sql`.

## Important
- Table photos currently use an HTTPS/HTTP image URL or local path. For production, object storage/CDN is recommended.
- Payment webhook becomes active only after `PAYMENT_WEBHOOK_SECRET` is configured and a provider sends `x-payment-signature`.
- Existing manual QRIS and printer flows remain available for staging.

## Validation
- Run `node --check` against all backend JS files.
- Fresh Railway PostgreSQL: run `database/schema.sql` once, then `npm run seed`.
