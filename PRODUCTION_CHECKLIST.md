# PHASE 4 — PRODUCTION CHECKLIST

## Railway staging
- [ ] Jalankan `database/migration_phase4.sql` satu kali.
- [ ] `NODE_ENV=production`.
- [ ] `DATABASE_URL`, `JWT_SECRET`, dan CORS origin hanya di environment variables.
- [ ] Backup PostgreSQL dibuat dan restore benar-benar diuji.
- [ ] Endpoint admin tanpa login ditolak.
- [ ] Role admin/kasir/kitchen diuji sesuai hak akses.
- [ ] Helmet/security headers aktif.
- [ ] express-rate-limit aktif.
- [ ] Upload gambar membatasi ukuran dan tipe.
- [ ] Error production tidak membocorkan secret/stack trace.
- [ ] Audit log digunakan untuk aksi penting.

## QRIS
QRIS hanya aktif setelah QRIS merchant resmi client diberikan dan diverifikasi. Jangan menganggap QR yang tampil sebagai pembayaran sukses tanpa verifikasi transaksi. Jangan simpan credential pembayaran di frontend.

## Hostinger cutover
1. Backup Railway.
2. Siapkan database production.
3. Jalankan schema + migration sesuai urutan pada database baru.
4. Isi environment variables production.
5. Smoke test.
6. Tes QR meja dari HP.
7. Tes reservasi + pre-order.
8. Tes order + kitchen.
9. Tes pembayaran.
10. Baru arahkan domain.
