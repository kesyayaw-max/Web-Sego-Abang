const db = require('../db');

/*
 * Provider-neutral notification service.
 * In Railway testing it records notifications in notification_logs.
 * A real WhatsApp provider can be attached later without changing reservation logic.
 */
async function logReservationNotification({reservationId, phone, event, message}) {
  const result = await db.query(`
    INSERT INTO notification_logs(reservation_id,channel,recipient,event,status,message)
    VALUES($1,'WHATSAPP',$2,$3,'PENDING',$4)
    RETURNING *`,
    [reservationId, phone, event, message]
  );
  return result.rows[0];
}
module.exports = { logReservationNotification };
