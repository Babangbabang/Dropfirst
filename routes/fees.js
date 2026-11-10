const express = require('express');
const { listFees, createFee, updateFee, deleteFee } = require('../lib/fees');

const router = express.Router();

/**
 * GET /api/fees — buyer-facing: active fees only. Shown from the very
 * start (before the buyer even authorizes funds) so they know upfront
 * what extra charges apply, same transparency principle as the menu.
 */
router.get('/fees', (req, res) => {
  res.json({ fees: listFees({ activeOnly: true }) });
});

/** GET /api/fees/all — dashboard: every fee, including inactive ones. */
router.get('/fees/all', (req, res) => {
  res.json({ fees: listFees() });
});

/** POST /api/fees  { label, description, amount_cents } — dashboard: add a new fee. */
router.post('/fees', (req, res) => {
  const { label, description, amount_cents } = req.body || {};
  const amountCents = Number(amount_cents);

  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    return res.status(400).json({ error: 'amount_cents must be a non-negative integer' });
  }

  res.json(createFee({ label: label.trim(), description: description || '', amount_cents: amountCents }));
});

/** PUT /api/fees/:id — dashboard: edit a fee (also toggles active). */
router.put('/fees/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  if (body.amount_cents !== undefined && (!Number.isInteger(Number(body.amount_cents)) || Number(body.amount_cents) < 0)) {
    return res.status(400).json({ error: 'amount_cents must be a non-negative integer' });
  }
  const updated = updateFee(id, {
    ...body,
    amount_cents: body.amount_cents !== undefined ? Number(body.amount_cents) : undefined,
  });
  if (!updated) return res.status(404).json({ error: 'Fee not found' });
  res.json(updated);
});

/** DELETE /api/fees/:id — dashboard: remove a fee entirely (fees aren't tied to past orders, unlike menu items). */
router.delete('/fees/:id', (req, res) => {
  const ok = deleteFee(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Fee not found' });
  res.json({ deleted: true });
});

module.exports = router;
