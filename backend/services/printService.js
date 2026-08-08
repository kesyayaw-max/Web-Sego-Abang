// services/printService.js
//
// PERUBAHAN PENTING (v2.1): backend TIDAK LAGI konek TCP langsung ke
// printer dapur. Karena backend jalan di cloud (Railway) sedangkan
// printer ada di jaringan lokal restoran, koneksi langsung itu hanya
// bisa jalan kalau port printer di-expose ke internet -- TIDAK aman.
//
// Sekarang alurnya:
//  1. Saat pembayaran dikonfirmasi, fungsi di bawah ini hanya menulis
//     satu baris job baru ke tabel `print_jobs` (status QUEUED) berisi
//     snapshot lengkap struk (JSON).
//  2. Print Agent lokal (proses kecil Node.js yang jalan di komputer
//     kasir/dapur, lihat backend/print-agent/agent.js) polling
//     `GET /api/print-queue` tiap beberapa detik, mengambil job QUEUED,
//     mencetak ke printer di jaringan lokalnya sendiri lewat ESC/POS,
//     lalu melaporkan hasilnya balik ke `POST /api/print-queue/:id/result`.
//  3. Setiap hasil (sukses/gagal) tetap dicatat ke `print_logs` untuk
//     audit, sama seperti sebelumnya.
//
// Ini pola yang lebih aman & umum dipakai sistem kasir berbasis cloud.

const { query } = require('../db');

/**
 * Menyusun payload struk & memasukkannya ke antrean cetak (print_jobs).
 * Dipanggil setelah pembayaran dikonfirmasi (confirm-payment).
 */
async function printKitchenReceipt({ bookingId, bookingCode, tableNumber, items, triggeredBy }) {
  const receiptPayload = {
    booking_code: bookingCode,
    table_number: tableNumber,
    items: items.map((i) => ({
      name: i.menu_name_snapshot,
      quantity: i.quantity,
      notes: i.notes || null,
    })),
    printed_note: 'Pembayaran QRIS TERKONFIRMASI',
    generated_at: new Date().toISOString(),
  };

  const result = await query(
    `INSERT INTO print_jobs (booking_id, triggered_by, is_reprint, payload, status)
     VALUES ($1, $2, FALSE, $3, 'QUEUED')
     RETURNING id`,
    [bookingId, triggeredBy, JSON.stringify(receiptPayload)]
  );

  const jobId = result.rows[0].id;
  console.log(`[PRINT] job antrean dibuat untuk ${bookingCode} (job ${jobId})`);

  return { status: 'QUEUED', jobId };
}

/**
 * Menambahkan job cetak-ulang ke antrean (dipakai tombol "Cetak Ulang"
 * di dashboard admin, mis. saat printer sebelumnya offline/kertas habis).
 */
async function reprintKitchenReceipt(bookingId, triggeredBy) {
  const bookingRes = await query(
    `SELECT b.booking_code, t.table_number
     FROM bookings b JOIN restaurant_tables t ON t.id = b.table_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = bookingRes.rows[0];
  if (!booking) throw new Error('Booking tidak ditemukan untuk cetak ulang.');

  const itemsRes = await query(
    `SELECT menu_name_snapshot, quantity, notes FROM booking_items WHERE booking_id = $1`,
    [bookingId]
  );

  const receiptPayload = {
    booking_code: booking.booking_code,
    table_number: booking.table_number,
    items: itemsRes.rows.map((i) => ({
      name: i.menu_name_snapshot,
      quantity: i.quantity,
      notes: i.notes || null,
    })),
    printed_note: 'CETAK ULANG',
    generated_at: new Date().toISOString(),
  };

  const result = await query(
    `INSERT INTO print_jobs (booking_id, triggered_by, is_reprint, payload, status)
     VALUES ($1, $2, TRUE, $3, 'QUEUED')
     RETURNING id`,
    [bookingId, triggeredBy, JSON.stringify(receiptPayload)]
  );

  return { status: 'QUEUED', jobId: result.rows[0].id };
}

/**
 * Dipanggil dari route /api/print-queue (dipoll agent lokal): ambil
 * sejumlah job QUEUED tertua, tandai sebagai "diklaim" supaya tidak
 * diambil dobel oleh polling berikutnya sebelum agent selesai lapor.
 */
async function claimQueuedJobs(limit = 5) {
  const result = await query(
    `UPDATE print_jobs
     SET claimed_at = now()
     WHERE id IN (
       SELECT id FROM print_jobs
       WHERE status = 'QUEUED'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, booking_id, is_reprint, payload, created_at`,
    [limit]
  );
  return result.rows;
}

/**
 * Dipanggil dari route hasil cetak (dilaporkan agent lokal setelah
 * mencoba mencetak). Mengubah status job + mencatat ke print_logs audit.
 */
async function completePrintJob(jobId, { status, errorMessage, triggeredBy, bookingId }) {
  await query(
    `UPDATE print_jobs SET status = $1, error_message = $2, completed_at = now() WHERE id = $3`,
    [status, errorMessage || null, jobId]
  );

  await query(
    `INSERT INTO print_logs (booking_id, triggered_by, status, error_message, raw_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [bookingId, triggeredBy || null, status, errorMessage || null, `print_job:${jobId}`]
  );
}

module.exports = {
  printKitchenReceipt,
  reprintKitchenReceipt,
  claimQueuedJobs,
  completePrintJob,
};
