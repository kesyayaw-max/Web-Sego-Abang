const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('OWNER','ADMIN'));

router.get('/today', async (req, res) => {
  try {
    const [reservations, orders, tables, menu] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM reservations WHERE reservation_at::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date AND status <> 'CANCELLED'`),
      db.query(`SELECT COUNT(*)::int AS count FROM bookings WHERE created_at::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date`),
      db.query(`SELECT status, COUNT(*)::int AS count FROM restaurant_tables GROUP BY status ORDER BY status`),
      db.query(`SELECT COUNT(*)::int AS unavailable FROM menus WHERE stock_status = 'OUT_OF_STOCK' AND is_active = TRUE`)
    ]);
    res.json({
      reservations_today: reservations.rows[0].count,
      orders_today: orders.rows[0].count,
      tables: tables.rows,
      unavailable_menu_items: menu.rows[0].unavailable
    });
  } catch (e) {
    console.error('[OPERATIONS] today error:',e);
    res.status(500).json({ error: 'Gagal memuat ringkasan operasional.' });
  }
});

router.get('/kitchen', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT b.id, b.booking_code, b.table_id, t.table_number, b.customer_name,
             b.kitchen_status, b.order_status, b.payment_status,
             b.status AS booking_status, b.created_at, b.total_amount,
             r.reservation_at
      FROM bookings b
      LEFT JOIN restaurant_tables t ON t.id=b.table_id
      LEFT JOIN reservations r ON r.id=b.reservation_id
      WHERE b.kitchen_status IN ('PENDING','CONFIRMED','COOKING','READY')
      ORDER BY COALESCE(r.reservation_at,b.created_at) ASC, b.created_at ASC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('[OPERATIONS] kitchen error:',e);
    res.status(500).json({ error: 'Gagal memuat antrean dapur.' });
  }
});

router.patch('/kitchen/:id', async (req, res) => {
  const allowed = ['PENDING','CONFIRMED','COOKING','READY','SERVED','COMPLETED'];
  const status = String(req.body.status || '').toUpperCase();
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status dapur tidak valid.' });

  try {
    const result = await db.withTransaction(async (client) => {
      const current = await client.query(`SELECT id,kitchen_status,order_status,status,table_id,booking_code FROM bookings WHERE id=$1 FOR UPDATE`,[req.params.id]);
      if (!current.rowCount) { const e=new Error('Pesanan tidak ditemukan.'); e.statusCode=404; throw e; }
      const b=current.rows[0];
      const order=['PENDING','CONFIRMED','COOKING','READY','SERVED','COMPLETED'];
      const from=order.indexOf(b.kitchen_status), to=order.indexOf(status);
      if (status !== b.kitchen_status && to < from) { const e=new Error(`Status tidak boleh mundur dari ${b.kitchen_status}.`); e.statusCode=409; throw e; }
      if (['COOKING','READY','SERVED','COMPLETED'].includes(status) && b.status === 'CANCELLED') { const e=new Error('Pesanan sudah dibatalkan.'); e.statusCode=409; throw e; }

      const updated = await client.query(`
        UPDATE bookings
        SET kitchen_status=$1,
            order_status=CASE
              WHEN $1='COOKING' THEN 'COOKING'
              WHEN $1='READY' THEN 'READY'
              WHEN $1='SERVED' THEN 'SERVED'
              WHEN $1='COMPLETED' THEN 'COMPLETED'
              WHEN $1='CONFIRMED' THEN 'CONFIRMED'
              ELSE order_status END,
            served_at=CASE WHEN $1='SERVED' THEN COALESCE(served_at,NOW()) ELSE served_at END,
            completed_at=CASE WHEN $1='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END
        WHERE id=$2 RETURNING *`,[status,req.params.id]);

      if (status === 'COMPLETED') {
        await client.query(`UPDATE restaurant_tables SET status='AVAILABLE',locked_until=NULL,current_booking_id=NULL WHERE id=$1 AND current_booking_id=$2`,[b.table_id,b.id]);
      }
      return updated.rows[0];
    });
    const io=req.app.get('io');
    if(io) io.emit('kitchen:status_changed',result);
    res.json(result);
  } catch (e) {
    console.error('[OPERATIONS] kitchen update error:',e);
    res.status(e.statusCode||500).json({ error: e.message || 'Gagal mengubah status dapur.' });
  }
});

module.exports = router;
