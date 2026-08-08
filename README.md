# Rm. Sego Abang — Sistem Reservasi Meja & QRIS Statis Manual

Sistem lengkap: database, backend (Node.js/Express), frontend statis
(landing page, menu, pesan meja, lacak pesanan, struk digital, dashboard
admin), dan Print Agent lokal untuk struk dapur.

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
│   │   └── auth.js              # JWT auth + otorisasi role OWNER/ADMIN + auth Print Agent
│   ├── routes/
│   │   ├── auth.js              # Login staf, refresh token, kelola staf
│   │   ├── bookings.js          # SEAT LOCKING + konfirmasi pembayaran
│   │   ├── menu.js              # Menu, kategori (owner-only), toggle stok
│   │   ├── settings.js          # Pengaturan restoran
│   │   └── printQueue.js        # API antrean cetak untuk Print Agent lokal
│   ├── services/
│   │   ├── printService.js      # Kelola antrean cetak (print_jobs)
│   │   └── auditService.js      # Helper pencatatan audit log
│   ├── print-agent/              # Proses terpisah, JALAN DI KOMPUTER KASIR/DAPUR
│   │   ├── agent.js              # Polling antrean + cetak ESC/POS ke printer lokal
│   │   └── README.md             # Panduan instalasi Print Agent
│   ├── tests/                    # Test Jest + Supertest
│   └── cron/
│       └── tableCleaner.js      # Background worker pembersih meja kedaluwarsa
└── frontend/
    ├── index.html                # Landing page restoran
    ├── menu.html                 # Daftar menu publik
    ├── customer.html             # Pilih meja & pesan
    ├── track.html                # Lacak status pesanan
    ├── receipt.html              # Struk digital + QR code
    ├── login.html                # Login staf
    └── admin-dashboard.html      # Dashboard admin (sudah tersambung API + Socket.IO asli)
```

## Cara menjalankan (development)

1. **Database**
   ```bash
   createdb sego_abang
   psql -U postgres -d sego_abang -f database/schema.sql
   cd backend && npm install
   npm run seed   # buat akun owner/admin + isi menu contoh
   ```

2. **Backend**
   ```bash
   cd backend
   cp .env.example .env   # isi DB_*, JWT_SECRET, PRINT_AGENT_API_KEY, dll
   npm run dev
   ```
   Server berjalan di `http://localhost:4000`. Cron job pembersih meja otomatis aktif saat server start.

3. **Print Agent (wajib untuk cetak struk dapur)**
   ```bash
   cd backend/print-agent
   npm install
   cp .env.example .env   # PRINT_AGENT_API_KEY harus sama persis dengan backend
   node agent.js
   ```
   Lihat `backend/print-agent/README.md` untuk detail & cara auto-start (pm2).

4. **Frontend**
   Buka langsung file HTML di `frontend/` di browser (atau lewat static server
   ringan, mis. `npx serve frontend`). `admin-dashboard.html` dan
   `login.html` sudah memanggil API asli di `http://localhost:4000/api`
   (ubah `API_BASE`/`SOCKET_URL` di bagian atas `<script>` masing-masing
   file kalau backend jalan di alamat lain).

5. **Test backend**
   ```bash
   cd backend
   npm test
   ```
   Test yang tersedia (`backend/tests/`) menguji validasi input & proteksi
   role/auth tanpa perlu koneksi database sungguhan.

## Alur kunci sistem

1. **Seat Locking**: `POST /api/bookings` mengunci baris meja dengan `SELECT ... FOR UPDATE` di dalam transaksi database, sehingga dua pelanggan yang klik meja sama dalam sepersekian detik tidak akan berhasil mengunci meja yang sama (race condition tercegah di level database, bukan hanya di frontend).
2. **Auto-expire**: `cron/tableCleaner.js` berjalan tiap 15 detik, mencari booking `PENDING_PAYMENT` yang `expires_at < now()`, lalu mengembalikan meja ke `AVAILABLE` dan menyiarkannya lewat Socket.IO. Query pakai `FOR UPDATE SKIP LOCKED` sehingga aman dijalankan di banyak instance backend sekaligus (tidak akan memproses baris yang sama dua kali).
3. **Konfirmasi manual + antrean cetak**: `POST /api/bookings/:id/confirm-payment` (khusus role OWNER/ADMIN) mengubah status booking & meja, lalu memasukkan job struk dapur ke antrean (`print_jobs`). **Print Agent lokal** (jalan di komputer kasir/dapur, lihat `backend/print-agent/`) yang mengambil job tersebut dan benar-benar mencetaknya ke printer thermal di jaringan lokal restoran — backend cloud tidak pernah konek langsung ke printer.
4. **Sesi login**: access token JWT berumur pendek (default 2 jam) + refresh token (default 7 hari, disimpan sebagai hash di tabel `refresh_tokens`, bisa dicabut lewat logout atau reset password). `admin-dashboard.html` otomatis menukar refresh token saat access token kedaluwarsa, tanpa memaksa staf login ulang di tengah kerja.
5. **Audit log**: aksi sensitif (login sukses/gagal, konfirmasi pembayaran, pembatalan booking, cetak ulang, manajemen akun staf) dicatat ke tabel `audit_logs` lewat `services/auditService.js`.
6. **Hak akses**: middleware `requireRole('OWNER')` memproteksi seluruh endpoint CRUD kategori & menu master (nama, harga). Endpoint toggle stok (`PATCH /api/menus/:id/stock`) dan konfirmasi pembayaran memakai `requireRole('OWNER', 'ADMIN')` karena keduanya adalah tugas operasional harian kasir. Endpoint `/api/print-queue` diproteksi API key terpisah (`authenticateAgent`), khusus untuk Print Agent, bukan staf manusia.

## Hal yang perlu disesuaikan sebelum produksi

- Ganti `JWT_SECRET`, `PRINT_AGENT_API_KEY`, dan seluruh kredensial di `.env`, jangan commit ke git.
- Jalankan `npm run seed` dengan `SEED_OWNER_PASSWORD` / `SEED_ADMIN_PASSWORD` custom (jangan pakai password contoh di production).
- Print Agent (`backend/print-agent/`) harus dijalankan di komputer yang selalu menyala di jam operasional restoran; disarankan pakai `pm2` supaya auto-start.
- Untuk multi-instance backend (load balanced): cron table cleaner sudah aman (pakai `SKIP LOCKED`), tapi kalau skala makin besar tetap pertimbangkan job queue terpisah (BullMQ + Redis) untuk beban lain.
- Sistem pembayaran masih QRIS statis manual (staf verifikasi & konfirmasi sendiri) — belum ada integrasi payment gateway otomatis (mis. Midtrans/Xendit). Ini keputusan desain, bukan bug; kalau mau otomatis, itu pekerjaan terpisah yang butuh akun & kredensial gateway pilihan restoran.
