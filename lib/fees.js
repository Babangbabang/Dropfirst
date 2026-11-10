const db = require('./db');

function ensureFeesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extra_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);

  // One-time carry-over: the old design only had a single fee, stored as
  // extra_fee_cents/extra_fee_label on the settings row. If that had a
  // value and this new table is still empty, bring it in as the first row
  // so upgrading doesn't silently drop an existing fee.
  const count = db.prepare('SELECT COUNT(*) AS n FROM extra_fees').get().n;
  if (count === 0) {
    const settingsColumns = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
    if (settingsColumns.includes('extra_fee_cents')) {
      const old = db.prepare('SELECT * FROM settings WHERE id = 1').get();
      if (old && old.extra_fee_cents > 0) {
        db.prepare(
          'INSERT INTO extra_fees (label, description, amount_cents, active) VALUES (?, ?, ?, 1)'
        ).run(old.extra_fee_label || 'Biaya tambahan', '', old.extra_fee_cents);
      }
    }
  }
}
ensureFeesTable();

function serialize(row) {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    amount_cents: row.amount_cents,
    active: !!row.active,
  };
}

/** All fees for the dashboard, or just the active ones for billing. */
function listFees({ activeOnly = false } = {}) {
  const rows = activeOnly
    ? db.prepare('SELECT * FROM extra_fees WHERE active = 1 ORDER BY id').all()
    : db.prepare('SELECT * FROM extra_fees ORDER BY id').all();
  return rows.map(serialize);
}

function createFee({ label, description, amount_cents }) {
  const info = db
    .prepare('INSERT INTO extra_fees (label, description, amount_cents, active) VALUES (?, ?, ?, 1)')
    .run(label, description || '', amount_cents);
  return serialize(db.prepare('SELECT * FROM extra_fees WHERE id = ?').get(info.lastInsertRowid));
}

function updateFee(id, patch) {
  const existing = db.prepare('SELECT * FROM extra_fees WHERE id = ?').get(id);
  if (!existing) return null;
  const next = {
    label: patch.label !== undefined && String(patch.label).trim() ? String(patch.label).trim() : existing.label,
    description: patch.description !== undefined ? patch.description : existing.description,
    amount_cents: patch.amount_cents !== undefined ? patch.amount_cents : existing.amount_cents,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active,
  };
  db.prepare(
    'UPDATE extra_fees SET label = ?, description = ?, amount_cents = ?, active = ? WHERE id = ?'
  ).run(next.label, next.description, next.amount_cents, next.active, id);
  return serialize(db.prepare('SELECT * FROM extra_fees WHERE id = ?').get(id));
}

function deleteFee(id) {
  const existing = db.prepare('SELECT * FROM extra_fees WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM extra_fees WHERE id = ?').run(id);
  return true;
}

module.exports = { listFees, createFee, updateFee, deleteFee };
