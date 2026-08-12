require('dotenv').config();
const bcrypt = require('bcrypt');
const { query, pool } = require('../backend/db');

async function main() {
  const email = (process.env.SEED_OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD || '';
  const name = process.env.SEED_OWNER_NAME || 'Owner RM. Sego Abang';
  if (!email || !password) {
    console.log('[SEED] Lewati pembuatan akun: SEED_OWNER_EMAIL/SEED_OWNER_PASSWORD belum diisi.');
    return;
  }
  if (password.length < 8) throw new Error('SEED_OWNER_PASSWORD minimal 8 karakter.');
  const hash = await bcrypt.hash(password, 12);
  await query(`INSERT INTO users(full_name,email,password_hash,role,is_active) VALUES($1,$2,$3,'OWNER',TRUE)
    ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name, password_hash=EXCLUDED.password_hash, role='OWNER', is_active=TRUE`, [name,email,hash]);
  console.log(`[SEED] OWNER siap: ${email}`);
}
main().catch(err=>{console.error('[SEED] gagal:',err);process.exitCode=1;}).finally(()=>pool.end());
