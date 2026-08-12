const express=require('express');
const crypto=require('crypto');
const {withTransaction,query}=require('../db');
const {createPayment}=require('../services/paymentProvider');
const {sendWhatsApp}=require('../services/whatsappService');
const router=express.Router();

function safeStatus(s){ return ['VERIFIED','REJECTED','EXPIRED'].includes(String(s||'').toUpperCase()) ? String(s).toUpperCase() : null; }

// Create/return one locked payment attempt. The amount is read from the booking,
// never from the browser.
router.post('/payments/create', async(req,res)=>{
  const {booking_code, token, idempotency_key}=req.body||{};
  if(!booking_code || !token) return res.status(400).json({success:false,message:'booking_code dan token wajib diisi.'});
  const idem=String(idempotency_key||`WEB-${booking_code}`).slice(0,120);
  try{
    const bookingRes=await query(`SELECT b.id,b.booking_code,b.public_token,b.customer_name,b.customer_phone,b.total_amount,b.status,b.payment_status,b.expires_at,
      p.id payment_id,p.amount,p.locked_amount,p.status payment_status_row,p.provider,p.provider_reference,p.qr_image_url,p.qr_payload,p.expires_at payment_expires_at
      FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id
      WHERE b.booking_code=$1 AND b.public_token=$2 ORDER BY p.created_at DESC LIMIT 1`,[booking_code,token]);
    if(!bookingRes.rowCount) return res.status(404).json({success:false,message:'Booking tidak ditemukan.'});
    const b=bookingRes.rows[0];
    if(b.status==='EXPIRED' || b.status==='CANCELLED') return res.status(409).json({success:false,message:'Booking sudah tidak dapat dibayar.'});
    if(b.payment_status==='PAID' || b.payment_status_row==='VERIFIED') return res.json({success:true,paid:true,payment:{status:'VERIFIED',amount:b.total_amount,provider_reference:b.provider_reference}});
    if(b.expires_at && new Date(b.expires_at)<=new Date()) return res.status(409).json({success:false,message:'Waktu pembayaran sudah habis.'});

    const payment=await withTransaction(async(client)=>{
      const locked=await client.query(`SELECT b.*,p.id payment_id,p.status payment_status,p.provider,p.provider_reference,p.qr_image_url,p.qr_payload,p.expires_at payment_expires_at,p.locked_amount,p.amount
        FROM bookings b JOIN payments p ON p.booking_id=b.id WHERE b.id=$1 FOR UPDATE OF b,p`,[b.id]);
      if(!locked.rowCount) throw Object.assign(new Error('Payment belum dibuat.'),{statusCode:409});
      const row=locked.rows[0];
      if(row.status==='EXPIRED'||row.status==='CANCELLED') throw Object.assign(new Error('Booking sudah tidak dapat dibayar.'),{statusCode:409});
      if(row.payment_status==='VERIFIED') return row;
      if(row.payment_expires_at && new Date(row.payment_expires_at)<=new Date()) throw Object.assign(new Error('Waktu pembayaran sudah habis.'),{statusCode:409});
      if(row.idempotency_key===idem && row.provider_reference) return row;
      await client.query(`UPDATE payments SET idempotency_key=$1,locked_amount=amount,expires_at=COALESCE(expires_at,$2),updated_at=now() WHERE id=$3`,[idem,row.expires_at,row.payment_id]);
      return {...row,idempotency_key:idem,locked_amount:row.amount,expires_at:row.expires_at};
    });

    if(payment.provider_reference && payment.qr_image_url) return res.json({success:true,paid:false,payment:{status:payment.payment_status,amount:payment.locked_amount,provider:payment.provider,provider_reference:payment.provider_reference,qr_image_url:payment.qr_image_url,qr_payload:payment.qr_payload,expires_at:payment.payment_expires_at||payment.expires_at}});

    const created=await createPayment({booking:b,payment,idempotencyKey:idem});
    const updated=await query(`UPDATE payments SET provider=$1,provider_reference=$2,qr_image_url=$3,qr_payload=$4,expires_at=$5,updated_at=now() WHERE id=$6 RETURNING status,amount,locked_amount,provider,provider_reference,qr_image_url,qr_payload,expires_at`,[created.provider,created.provider_reference,created.qr_image_url,created.qr_payload,created.expires_at,payment.payment_id]);
    const out=updated.rows[0];
    res.json({success:true,paid:false,payment:{...out,demo:!!created.demo}});
  }catch(err){console.error('[PAYMENT CREATE]',err);res.status(err.statusCode||500).json({success:false,message:err.message||'Gagal membuat pembayaran.'});}
});

router.get('/payments/:bookingCode/status',async(req,res)=>{
  const token=String(req.query.token||'').trim();
  if(!token) return res.status(401).json({success:false,message:'Token akses booking diperlukan.'});
  try{
    const r=await query(`SELECT b.booking_code,b.total_amount,b.status,b.payment_status,b.expires_at,p.status payment_row_status,p.amount,p.locked_amount,p.provider,p.provider_reference,p.qr_image_url,p.qr_payload,p.expires_at payment_expires_at
      FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id WHERE b.booking_code=$1 AND b.public_token=$2 ORDER BY p.created_at DESC LIMIT 1`,[req.params.bookingCode,token]);
    if(!r.rowCount) return res.status(404).json({success:false,message:'Booking tidak ditemukan.'});
    res.json({success:true,payment:r.rows[0]});
  }catch(err){res.status(500).json({success:false,message:'Gagal memuat status pembayaran.'});}
});

// Provider-neutral webhook. Signature is HMAC-SHA256 of the exact raw request body.
router.post('/payments/webhook',async(req,res)=>{
  const secret=process.env.PAYMENT_WEBHOOK_SECRET||'';
  if(!secret) return res.status(503).json({success:false,message:'Payment webhook belum dikonfigurasi.'});
  const signature=String(req.headers['x-payment-signature']||'').trim().toLowerCase();
  const raw=req.rawBody || Buffer.from(JSON.stringify(req.body||{}));
  const expected=crypto.createHmac('sha256',secret).update(raw).digest('hex');
  if(!signature || !/^[a-f0-9]{64}$/.test(signature) || !crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'))) return res.status(401).json({success:false,message:'Signature pembayaran tidak valid.'});
  const {event_id,booking_id,status,reference,notes,amount}=req.body||{};
  const next=safeStatus(status);
  if(!booking_id || !event_id || !next) return res.status(400).json({success:false,message:'Payload webhook tidak valid.'});
  try{
    const result=await withTransaction(async(client)=>{
      const hash=crypto.createHash('sha256').update(raw).digest('hex');
      const inserted=await client.query(`INSERT INTO payment_webhook_events(provider,event_id,payload_hash,status) VALUES($1,$2,$3,'RECEIVED') ON CONFLICT(provider,event_id) DO NOTHING RETURNING id`,[process.env.PAYMENT_PROVIDER||'GENERIC_HTTP',event_id,hash]);
      if(!inserted.rowCount) return {duplicate:true};
      const b=await client.query(`SELECT id,booking_code,status,total_amount FROM bookings WHERE id=$1 FOR UPDATE`,[booking_id]);
      if(!b.rowCount) throw Object.assign(new Error('Booking tidak ditemukan.'),{statusCode:404});
      const p=await client.query(`SELECT id,amount,locked_amount,status FROM payments WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[booking_id]);
      if(!p.rowCount) throw Object.assign(new Error('Payment tidak ditemukan.'),{statusCode:404});
      const pay=p.rows[0];
      if(amount!==undefined && Number(amount)!==Number(pay.locked_amount??pay.amount)) throw Object.assign(new Error('Nominal webhook tidak sesuai nominal yang dikunci.'),{statusCode:409});
      await client.query(`UPDATE payments SET status=$1::payment_status,bank_reference=COALESCE($2,bank_reference),notes=COALESCE($3,notes),verified_at=CASE WHEN $1='VERIFIED' THEN COALESCE(verified_at,now()) ELSE verified_at END,updated_at=now() WHERE id=$4`,[next,reference||null,notes||null,pay.id]);
      if(next==='VERIFIED') await client.query(`UPDATE bookings SET status='CONFIRMED',payment_status='PAID',order_status=CASE WHEN order_status='PENDING' THEN 'CONFIRMED' ELSE order_status END,kitchen_status=CASE WHEN kitchen_status='PENDING' THEN 'CONFIRMED' ELSE kitchen_status END,confirmed_at=COALESCE(confirmed_at,now()),updated_at=now() WHERE id=$1 AND status<>'CANCELLED'`,[booking_id]);
      else await client.query(`UPDATE bookings SET status=CASE WHEN status='PENDING_PAYMENT' THEN $2::booking_status ELSE status END,payment_status=CASE WHEN $2='CANCELLED' THEN 'UNPAID' ELSE 'FAILED' END,updated_at=now() WHERE id=$1`,[booking_id,next==='REJECTED'?'CANCELLED':'EXPIRED']);
      await client.query(`UPDATE payment_webhook_events SET processed_at=now(),status='PROCESSED' WHERE id=$1`,[inserted.rows[0].id]);
      return {duplicate:false,booking:b.rows[0]};
    });
    if(!result.duplicate){
      const io=req.app.get('io'); if(io) io.emit('booking:payment_updated',{booking_id,booking_code:result.booking.booking_code,status:next});
      if(next==='VERIFIED') sendWhatsApp({phone:(await query('SELECT customer_phone FROM bookings WHERE id=$1',[booking_id])).rows[0]?.customer_phone,event:'PAYMENT_CONFIRMED',message:`Pembayaran ${result.booking.booking_code} sudah berhasil dikonfirmasi.`}).catch(e=>console.error('[WHATSAPP]',e.message));
    }
    res.json({success:true,duplicate:result.duplicate});
  }catch(err){console.error('[PAYMENT WEBHOOK]',err);res.status(err.statusCode||500).json({success:false,message:err.message||'Gagal memproses webhook.'});}
});
module.exports=router;
