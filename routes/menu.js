const express = require('express');
const db = require('../lib/db');

const router = express.Router();

// Self-migration: ingredients (comma-separated tag list, same convention as
// the existing `tags` column) + a soft-delete flag. We never hard-delete a
// menu item — past orders JOIN on menu_item_id, so removing the row would
// break old invoices and order history. "Delete" from the dashboard just
// sets active = 0.
const menuColumns = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
if (!menuColumns.includes('ingredients')) {
  db.exec("ALTER TABLE menu_items ADD COLUMN ingredients TEXT NOT NULL DEFAULT ''");
}
if (!menuColumns.includes('active')) {
  db.exec('ALTER TABLE menu_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}

function parseList(csv) {
  return (csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Accepts either an array (["nasi","telur"]) or a comma string ("nasi, telur")
// from the client and normalizes it to the comma-separated form we store.
function toCsv(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean).join(',');
  if (typeof value === 'string') return parseList(value).join(',');
  return '';
}

function serializeItem(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price_cents: row.price_cents,
    tags: parseList(row.tags),
    ingredients: parseList(row.ingredients),
    active: !!row.active,
  };
}

/** GET /api/menu — buyer-facing list: active items only. */
router.get('/menu', (req, res) => {
  const items = db.prepare('SELECT * FROM menu_items WHERE active = 1 ORDER BY id').all().map(serializeItem);
  res.json({ items });
});

/**
 * GET /api/menu/all — dashboard: every item, including inactive ones, so
 * staff can see and re-enable something they turned off earlier.
 */
router.get('/menu/all', (req, res) => {
  const items = db.prepare('SELECT * FROM menu_items ORDER BY id').all().map(serializeItem);
  res.json({ items });
});

/** POST /api/menu — dashboard: create a new menu item. */
router.post('/menu', (req, res) => {
  const { name, description, price_cents, tags, ingredients } = req.body || {};
  const priceCents = Number(price_cents);

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    return res.status(400).json({ error: 'price_cents must be a non-negative integer' });
  }

  const info = db
    .prepare(
      'INSERT INTO menu_items (name, description, price_cents, tags, ingredients, active) VALUES (?, ?, ?, ?, ?, 1)'
    )
    .run(name.trim(), description || '', priceCents, toCsv(tags), toCsv(ingredients));

  res.json(serializeItem(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(info.lastInsertRowid)));
});

/**
 * PUT /api/menu/:id — dashboard: edit a menu item. Also how active/inactive
 * is toggled (pass active: true to bring a soft-deleted item back).
 * Only fields present in the body are changed — omit a field to leave it
 * as-is.
 */
router.put('/menu/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Menu item not found' });

  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
  const description = body.description !== undefined ? body.description : existing.description;
  const priceCents = body.price_cents !== undefined ? Number(body.price_cents) : existing.price_cents;
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    return res.status(400).json({ error: 'price_cents must be a non-negative integer' });
  }
  const tags = body.tags !== undefined ? toCsv(body.tags) : existing.tags;
  const ingredients = body.ingredients !== undefined ? toCsv(body.ingredients) : existing.ingredients;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : existing.active;

  db.prepare(
    'UPDATE menu_items SET name = ?, description = ?, price_cents = ?, tags = ?, ingredients = ?, active = ? WHERE id = ?'
  ).run(name, description, priceCents, tags, ingredients, active, id);

  res.json(serializeItem(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id)));
});

/**
 * DELETE /api/menu/:id — soft-delete only (sets active = 0). See the note
 * at the top of this file for why: historical orders still need the row.
 * Use PUT with { active: true } to restore it.
 */
router.delete('/menu/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Menu item not found' });

  db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(id);
  res.json(serializeItem(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id)));
});

module.exports = router;
