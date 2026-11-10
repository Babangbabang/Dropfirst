const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
// const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'Dropfirst.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  tags TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | open | closed
  currency TEXT NOT NULL DEFAULT 'USD',
  party_size INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

-- One row per PayPal authorization (initial hold + any top-ups)
CREATE TABLE IF NOT EXISTS authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  order_id TEXT,                 -- PayPal order id (before approval)
  authorization_id TEXT,         -- PayPal authorization id (after approval)
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created', -- created | authorized | captured | voided
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id TEXT NOT NULL REFERENCES tabs(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  price_cents_at_order INTEGER NOT NULL,
  added_by TEXT DEFAULT 'buyer', -- buyer | agent
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Safe migration: adds columns that didn't exist in earlier versions of this
// schema, for databases created before this change. No-op on fresh installs.
const tabColumns = db.prepare("PRAGMA table_info(tabs)").all().map((c) => c.name);
if (!tabColumns.includes('party_size')) db.exec('ALTER TABLE tabs ADD COLUMN party_size INTEGER DEFAULT 1');
if (!tabColumns.includes('closed_at')) db.exec('ALTER TABLE tabs ADD COLUMN closed_at TEXT');

const seedCount = db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n;
if (seedCount === 0) {
  const insert = db.prepare(
    'INSERT INTO menu_items (name, description, price_cents, tags) VALUES (?, ?, ?, ?)'
  );
  const seed = db.transaction((items) => {
    for (const it of items) insert.run(it.name, it.description, it.price_cents, it.tags);
  });
  seed([
    { name: 'Nasi Goreng', description: 'Indonesian fried rice with egg and prawn crackers', price_cents: 650, tags: 'spicy,rice' },
    { name: 'Satay Ayam (5 skewers)', description: 'Grilled chicken skewers with peanut sauce', price_cents: 500, tags: 'grill,peanut' },
    { name: 'Gado-Gado', description: 'Vegetables and tofu in peanut dressing', price_cents: 450, tags: 'vegetarian,peanut' },
    { name: 'Es Teh Manis', description: 'Sweet iced tea', price_cents: 150, tags: 'drink' },
    { name: 'Es Jeruk', description: 'Fresh iced orange juice', price_cents: 200, tags: 'drink' },
    { name: 'Kerupuk Extra', description: 'Extra prawn crackers', price_cents: 100, tags: 'side' },
    { name: 'Ayam Bakar', description: 'Grilled marinated chicken, half portion', price_cents: 750, tags: 'grill' },
    { name: 'Sop Buntut', description: 'Oxtail soup', price_cents: 950, tags: 'soup' },
  ]);
}

module.exports = db;
