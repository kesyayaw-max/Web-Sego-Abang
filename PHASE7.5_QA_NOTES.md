# Phase 7.5 QA Notes

## Fixed in this build
- Staff login password field is forced to full width.
- Show/hide password control stays inside the field.
- Replaced emoji eye with an inline SVG icon for consistent rendering.
- Added accessible `aria-label` / `aria-pressed` state to the password toggle.
- Added mobile sizing and reduced-motion handling.

## Still required before production
1. Run the full Railway end-to-end checklist (reservation, remote pre-order, QR table, kitchen, payment, cancellation).
2. Configure and verify a real licensed QRIS/PJP provider before enabling real payments.
3. Configure WhatsApp Business Cloud or another approved provider; staging `LOG_ONLY` is not real messaging.
4. Verify database backup + restore.
5. Verify owner/admin authorization and audit-log coverage.
6. Decide production image storage (current menu/table photo fields are URL-based; direct upload/object storage is not yet implemented).
7. Add a reproducible dependency lockfile (`package-lock.json`) before production deployment.
8. Test on real Android/iPhone and desktop browsers, including camera QR scanning.
9. Replace any third-party photo for which commercial usage rights are not confirmed.
