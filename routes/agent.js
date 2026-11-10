const express = require('express');
const db = require('../lib/db');
const { proposeOrder } = require('../lib/agent');
const { getTabSummary } = require('./tabs');

const router = express.Router();

/**
 * POST /api/tabs/:id/agent  { request: "lunch for 2, no spicy" }
 * The model only PROPOSES a cart. It is re-priced and budget-checked
 * server-side in proposeOrder()/validateAndPrice() before anything is
 * added — the agent can never add items the authorized funds don't cover.
 */
router.post('/tabs/:id/agent', async (req, res) => {
  const { id } = req.params;
  const summary = getTabSummary(id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  if (summary.tab.status !== 'open') {
    return res.status(409).json({ error: `Tab is ${summary.tab.status}, not open for ordering` });
  }

  const menuItems = db.prepare('SELECT * FROM menu_items ORDER BY id').all();
  const proposal = await proposeOrder({
    menuItems,
    budgetCents: summary.remaining_budget_cents,
    request: req.body.request || '',
  });

  res.json(proposal); // buyer reviews this and confirms via POST /api/tabs/:id/items per line
});

module.exports = router;
