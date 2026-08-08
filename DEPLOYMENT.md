# Panduan Deploy — Railway (backend) + Hostinger (frontend)

Arsitektur yang disarankan: **backend Node.js + database jalan di Railway**,
**frontend (dashboard admin & halaman pelanggan statis) di-hosting di Hostinger**.
Alasannya: hosting shared/bisnis Hostinger paling stabil untuk file statis
(HTML/CSS/JS), sedangkan Railway didesain untuk proses Node.js yang harus
selalu hidup (cron job seat-locking, koneksi Socket.IO, koneksi database
persisten) — hal-hal yang biasanya tidak didukung penuh di shared hosting.

---

## Bagian 0 — Update project Railway yang SUDAH ADA (database lama tetap aman)

Kalau kamu **sudah** punya project Railway berjalan dengan database berisi
data asli (booking, menu, staf, dll), JANGAN jalankan ulang `database/schema.sql`
— itu akan gagal (tabel sudah ada) atau berisiko. Ikuti langkah ini saja:

1. **Deploy kode backend terbaru** ke service Railway yang sudah ada:
   - Kalau service terhubung ke GitHub repo: push kode baru ke branch yang
     dipakai Railway (mis. `main`) → Railway otomatis redeploy.
   - Kalau pakai Railway CLI:
     ```bash
     cd backend
     railway link   # pilih project & service backend yang sudah ada
     railway up
     ```

2. **Jalankan migrasi tambahan (BUKAN schema.sql penuh)** — ini menambah
   3 tabel baru (`print_jobs`, `refresh_tokens`, `audit_logs`) tanpa
   menyentuh data lama sama sekali:
   ```bash
   railway run psql "$DATABASE_URL" -f database/migrations/001_print_agent_refresh_audit.sql
   ```
   Atau lewat Railway dashboard → plugin PostgreSQL kamu yang sudah ada →
   tab "Query" → paste isi file `database/migrations/001_print_agent_refresh_audit.sql`
   → Run. File ini aman dijalankan berkali-kali (idempotent) dan tidak
   akan menghapus/mengubah data yang sudah ada.

3. **Tambahkan environment variable baru** di tab "Variables" service
   backend Railway kamu yang sudah ada (yang lama biarkan seperti semula):
   - `PRINT_AGENT_API_KEY` — random string baru, generate:
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   - `ACCESS_TOKEN_EXPIRES_IN` = `2h` (opsional, ada default)
   - `REFRESH_TOKEN_EXPIRES_DAYS` = `7` (opsional, ada default)

4. **Verifikasi data lama masih utuh** — buka tab "Query" Postgres Railway,
   jalankan `SELECT COUNT(*) FROM users;` dan `SELECT COUNT(*) FROM bookings;`,
   pastikan jumlahnya sama seperti sebelum migrasi.

5. **Jalankan Print Agent** di komputer kasir/dapur (lihat "Catatan Printer
   Thermal Dapur" di bagian bawah panduan ini) — ini proses terpisah, TIDAK
   di-deploy ke Railway.

6. Staf yang sedang login saat deploy akan otomatis logout satu kali (format
   token berubah dari 12 jam ke 2 jam + refresh token) — tinggal login ulang
   sekali, setelah itu sesi diperpanjang otomatis oleh dashboard.

Kalau kamu justru **belum pernah** deploy ke Railway sama sekali, lewati
bagian ini dan ikuti Bagian 1 di bawah dari awal (pakai `schema.sql` penuh,
bukan file migrasi).

---

## Bagian 1 — Deploy Backend + Database ke Railway (project BARU / dari nol)

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
   - `PRINT_AGENT_API_KEY` — random string panjang, **harus sama persis**
     dengan yang diisi di `.env` Print Agent lokal (lihat bagian "Catatan
     Printer Thermal Dapur" di bawah). Generate:
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   - `ACCESS_TOKEN_EXPIRES_IN` = `2h`, `REFRESH_TOKEN_EXPIRES_DAYS` = `7`
     (opsional, sudah ada default masuk akal jika tidak diisi)

5. **Buat akun owner/admin**
   `database/seed.js` sudah generate hash bcrypt asli otomatis (bukan
   placeholder) — password default dipakai kalau kamu tidak override:
   ```bash
   # opsional: set password custom lewat env var sebelum seed,
   # kalau tidak diisi akan pakai default 'SegoAbang@Owner2026!' dst.
   railway run -e SEED_OWNER_PASSWORD="password_kamu" -e SEED_ADMIN_PASSWORD="password_kamu2" \
     node ../database/seed.js
   ```
   Untuk project yang SUDAH ADA datanya, **lewati langkah ini** (jangan
   jalankan seed ulang, nanti password owner/admin ke-reset ke default).

6. Railway otomatis memberi domain publik `https://<nama-project>.up.railway.app`
   — inilah `BASE_URL` API yang dipanggil frontend di Hostinger.

---

## Bagian 2 — Deploy Frontend ke Hostinger

`frontend/admin-dashboard.html` sudah tersambung ke API Railway + Socket.IO
asli (bukan data simulasi). Sebelum upload ke Hostinger, cukup 1 langkah:
ganti `API_BASE` dan `SOCKET_URL` di bagian atas `<script>` (`admin-dashboard.html`
dan `login.html`) dari `http://localhost:4000` ke domain Railway kamu:

```js
const API_BASE = 'https://<nama-project>.up.railway.app/api';
const SOCKET_URL = 'https://<nama-project>.up.railway.app';
```

Frontend publik lain (`index.html`, `menu.html`, `customer.html`, `track.html`,
`receipt.html`) juga perlu penyesuaian `API_BASE` yang sama kalau ada.

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

`printService.js` (backend) TIDAK LAGI konek TCP langsung ke printer dapur.
Sebagai gantinya, backend hanya menaruh job cetak ke antrean (`print_jobs`),
dan **Print Agent lokal** (proses kecil Node.js yang jalan di komputer
kasir/dapur restoran) yang mengambil & mencetaknya lewat ESC/POS ke jaringan
lokalnya sendiri. Ini menghindari kebutuhan membuka port printer (9100) ke
internet, yang tidak aman.

Sudah tersedia lengkap di `backend/print-agent/` — lihat
`backend/print-agent/README.md` untuk instalasi & konfigurasinya. Ringkas:

```bash
cd backend/print-agent
npm install
cp .env.example .env   # isi API_BASE_URL, PRINT_AGENT_API_KEY (samakan dengan Railway), PRINTER_IP/PORT
node agent.js
```

Set juga variable `PRINT_AGENT_API_KEY` di Railway (tab Variables backend) —
harus sama persis dengan yang ada di `.env` print-agent.
