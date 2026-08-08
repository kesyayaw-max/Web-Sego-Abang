# Print Agent — RM. Sego Abang Pendopo Wonomarto

Proses kecil Node.js yang **wajib dijalankan di komputer kasir/dapur restoran**
(bukan di Railway), supaya printer thermal dapur — yang ada di jaringan lokal
restoran — tidak perlu di-expose ke internet.

## Kenapa perlu ini?

Backend jalan di cloud (Railway). Printer dapur ada di jaringan lokal restoran.
Kalau backend cloud konek TCP langsung ke printer, port printer (9100) harus
dibuka ke internet lewat port-forwarding router — **berisiko keamanan**.

Solusinya: backend hanya menulis "job cetak" ke database (status `QUEUED`).
Agent ini yang polling dari dalam jaringan restoran, mengambil job, mencetak
ke printer lokal, lalu lapor balik ke backend. Tidak ada port yang perlu
dibuka ke internet.

## Instalasi

1. Install Node.js 18+ di komputer kasir/dapur (yang selalu menyala saat jam
   operasional restoran).
2. ```bash
   cd backend/print-agent
   npm install
   cp .env.example .env
   ```
3. Isi `.env`:
   - `API_BASE_URL` — domain backend Railway kamu.
   - `PRINT_AGENT_API_KEY` — **harus sama persis** dengan variable
     `PRINT_AGENT_API_KEY` yang di-set di Railway (tab Variables backend).
     Generate sekali: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
   - `PRINTER_IP` / `PRINTER_PORT` — alamat printer thermal di jaringan lokal
     restoran ini (biasanya `192.168.x.x:9100`).
4. Jalankan:
   ```bash
   node agent.js
   ```
5. **Supaya otomatis nyala tiap komputer boot** (disarankan untuk produksi):
   ```bash
   npm install -g pm2
   pm2 start agent.js --name sego-abang-print-agent
   pm2 save
   pm2 startup   # ikuti instruksi yang muncul supaya pm2 auto-start saat OS boot
   ```

## Cara kerja singkat

1. Tiap `POLL_INTERVAL_MS` (default 3 detik), agent memanggil
   `GET /api/print-queue` di backend.
2. Backend mengembalikan job `QUEUED` terbaru dan langsung menandainya
   "diklaim" (supaya tidak diambil dobel).
3. Agent mencetak tiap job ke printer lokal lewat ESC/POS (TCP LAN).
4. Agent melapor hasil (`PRINTED` atau `FAILED`) ke
   `POST /api/print-queue/:id/result`.
5. Dashboard admin dapat notifikasi real-time (`kitchen:receipt_printed`)
   lewat Socket.IO dari backend.

## Troubleshooting

- **Agent jalan tapi tidak ada yang tercetak** → cek `PRINT_AGENT_API_KEY`
  sama persis dengan Railway; cek log agent untuk error `401` (kalau ada,
  key salah).
- **Error "Printer dapur tidak terhubung"** → pastikan komputer agent dan
  printer ada di jaringan LAN/WiFi yang sama, cek `PRINTER_IP` benar
  (biasanya bisa dicek dari menu konfigurasi printer itu sendiri).
- **Ingin lebih dari satu titik cetak** (mis. dapur + kasir) → jalankan
  beberapa instance agent dengan `PRINTER_IP` berbeda; keduanya akan
  berebut job dari antrean yang sama (job yang sudah diklaim salah satu
  tidak akan diambil yang lain).
