const express = require('express');
const { getSettings, updateSettings } = require('../lib/settings');

const router = express.Router();

/** GET /api/settings — read by the buyer app (and the dashboard) to know current policy. */
router.get('/settings', (req, res) => {
  res.json(getSettings());
});

/**
 * PUT /api/settings — written only by the dashboard.
 * NOTE: there is no authentication on this route in this hackathon build.
 * Before using this anywhere beyond a local demo, put this behind an admin
 * login (e.g. a simple shared password check, or a real auth system) —
 * right now anyone who finds this URL can change the restaurant's policy.
 */
router.put('/settings', (req, res) => {
  const updated = updateSettings(req.body || {});
  res.json(updated);
});

module.exports = router;
