# Railway Testing — RM. Sego Abang

Versi ini sengaja dibuat sebagai **staging/test online** sebelum frontend dipindahkan ke Hostinger. Satu Railway service menyajikan frontend + backend.

## 1. Deploy

Upload/push folder project ini ke Railway sebagai source project. Railway akan memakai `railway.json` di root.

Tambahkan PostgreSQL di project Railway dan pastikan `DATABASE_URL` terhubung ke service aplikasi.

## 2. Variables wajib

- `NODE_ENV=production`
- `JWT_SECRET=<acak-panjang-dan-rahasia>`
- `CORS_ORIGIN=https://rmsegoabang.up.railway.app`
- `TABLE_LOCK_MINUTES=10`
- `SEED_OWNER_PASSWORD=<password-uji-owner>`
- `SEED_ADMIN_PASSWORD=<password-uji-admin>`

`DATABASE_URL` diberikan otomatis oleh Railway PostgreSQL.

## 3. Buat database

Setelah PostgreSQL aktif, jalankan `database/schema.sql` sekali. Setelah schema selesai, jalankan:

```bash
npm run seed
```

Jangan menjalankan seed berulang di production jika tidak ingin password akun di-reset. Untuk staging, seed aman dijalankan ulang karena menggunakan upsert pada akun.

## 4. URL staging

Website dan API memakai domain Railway yang sama:

- Website: `https://rmsegoabang.up.railway.app/`
- Health: `https://rmsegoabang.up.railway.app/api/health`
- API: `https://rmsegoabang.up.railway.app/api/...`

Frontend menggunakan `/api` dan `window.location.origin`, sehingga tidak ada `localhost` dependency.

## 5. QRIS

QRIS saat ini **DEMO**. Tidak ada transaksi nyata dan tidak terhubung ke Midtrans/acquirer. Payment tetap `PENDING` sampai admin melakukan verifikasi manual.

## 6. Checklist test

1. Buka homepage dari HP.
2. Buka menu.
3. Pilih meja.
4. Tambahkan makanan.
5. Isi nama, WhatsApp, dan jumlah tamu.
6. Buat booking.
7. Pastikan QRIS demo muncul.
8. Catat booking code.
9. Buka halaman tracking.
10. Login admin.
11. Pastikan booking masuk dashboard.
12. Verifikasi pembayaran sebagai admin.
13. Pastikan status booking berubah menjadi confirmed.
14. Buka receipt.
15. Coba dua browser/HP memilih meja yang sama untuk menguji seat locking.
16. Tunggu lock timeout untuk memastikan meja kembali available.

## 7. Sebelum Hostinger

Nanti saat frontend dipindahkan ke Hostinger:
- ganti canonical/OG/sitemap/robots dari URL Railway ke domain client;
- ganti `CORS_ORIGIN` di Railway ke domain Hostinger;
- jika frontend dan backend beda domain, ubah `API_BASE` dan `SOCKET_URL` dari konfigurasi same-origin staging menjadi URL Railway;
- ganti QRIS demo dengan QRIS resmi client;
- ganti password staging;
- buat backup database sebelum migrasi.
