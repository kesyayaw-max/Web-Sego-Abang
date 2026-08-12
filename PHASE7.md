# PHASE 7 — PAYMENT + WHATSAPP

## What is included

- Server-side price locking for every payment.
- Public payment creation using booking code + secret public token.
- Idempotent payment creation.
- Provider-neutral payment adapter.
- `MOCK` payment provider for safe Railway staging (never moves real money).
- `GENERIC_HTTP` adapter for a licensed QRIS/PJP integration.
- HMAC-SHA256 webhook verification using the exact raw request body.
- Webhook idempotency via `payment_webhook_events`.
- Webhook amount verification against the locked amount.
- Automatic booking/payment status synchronization after verified payment.
- Public payment status endpoint protected by booking token.
- WhatsApp notification abstraction with LOG_ONLY, MOCK, and META_CLOUD modes.
- Reservation created/confirmed/arrived/cancelled and payment-confirmed notification hooks.
- Snapshot-price display bug fixed for reservation items.

## Important production boundary

The application does NOT invent a real QRIS payment payload. Real QRIS collection must use a licensed PJP/provider. The app controls the order amount, creates a locked payment record, and consumes the provider's QR image/reference through the adapter.

For staging use:

```env
PAYMENT_PROVIDER=MOCK
WHATSAPP_PROVIDER=LOG_ONLY
```

No real payment is collected in MOCK mode.

For a real provider, implement/verify the provider contract behind `GENERIC_HTTP`:

Request JSON:
- reference
- amount
- currency
- method=QRIS
- expires_at
- customer.name
- customer.phone
- metadata.booking_id

Expected response JSON:
- reference or provider_reference
- status
- qr_image_url and/or qr_payload
- optional expires_at

Webhook JSON:
- event_id
- booking_id
- status: VERIFIED | REJECTED | EXPIRED
- reference
- amount
- notes

Header:
- `x-payment-signature`: HMAC-SHA256 hex of the exact raw JSON body using `PAYMENT_WEBHOOK_SECRET`.

## WhatsApp

For production, `META_CLOUD` requires an approved WhatsApp Business sender and approved templates where template messaging is required. Do not use WhatsApp Web automation.

## Railway test

1. Fresh PostgreSQL.
2. Run `database/schema.sql` once.
3. Run `node database/seed.js`.
4. Set `PAYMENT_PROVIDER=MOCK` and `WHATSAPP_PROVIDER=LOG_ONLY`.
5. Create an order.
6. Call `/api/payments/create` with booking code + public token.
7. Verify amount equals the server total.
8. Re-send the same idempotency key and confirm only one payment reference exists.
9. Generate a test webhook signature and send `VERIFIED` with the exact locked amount.
10. Confirm booking becomes `CONFIRMED` and payment becomes `PAID`.
11. Send the same webhook event again; it must return `duplicate:true` and must not double-process.
