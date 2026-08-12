const crypto = require('crypto');

function canonicalAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Nominal pembayaran tidak valid.');
  return Math.round(n * 100) / 100;
}

function hmacSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function createPayment({ booking, payment, idempotencyKey }) {
  const provider = String(process.env.PAYMENT_PROVIDER || 'MANUAL').toUpperCase();
  const amount = canonicalAmount(payment.locked_amount ?? payment.amount);

  if (provider === 'MOCK') {
    const ref = `MOCK-${booking.booking_code}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    return {
      provider: 'MOCK',
      provider_reference: ref,
      status: 'PENDING',
      qr_image_url: null,
      qr_payload: `DEMO_QRIS|${booking.booking_code}|${amount.toFixed(2)}`,
      expires_at: payment.expires_at || booking.expires_at,
      demo: true,
    };
  }

  if (provider !== 'GENERIC_HTTP') {
    throw Object.assign(new Error('Payment provider belum dikonfigurasi. Gunakan PAYMENT_PROVIDER=MOCK untuk Railway staging atau GENERIC_HTTP untuk provider QRIS resmi.'), { statusCode: 503 });
  }

  const url = String(process.env.PAYMENT_CREATE_URL || '').trim();
  const apiKey = String(process.env.PAYMENT_API_KEY || '').trim();
  if (!url || !apiKey) {
    throw Object.assign(new Error('PAYMENT_CREATE_URL dan PAYMENT_API_KEY wajib diisi untuk provider QRIS.'), { statusCode: 503 });
  }

  const payload = {
    reference: booking.booking_code,
    amount,
    currency: 'IDR',
    method: 'QRIS',
    expires_at: (payment.expires_at || booking.expires_at).toISOString(),
    customer: { name: booking.customer_name, phone: booking.customer_phone },
    metadata: { booking_id: booking.id },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || data.error || `Provider payment HTTP ${response.status}`);
    err.statusCode = 502;
    throw err;
  }
  if (!data.reference && !data.provider_reference) throw Object.assign(new Error('Provider tidak mengembalikan reference pembayaran.'), { statusCode: 502 });
  return {
    provider: 'GENERIC_HTTP',
    provider_reference: data.reference || data.provider_reference,
    status: String(data.status || 'PENDING').toUpperCase(),
    qr_image_url: data.qr_image_url || data.qrImageUrl || null,
    qr_payload: data.qr_payload || data.qrPayload || null,
    expires_at: data.expires_at ? new Date(data.expires_at) : (payment.expires_at || booking.expires_at),
    demo: false,
  };
}

module.exports = { createPayment, canonicalAmount, hmacSignature };
