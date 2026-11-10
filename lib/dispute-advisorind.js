// Helps staff read a pending cancellation request at a glance. This
// NEVER decides anything on its own — it only summarizes what's in the
// system (when items were locked, whether any were already rejected, how
// long the request has been waiting) and offers a recommendation. Staff
// always click Approve or Deny themselves; silence here never moves
// money (see the auto-deny-on-timeout logic in tabs.js, which denies,
// never approves, if nobody responds).
//
// Same provider-agnostic shape as lib/agent.js: works out of the box with
// a rule-based read, with a spot to wire in a real model later if wanted.

function sqliteUtcToMs(sqliteDatetime) {
  if (!sqliteDatetime) return null;
  return new Date(sqliteDatetime.replace(' ', 'T') + 'Z').getTime();
}

function minutesSince(sqliteDatetime) {
  const ms = sqliteUtcToMs(sqliteDatetime);
  if (ms === null) return null;
  return (Date.now() - ms) / 60000;
}

/**
 * @param {object} args
 * @param {string|null} args.firstLockedAt   earliest order_items.created_at for this tab
 * @param {string|null} args.cancelRequestedAt
 * @param {number} args.rejectedCount        how many items staff already rejected
 * @param {number} args.totalDueCents
 * @param {string} args.currency
 */
function adviseOnCancelRequest({ firstLockedAt, cancelRequestedAt, rejectedCount, totalDueCents, currency }) {
  const sinceLocked = minutesSince(firstLockedAt);
  const sinceRequested = minutesSince(cancelRequestedAt);

  const facts = [];
  facts.push(
    sinceLocked === null
      ? 'Belum ada menu yang pernah dikunci'
      : `Menu pertama dikunci ${Math.round(sinceLocked)} menit lalu`
  );
  if (rejectedCount > 0) {
    facts.push(`${rejectedCount} menu di antaranya sudah ditolak staff sebelumnya`);
  }
  facts.push(`Sisa nilai pesanan saat ini ${(totalDueCents / 100).toFixed(2)} ${currency}`);
  if (sinceRequested !== null) {
    facts.push(`Permintaan batal diajukan ${Math.round(sinceRequested)} menit lalu`);
  }

  let recommendation;
  let reason;
  if (sinceLocked === null) {
    recommendation = 'Setujui';
    reason = 'Tidak ada menu yang tercatat terkunci — aman dibatalkan.';
  } else if (sinceLocked <= 3) {
    recommendation = 'Setujui';
    reason = 'Baru saja dikunci — kemungkinan dapur belum sempat memproses.';
  } else if (sinceLocked > 15) {
    recommendation = 'Cek manual dulu';
    reason = 'Sudah terkunci cukup lama — kemungkinan sudah diproses dapur. Konfirmasi langsung sebelum menyetujui.';
  } else {
    recommendation = 'Cek manual dulu';
    reason = 'Belum ada sinyal yang jelas ke salah satu arah — gunakan penilaian langsung.';
  }

  return { summary: facts.join('. ') + '.', recommendation, reason };
}

module.exports = { adviseOnCancelRequest };
