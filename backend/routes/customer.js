const express = require('express');
const db = require('../db');
const router = express.Router();

function cleanPhone(v) { return String(v || '').replace(/\D/g, ''); }

router.post('/reservation-lookup', async (req,res)=>{
  const phone=cleanPhone(req.body.phone);
  const token=String(req.body.lookup_token||'').trim();
  if (!phone || !token) return res.status(400).json({error:'Kode akses reservasi dan nomor WhatsApp wajib diisi.'});
  try {
    const r=await db.query(`
      SELECT r.id,r.reservation_code,r.status,r.reservation_at,r.duration_minutes,r.guest_count,r.table_id,
             r.customer_name,r.customer_phone,r.notes,r.confirmed_at,r.cancelled_at,
             t.table_number,t.zone
      FROM reservations r
      LEFT JOIN restaurant_tables t ON t.id=r.table_id
      WHERE r.lookup_token=$1 AND regexp_replace(r.customer_phone,'\\D','','g')=$2
      LIMIT 1`,[token,phone]);
    if(!r.rowCount) return res.status(404).json({error:'Reservasi tidak ditemukan atau data akses tidak cocok.'});
    const reservation=r.rows[0];
    const items=await db.query(`
      SELECT ri.quantity,ri.notes,COALESCE(ri.name_snapshot,m.name) AS name,COALESCE(ri.price_snapshot,m.price) AS price,(COALESCE(ri.price_snapshot,m.price)*ri.quantity) AS subtotal
      FROM reservation_items ri JOIN menus m ON m.id=ri.menu_id
      WHERE ri.reservation_id=$1 ORDER BY ri.created_at`,[reservation.id]);
    res.json({...reservation,items:items.rows});
  } catch(e){console.error('[CUSTOMER] lookup error:',e);res.status(500).json({error:'Gagal mencari reservasi.'});}
});

router.post('/reservation/:id/cancel', async (req,res)=>{
  const phone=cleanPhone(req.body.phone); const token=String(req.body.lookup_token||'').trim();
  if (!phone || !token) return res.status(400).json({error:'Token akses dan nomor WhatsApp wajib diisi.'});
  try{
    const r=await db.withTransaction(async(client)=>{
      const updated=await client.query(`UPDATE reservations SET status='CANCELLED',cancelled_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND lookup_token=$3 AND regexp_replace(customer_phone,'\\D','','g')=$2
          AND status IN ('PENDING','CONFIRMED') AND reservation_at > NOW()
        RETURNING id,reservation_code,status`,[req.params.id,phone,token]);
      if(!updated.rowCount) return updated;
      await client.query(`UPDATE bookings SET status='CANCELLED',cancelled_reason='Reservasi dibatalkan pelanggan' WHERE reservation_id=$1 AND status='CONFIRMED'`,[updated.rows[0].id]);
      return updated;
    });
    if(!r.rowCount) return res.status(404).json({error:'Reservasi tidak dapat dibatalkan.'});
    const io=req.app.get('io');
    if(io) io.emit('reservation:status_changed',{reservation_code:r.rows[0].reservation_code,status:'CANCELLED'});
    res.json({success:true,...r.rows[0]});
  }catch(e){console.error('[CUSTOMER] cancel error:',e);res.status(500).json({error:'Gagal membatalkan reservasi.'});}
});

module.exports=router;
