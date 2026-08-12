const db = require('../db');

function normalizePhone(phone) {
  let p = String(phone || '').replace(/[^0-9+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = `62${p.slice(1)}`;
  if (!p.startsWith('62')) return null;
  return p;
}

async function sendWhatsApp({ reservationId = null, phone, event, message, templateName = null, templateParams = [] }) {
  const recipient = normalizePhone(phone);
  if (!recipient) throw new Error('Nomor WhatsApp tidak valid.');
  const mode = String(process.env.WHATSAPP_PROVIDER || 'LOG_ONLY').toUpperCase();

  const log = await db.query(`INSERT INTO notification_logs(reservation_id,channel,recipient,event,status,message,provider)
    VALUES($1,'WHATSAPP',$2,$3,'PENDING',$4,$5) RETURNING id`,
    [reservationId, recipient, event, message, mode]);
  const logId = log.rows[0].id;

  if (mode === 'LOG_ONLY' || mode === 'MOCK') {
    await db.query(`UPDATE notification_logs SET status='SENT', sent_at=now() WHERE id=$1`, [logId]);
    return { sent: true, provider: mode, demo: mode === 'MOCK', log_id: logId };
  }

  if (mode !== 'META_CLOUD') throw new Error('WHATSAPP_PROVIDER tidak didukung.');
  const version = String(process.env.WHATSAPP_GRAPH_VERSION || '').trim();
  const phoneId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const token = String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
  if (!version || !phoneId || !token) throw new Error('Konfigurasi WhatsApp Cloud API belum lengkap.');

  const effectiveTemplate = templateName || process.env.WHATSAPP_DEFAULT_TEMPLATE || null;
  const body = effectiveTemplate ? {
    messaging_product: 'whatsapp', to: recipient, type: 'template',
    template: { name: effectiveTemplate, language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'id' },
      components: templateParams.length ? [{ type: 'body', parameters: templateParams.map(text => ({ type:'text', text:String(text) })) }] : [] }
  } : { messaging_product:'whatsapp', to:recipient, type:'text', text:{ body:message, preview_url:false } };

  const response = await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneId)}/messages`, {
    method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${token}`}, body:JSON.stringify(body)
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) {
    await db.query(`UPDATE notification_logs SET status='FAILED', error_message=$2 WHERE id=$1`, [logId, data.error?.message || `HTTP ${response.status}`]);
    throw new Error(data.error?.message || `WhatsApp HTTP ${response.status}`);
  }
  const providerMessageId = data.messages?.[0]?.id || null;
  await db.query(`UPDATE notification_logs SET status='SENT', provider_message_id=$2, sent_at=now() WHERE id=$1`, [logId, providerMessageId]);
  return { sent:true, provider:'META_CLOUD', provider_message_id:providerMessageId, log_id:logId };
}

module.exports = { sendWhatsApp, normalizePhone };
