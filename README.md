# RM Sego Abang

Sistem restoran dine-in dengan reservasi jarak jauh, QR meja, pemesanan makanan, pembayaran QRIS/kasir, dashboard admin, dan reservasi.

## Alur pelanggan

### 1. Reservasi dari jarak jauh
Pelanggan dapat:
- memilih tanggal dan jam kunjungan,
- memilih meja yang tersedia,
- memilih makanan terlebih dahulu,
- mengirim reservasi/pesanan sebelum datang.

Tujuannya agar ketika pelanggan tiba, meja dan pesanan sudah dipersiapkan. Jika restoran ingin pembayaran dilakukan di tempat, pelanggan tetap membayar saat tiba melalui QRIS atau kasir.

### 2. Pelanggan datang tanpa reservasi / ingin pesan tambahan
Pelanggan scan QR di meja. QR otomatis mengenali nomor meja sehingga pelanggan tidak perlu memilih meja lagi.

### 3. Pembayaran
Tersedia:
- QRIS — sementara mode demo/manual sampai QRIS merchant resmi client diberikan.
- Bayar di Kasir — kasir/admin mengonfirmasi pembayaran.

## Struktur

```text
frontend/       halaman pelanggan dan dashboard
backend/        API, auth, printer, cron
database/       schema, seed, migration
railway.json    konfigurasi deploy Railway
nixpacks.toml   konfigurasi build Railway
```

## Database Railway

Untuk database baru, jalankan `database/schema.sql` lalu `database/seed.js` sesuai kebutuhan.

Untuk database Railway yang sudah berisi schema lama, jangan menjalankan `schema.sql` ulang. Jalankan migration yang diperlukan satu kali, misalnya `database/migration_reservations.sql`.

## Catatan produksi

- QRIS demo harus diganti dengan QRIS merchant resmi client.
- Penyimpanan foto menu saat ini cocok untuk testing; production sebaiknya menggunakan object storage.
- Uji alur lengkap: reservasi → meja → order → pembayaran → konfirmasi admin → dapur.


## Customer Experience — Phase 3
- Pelanggan dapat mengecek reservasi dengan kode reservasi + nomor WhatsApp.
- Pelanggan dapat membatalkan reservasi yang masih PENDING/CONFIRMED sesuai kebijakan restoran.
- Notifikasi WhatsApp menggunakan service abstraction; Railway testing mencatat event, provider WhatsApp nyata dapat disambungkan kemudian.


## Phase 4
Production hardening includes audit-log schema, user roles, QR token support, QRIS enable flag, and a Hostinger cutover checklist. Existing Helmet and express-rate-limit protections are retained.


## Database Setup (Consolidated)
Untuk deployment fresh, database sekarang cukup menggunakan `database/schema.sql` satu kali. Tidak perlu menjalankan migration_phase1 sampai migration_phase5 satu per satu. Setelah schema selesai, jalankan `node database/seed.js` dengan `SEED_OWNER_EMAIL` dan `SEED_OWNER_PASSWORD`.

## Phase 7

Payment is now provider-neutral with server-side price locking and idempotent webhooks. WhatsApp notifications are provider-neutral and can run in LOG_ONLY/MOCK for staging or META_CLOUD for official WhatsApp Business API delivery.


## Phase 7.5 UI/UX
Visual redesign for Pendopo Wonomarto is included in `frontend/assets/phase75-ui.css`. It is loaded after page-specific styles and does not alter API/business logic.
