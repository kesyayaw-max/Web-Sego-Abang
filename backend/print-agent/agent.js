#!/usr/bin/env node
// print-agent/agent.js
//
// INI DIJALANKAN DI KOMPUTER KASIR/DAPUR RESTORAN, BUKAN DI RAILWAY.
// Tujuannya: backend cloud tidak pernah perlu konek langsung ke printer
// dapur (yang ada di jaringan lokal restoran, bukan internet). Sebagai
// gantinya, proses kecil ini yang:
//   1. Polling `GET {API_BASE}/api/print-queue` tiap POLL_INTERVAL_MS.
//   2. Untuk tiap job QUEUED yang didapat, cetak ke printer thermal
//      lokal (ESC/POS via node-thermal-printer, koneksi TCP LAN biasa).
//   3. Lapor hasilnya ke `POST {API_BASE}/api/print-queue/:id/result`.
//
// Cara pakai:
//   cd backend/print-agent
//   npm install
//   cp .env.example .env   # isi API_BASE_URL, PRINT_AGENT_API_KEY, PRINTER_IP/PORT
//   node agent.js
//   # atau supaya otomatis nyala tiap komputer restoran booting:
//   npm install -g pm2 && pm2 start agent.js --name sego-abang-print-agent

require('dotenv').config();
const { printer: ThermalPrinter, types: PrinterTypes } = require('node-thermal-printer');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';
const AGENT_KEY = process.env.PRINT_AGENT_API_KEY;
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.50';
const PRINTER_PORT = process.env.PRINTER_PORT || '9100';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);

if (!AGENT_KEY) {
  console.error('[AGENT] FATAL: PRINT_AGENT_API_KEY belum di-set di .env. Agent berhenti.');
  process.exit(1);
}

async function fetchQueuedJobs() {
  const res = await fetch(`${API_BASE_URL}/api/print-queue?limit=5`, {
    headers: { 'X-Print-Agent-Key': AGENT_KEY },
  });
  if (!res.ok) throw new Error(`GET /print-queue gagal: ${res.status}`);
  const data = await res.json();
  return data.jobs || [];
}

async function reportResult(jobId, body) {
  const res = await fetch(`${API_BASE_URL}/api/print-queue/${jobId}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Print-Agent-Key': AGENT_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[AGENT] gagal lapor hasil job ${jobId}: ${res.status}`);
}

/**
 * Mencetak satu payload struk ke printer thermal lokal.
 * Struktur cetakan sama seperti versi lama (services/printService.js
 * yang dulu jalan langsung di backend), hanya sekarang jalan di sini.
 */
async function printReceipt(payload) {
  const thermalPrinter = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${PRINTER_IP}:${PRINTER_PORT}`,
    options: { timeout: 5000 },
  });

  const isConnected = await thermalPrinter.isPrinterConnected();
  if (!isConnected) {
    throw new Error(`Printer dapur tidak terhubung di ${PRINTER_IP}:${PRINTER_PORT}`);
  }

  thermalPrinter.alignCenter();
  thermalPrinter.bold(true);
  thermalPrinter.setTextSize(1, 1);
  thermalPrinter.println('RM. SEGO ABANG');
  thermalPrinter.println('PENDOPO WONOMARTO');
  thermalPrinter.println(payload.printed_note === 'CETAK ULANG' ? 'STRUK DAPUR (CETAK ULANG)' : 'STRUK DAPUR');
  thermalPrinter.bold(false);
  thermalPrinter.drawLine();

  thermalPrinter.alignLeft();
  thermalPrinter.println(`No. Pesanan : ${payload.booking_code}`);
  thermalPrinter.println(`Meja        : ${payload.table_number}`);
  thermalPrinter.println(`Waktu       : ${new Date().toLocaleString('id-ID')}`);
  thermalPrinter.drawLine();

  thermalPrinter.setTextSize(1, 2);
  for (const item of payload.items) {
    thermalPrinter.println(`${item.quantity}x ${item.name}`);
    if (item.notes) {
      thermalPrinter.setTextSize(0, 0);
      thermalPrinter.println(`   Catatan: ${item.notes}`);
      thermalPrinter.setTextSize(1, 2);
    }
  }
  thermalPrinter.setTextSize(0, 0);
  thermalPrinter.drawLine();

  thermalPrinter.alignCenter();
  thermalPrinter.println(payload.printed_note || '');
  thermalPrinter.println('Segera siapkan pesanan. Matur nuwun!');
  thermalPrinter.cut();

  await thermalPrinter.execute();
}

async function tick() {
  let jobs;
  try {
    jobs = await fetchQueuedJobs();
  } catch (err) {
    console.error('[AGENT] gagal polling antrean:', err.message);
    return;
  }

  for (const job of jobs) {
    console.log(`[AGENT] mencetak job ${job.id} (booking ${job.payload.booking_code})...`);
    try {
      await printReceipt(job.payload);
      await reportResult(job.id, { status: 'PRINTED', booking_id: job.booking_id });
      console.log(`[AGENT] job ${job.id} berhasil dicetak.`);
    } catch (err) {
      console.error(`[AGENT] job ${job.id} gagal dicetak:`, err.message);
      await reportResult(job.id, {
        status: 'FAILED',
        error_message: err.message,
        booking_id: job.booking_id,
      });
    }
  }
}

console.log('[AGENT] Print Agent RM. Sego Abang Pendopo Wonomarto aktif.');
console.log(`[AGENT] API_BASE_URL = ${API_BASE_URL}`);
console.log(`[AGENT] Printer target = ${PRINTER_IP}:${PRINTER_PORT}`);
console.log(`[AGENT] Polling tiap ${POLL_INTERVAL_MS}ms.`);

setInterval(tick, POLL_INTERVAL_MS);
tick(); // jalankan sekali di awal, tidak menunggu interval pertama
