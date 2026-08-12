
// routes/reservations.js
const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { withTransaction, query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendWhatsApp } = require('../services/whatsappService');

const router = express.Router();

function generateReservationCode() {
  const d = new Date();
  const date = d.toISOString().slice(0,10).replace(/-/g,'');
  const rand = String(Math.floor(10000 + Math.random() * 90000));
  return `RSV-${date}-${rand}`;
}

const createValidation = [
  body('customer_name').trim().isLength({ min: 2, max: 120 }).withMessage('Nama minimal 2 karakter.'),
  body('customer_phone').trim().matches(/^(\+62|62|0)[0-9]{8,13}$/).withMessage('Format nomor WhatsApp tidak valid.'),
  body('table_id').optional().isUUID(),
  body('guest_count').isInt({ min: 1, max: 50 }).withMessage('Jumlah tamu 1–50 orang.'),
  body('reservation_at').isISO8601().withMessage('Tanggal dan waktu reservasi tidak valid.'),
  body('table_id').optional({ nullable: true }).isUUID().withMessage('Meja pilihan tidak valid.'),
  body('notes').optional().isLength({ max: 500 }).withMessage('Catatan maksimal 500 karakter.'),
  body('items').optional().isArray({ max: 50 }).withMessage('Daftar makanan tidak valid.'),
  body('items.*.menu_id').optional().isUUID().withMessage('Menu tidak valid.'),
  body('items.*.quantity').optional().isInt({ min: 1, max: 50 }).withMessage('Jumlah makanan tidak valid.'),
  body('items.*.notes').optional().isLength({ max: 255 }).withMessage('Catatan makanan terlalu panjang.')
];

// Public: meja yang tersedia untuk slot reservasi tertentu.
router.get('/reservation-tables', async (req,res) => {
  try {
    const { reservation_at, guest_count=1 } = req.query;
    if (!reservation_at) return res.status(400).json({success:false,message:'reservation_at wajib diisi.'});
    const at = new Date(reservation_at);
    if (Number.isNaN(at.getTime())) return res.status(400).json({success:false,message:'Waktu reservasi tidak valid.'});
    const duration = parseInt(process.env.RESERVATION_DURATION_MINUTES || '120',10);
    const result = await query(
      `SELECT t.id, t.table_number, t.capacity, t.zone, t.photo_url,
        NOT EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.table_id=t.id
            AND r.status IN ('PENDING','CONFIRMED')
            AND r.reservation_at < $1::timestamptz + ($2::text || ' minutes')::interval
            AND r.reservation_at + (r.duration_minutes::text || ' minutes')::interval > $1::timestamptz
        ) AS available
       FROM restaurant_tables t
       WHERE t.capacity >= $3
       ORDER BY t.table_number`,
      [at.toISOString(), duration, Number(guest_count)]
    );
    res.json({success:true,duration_minutes:duration,tables:result.rows});
  } catch(err) {
    console.error('[RESERVATIONS] tables error:',err);
    res.status(500).json({success:false,message:'Gagal memuat meja reservasi.'});
  }
});

// Public: buat reservasi masa depan. Tidak mengunci meja sekarang.
router.post('/reservations', createValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success:false, message:errors.array()[0].msg });

  const { customer_name, customer_phone, guest_count, reservation_at, table_id, notes } = req.body;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const requestedAt = new Date(reservation_at);
  const duration = parseInt(process.env.RESERVATION_DURATION_MINUTES || '120', 10);

  if (Number.isNaN(requestedAt.getTime())) {
    return res.status(400).json({ success:false, message:'Waktu reservasi tidak valid.' });
  }

  // Reservasi harus berada di masa depan dan maksimal 90 hari.
  const now = new Date();
  const max = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  if (requestedAt <= now) return res.status(400).json({ success:false, message:'Tanggal reservasi harus setelah sekarang.' });
  if (requestedAt > max) return res.status(400).json({ success:false, message:'Reservasi maksimal 90 hari ke depan.' });

  try {
    const result = await withTransaction(async (client) => {
      let chosenTable = null;

      if (table_id) {
        const t = await client.query(
          `SELECT id, table_number, capacity, zone
           FROM restaurant_tables WHERE id = $1 FOR SHARE`,
          [table_id]
        );
        chosenTable = t.rows[0];
        if (!chosenTable) {
          const e = new Error('Meja pilihan tidak ditemukan.'); e.statusCode = 404; throw e;
        }
        if (guest_count > chosenTable.capacity) {
          const e = new Error(`Meja ${chosenTable.table_number} hanya untuk ${chosenTable.capacity} orang.`); e.statusCode = 400; throw e;
        }

        const conflict = await client.query(
          `SELECT reservation_code
           FROM reservations
           WHERE table_id = $1
             AND status IN ('PENDING','CONFIRMED')
             AND reservation_at < $2::timestamptz + ($3::text || ' minutes')::interval
             AND reservation_at + (duration_minutes::text || ' minutes')::interval > $2::timestamptz
           LIMIT 1`,
          [table_id, requestedAt.toISOString(), duration]
        );
        if (conflict.rows.length) {
          const e = new Error(`Meja ${chosenTable.table_number} sudah memiliki reservasi di waktu tersebut.`); e.statusCode = 409; throw e;
        }
      }

      // Validate and snapshot pre-order menu items inside the same transaction.
      let preOrderTotal = 0;
      const normalizedItems = [];
      if (items.length) {
        const ids = [...new Set(items.map(x => x.menu_id).filter(Boolean))];
        const menus = await client.query(
          `SELECT id, name, price, stock_status FROM menus WHERE id = ANY($1::uuid[]) AND is_active = TRUE`,
          [ids]
        );
        const byId = new Map(menus.rows.map(m => [m.id, m]));
        for (const item of items) {
          const menu = byId.get(item.menu_id);
          if (!menu) { const e=new Error('Salah satu menu tidak tersedia.'); e.statusCode=400; throw e; }
          if (menu.stock_status !== 'AVAILABLE') { const e=new Error(`Menu ${menu.name} sedang habis.`); e.statusCode=409; throw e; }
          const qty = Number(item.quantity);
          const subtotal = Number(menu.price) * qty;
          preOrderTotal += subtotal;
          normalizedItems.push({ menu_id: menu.id, name: menu.name, price: menu.price, quantity: qty, notes: item.notes?.trim() || null });
        }
      }

      const code = generateReservationCode();
      const lookupToken = crypto.randomBytes(24).toString('base64url');
      const ins = await client.query(
        `INSERT INTO reservations
          (reservation_code, lookup_token, table_id, customer_name, customer_phone, guest_count, reservation_at, duration_minutes, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, reservation_code, lookup_token, reservation_at, duration_minutes, status`,
        [code, lookupToken, table_id || null, customer_name.trim(), customer_phone.trim(), guest_count, requestedAt.toISOString(), duration, notes?.trim() || null]
      );

      for (const item of normalizedItems) {
        await client.query(
          `INSERT INTO reservation_items (reservation_id, menu_id, quantity, notes, name_snapshot, price_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ins.rows[0].id, item.menu_id, item.quantity, item.notes, item.name, item.price]
        );
      }

      return { reservation: ins.rows[0], table: chosenTable, items: normalizedItems, pre_order_total: preOrderTotal };
    });

    const io = req.app.get('io');
    if (io) io.emit('reservation:new', {
      ...result.reservation,
      table_number: result.table?.table_number || null,
      customer_name: customer_name.trim(),
      guest_count
    });

    sendWhatsApp({reservationId: result.reservation.id, phone: customer_phone, event:'RESERVATION_CREATED', message:`Reservasi ${result.reservation.reservation_code} berhasil dibuat. Menunggu konfirmasi restoran.`}).catch(e=>console.error('[WHATSAPP]',e.message));
    res.status(201).json({
      success: true,
      message: 'Reservasi berhasil dikirim. Tunggu konfirmasi dari restoran.',
      reservation: {
        ...result.reservation,
        table_number: result.table?.table_number || null,
        items: result.items || [],
        pre_order_total: result.pre_order_total || 0
      }
    });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) console.error('[RESERVATIONS] create error:', err);
    res.status(code).json({ success:false, message:err.message || 'Gagal membuat reservasi.' });
  }
});

// Public: cek status dengan kode reservasi.
router.get('/reservations/:code', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(401).json({ success:false, message:'Token akses reservasi diperlukan.' });
    const r = await query(
      `SELECT r.id, r.reservation_code, r.customer_name, r.guest_count,
              r.reservation_at, r.duration_minutes, r.notes, r.status,
              r.created_at, t.table_number, t.zone
       FROM reservations r
       LEFT JOIN restaurant_tables t ON t.id = r.table_id
       WHERE r.reservation_code = $1 AND r.lookup_token = $2`,
      [req.params.code, token]
    );
    if (!r.rows.length) return res.status(404).json({ success:false, message:'Kode reservasi tidak ditemukan.' });
    const items = await query(
      `SELECT ri.menu_id, ri.quantity, ri.notes, m.name, m.price, (m.price * ri.quantity) AS subtotal
       FROM reservation_items ri JOIN menus m ON m.id=ri.menu_id
       WHERE ri.reservation_id=$1 ORDER BY ri.created_at`,
      [r.rows[0].id]
    );
    res.json({ success:true, reservation:{...r.rows[0], items:items.rows} });
  } catch (err) {
    console.error('[RESERVATIONS] public status error:', err);
    res.status(500).json({ success:false, message:'Gagal memuat reservasi.' });
  }
});

// Admin: detail reservasi + pre-order.
router.get('/reservations/:id', authenticate, requireRole('OWNER','ADMIN'), async (req,res)=>{
  try{
    const rr=await query(
      `SELECT r.*, t.table_number, t.zone
       FROM reservations r LEFT JOIN restaurant_tables t ON t.id=r.table_id
       WHERE r.id=$1`,[req.params.id]);
    if(!rr.rows.length)return res.status(404).json({success:false,message:'Reservasi tidak ditemukan.'});
    const ir=await query(
      `SELECT ri.menu_id, ri.quantity, ri.notes, COALESCE(ri.name_snapshot,m.name) AS name, COALESCE(ri.price_snapshot,m.price) AS price,
              (COALESCE(ri.price_snapshot,m.price)*ri.quantity) AS subtotal
       FROM reservation_items ri JOIN menus m ON m.id=ri.menu_id
       WHERE ri.reservation_id=$1 ORDER BY ri.created_at`,[req.params.id]);
    res.json({success:true,reservation:{...rr.rows[0],items:ir.rows}});
  }catch(err){
    console.error('[RESERVATIONS] detail error:',err);
    res.status(500).json({success:false,message:'Gagal memuat detail reservasi.'});
  }
});

// Admin: daftar reservasi.
router.get('/reservations', authenticate, requireRole('OWNER','ADMIN'), async (req,res) => {
  try {
    const { date, status } = req.query;
    const params = [];
    const conditions = [];
    if (date) { params.push(date); conditions.push(`DATE(r.reservation_at AT TIME ZONE 'Asia/Jakarta') = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await query(
      `SELECT r.id, r.reservation_code, r.customer_name, r.customer_phone, r.guest_count,
              r.reservation_at, r.duration_minutes, r.notes, r.status,
              r.created_at, r.confirmed_at, t.table_number, t.zone,
              COALESCE((SELECT SUM(ri.quantity) FROM reservation_items ri WHERE ri.reservation_id=r.id),0) AS pre_order_qty
       FROM reservations r
       LEFT JOIN restaurant_tables t ON t.id = r.table_id
       ${where}
       ORDER BY r.reservation_at ASC`,
      params
    );
    res.json({ success:true, reservations:rows.rows });
  } catch (err) {
    console.error('[RESERVATIONS] list error:', err);
    res.status(500).json({ success:false, message:'Gagal memuat reservasi.' });
  }
});

// Admin: konfirmasi dan opsional memilih meja.
router.post('/reservations/:id/confirm', authenticate, requireRole('OWNER','ADMIN'), async (req,res) => {
  const { table_id } = req.body || {};
  try {
    const result = await withTransaction(async (client) => {
      const rr = await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`, [req.params.id]);
      const r = rr.rows[0];
      if (!r) { const e=new Error('Reservasi tidak ditemukan.'); e.statusCode=404; throw e; }
      if (!['PENDING'].includes(r.status)) { const e=new Error(`Reservasi berstatus ${r.status}.`); e.statusCode=409; throw e; }

      let chosen = r.table_id;
      if (table_id) chosen = table_id;

      if (chosen) {
        const t = await client.query(`SELECT id, table_number, capacity FROM restaurant_tables WHERE id=$1 FOR SHARE`, [chosen]);
        if (!t.rows[0]) { const e=new Error('Meja tidak ditemukan.'); e.statusCode=404; throw e; }
        if (r.guest_count > t.rows[0].capacity) { const e=new Error(`Meja ${t.rows[0].table_number} tidak cukup untuk ${r.guest_count} orang.`); e.statusCode=400; throw e; }

        const conflict = await client.query(
          `SELECT reservation_code FROM reservations
           WHERE id <> $1 AND table_id=$2 AND status IN ('PENDING','CONFIRMED')
             AND reservation_at < $3::timestamptz + (duration_minutes::text || ' minutes')::interval
             AND reservation_at + (duration_minutes::text || ' minutes')::interval > $3::timestamptz
           LIMIT 1`,
          [r.id, chosen, r.reservation_at]
        );
        if (conflict.rows.length) { const e=new Error('Meja tersebut bentrok dengan reservasi lain.'); e.statusCode=409; throw e; }
      }

      const upd = await client.query(
        `UPDATE reservations SET status='CONFIRMED', table_id=$1, confirmed_by=$2, confirmed_at=now(), updated_at=now()
         WHERE id=$3
         RETURNING id,reservation_code, reservation_at, customer_name, guest_count`,
        [chosen || null, req.user.id, r.id]
      );

      const itemRes = await client.query(`
        SELECT ri.menu_id, ri.quantity, ri.notes, m.name, m.price
        FROM reservation_items ri JOIN menus m ON m.id=ri.menu_id
        WHERE ri.reservation_id=$1 ORDER BY ri.created_at`, [r.id]);
      let preorderBooking = null;
      if (itemRes.rowCount > 0 && !chosen) { const e=new Error('Reservasi dengan pre-order wajib memiliki meja yang dikonfirmasi.'); e.statusCode=400; throw e; }
      if (itemRes.rowCount > 0) {
        const existing = await client.query(`SELECT id,booking_code FROM bookings WHERE reservation_id=$1 LIMIT 1 FOR UPDATE`,[r.id]);
        if (existing.rowCount) {
          preorderBooking = existing.rows[0];
        } else {
          const total = itemRes.rows.reduce((sum,x)=>sum+Number(x.price)*Number(x.quantity),0);
          const code = `RSV-${r.reservation_code}`;
          const b = await client.query(`
            INSERT INTO bookings (booking_code,public_token,reservation_id,table_id,customer_name,customer_phone,guest_count,total_amount,status,payment_status,order_status,kitchen_status,expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED','UNPAID','CONFIRMED','CONFIRMED',$9)
            RETURNING id,booking_code,public_token,total_amount,status,payment_status,order_status,kitchen_status`,
            [code,crypto.randomBytes(24).toString('base64url'),r.id,chosen||null,r.customer_name,r.customer_phone,r.guest_count,total,new Date(new Date(r.reservation_at).getTime()+Number(r.duration_minutes)*60000)]
          );
          preorderBooking=b.rows[0];
          for (const item of itemRes.rows) {
            await client.query(`INSERT INTO booking_items(booking_id,menu_id,menu_name_snapshot,price_snapshot,quantity,subtotal,notes) VALUES($1,$2,$3,$4,$5,$6,$7)`,[preorderBooking.id,item.menu_id,item.name,item.price,item.quantity,Number(item.price)*Number(item.quantity),item.notes||null]);
          }
          await client.query(`INSERT INTO payments (booking_id,amount,method,status,locked_amount,expires_at,provider) VALUES ($1,$2,'QRIS','PENDING',$2,$3,'MANUAL')`,[preorderBooking.id,total,new Date(new Date(r.reservation_at).getTime()+Number(r.duration_minutes)*60000)]);
        }
      }
      if (chosen) {
        await client.query(`UPDATE restaurant_tables SET status='RESERVED', locked_until=NULL, current_booking_id=$1, updated_at=now() WHERE id=$2 AND status IN ('AVAILABLE','RESERVED')`, [preorderBooking?.id || null, chosen]);
      }
      const t = chosen ? await client.query(`SELECT table_number FROM restaurant_tables WHERE id=$1`, [chosen]) : {rows:[]};
      return { ...upd.rows[0], table_number:t.rows[0]?.table_number || null, preorder_booking:preorderBooking };
    });

    const io=req.app.get('io');
    if(io) io.emit('reservation:status_changed', result);
    sendWhatsApp({reservationId: result.id, phone:(await query('SELECT customer_phone FROM reservations WHERE id=$1',[result.id])).rows[0]?.customer_phone, event:'RESERVATION_CONFIRMED', message:`Reservasi ${result.reservation_code} sudah dikonfirmasi. Sampai jumpa di RM Sego Abang.`}).catch(e=>console.error('[WHATSAPP]',e.message));
    res.json({ success:true, message:'Reservasi dikonfirmasi.', reservation:result });
  } catch(err) {
    const code=err.statusCode||500;
    if(code===500) console.error('[RESERVATIONS] confirm error:',err);
    res.status(code).json({ success:false, message:err.message||'Gagal mengonfirmasi reservasi.' });
  }
});


// Admin: tandai customer sudah datang. Pre-order yang terkait langsung masuk antrean dapur.
router.post('/reservations/:id/arrive', authenticate, requireRole('OWNER','ADMIN'), async (req,res)=>{
  try{
    const result=await withTransaction(async(client)=>{
      const rr=await client.query(`SELECT * FROM reservations WHERE id=$1 FOR UPDATE`,[req.params.id]);
      const r=rr.rows[0];
      if(!r){const e=new Error('Reservasi tidak ditemukan.');e.statusCode=404;throw e;}
      if(r.status!=='CONFIRMED'){const e=new Error(`Reservasi berstatus ${r.status} dan belum bisa ditandai datang.`);e.statusCode=409;throw e;}
      const upd=await client.query(`UPDATE reservations SET status='ARRIVED',updated_at=now() WHERE id=$1 RETURNING id,reservation_code,customer_name,table_id,status`,[r.id]);
      const b=await client.query(`UPDATE bookings SET order_status=CASE WHEN kitchen_status='CONFIRMED' THEN 'COOKING' ELSE order_status END, kitchen_status=CASE WHEN kitchen_status='CONFIRMED' THEN 'COOKING' ELSE kitchen_status END, updated_at=now() WHERE reservation_id=$1 AND status='CONFIRMED' RETURNING id,booking_code,table_id,kitchen_status,order_status`,[r.id]);
      if(r.table_id) await client.query(`UPDATE restaurant_tables SET status='CONFIRMED',current_booking_id=$1,locked_until=NULL,updated_at=now() WHERE id=$2`,[b.rows[0]?.id||null,r.table_id]);
      return {reservation:upd.rows[0],booking:b.rows[0]||null};
    });
    const io=req.app.get('io'); if(io) io.emit('reservation:status_changed',result.reservation), io.emit('reservation:arrived',result);
    sendWhatsApp({reservationId: result.reservation.id, phone:(await query('SELECT customer_phone FROM reservations WHERE id=$1',[result.reservation.id])).rows[0]?.customer_phone, event:'CUSTOMER_ARRIVED', message:`Customer ${result.reservation.reservation_code} sudah tercatat datang. Pesanan mulai diproses.`}).catch(e=>console.error('[WHATSAPP]',e.message));
    res.json({success:true,message:'Customer ditandai sudah datang.',reservation:result.reservation,booking:result.booking});
  }catch(err){res.status(err.statusCode||500).json({success:false,message:err.message||'Gagal menandai customer datang.'});}
});

// Admin: batalkan.
router.post('/reservations/:id/cancel', authenticate, requireRole('OWNER','ADMIN'), async (req,res) => {
  try {
    const result=await withTransaction(async(client)=>{
      const r=await client.query(`UPDATE reservations SET status='CANCELLED', cancelled_at=now(), updated_at=now() WHERE id=$1 AND status IN ('PENDING','CONFIRMED') RETURNING id,reservation_code`, [req.params.id]);
      if(!r.rows.length){const e=new Error('Reservasi tidak ditemukan atau sudah diproses.');e.statusCode=409;throw e;}
      await client.query(`UPDATE bookings SET status='CANCELLED', cancelled_reason='Reservasi dibatalkan' WHERE reservation_id=$1 AND status='CONFIRMED'`,[r.rows[0].id]);
      await client.query(`UPDATE restaurant_tables SET status='AVAILABLE',locked_until=NULL,current_booking_id=NULL,updated_at=now() WHERE id=(SELECT table_id FROM reservations WHERE id=$1) AND status='RESERVED'`,[r.rows[0].id]);
      return r.rows[0];
    });
    const io=req.app.get('io');
    if(io) io.emit('reservation:status_changed', { reservation_code:result.reservation_code, status:'CANCELLED' });
    res.json({ success:true, message:'Reservasi dibatalkan.' });
  } catch(err) {
    console.error('[RESERVATIONS] cancel error:',err);
    res.status(err.statusCode||500).json({ success:false, message:err.message||'Gagal membatalkan reservasi.' });
  }
});

module.exports = router;
