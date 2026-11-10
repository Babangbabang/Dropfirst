const db = require('./db');

// Single-row settings table — the whole restaurant shares one configuration.
// Add the migration below to lib/db.js if it isn't there yet:
//
//   db.exec(`
//     CREATE TABLE IF NOT EXISTS settings (
//       id INTEGER PRIMARY KEY CHECK (id = 1),
//       cancel_locked INTEGER NOT NULL DEFAULT 0,      -- 0/1: buyers allowed to remove items?
//       table_id_editable INTEGER NOT NULL DEFAULT 1,  -- 0/1: buyer can change table # after setting it once?
//       extra_fee_cents INTEGER NOT NULL DEFAULT 0,    -- flat surcharge added at close (e.g. service charge)
//       extra_fee_label TEXT NOT NULL DEFAULT 'Biaya layanan'
//     );
//   `);
//   db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();

function ensureSettingsTable() {
  // extra_fee_cents / extra_fee_label are kept in CREATE TABLE for anyone
  // upgrading from the single-fee version (lib/fees.js reads them once to
  // migrate into the new extra_fees table) but are no longer written here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cancel_locked INTEGER NOT NULL DEFAULT 0,
      table_id_editable INTEGER NOT NULL DEFAULT 1,
      extra_fee_cents INTEGER NOT NULL DEFAULT 0,
      extra_fee_label TEXT NOT NULL DEFAULT 'Biaya layanan',
      cancel_approval_timeout_minutes INTEGER NOT NULL DEFAULT 15
    );
  `);
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  // Safe migration for a settings row created before this column existed.
  const cols = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
  if (!cols.includes('cancel_approval_timeout_minutes')) {
    db.exec('ALTER TABLE settings ADD COLUMN cancel_approval_timeout_minutes INTEGER NOT NULL DEFAULT 15');
  }
}
ensureSettingsTable();

function getSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  return {
    cancel_locked: !!row.cancel_locked,
    table_id_editable: !!row.table_id_editable,
    cancel_approval_timeout_minutes: row.cancel_approval_timeout_minutes,
  };
}

function updateSettings(patch) {
  const current = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const next = {
    cancel_locked: patch.cancel_locked !== undefined ? (patch.cancel_locked ? 1 : 0) : current.cancel_locked,
    table_id_editable:
      patch.table_id_editable !== undefined ? (patch.table_id_editable ? 1 : 0) : current.table_id_editable,
    cancel_approval_timeout_minutes:
      patch.cancel_approval_timeout_minutes !== undefined
        ? Math.max(1, Number(patch.cancel_approval_timeout_minutes) || 15)
        : current.cancel_approval_timeout_minutes,
  };
  db.prepare(
    'UPDATE settings SET cancel_locked = ?, table_id_editable = ?, cancel_approval_timeout_minutes = ? WHERE id = 1'
  ).run(next.cancel_locked, next.table_id_editable, next.cancel_approval_timeout_minutes);
  return getSettings();
}

module.exports = { getSettings, updateSettings };
