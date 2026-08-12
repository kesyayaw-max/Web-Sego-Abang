# Panduan Deploy — Railway (backend) + Hostinger (frontend)

Arsitektur yang disarankan: **backend Node.js + database jalan di Railway**,
**frontend (dashboard admin & halaman pelanggan statis) di-hosting di Hostinger**.
Alasannya: hosting shared/bisnis Hostinger paling stabil untuk file statis
(HTML/CSS/JS), sedangkan Railway didesain untuk proses Node.js yang harus
selalu hidup (cron job seat-locking, koneksi Socket.IO, koneksi database
persisten) — hal-hal yang biasanya tidak didukung penuh di shared hosting.

---

## Bagian 1 — Deploy Backend + Database ke Railway

1. **Buat project baru di Railway** → "Deploy from GitHub repo" (push folder
   `backend/` ke repo git dulu), atau pakai Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   cd backend
   railway init
   railway up
   ```

2. **Tambahkan database PostgreSQL**
   Di dashboard project Railway → "+ New" → "Database" → "PostgreSQL".
   Railway otomatis membuat variable `DATABASE_URL` dan menyuntikkannya ke
   service backend jika keduanya berada di project yang sama (klik "Connect").
   File `db.js` sudah disiapkan untuk otomatis memakai `DATABASE_URL` ini.

3. **Jalankan migrasi skema**
   Dari komputer lokal (Railway CLI sudah login & project ter-link):
   ```bash
   railway connect postgres
   # masuk ke psql interaktif, lalu:
   \i database/schema.sql
   ```
   Atau tanpa masuk interaktif:
   ```bash
   railway run psql "$DATABASE_URL" -f database/schema.sql
   ```

4. **Set environment variables** di tab "Variables" service backend:
   - `JWT_SECRET` — string acak panjang (jangan pakai contoh di `.env.example`)
   - `NODE_ENV` = `production`
   - `CORS_ORIGIN` = domain Hostinger kamu, mis. `https://segoabang.com`
   - `TABLE_LOCK_MINUTES` = `10`
   - `KITCHEN_PRINTER_IP` / `KITCHEN_PRINTER_PORT` — sesuaikan jaringan printer dapur
     (catatan: printer dapur ada di jaringan lokal restoran, sedangkan backend
     jalan di cloud Railway — printer HARUS bisa diakses dari internet, mis.
     lewat port-forwarding router atau VPN, atau pertimbangkan agen printer
     lokal terpisah yang polling ke backend. Lihat bagian "Catatan Printer" di bawah.)

5. **Update seed password admin/owner**
   Password contoh di `schema.sql` masih placeholder. Generate hash asli:
   ```bash
   node -e "console.log(require('bcrypt').hashSync('password_asli_kamu', 12))"
   ```
   lalu `UPDATE users SET password_hash = '...' WHERE email = 'owner@segoabang.id';`

6. Railway otomatis memberi domain publik `https://<nama-project>.up.railway.app`
   — inilah `BASE_URL` API yang dipanggil frontend di Hostinger.

---

## Bagian 2 — Deploy Frontend ke Hostinger

`frontend/admin-dashboard.html` saat ini masih memakai **data simulasi (mock)**
di dalam `<script>` supaya bisa langsung dibuka tanpa backend. Sebelum upload
ke Hostinger, sambungkan ke API Railway:

1. Buka `admin-dashboard.html`, cari komentar `DATA MOCK` di bagian `<script>`.
2. Ganti array `tables`, `menus`, `categories` dengan `fetch()` ke API Railway, contoh:
   ```js
   const API_BASE = 'https://<nama-project>.up.railway.app/api';
   const res = await fetch(`${API_BASE}/tables`);
   const { tables } = await res.json();
   ```
3. Tambahkan Socket.IO client sebelum `</body>` untuk update real-time:
   ```html
   <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
   <script>
     const socket = io('https://<nama-project>.up.railway.app');
     socket.on('table:status_changed', (data) => { /* update UI */ });
     socket.on('menu:stock_changed', (data) => { /* update UI */ });
   </script>
   ```
4. Simpan token login (`POST /api/auth/login`) di memory JS setelah admin
   login, kirim sebagai header `Authorization: Bearer <token>` di setiap
   request yang butuh role (konfirmasi pembayaran, kelola kategori, dll).

### Upload ke Hostinger

- **hPanel → File Manager** → masuk ke `public_html/` (atau subfolder/subdomain
  seperti `admin.segoabang.id`) → upload `admin-dashboard.html` (bisa
  rename jadi `index.html` supaya langsung terbuka di root domain).
- Atau lewat FTP (kredensial ada di hPanel → "FTP Accounts"), pakai FileZilla:
  upload ke folder `public_html/`.
- Aktifkan **SSL gratis** (hPanel → SSL) supaya domain jadi `https://` — wajib
  supaya `fetch()` ke API Railway (yang juga https) tidak diblokir mixed-content
  oleh browser.

> Catatan: paket Hostinger Business/Cloud juga mendukung Node.js apps lewat
> hPanel, tapi untuk sistem ini (butuh cron job selalu aktif, koneksi
> Socket.IO persisten, dan koneksi database jangka panjang) Railway jauh
> lebih cocok. Simpan backend di Railway, dan pakai Hostinger murni untuk
> menyajikan file statis frontend.

---

## Catatan Printer Thermal Dapur

`printService.js` mengirim ESC/POS lewat koneksi TCP langsung ke IP printer
(`tcp://<ip>:9100>`). Ini hanya berfungsi kalau backend dan printer berada di
jaringan yang sama. Karena backend akan jalan di cloud (Railway), ada dua opsi:

1. **Port-forwarding**: buka port 9100 dari router restoran ke printer —
   TIDAK disarankan untuk keamanan (port printer akan terekspos ke internet).
2. **Print agent lokal (disarankan)**: jalankan proses kecil Node.js di
   komputer kasir/dapur restoran yang polling endpoint backend (mis. tiap
   2 detik cek `GET /api/print-queue`) atau mendengarkan event Socket.IO
   `kitchen:receipt_printed`, lalu print agent itulah yang mengirim ESC/POS
   ke printer di jaringan lokalnya sendiri. Ini pola yang lebih aman & umum
   dipakai sistem kasir cloud.

Bagian print agent lokal ini belum termasuk dalam kode yang diberikan — beri
tahu saya kalau mau saya buatkan sekalian.


## Alur terbaru
Reservasi jarak jauh dapat memilih meja dan menyiapkan makanan sebelum datang. QR meja digunakan terutama untuk pelanggan yang datang tanpa reservasi atau untuk pesanan tambahan setelah duduk. Pembayaran tersedia melalui QRIS demo/manual atau bayar di kasir.


## Database — One File
Pada package consolidated ini, seluruh schema Phase 1–5, reservasi, remote preorder, audit, QR token, dan hardening sudah digabung ke `database/schema.sql`. Untuk database PostgreSQL BARU: jalankan `database/schema.sql` sekali, lalu `node database/seed.js`. Jangan menjalankan migration lama secara terpisah.
