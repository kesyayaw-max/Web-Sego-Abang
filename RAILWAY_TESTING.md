# TESTING DI RAILWAY — RM SEGO ABANG

Tujuan: memastikan semua alur berjalan di Railway sebelum masuk Hostinger.

## Database
Jika PostgreSQL Railway sudah berisi data:
- Jangan jalankan `schema.sql` ulang.
- Jalankan `migration_reservations.sql` satu kali bila reservasi belum ada.
- Jalankan `migration_remote_preorder.sql` satu kali untuk pilih meja + pre-order.
- Jalankan seed hanya jika data awal memang belum ada.

## Environment
Set minimal:
- DATABASE_URL
- JWT_SECRET
- FRONTEND_URL
- NODE_ENV=production
- PORT biasanya disediakan Railway.

Jangan commit `.env` berisi secret.

## QA
1. Home dan menu tampil.
2. Foto menu bisa ditambah/edit.
3. Admin login.
4. Meja dan QR per meja.
5. Scan QR otomatis mengenali meja.
6. Walk-in bisa order.
7. Reservasi bisa memilih tanggal, jam, jumlah tamu, meja, dan makanan.
8. Reservasi muncul di dashboard.
9. Admin bisa konfirmasi/batalkan.
10. Pre-order terhubung ke reservasi.
11. Pelanggan reservasi tidak perlu scan QR lagi untuk pesanan awal.
12. Walk-in tetap bisa scan QR untuk order.
13. Pembayaran QRIS hanya dianggap lunas setelah verifikasi nyata.
14. Bayar di kasir bisa dikonfirmasi admin.
15. Pesanan yang sudah dibayar/diterima masuk alur dapur.
16. Pembatalan mengembalikan meja ke available.
17. Tes mobile dan scan QR dari HP.
18. Tes endpoint admin tanpa login harus ditolak.

## Skenario akhir
A. Reservasi → pilih meja → pre-order → datang → makanan diproses → bayar.
B. Walk-in → scan QR → order → bayar QRIS/kasir → konfirmasi → dapur.
C. Reservasi dibatalkan → meja tersedia kembali.

Jangan pindah ke Hostinger sebelum A/B/C lolos.


## PHASE 1 — aturan operasional
- Meja memiliki kapasitas.
- Reservasi memiliki start/end time.
- Reservasi yang waktunya bentrok pada meja yang sama ditolak.
- Meja maintenance tidak dapat dipilih.
- Order memiliki status: PENDING → CONFIRMED → COOKING → READY → SERVED → COMPLETED.
- Pembayaran memiliki status terpisah dari order: UNPAID → PAID/FAILED.
- Reservasi memiliki status: PENDING → CONFIRMED → ARRIVED → COMPLETED atau CANCELLED/NO_SHOW.


## PHASE 2 — operasional
Jalankan `database/migration_phase2.sql` satu kali setelah migration Phase 1.

Tes:
- `/operations.html` untuk ringkasan hari ini.
- `/kitchen.html` untuk antrean dapur.
- Menu dapat ditandai tersedia/habis melalui API admin.
- Status dapur dipisahkan dari pembayaran.
- Order bergerak PENDING → CONFIRMED → COOKING → READY → SERVED → COMPLETED.


## PHASE 3 — customer experience
Jalankan `database/migration_phase3.sql` satu kali setelah Phase 2.

Tes:
- `/reservation-lookup.html` untuk cek reservasi.
- Kode reservasi + nomor WhatsApp harus cocok.
- Detail pre-order ikut tampil.
- Reservasi PENDING/CONFIRMED dapat dibatalkan pelanggan.
- Event notifikasi dicatat di `notification_logs`.
- Provider WhatsApp nyata belum dianggap aktif hanya karena log dibuat.


## PHASE 4 — production hardening
Run `database/migration_phase4.sql` once. Before Hostinger, test database backup/restore, secrets, admin authorization, security headers, rate limiting, audit logs, roles, official QRIS verification, and all end-to-end scenarios.
