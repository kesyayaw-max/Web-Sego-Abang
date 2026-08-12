const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { query, withTransaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('OWNER'));

const tableValidation = [
  body('table_number').trim().isLength({ min: 1, max: 10 }).matches(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/).withMessage('Nomor meja tidak valid.'),
  body('capacity').isInt({ min: 1, max: 50 }).withMessage('Kapasitas 1–50 orang.'),
  body('zone').optional({ nullable: true }).trim().isLength({ max: 50 }).withMessage('Zona maksimal 50 karakter.'),
  body('pos_x').optional().isInt({ min: 0, max: 100 }).withMessage('Posisi X harus 0–100.'),
  body('pos_y').optional().isInt({ min: 0, max: 100 }).withMessage('Posisi Y harus 0–100.'),
  body('photo_url').optional({ nullable: true, checkFalsy: true }).isLength({ max: 2000 }).withMessage('URL foto terlalu panjang.')
    .custom(v => !v || /^(https?:\/\/|\/)/i.test(v)).withMessage('Foto harus berupa URL https/http atau path lokal.'),
];

function validErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ success: false, message: errors.array()[0].msg }); return true; }
  return false;
}

router.get('/table-management', async (req, res) => {
  try {
    const result = await query(`SELECT id,table_number,capacity,zone,pos_x,pos_y,status,locked_until,current_booking_id,qr_token,photo_url,created_at,updated_at FROM restaurant_tables ORDER BY table_number ASC`);
    res.json({ success: true, tables: result.rows });
  } catch (err) {
    console.error('[TABLE-MANAGEMENT] list error:', err);
    res.status(500).json({ success: false, message: 'Gagal memuat manajemen meja.' });
  }
});

router.post('/table-management', tableValidation, async (req, res) => {
  if (validErrors(req,res)) return;
  const { table_number, capacity, zone, pos_x=10, pos_y=10, photo_url=null } = req.body;
  try {
    const qr = crypto.randomBytes(30).toString('hex');
    const result = await query(`INSERT INTO restaurant_tables(table_number,capacity,zone,pos_x,pos_y,qr_token,photo_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,table_number,capacity,zone,pos_x,pos_y,status,qr_token,photo_url`, [table_number.trim(),Number(capacity),zone?.trim()||null,Number(pos_x),Number(pos_y),qr,photo_url?.trim()||null]);
    res.status(201).json({ success:true, table:result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({success:false,message:'Nomor meja atau QR token sudah digunakan.'});
    console.error('[TABLE-MANAGEMENT] create error:',err);
    res.status(500).json({success:false,message:'Gagal menambah meja.'});
  }
});

router.put('/table-management/:id', tableValidation, async (req,res)=>{
  if (validErrors(req,res)) return;
  const { table_number, capacity, zone, pos_x=10, pos_y=10, photo_url=null } = req.body;
  try {
    const result=await query(`UPDATE restaurant_tables SET table_number=$1,capacity=$2,zone=$3,pos_x=$4,pos_y=$5,photo_url=$6,updated_at=now() WHERE id=$7 RETURNING id,table_number,capacity,zone,pos_x,pos_y,status,qr_token,photo_url`,[table_number.trim(),Number(capacity),zone?.trim()||null,Number(pos_x),Number(pos_y),photo_url?.trim()||null,req.params.id]);
    if(!result.rowCount) return res.status(404).json({success:false,message:'Meja tidak ditemukan.'});
    res.json({success:true,table:result.rows[0]});
  } catch(err){
    if(err.code==='23505') return res.status(409).json({success:false,message:'Nomor meja sudah digunakan.'});
    console.error('[TABLE-MANAGEMENT] update error:',err); res.status(500).json({success:false,message:'Gagal mengubah meja.'});
  }
});

router.delete('/table-management/:id', async (req,res)=>{
  try {
    const result=await withTransaction(async(client)=>{
      const t=await client.query(`SELECT id,status,current_booking_id FROM restaurant_tables WHERE id=$1 FOR UPDATE`,[req.params.id]);
      if(!t.rowCount){const e=new Error('Meja tidak ditemukan.');e.statusCode=404;throw e;}
      if(t.rows[0].current_booking_id || ['LOCKED','CONFIRMED'].includes(t.rows[0].status)){const e=new Error('Meja sedang dipakai/terkunci dan tidak bisa dihapus.');e.statusCode=409;throw e;}
      const refs=await client.query(`SELECT COUNT(*)::int AS count FROM reservations WHERE table_id=$1 AND status IN ('PENDING','CONFIRMED','ARRIVED')`,[req.params.id]);
      if(Number(refs.rows[0].count)>0){const e=new Error('Meja masih memiliki reservasi aktif. Selesaikan reservasi terlebih dahulu.');e.statusCode=409;throw e;}
      await client.query(`DELETE FROM restaurant_tables WHERE id=$1`,[req.params.id]);
      return true;
    });
    res.json({success:true,message:'Meja berhasil dihapus.'});
  } catch(err){res.status(err.statusCode||500).json({success:false,message:err.message||'Gagal menghapus meja.'});}
});

router.post('/table-management/:id/regenerate-qr', async(req,res)=>{
  try{
    const qr=crypto.randomBytes(30).toString('hex');
    const result=await query(`UPDATE restaurant_tables SET qr_token=$1,updated_at=now() WHERE id=$2 RETURNING id,table_number,qr_token,photo_url`,[qr,req.params.id]);
    if(!result.rowCount)return res.status(404).json({success:false,message:'Meja tidak ditemukan.'});
    res.json({success:true,table:result.rows[0]});
  }catch(err){console.error('[TABLE-MANAGEMENT] qr error:',err);res.status(500).json({success:false,message:'Gagal membuat QR baru.'});}
});

module.exports=router;
