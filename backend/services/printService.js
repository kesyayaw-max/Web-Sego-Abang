// services/printService.js
// Mengirim perintah cetak ke Thermal Printer dapur memakai protokol
// ESC/POS lewat koneksi jaringan (printer thermal LAN, port 9100 —
// standar RAW printing). Memakai library `node-thermal-printer`.
//
// npm install node-thermal-printer
//
// Jika restoran memakai printer USB/Bluetooth, ganti `ThermalPrinter`
// type/interface sesuai driver (mis. 'printer:USB001' atau device path
// Bluetooth). Struktur kode di bawah tetap sama.

const { printer: ThermalPrinter, types: PrinterTypes } = require('node-thermal-printer');
const { query } = require('../db');

/**
 * Mengambil konfigurasi printer dapur dari tabel restaurant_settings
 * supaya IP/port bisa diubah OWNER tanpa redeploy kode.
 */
async function getPrinterConfig() {
  const result = await query(
    `SELECT key, value FROM restaurant_settings
     WHERE key IN ('kitchen_printer_ip', 'kitchen_printer_port')`
  );
  const settings = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
  return {
    ip: settings.kitchen_printer_ip || '192.168.1.50',
    port: settings.kitchen_printer_port || '9100',
  };
}

/**
 * Membangun & mengirim struk dapur ke printer thermal, lalu mencatat
 * hasilnya (sukses/gagal) ke tabel print_logs untuk audit.
 *
 * @param {Object} payload
 * @param {string} payload.bookingId
 * @param {string} payload.bookingCode
 * @param {string} payload.tableNumber
 * @param {Array}  payload.items   - [{ menu_name_snapshot, quantity, notes }]
 * @param {string} payload.triggeredBy - user id admin yang konfirmasi
 */
async function printKitchenReceipt({ bookingId, bookingCode, tableNumber, items, triggeredBy }) {
  const { ip, port } = await getPrinterConfig();

  const thermalPrinter = new ThermalPrinter({
    type: PrinterTypes.EPSON, // sebagian besar printer thermal kompatibel ESC/POS-EPSON
    interface: `tcp://${ip}:${port}`,
    options: { timeout: 5000 },
  });

  let rawPayload = '';
  let printStatus = 'SUCCESS';
  let errorMessage = null;

  try {
    const isConnected = await thermalPrinter.isPrinterConnected();
    if (!isConnected) {
      throw new Error(`Printer dapur tidak terhubung di ${ip}:${port}`);
    }

    thermalPrinter.alignCenter();
    thermalPrinter.bold(true);
    thermalPrinter.setTextSize(1, 1);
    thermalPrinter.println('RM. SEGO ABANG');
    thermalPrinter.println('PENDOPO WONOMARTO');
    thermalPrinter.println('STRUK DAPUR');
    thermalPrinter.bold(false);
    thermalPrinter.drawLine();

    thermalPrinter.alignLeft();
    thermalPrinter.println(`No. Pesanan : ${bookingCode}`);
    thermalPrinter.println(`Meja        : ${tableNumber}`);
    thermalPrinter.println(`Waktu       : ${new Date().toLocaleString('id-ID')}`);
    thermalPrinter.drawLine();

    thermalPrinter.setTextSize(1, 2);
    for (const item of items) {
      thermalPrinter.println(`${item.quantity}x ${item.menu_name_snapshot}`);
      if (item.notes) {
        thermalPrinter.setTextSize(0, 0);
        thermalPrinter.println(`   Catatan: ${item.notes}`);
        thermalPrinter.setTextSize(1, 2);
      }
    }
    thermalPrinter.setTextSize(0, 0);
    thermalPrinter.drawLine();

    thermalPrinter.alignCenter();
    thermalPrinter.println('Pembayaran QRIS TERKONFIRMASI');
    thermalPrinter.println('Segera siapkan pesanan. Matur nuwun!');
    thermalPrinter.cut();

    rawPayload = thermalPrinter.getText();
    await thermalPrinter.execute();
  } catch (err) {
    printStatus = 'FAILED';
    errorMessage = err.message;
    rawPayload = thermalPrinter.getText ? thermalPrinter.getText() : '';
  }

  // Catat hasil cetak ke audit log, apapun hasilnya (sukses/gagal)
  await query(
    `INSERT INTO print_logs (booking_id, triggered_by, status, error_message, raw_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [bookingId, triggeredBy, printStatus, errorMessage, rawPayload]
  );

  if (printStatus === 'FAILED') {
    console.error(`[PRINT] Gagal mencetak struk ${bookingCode}: ${errorMessage}`);
  }

  return { status: printStatus, error: errorMessage };
}

/**
 * Endpoint untuk re-print manual jika printer sebelumnya gagal/kertas habis.
 * Dipanggil dari dashboard admin lewat tombol "Cetak Ulang".
 */
async function reprintKitchenReceipt(bookingId, triggeredBy) {
  const bookingRes = await query(
    `SELECT b.booking_code, t.table_number
     FROM bookings b JOIN restaurant_tables t ON t.id = b.table_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = bookingRes.rows[0];
  if (!booking) throw new Error('Booking tidak ditemukan untuk cetak ulang.');

  const itemsRes = await query(
    `SELECT menu_name_snapshot, quantity, notes FROM booking_items WHERE booking_id = $1`,
    [bookingId]
  );

  return printKitchenReceipt({
    bookingId,
    bookingCode: booking.booking_code,
    tableNumber: booking.table_number,
    items: itemsRes.rows,
    triggeredBy,
  });
}

module.exports = { printKitchenReceipt, reprintKitchenReceipt };
