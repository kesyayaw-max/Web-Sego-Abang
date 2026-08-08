// routes/bookings.js
// Inti fitur: SEAT LOCKING otomatis saat pelanggan klik "Pesan".
//
// Alur:
//  1. Pelanggan kirim { table_id, customer_name, customer_phone, items[] }
//  2. Backend BEGIN TRANSACTION, SELECT ... FOR UPDATE baris meja target
//  3. Jika status meja bukan 'AVAILABLE' -> tolak (409 Conflict).
//  4. Jika 'AVAILABLE' -> buat booking baru (status PENDING_PAYMENT,
//     expires_at = now() + 10 menit) + booking_items, lalu update
//     meja jadi 'LOCKED' dengan locked_until = expires_at.
//  5. COMMIT. Broadcast perubahan status meja via WebSocket (Socket.IO).
//  6. Response ke pelanggan berisi data QRIS statis + total tagihan +
//     waktu kedaluwarsa, untuk ditampilkan sebagai countdown 10 menit.

const express = require('express');
const { body, query: qParam, validationResult } = require('express-validator');
const { withTransaction, query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { printKitchenReceipt, reprintKitchenReceipt } = require('../services/printService');
const { logAudit, clientIp } = require('../services/auditService');

const router = express.Router();
const LOCK_DURATION_MINUTES = parseInt(process.env.TABLE_LOCK_MINUTES || '10', 10);

function generateBookingCode() {
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = String(Math.floor(1000 + Math.random() * 9000));
  return `SGA-${datePart}-${randomPart}`;
}

// ─────────────────────────────────────────────────────────────
// GET /api/tables
// Denah meja beserta status terkini. Publik (halaman pelanggan & admin).
// ─────────────────────────────────────────────────────────────
router.get('/tables', async (req, res) => {
  try {
    const result = await query(`
      SELECT id, table_number, capacity, zone, pos_x, pos_y,
             status, locked_until, current_booking_id
      FROM restaurant_tables
      ORDER BY table_number ASC
    `);
    return res.json({ success: true, tables: result.rows });
  } catch (err) {
    console.error('[BOOKINGS] get tables error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat data meja.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/bookings
// List semua booking — dilindungi auth OWNER/ADMIN.
// Query params: status, date (YYYY-MM-DD), page, limit
// ─────────────────────────────────────────────────────────────
router.get('/bookings', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const { status, date, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`b.status = $${params.length}`);
    }
    if (date) {
      params.push(date);
      conditions.push(`DATE(b.created_at AT TIME ZONE 'Asia/Jakarta') = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total count
    const countRes = await query(
      `SELECT COUNT(*) FROM bookings b ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count);

    // Paginated data
    params.push(parseInt(limit), offset);
    const result = await query(
      `SELECT b.id, b.booking_code, b.status, b.total_amount,
              b.customer_name, b.customer_phone, b.guest_count,
              b.created_at, b.expires_at, b.confirmed_at,
              t.table_number, t.zone,
              u.full_name AS confirmed_by_name
       FROM bookings b
       JOIN restaurant_tables t ON t.id = b.table_id
       LEFT JOIN users u ON u.id = b.confirmed_by
       ${where}
       ORDER BY b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      bookings: result.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('[BOOKINGS] list bookings error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat riwayat booking.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/bookings
// Endpoint utama SEAT LOCKING. Dipanggil saat pelanggan klik "Pesan".
// ─────────────────────────────────────────────────────────────
const bookingValidation = [
  body('table_id').isUUID().withMessage('ID meja tidak valid.'),
  body('customer_name').trim().isLength({ min: 2, max: 120 }).withMessage('Nama pelanggan 2–120 karakter.'),
  body('customer_phone')
    .trim()
    .matches(/^(\+62|62|0)[0-9]{8,13}$/)
    .withMessage('Format nomor HP tidak valid (contoh: 08123456789).'),
  body('guest_count').optional().isInt({ min: 1, max: 50 }).withMessage('Jumlah tamu 1–50 orang.'),
  body('items').isArray({ min: 1 }).withMessage('Minimal 1 item pesanan.'),
  body('items.*.menu_id').isUUID().withMessage('ID menu tidak valid.'),
  body('items.*.quantity').isInt({ min: 1, max: 99 }).withMessage('Jumlah item 1–99.'),
];

router.post('/bookings', bookingValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg });
  }

  const { table_id, customer_name, customer_phone, guest_count, items } = req.body;

  try {
    const bookingResult = await withTransaction(async (client) => {
      // Langkah 1: Kunci baris meja target (row-level lock)
      const tableRes = await client.query(
        `SELECT id, table_number, capacity, status, locked_until
         FROM restaurant_tables
         WHERE id = $1
         FOR UPDATE`,
        [table_id]
      );

      const table = tableRes.rows[0];
      if (!table) {
        const err = new Error('Meja tidak ditemukan.');
        err.statusCode = 404;
        throw err;
      }

      const now = new Date();
      const isStillLocked = table.status === 'LOCKED' && table.locked_until && new Date(table.locked_until) > now;
      const isTaken = table.status === 'CONFIRMED' || isStillLocked;

      if (isTaken) {
        const err = new Error(`Meja ${table.table_number} sedang tidak tersedia. Silakan pilih meja lain.`);
        err.statusCode = 409;
        throw err;
      }

      // Validasi jumlah tamu tidak melebihi kapasitas
      if (guest_count && guest_count > table.capacity) {
        const err = new Error(`Meja ${table.table_number} hanya untuk ${table.capacity} orang.`);
        err.statusCode = 400;
        throw err;
      }

      // Langkah 2: Validasi menu & hitung total harga di server
      // Harga TIDAK dipercaya dari input client
      const menuIds = items.map((it) => it.menu_id);
      const menuRes = await client.query(
        `SELECT id, name, price, stock_status, is_active
         FROM menus WHERE id = ANY($1::uuid[])`,
        [menuIds]
      );

      const menuMap = new Map(menuRes.rows.map((m) => [m.id, m]));
      let totalAmount = 0;
      const itemsToInsert = [];

      for (const item of items) {
        const menu = menuMap.get(item.menu_id);
        if (!menu || !menu.is_active) {
          const err = new Error('Salah satu menu tidak ditemukan atau sudah tidak aktif.');
          err.statusCode = 400;
          throw err;
        }
        if (menu.stock_status === 'OUT_OF_STOCK') {
          const err = new Error(`Menu "${menu.name}" sedang habis. Silakan pilih menu lain.`);
          err.statusCode = 409;
          throw err;
        }
        const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
        const subtotal = parseFloat(menu.price) * quantity;
        totalAmount += subtotal;
        itemsToInsert.push({
          menu_id: menu.id,
          menu_name_snapshot: menu.name,
          price_snapshot: menu.price,
          quantity,
          subtotal,
          notes: item.notes ? String(item.notes).substring(0, 255) : null,
        });
      }

      // Langkah 3: Buat booking baru
      const expiresAt = new Date(now.getTime() + LOCK_DURATION_MINUTES * 60 * 1000);
      const bookingCode = generateBookingCode();

      const insertBooking = await client.query(
        `INSERT INTO bookings
           (booking_code, table_id, customer_name, customer_phone, guest_count,
            total_amount, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_PAYMENT', $7)
         RETURNING id, booking_code, total_amount, status, expires_at`,
        [bookingCode, table_id, customer_name.trim(), customer_phone.trim(), guest_count || 1, totalAmount, expiresAt]
      );
      const booking = insertBooking.rows[0];

      // Langkah 4: Simpan rincian item pesanan
      for (const it of itemsToInsert) {
        await client.query(
          `INSERT INTO booking_items
             (booking_id, menu_id, menu_name_snapshot, price_snapshot, quantity, subtotal, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [booking.id, it.menu_id, it.menu_name_snapshot, it.price_snapshot, it.quantity, it.subtotal, it.notes]
        );
      }

      // Langkah 5: KUNCI MEJA -> status LOCKED (Kuning)
      await client.query(
        `UPDATE restaurant_tables
         SET status = 'LOCKED', locked_until = $1, current_booking_id = $2
         WHERE id = $3`,
        [expiresAt, booking.id, table_id]
      );

      // Langkah 6: Buat baris payment berstatus PENDING
      await client.query(
        `INSERT INTO payments (booking_id, amount, method, status)
         VALUES ($1, $2, 'QRIS_STATIC', 'PENDING')`,
        [booking.id, totalAmount]
      );

      return { booking, table_number: table.table_number };
    });

    // Ambil data QRIS statis dari settings
    const settingsRes = await query(
      `SELECT key, value FROM restaurant_settings
       WHERE key IN ('qris_static_image_url', 'qris_bank_name')`
    );
    const settings = Object.fromEntries(settingsRes.rows.map((r) => [r.key, r.value]));

    // Broadcast real-time
    const io = req.app.get('io');
    if (io) {
      // 1. Update floor map di semua client (pelanggan & admin)
      io.emit('table:status_changed', {
        table_id,
        table_number: bookingResult.table_number,
        status: 'LOCKED',
        locked_until: bookingResult.booking.expires_at,
      });
      // 2. Notifikasi khusus admin: pesanan baru masuk
      io.emit('booking:new', {
        booking_id:    bookingResult.booking.id,
        booking_code:  bookingResult.booking.booking_code,
        table_id,
        table_number:  bookingResult.table_number,
        customer_name: req.body.customer_name?.trim(),
        customer_phone: req.body.customer_phone?.trim(),
        guest_count:   req.body.guest_count || 1,
        total_amount:  bookingResult.booking.total_amount,
        expires_at:    bookingResult.booking.expires_at,
        created_at:    new Date().toISOString(),
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Meja berhasil dikunci. Silakan selesaikan pembayaran dalam 10 menit.',
      booking: {
        id: bookingResult.booking.id,
        booking_code: bookingResult.booking.booking_code,
        total_amount: bookingResult.booking.total_amount,
        status: bookingResult.booking.status,
        expires_at: bookingResult.booking.expires_at,
      },
      payment_instructions: {
        method: 'QRIS_STATIC',
        qris_image_url: settings.qris_static_image_url,
        bank_name: settings.qris_bank_name,
        amount: bookingResult.booking.total_amount,
        countdown_seconds: LOCK_DURATION_MINUTES * 60,
        note: 'Gunakan nominal PERSIS sesuai tagihan agar mempermudah verifikasi admin.',
      },
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode === 500) console.error('[BOOKINGS] create booking error:', err);
    return res.status(statusCode).json({ success: false, message: err.message || 'Gagal membuat pesanan.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/bookings/:id/status
// Dilindungi auth supaya hanya admin/pelanggan dengan booking_code yang tahu.
// ─────────────────────────────────────────────────────────────
router.get('/bookings/:id/status', async (req, res) => {
  try {
    // Boleh akses dengan booking ID (UUID) ATAU booking_code
    const identifier = req.params.id;
    const isUUID = /^[0-9a-f-]{36}$/i.test(identifier);

    const result = await query(
      `SELECT b.id, b.booking_code, b.status, b.expires_at, b.total_amount,
              b.customer_name, b.guest_count,
              t.table_number, t.status AS table_status
       FROM bookings b
       JOIN restaurant_tables t ON t.id = b.table_id
       WHERE ${isUUID ? 'b.id = $1' : 'b.booking_code = $1'}`,
      [identifier]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Booking tidak ditemukan.' });
    }
    return res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    console.error('[BOOKINGS] get status error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat status booking.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/bookings/:id/items
// Detail item per booking — untuk modal dashboard admin.
// ─────────────────────────────────────────────────────────────
router.get('/bookings/:id/items', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const result = await query(
      `SELECT bi.id, bi.menu_name_snapshot, bi.quantity, bi.price_snapshot, bi.subtotal, bi.notes
       FROM booking_items bi
       WHERE bi.booking_id = $1`,
      [req.params.id]
    );
    return res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error('[BOOKINGS] get items error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat detail item.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/bookings/:id/confirm-payment
// DIPROTEKSI: hanya OWNER & ADMIN (kasir) yang login yang boleh akses.
// ─────────────────────────────────────────────────────────────
router.post('/bookings/:id/confirm-payment', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { bank_reference, notes } = req.body;

  try {
    const result = await withTransaction(async (client) => {
      const bookingRes = await client.query(
        `SELECT b.id, b.booking_code, b.status, b.table_id, b.total_amount,
                t.table_number
         FROM bookings b
         JOIN restaurant_tables t ON t.id = b.table_id
         WHERE b.id = $1
         FOR UPDATE`,
        [id]
      );

      const booking = bookingRes.rows[0];
      if (!booking) {
        const err = new Error('Booking tidak ditemukan.');
        err.statusCode = 404;
        throw err;
      }
      if (booking.status !== 'PENDING_PAYMENT') {
        const err = new Error(`Booking ini berstatus "${booking.status}" dan tidak bisa dikonfirmasi lagi.`);
        err.statusCode = 409;
        throw err;
      }

      // 1. Update payment -> VERIFIED
      await client.query(
        `UPDATE payments
         SET status = 'VERIFIED', bank_reference = $1, notes = $2,
             verified_by = $3, verified_at = now()
         WHERE booking_id = $4`,
        [bank_reference || null, notes || null, req.user.id, id]
      );

      // 2. Update booking -> CONFIRMED
      await client.query(
        `UPDATE bookings
         SET status = 'CONFIRMED', confirmed_by = $1, confirmed_at = now()
         WHERE id = $2`,
        [req.user.id, id]
      );

      // 3. Update meja -> CONFIRMED (Merah), lepas locked_until
      await client.query(
        `UPDATE restaurant_tables
         SET status = 'CONFIRMED', locked_until = NULL
         WHERE id = $1`,
        [booking.table_id]
      );

      const itemsRes = await client.query(
        `SELECT menu_name_snapshot, quantity, notes
         FROM booking_items WHERE booking_id = $1`,
        [id]
      );

      return { booking, items: itemsRes.rows };
    });

    // Masukkan struk dapur ke antrean cetak (dieksekusi oleh Print Agent
    // lokal di komputer kasir/dapur restoran, bukan langsung dari sini —
    // lihat backend/print-agent/).
    let printOutcome;
    try {
      printOutcome = await printKitchenReceipt({
        bookingId: result.booking.id,
        bookingCode: result.booking.booking_code,
        tableNumber: result.booking.table_number,
        items: result.items,
        triggeredBy: req.user.id,
      });
    } catch (printErr) {
      console.error('[PRINT] gagal memasukkan struk ke antrean cetak:', printErr);
      printOutcome = { status: 'FAILED', error: printErr.message };
    }

    await logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'BOOKING_CONFIRMED',
      entityType: 'booking',
      entityId: result.booking.id,
      ip: clientIp(req),
      metadata: { booking_code: result.booking.booking_code, bank_reference: bank_reference || null },
    });

    // Broadcast real-time
    const io = req.app.get('io');
    if (io) {
      io.emit('table:status_changed', {
        table_id: result.booking.table_id,
        table_number: result.booking.table_number,
        status: 'CONFIRMED',
        locked_until: null,
      });
      // ← Didengarkan oleh track.html untuk auto-update status
      io.emit('booking:status_changed', {
        id: result.booking.id,
        booking_code: result.booking.booking_code,
        status: 'CONFIRMED',
        table_number: result.booking.table_number,
        confirmed_at: new Date().toISOString(),
      });
      io.emit('booking:confirmed', {
        booking_code: result.booking.booking_code,
        table_number: result.booking.table_number,
      });
      io.emit('kitchen:receipt_printed', {
        booking_code: result.booking.booking_code,
        table_number: result.booking.table_number,
        print_status: printOutcome.status,
      });
    }

    return res.json({
      success: true,
      message: `Pembayaran meja ${result.booking.table_number} terkonfirmasi. Struk dapur ${printOutcome.status === 'QUEUED' ? 'masuk antrean cetak' : 'gagal dimasukkan ke antrean'}.`,
      booking_status: 'CONFIRMED',
      print_status: printOutcome.status,
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode === 500) console.error('[BOOKINGS] confirm payment error:', err);
    return res.status(statusCode).json({ success: false, message: err.message || 'Gagal mengonfirmasi pembayaran.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/bookings/:id/reprint
// Admin/Owner minta cetak ulang struk dapur (mis. printer sempat error).
// ─────────────────────────────────────────────────────────────
router.post('/bookings/:id/reprint', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const bookingRes = await query(
      `SELECT status FROM bookings WHERE id = $1`,
      [req.params.id]
    );
    if (bookingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Booking tidak ditemukan.' });
    }
    if (bookingRes.rows[0].status !== 'CONFIRMED') {
      return res.status(409).json({ success: false, message: 'Hanya booking CONFIRMED yang bisa dicetak ulang.' });
    }

    const printOutcome = await reprintKitchenReceipt(req.params.id, req.user.id);

    await logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'RECEIPT_REPRINT_QUEUED',
      entityType: 'booking',
      entityId: req.params.id,
      ip: clientIp(req),
    });

    return res.json({
      success: true,
      message: 'Cetak ulang masuk antrean. Agent printer dapur akan mencetaknya dalam beberapa detik.',
      print_status: printOutcome.status,
    });
  } catch (err) {
    console.error('[BOOKINGS] reprint error:', err);
    return res.status(500).json({ success: false, message: 'Gagal cetak ulang.' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/bookings/:id/cancel
// Admin/Owner bisa membatalkan manual.
// ─────────────────────────────────────────────────────────────
router.post('/bookings/:id/cancel', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const result = await withTransaction(async (client) => {
      const bookingRes = await client.query(
        `SELECT id, table_id, status FROM bookings WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const booking = bookingRes.rows[0];
      if (!booking) {
        const err = new Error('Booking tidak ditemukan.');
        err.statusCode = 404;
        throw err;
      }
      if (booking.status !== 'PENDING_PAYMENT') {
        const err = new Error('Hanya booking berstatus PENDING_PAYMENT yang bisa dibatalkan manual.');
        err.statusCode = 409;
        throw err;
      }

      await client.query(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_reason = $1 WHERE id = $2`,
        [reason || 'Dibatalkan oleh admin', id]
      );
      await client.query(
        `UPDATE payments SET status = 'REJECTED' WHERE booking_id = $1 AND status = 'PENDING'`,
        [id]
      );
      await client.query(
        `UPDATE restaurant_tables
         SET status = 'AVAILABLE', locked_until = NULL, current_booking_id = NULL
         WHERE id = $1`,
        [booking.table_id]
      );

      return { table_id: booking.table_id };
    });

    await logAudit({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'BOOKING_CANCELLED',
      entityType: 'booking',
      entityId: id,
      ip: clientIp(req),
      metadata: { reason: reason || null },
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('table:status_changed', {
        table_id: result.table_id,
        status: 'AVAILABLE',
        locked_until: null,
      });
    }

    return res.json({ success: true, message: 'Booking dibatalkan, meja kembali tersedia.' });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode === 500) console.error('[BOOKINGS] cancel error:', err);
    return res.status(statusCode).json({ success: false, message: err.message || 'Gagal membatalkan booking.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/stats/today — ringkasan KPI hari ini untuk dashboard
// ─────────────────────────────────────────────────────────────
router.get('/stats/today', authenticate, requireRole('OWNER', 'ADMIN'), async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed_today,
        COUNT(*) FILTER (WHERE status = 'PENDING_PAYMENT') AS pending,
        COUNT(*) FILTER (WHERE status = 'EXPIRED') AS expired_today,
        COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled_today,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'CONFIRMED'), 0) AS revenue_today
      FROM bookings
      WHERE DATE(created_at AT TIME ZONE 'Asia/Jakarta') = CURRENT_DATE AT TIME ZONE 'Asia/Jakarta'
    `);
    return res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    console.error('[BOOKINGS] stats error:', err);
    return res.status(500).json({ success: false, message: 'Gagal memuat statistik.' });
  }
});

module.exports = router;
