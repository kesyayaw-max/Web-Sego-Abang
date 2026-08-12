// cron/tableCleaner.js
// Background worker yang berjalan setiap beberapa detik untuk mencari
// booking PENDING_PAYMENT yang sudah lewat waktu (expires_at < now())
// dan belum dikonfirmasi admin. Booking tersebut otomatis di-EXPIRE
// dan meja terkait dikembalikan ke status AVAILABLE (Hijau).
//
// Berjalan sebagai node-cron di dalam proses server yang sama supaya
// deployment sederhana (cukup satu proses). Untuk skala besar/multi
// instance, sebaiknya dipindah ke worker terpisah + job queue
// (BullMQ/Redis) supaya tidak dieksekusi ganda oleh tiap instance.

const cron = require('node-cron');
const { withTransaction } = require('../db');

/**
 * Menjalankan satu siklus pembersihan. Diekspos sebagai fungsi terpisah
 * supaya bisa dites unit test tanpa harus menunggu jadwal cron.
 */
async function cleanExpiredLocks(io) {
  try {
    const expiredTables = await withTransaction(async (client) => {
      // Ambil semua booking yang PENDING_PAYMENT dan sudah lewat expires_at.
      // FOR UPDATE SKIP LOCKED: jika ada worker lain yang kebetulan sedang
      // memproses baris yang sama, baris itu dilewati saja (aman untuk
      // multi-instance tanpa saling menunggu / deadlock).
      const expiredRes = await client.query(`
        SELECT b.id AS booking_id, b.table_id, b.booking_code, t.table_number
        FROM bookings b
        JOIN restaurant_tables t ON t.id = b.table_id
        WHERE b.status = 'PENDING_PAYMENT' AND b.expires_at < now()
        FOR UPDATE OF b SKIP LOCKED
      `);

      const results = [];

      for (const row of expiredRes.rows) {
        // Update booking -> EXPIRED
        await client.query(
          `UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`,
          [row.booking_id]
        );

        // Kembalikan meja -> AVAILABLE (Hijau), lepas kuncian
        await client.query(
          `UPDATE restaurant_tables
           SET status = 'AVAILABLE', locked_until = NULL, current_booking_id = NULL
           WHERE id = $1`,
          [row.table_id]
        );

        // Tandai payment terkait sebagai EXPIRED juga (jika masih PENDING)
        await client.query(
          `UPDATE payments SET status = 'EXPIRED'
           WHERE booking_id = $1 AND status = 'PENDING'`,
          [row.booking_id]
        );

        results.push(row);
      }

      return results;
    });

    if (expiredTables.length > 0) {
      console.log(`[CRON] ${expiredTables.length} booking kedaluwarsa dibersihkan:`,
        expiredTables.map((t) => t.booking_code).join(', '));

      // Broadcast setiap perubahan meja ke seluruh client yang terhubung
      if (io) {
        for (const t of expiredTables) {
          io.emit('table:status_changed', {
            table_id: t.table_id,
            table_number: t.table_number,
            status: 'AVAILABLE',
            locked_until: null,
            reason: 'EXPIRED',
          });
        }
      }
    }

    return expiredTables;
  } catch (err) {
    console.error('[CRON] gagal membersihkan meja kedaluwarsa:', err);
    return [];
  }
}

/**
 * Mendaftarkan jadwal cron. Dipanggil sekali saat server start.
 * Jadwal: setiap 15 detik — cukup rapat karena lock hanya 10 menit,
 * supaya pelanggan lain tidak menunggu lama setelah slot terbuka.
 */
function startTableCleanerCron(io) {
  const task = cron.schedule('*/15 * * * * *', () => {
    cleanExpiredLocks(io);
  });
  console.log('[CRON] Table cleaner cron job aktif (setiap 15 detik).');
  return task;
}

module.exports = { startTableCleanerCron, cleanExpiredLocks };
