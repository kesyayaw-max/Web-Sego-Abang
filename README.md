# Rm. Sego Abang — Sistem Reservasi Meja & QRIS Statis Manual

Blueprint sistem lengkap: database, backend (Node.js/Express), dan mockup dashboard admin (Tailwind CSS).

## Struktur folder

```
rm-sego-abang/
├── database/
│   └── schema.sql              # Skema PostgreSQL lengkap + seed data
├── backend/
│   ├── server.js                # Entry point Express + Socket.IO + cron
│   ├── db.js                    # Pool koneksi & helper transaksi
│   ├── package.json
│   ├── middleware/
│   │   └── auth.js              # JWT auth + otorisasi role OWNER/ADMIN
│   ├── routes/
│   │   ├── auth.js              # Login staf
│   │   ├── bookings.js          # SEAT LOCKING + konfirmasi pembayaran
│   │   └── menu.js              # Menu, kategori (owner-only), toggle stok
│   ├── cron/
│   │   └── tableCleaner.js      # Background worker pembersih 10 menit
│   └── services/
│       └── printService.js      # Cetak struk dapur ESC/POS otomatis
└── frontend/
    └── admin-dashboard.html     # Mockup dashboard admin (Tailwind CSS)
```

## Cara menjalankan (development)

1. **Database**
   ```bash
   createdb sego_abang
   psql -U postgres -d sego_abang -f database/schema.sql
   ```
   Ganti hash password di seed `users` dengan hasil `bcrypt.hash()` sungguhan sebelum dipakai produksi.

2. **Backend**
   ```bash
   cd backend
   npm install
   cp .env.example .env   # isi DB_HOST, DB_USER, JWT_SECRET, dll (buat file ini sendiri)
   npm run dev
   ```
   Server berjalan di `http://localhost:4000`. Cron job pembersih meja otomatis aktif saat server start.

3. **Frontend dashboard admin (mockup)**
   Buka langsung `frontend/admin-dashboard.html` di browser — mockup ini memakai data simulasi (mock) di JavaScript agar bisa langsung dilihat tanpa backend berjalan. Gunakan tombol "Owner / Admin" di sidebar bawah untuk mensimulasikan kedua peran.

   Untuk menghubungkan ke backend sungguhan, ganti bagian `DATA MOCK` di `<script>` dengan pemanggilan:
   - `GET /api/tables` — render live map
   - `GET /api/menus` — render daftar stok
   - `GET /api/categories` — render kelola kategori
   - Socket.IO client (`socket.io-client`) mendengarkan event `table:status_changed`, `menu:stock_changed`, `kitchen:receipt_printed`.

## Alur kunci sistem

1. **Seat Locking**: `POST /api/bookings` mengunci baris meja dengan `SELECT ... FOR UPDATE` di dalam transaksi database, sehingga dua pelanggan yang klik meja sama dalam sepersekian detik tidak akan berhasil mengunci meja yang sama (race condition tercegah di level database, bukan hanya di frontend).
2. **Auto-expire**: `cron/tableCleaner.js` berjalan tiap 15 detik, mencari booking `PENDING_PAYMENT` yang `expires_at < now()`, lalu mengembalikan meja ke `AVAILABLE` dan menyiarkannya lewat Socket.IO.
3. **Konfirmasi manual + cetak otomatis**: `POST /api/bookings/:id/confirm-payment` (khusus role OWNER/ADMIN) mengubah status booking & meja, lalu langsung memanggil `printService.printKitchenReceipt()` untuk mencetak ke printer thermal dapur.
4. **Hak akses**: middleware `requireRole('OWNER')` memproteksi seluruh endpoint CRUD kategori & menu master (nama, harga). Endpoint toggle stok (`PATCH /api/menus/:id/stock`) dan konfirmasi pembayaran memakai `requireRole('OWNER', 'ADMIN')` karena keduanya adalah tugas operasional harian kasir.

## Hal yang perlu disesuaikan sebelum produksi

- Ganti `JWT_SECRET` dan seluruh kredensial di `.env`, jangan commit ke git.
- IP/port printer thermal dapur (`kitchen_printer_ip`, `kitchen_printer_port`) diatur lewat tabel `restaurant_settings`, ubah sesuai jaringan restoran.
- Untuk multi-instance backend (load balanced), pertimbangkan memindah cron job ke worker terpisah dengan job queue (BullMQ + Redis) agar tidak dieksekusi ganda.
- Tambahkan HTTPS, refresh token, dan audit log login untuk keamanan produksi.
