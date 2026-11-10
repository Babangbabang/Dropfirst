const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const paypal = require('../lib/paypal');
const { getSettings } = require('../lib/settings');
const { listFees } = require('../lib/fees');
const { adviseOnCancelRequest } = require('../lib/dispute-advisor');

const router = express.Router();
const CURRENCY = process.env.CURRENCY || 'USD';

// Safe migration: adds the table-identifier column if it isn't there yet
// (e.g. "Table 7", "B12"). No-op if it already exists. Doing it here keeps
// this feature self-contained without requiring a hand-edit of lib/db.js.
const tabColumns = db.prepare('PRAGMA table_info(tabs)').all().map((c) => c.name);
if (!tabColumns.includes('table_identifier')) {
  db.exec('ALTER TABLE tabs ADD COLUMN table_identifier TEXT');
}
// Cancellation-approval workflow: once items are locked, a buyer's cancel
// request pauses on tab status 'pending_cancel' instead of voiding funds
// immediately — staff approve or deny it from the dashboard.
if (!tabColumns.includes('cancel_requested_at')) {
  db.exec('ALTER TABLE tabs ADD COLUMN cancel_requested_at TEXT');
}
if (!tabColumns.includes('cancel_deny_reason')) {
  db.exec('ALTER TABLE tabs ADD COLUMN cancel_deny_reason TEXT');
}

// The authorization_id (from authorize) is NOT the same id as a capture —
// PayPal's refund API needs the capture's own id. Without storing this,
// money already captured could never be refunded if a cancel happens
// after a partial close().
const authColumns = db.prepare('PRAGMA table_info(authorizations)').all().map((c) => c.name);
if (!authColumns.includes('capture_id')) {
  db.exec('ALTER TABLE authorizations ADD COLUMN capture_id TEXT');
}
if (!authColumns.includes('refunded_cents')) {
  db.exec('ALTER TABLE authorizations ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0');
}

// Lets the restaurant reject one locked item (e.g. out of stock) instead of
// silently deleting it, so the buyer still sees what happened and why.
const orderItemColumns = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
if (!orderItemColumns.includes('rejected')) {
  db.exec('ALTER TABLE order_items ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0');
}
if (!orderItemColumns.includes('reject_reason')) {
  db.exec('ALTER TABLE order_items ADD COLUMN reject_reason TEXT');
}

// SQLite's datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" with no
// timezone marker — new Date() on that string gets parsed as LOCAL time by
// JS, which silently produces the wrong offset on any server not running
// in UTC. This makes it explicit.
function sqliteUtcToMs(sqliteDatetime) {
  if (!sqliteDatetime) return null;
  return new Date(sqliteDatetime.replace(' ', 'T') + 'Z').getTime();
}

function getTabSummary(tabId) {
  let tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId);
  if (!tab) return null;

  // Lazy auto-deny: if a cancellation request has sat unanswered past the
  // configured window, deny it automatically rather than leaving the buyer
  // stuck forever. This NEVER auto-approves — silence should never move
  // money, only ever fall back to "stays open, ask staff directly."
  if (tab.status === 'pending_cancel' && tab.cancel_requested_at) {
    const { cancel_approval_timeout_minutes } = getSettings();
    const deadlineMs = sqliteUtcToMs(tab.cancel_requested_at) + cancel_approval_timeout_minutes * 60000;
    if (Date.now() > deadlineMs) {
      db.prepare(
        "UPDATE tabs SET status = 'open', cancel_deny_reason = ?, cancel_requested_at = NULL WHERE id = ?"
      ).run('Kedaluwarsa — staff tidak merespons dalam waktu yang ditentukan. Hubungi staff langsung di tempat.', tabId);
      tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId);
    }
  }

  const authRows = db.prepare('SELECT * FROM authorizations WHERE tab_id = ?').all(tabId);
  // const authorizedCents = authRows
  //   .filter((a) => a.status === 'authorized')
  //   .reduce((sum, a) => sum + a.amount_cents, 0);
  // const capturedCents = authRows
  //   .filter((a) => a.status === 'captured')
  //   .reduce((sum, a) => sum + a.amount_cents, 0);
 const authorizedCents = authRows
    .filter((a) => a.status === 'authorized' || a.status === 'captured')
    .reduce((sum, a) => sum + a.amount_cents, 0);

  const capturedCents = authRows
    .filter((a) => a.status === 'captured')
    .reduce((sum, a) => sum + a.amount_cents, 0);
  // const itemRows = db.prepare('SELECT * FROM order_items WHERE tab_id = ?').all(tabId);
  // const orderedCents = itemRows.reduce((sum, i) => sum + i.price_cents_at_order * i.quantity, 0);

  // return {
  //   tab,
  //   authorizations: authRows,
  //   items: itemRows,
  //   authorized_cents: authorizedCents,
  //   captured_cents: capturedCents,
  //   ordered_cents: orderedCents,
  //   remaining_budget_cents: authorizedCents - orderedCents,
  // };
  const itemRows = db.prepare(`
  SELECT 
    oi.id,
    oi.menu_item_id,
    oi.quantity,
    oi.price_cents_at_order,
    oi.added_by,
    oi.created_at,
    oi.rejected,
    oi.reject_reason,
    mi.name AS menu_name,
    mi.description AS menu_description
  FROM order_items oi
  JOIN menu_items mi ON mi.id = oi.menu_item_id
  WHERE oi.tab_id = ?
  ORDER BY oi.id
`).all(tabId);
  // Rejected items (restaurant turned one down, e.g. out of stock) are kept
  // in the list so the buyer can still see what happened and why, but they
  // no longer count toward the bill or the remaining budget.
  const orderedCents = itemRows
    .filter((i) => !i.rejected)
    .reduce((sum, i) => sum + i.price_cents_at_order * i.quantity, 0);
const items = itemRows.map((item) => ({
  id: item.id,                                              // ← needed by DELETE /items/:itemId on the frontend
  name: item.menu_name,                                    // ← dari JOIN
  quantity: item.quantity,
  price_cents: item.price_cents_at_order,                  // ← harga saat order
  subtotal_cents: item.price_cents_at_order * item.quantity,
  menu_item_id: item.menu_item_id,
  rejected: !!item.rejected,
  reject_reason: item.reject_reason || null,
}));
  // Extra fees (e.g. service charge, packaging fee) are set restaurant-wide
  // from the dashboard — there can be more than one, each with its own
  // label and explanation. They're billed on top of the food total at
  // close() time, but never count against the buyer's ordering budget —
  // remaining_budget_cents still reflects only what's left to spend on
  // menu items.
  const settings = getSettings();
  const extraFees = listFees({ activeOnly: true }); // [{ id, label, description, amount_cents }, ...]
  const extraFeeCents = extraFees.reduce((sum, f) => sum + f.amount_cents, 0);
  const totalDueCents = orderedCents + extraFeeCents;

  // While a cancellation request is pending, staff get an AI-generated
  // read of the situation alongside the raw facts — it only ever
  // RECOMMENDS; approve/deny is always a staff click, never automatic.
  let cancelAdvice = null;
  if (tab.status === 'pending_cancel') {
    const firstLockedAt = db.prepare('SELECT MIN(created_at) AS t FROM order_items WHERE tab_id = ?').get(tabId).t;
    const rejectedCount = itemRows.filter((i) => i.rejected).length;
    cancelAdvice = adviseOnCancelRequest({
      firstLockedAt,
      cancelRequestedAt: tab.cancel_requested_at,
      rejectedCount,
      totalDueCents,
      currency: tab.currency,
    });
  }

  return {
    tab,
    authorizations: authRows,
    items,
    authorized_cents: authorizedCents,
    captured_cents: capturedCents,
    ordered_cents: orderedCents,
    // Reserves room for the extra fees from the start — otherwise a buyer
    // could lock food items right up to the full authorized amount, then
    // get blocked (or worse, under-collected) once fees are added at close.
    remaining_budget_cents: authorizedCents - orderedCents - extraFeeCents,
    extra_fees: extraFees,        // itemized breakdown, each with its own description
    extra_fee_cents: extraFeeCents, // sum of all active fees
    total_due_cents: totalDueCents,
    cancel_locked: settings.cancel_locked,
    table_id_editable: settings.table_id_editable,
    cancel_approval_timeout_minutes: settings.cancel_approval_timeout_minutes,
    cancel_advice: cancelAdvice,
  };
}

/** POST /api/tabs  { amount_cents } -> creates tab + PayPal order (intent AUTHORIZE) */
router.post('/tabs', async (req, res) => {
  try {
    const amountCents = Number(req.body.amount_cents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }

    const tableIdentifier =
      typeof req.body.table_identifier === 'string' && req.body.table_identifier.trim()
        ? req.body.table_identifier.trim().slice(0, 40)
        : null;

    const tabId = crypto.randomUUID();
    db.prepare('INSERT INTO tabs (id, status, currency, table_identifier) VALUES (?, ?, ?, ?)').run(
      tabId,
      'pending',
      CURRENCY,
      tableIdentifier
    );

    const order = await paypal.createOrder({ amountCents, currency: CURRENCY, tabId });

    db.prepare(
      'INSERT INTO authorizations (tab_id, order_id, amount_cents, status) VALUES (?, ?, ?, ?)'
    ).run(tabId, order.id, amountCents, 'created');

    res.json({ tab_id: tabId, paypal_order_id: order.id });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to create PayPal order', details: err.details || err.message });
  }
});

/** POST /api/tabs/:id/authorize  { order_id } -> turns approved order into a held authorization */
router.post('/tabs/:id/authorize', async (req, res) => {
  try {
    const { id } = req.params;
    const { order_id } = req.body;
    const authRow = db
      .prepare('SELECT * FROM authorizations WHERE tab_id = ? AND order_id = ?')
      .get(id, order_id);
    if (!authRow) return res.status(404).json({ error: 'No matching order for this tab' });

    const { authorizationId } = await paypal.authorizeOrder(order_id);
    if (!authorizationId) {
      return res.status(502).json({ error: 'PayPal did not return an authorization id' });
    }

    db.prepare(
      "UPDATE authorizations SET authorization_id = ?, status = 'authorized' WHERE id = ?"
    ).run(authorizationId, authRow.id);
    db.prepare("UPDATE tabs SET status = 'open' WHERE id = ?").run(id);

    res.json(getTabSummary(id));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to authorize PayPal order', details: err.details || err.message });
  }
});

/**
 * GET /api/tabs?status=open — lists tabs for the dashboard (open ones by
 * default, since those are the only ones staff can still act on).
 */
router.get('/tabs', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'open';
  const rows = db.prepare('SELECT id FROM tabs WHERE status = ? ORDER BY created_at DESC').all(status);
  res.json({ tabs: rows.map((r) => getTabSummary(r.id)) });
});

/** GET /api/tabs/:id -> full summary */
router.get('/tabs/:id', (req, res) => {
  const summary = getTabSummary(req.params.id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  res.json(summary);
});

/**
 * POST /api/tabs/:id/items/:itemId/reject  { reason }
 * Restaurant-side only: marks one locked item as rejected (out of stock,
 * can't make it, etc) instead of deleting it, so the buyer still sees what
 * happened and why. This works even when the buyer-facing cancel_locked
 * setting is on — that setting restricts the BUYER's own "−1"/"✕", not the
 * restaurant's ability to turn an item down.
 */
router.post('/tabs/:id/items/:itemId/reject', (req, res) => {
  const { id, itemId } = req.params;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!reason) return res.status(400).json({ error: 'A reason is required to reject an item' });

  const summary = getTabSummary(id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  if (summary.tab.status !== 'open') {
    return res.status(409).json({ error: `Tab is ${summary.tab.status}, items can no longer be changed` });
  }

  const row = db.prepare('SELECT * FROM order_items WHERE id = ? AND tab_id = ?').get(itemId, id);
  if (!row) return res.status(404).json({ error: 'Order item not found on this tab' });
  if (row.rejected) return res.status(409).json({ error: 'This item was already rejected' });

  db.prepare('UPDATE order_items SET rejected = 1, reject_reason = ? WHERE id = ?').run(reason, itemId);
  res.json(getTabSummary(id));
});

/**
 * PATCH /api/tabs/:id/table  { table_identifier }
 * Sets or changes the table number / identifier for this tab.
 * - If settings.table_id_editable is true: can be set or changed any time
 *   while the tab is open.
 * - If false: can only be set ONCE (while it's still empty). Once a value
 *   exists, further changes are rejected — the dashboard decides it's
 *   locked policy, not something the buyer can override from their side.
 */
router.patch('/tabs/:id/table', (req, res) => {
  const { id } = req.params;
  const summary = getTabSummary(id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  if (summary.tab.status === 'closed' || summary.tab.status === 'cancelled') {
    return res.status(409).json({ error: `Tab is ${summary.tab.status}, cannot change the table identifier` });
  }

  const nextValue = typeof req.body.table_identifier === 'string' ? req.body.table_identifier.trim().slice(0, 40) : '';
  if (!nextValue) return res.status(400).json({ error: 'table_identifier must be a non-empty string' });

  const alreadySet = !!summary.tab.table_identifier;
  if (!summary.table_id_editable && alreadySet) {
    return res.status(409).json({
      error: 'Table identifier is locked by restaurant settings and already set — it cannot be changed.',
    });
  }

  db.prepare('UPDATE tabs SET table_identifier = ? WHERE id = ?').run(nextValue, id);
  res.json(getTabSummary(id));
});

/** POST /api/tabs/:id/items  { menu_item_id, quantity, added_by } -> add to order if within budget */
router.post('/tabs/:id/items', (req, res) => {
  const { id } = req.params;
  const menuItemId = Number(req.body.menu_item_id);
  const quantity = Math.max(1, Number(req.body.quantity) || 1);
  const addedBy = req.body.added_by === 'agent' ? 'agent' : 'buyer';

  const summary = getTabSummary(id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  if (summary.tab.status !== 'open') {
    return res.status(409).json({ error: `Tab is ${summary.tab.status}, not open for ordering` });
  }

  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(menuItemId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  const lineTotal = item.price_cents * quantity;
  if (lineTotal > summary.remaining_budget_cents) {
    return res.status(409).json({
      error: 'This order would exceed the authorized budget. Add funds first.',
      remaining_budget_cents: summary.remaining_budget_cents,
      attempted_cents: lineTotal,
    });
  }

  db.prepare(
    'INSERT INTO order_items (tab_id, menu_item_id, quantity, price_cents_at_order, added_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, menuItemId, quantity, item.price_cents, addedBy);

  res.json(getTabSummary(id));
});

/** POST /api/tabs/:id/topup  { amount_cents } -> new PayPal order to raise the budget */
router.post('/tabs/:id/topup', async (req, res) => {
  try {
    const { id } = req.params;
    const amountCents = Number(req.body.amount_cents);
    const summary = getTabSummary(id);
    if (!summary) return res.status(404).json({ error: 'Tab not found' });
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }

    const order = await paypal.createOrder({ amountCents, currency: summary.tab.currency, tabId: id });
    db.prepare(
      'INSERT INTO authorizations (tab_id, order_id, amount_cents, status) VALUES (?, ?, ?, ?)'
    ).run(id, order.id, amountCents, 'created');

    res.json({ paypal_order_id: order.id });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to create top-up order', details: err.details || err.message });
  }
});

/** POST /api/tabs/:id/close -> capture the final bill, void any unused holds */
router.post('/tabs/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    const summary = getTabSummary(id);
    if (!summary) return res.status(404).json({ error: 'Tab not found' });
    if (summary.tab.status !== 'open') {
      return res.status(409).json({ error: `Tab is already ${summary.tab.status}` });
    }

    // The bill includes the restaurant-wide extra fee (e.g. service charge)
    // on top of what was actually ordered. This fee is NOT checked against
    // remaining_budget_cents while ordering (it's a surcharge, not a menu
    // item) — so it's possible, if the fee is large or was raised after the
    // buyer authorized their hold, that there isn't enough held to cover it.
    // Catch that clearly here rather than letting PayPal's capture fail
    // with a confusing error.
    const totalAuthorizedCents = summary.authorized_cents + summary.captured_cents;
    if (summary.total_due_cents > totalAuthorizedCents) {
      return res.status(409).json({
        error:
          'Authorized funds are not enough to cover the bill plus the extra fee. Ask the buyer to top up before closing.',
        total_due_cents: summary.total_due_cents,
        authorized_cents: totalAuthorizedCents,
        shortfall_cents: summary.total_due_cents - totalAuthorizedCents,
      });
    }

    // Resumable: if a previous call to /close got interrupted partway
    // (refresh, crash, network error), some authorizations may already be
    // 'captured'. Only count what's STILL owed, not the full bill again —
    // otherwise a retry would try to capture more than the actual total.
    const billCents = summary.total_due_cents;
    const alreadyCapturedCents = summary.captured_cents;
    const authorizedRows = summary.authorizations.filter((a) => a.status === 'authorized');

    let remainingToCapture = Math.max(0, billCents - alreadyCapturedCents);
    for (const auth of authorizedRows) {
      if (remainingToCapture <= 0) {
        // Nothing left to charge on this authorization: release it in full.
        await paypal.voidAuthorization(auth.authorization_id);
        db.prepare("UPDATE authorizations SET status = 'voided' WHERE id = ?").run(auth.id);
        continue;
      }
      const captureAmount = Math.min(auth.amount_cents, remainingToCapture);

      // Always final_capture: true here. Closing the tab means we will never
      // capture against this authorization again, so this tells PayPal to
      // auto-release any untouched remainder of THIS specific hold back to
      // the buyer — not just the full holds we skip entirely below.
      const captureResult = await paypal.captureAuthorization(auth.authorization_id, {
        amountCents: captureAmount,
        currency: summary.tab.currency,
        finalCapture: true,
      });
      // captureResult.id is the CAPTURE's own id — different from
      // auth.authorization_id, and the only thing PayPal's refund API
      // accepts. Must be saved now; it can't be recovered later.
      db.prepare(
        "UPDATE authorizations SET status = 'captured', amount_cents = ?, capture_id = ? WHERE id = ?"
      ).run(captureAmount, captureResult.id || null, auth.id);
      remainingToCapture -= captureAmount;

      // If this authorization had more held than we needed, PayPal auto-releases
      // the untouched remainder once final_capture=true is sent for it.
    }

    db.prepare("UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
    res.json(getTabSummary(id));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to close tab', details: err.details || err.message });
  }
});

/**
 * Releases every still-held authorization on a tab AND refunds anything
 * that was already captured, then marks it cancelled. The refund part
 * matters for an edge case: if close() previously captured some
 * authorizations before failing partway through (see the retry-safe logic
 * there), the tab stays 'open' with real money already taken. Cancelling
 * from that state must send that money back, not just release the
 * still-held remainder — otherwise the buyer is charged for an order that
 * no longer exists.
 * Shared by the immediate-cancel path, the staff-approved path, and the
 * dashboard's direct staff-cancel.
 */
async function voidAllAndCancel(id, summary) {
  const released = [];
  const refunded = [];
  const failed = [];

  for (const auth of summary.authorizations) {
    try {
      if (auth.status === 'authorized') {
        await paypal.voidAuthorization(auth.authorization_id);
        db.prepare("UPDATE authorizations SET status = 'voided' WHERE id = ?").run(auth.id);
        released.push(auth.authorization_id);
      } else if (auth.status === 'captured' && auth.amount_cents > (auth.refunded_cents || 0)) {
        const amountToRefund = auth.amount_cents - (auth.refunded_cents || 0);
        await paypal.refundCapture(auth.capture_id, { amountCents: amountToRefund, currency: summary.tab.currency });
        db.prepare("UPDATE authorizations SET status = 'refunded', refunded_cents = amount_cents WHERE id = ?").run(
          auth.id
        );
        refunded.push({ capture_id: auth.capture_id, amount_cents: amountToRefund });
      }
      // 'voided' / 'refunded' / 'created' rows: nothing to do.
    } catch (err) {
      // Keep going even if one hold/capture fails to release — report it
      // so the client can retry just the stuck ones instead of the whole tab.
      failed.push({
        authorization_id: auth.authorization_id,
        capture_id: auth.capture_id || null,
        error: err.details || err.message,
      });
    }
  }

  if (failed.length === 0) {
    db.prepare(
      "UPDATE tabs SET status = 'cancelled', closed_at = datetime('now'), cancel_requested_at = NULL WHERE id = ?"
    ).run(id);
  }
  return { released, refunded, failed };
}

/**
 * POST /api/tabs/:id/cancel
 * - If nothing has ever been locked on this tab: cancels immediately,
 *   voiding every hold. No approval needed — nothing for staff to lose.
 * - If items HAVE been locked: pauses on status 'pending_cancel' instead.
 *   Nothing is voided yet — staff must approve or deny from the dashboard
 *   (see /cancel/approve and /cancel/deny below). If staff don't respond
 *   within the configured window, it's auto-DENIED (never auto-approved —
 *   see the lazy check at the top of getTabSummary).
 */
// router.post('/tabs/:id/cancel', async (req, res) => {
//   try {
//     const { id } = req.params;
//     const summary = getTabSummary(id);
//     if (!summary) return res.status(404).json({ error: 'Tab not found' });
//     if (summary.tab.status === 'closed') {
//       return res.status(409).json({ error: 'Tab is already closed and paid — cannot cancel.' });
//     }
//     if (summary.tab.status === 'cancelled') {
//       return res.json(summary); // already cancelled: no-op, not an error
//     }
//     if (summary.tab.status === 'pending_cancel') {
//       return res.json(summary); // already pending — don't restart the approval timer
//     }

//     const itemCount = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE tab_id = ?').get(id).n;

//     if (itemCount === 0) {
//       const { released, refunded, failed } = await voidAllAndCancel(id, summary);
//       return res.json({ ...getTabSummary(id), released, refunded, failed });
//     }

//     // Items have been locked — this needs staff sign-off before anything
//     // is actually voided.
//     db.prepare(
//       "UPDATE tabs SET status = 'pending_cancel', cancel_requested_at = datetime('now'), cancel_deny_reason = NULL WHERE id = ?"
//     ).run(id);
//     res.json(getTabSummary(id));
//   } catch (err) {
//     console.error(err);
//     res.status(502).json({ error: 'Failed to process cancel request', details: err.details || err.message });
//   }
// });
router.post('/tabs/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const summary = getTabSummary(id);
    if (!summary) return res.status(404).json({ error: 'Tab not found' });
    if (summary.tab.status === 'closed') {
      return res.status(409).json({ error: 'Tab is already closed and paid — cannot cancel.' });
    }
    if (summary.tab.status === 'cancelled') {
      return res.json(summary);
    }
    if (summary.tab.status === 'pending_cancel') {
      return res.json(summary);
    }

    // ==========================================
    // AMBIL SETTING
    // ==========================================
    const { cancel_locked } = getSettings();
    const itemCount = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE tab_id = ?').get(id).n;

    // ==========================================
    // KEPUTUSAN:
    // - Jika cancel_locked = false → langsung cancel
    // - Jika cancel_locked = true && itemCount = 0 → langsung cancel
    // - Jika cancel_locked = true && itemCount > 0 → pending_cancel
    // ==========================================
    const needsApproval = cancel_locked && itemCount > 0;

    if (!needsApproval) {
      // Langsung cancel
      const { released, refunded, failed } = await voidAllAndCancel(id, summary);
      return res.json({ ...getTabSummary(id), released, refunded, failed });
    }

    // Pending cancel (tunggu staf)
    db.prepare(
      "UPDATE tabs SET status = 'pending_cancel', cancel_requested_at = datetime('now'), cancel_deny_reason = NULL WHERE id = ?"
    ).run(id);
    res.json(getTabSummary(id));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to process cancel request', details: err.details || err.message });
  }
});
/**
 * POST /api/tabs/:id/staff-cancel — dashboard-only: staff cancels an
 * active order directly (no-show, duplicate tab, kitchen can't fulfill it,
 * etc), voiding every held authorization immediately. Unlike the buyer-
 * facing /cancel endpoint, this never pauses for approval — staff
 * initiating it IS the approval. Works on 'open' tabs and also on
 * 'pending_cancel' ones (staff can short-circuit their own pending
 * approval queue this way instead of using /cancel/approve).
 */
router.post('/tabs/:id/staff-cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const summary = getTabSummary(id);
    if (!summary) return res.status(404).json({ error: 'Tab not found' });
    if (summary.tab.status === 'closed') {
      return res.status(409).json({ error: 'Tab is already closed and paid — cannot cancel.' });
    }
    if (summary.tab.status === 'cancelled') {
      return res.json(summary); // already cancelled: no-op, not an error
    }

    const { released, refunded, failed } = await voidAllAndCancel(id, summary);
    res.json({ ...getTabSummary(id), released, refunded, failed });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to cancel order', details: err.details || err.message });
  }
});

/**
 * POST /api/tabs/:id/cancel/approve — staff-only: approves a pending
 * cancellation request, voiding every held authorization.
 */
router.post('/tabs/:id/cancel/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const summary = getTabSummary(id);
    if (!summary) return res.status(404).json({ error: 'Tab not found' });
    if (summary.tab.status !== 'pending_cancel') {
      return res.status(409).json({ error: `Tab is ${summary.tab.status}, there is no pending cancellation to approve` });
    }

    const { released, refunded, failed } = await voidAllAndCancel(id, summary);
    res.json({ ...getTabSummary(id), released, refunded, failed });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to approve cancellation', details: err.details || err.message });
  }
});

/**
 * POST /api/tabs/:id/cancel/deny  { reason } — staff-only: denies a
 * pending cancellation request. Nothing is voided; the tab goes back to
 * 'open' so the buyer can keep ordering or try again later.
 */
router.post('/tabs/:id/cancel/deny', (req, res) => {
  const { id } = req.params;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!reason) return res.status(400).json({ error: 'A reason is required to deny a cancellation request' });

  const summary = getTabSummary(id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  if (summary.tab.status !== 'pending_cancel') {
    return res.status(409).json({ error: `Tab is ${summary.tab.status}, there is no pending cancellation to deny` });
  }

  db.prepare(
    "UPDATE tabs SET status = 'open', cancel_deny_reason = ?, cancel_requested_at = NULL WHERE id = ?"
  ).run(reason, id);
  res.json(getTabSummary(id));
});

/**
 * POST /api/tabs/:id/release-holds
 * Recovery tool: retries any authorization row still stuck at 'authorized'
 * (void it) or 'captured' (refund it) regardless of the tab's own status.
 * Use this when /close, /cancel, /cancel/approve, or /staff-cancel
 * reported a partial failure — call it again (it's safe to retry) until
 * `failed` comes back empty. Covers refunds too, not just holds, since a
 * stuck refund is just as much "the buyer's money isn't back yet" as a
 * stuck void is.
 */
router.post('/tabs/:id/release-holds', async (req, res) => {
  try {
    const { id } = req.params;
    const summary = getTabSummary(id);
    if (!summary) return res.status(404).json({ error: 'Tab not found' });

    // Safety guard: only run on a tab where cancellation was actually in
    // progress. On a plain 'open' tab, a captured-but-not-yet-finalized
    // authorization almost certainly means the buyer meant to finish
    // paying (retry /close), not cancel — refunding it here would wrongly
    // undo a legitimate in-progress payment.
    if (summary.tab.status === 'open') {
      return res.status(409).json({
        error:
          'This tab is open, not being cancelled. If a payment partially failed, retry closing it instead — this tool is only for cleaning up after a cancellation.',
      });
    }

    const released = [];
    const refunded = [];
    const failed = [];

    for (const auth of summary.authorizations) {
      try {
        if (auth.status === 'authorized') {
          await paypal.voidAuthorization(auth.authorization_id);
          db.prepare("UPDATE authorizations SET status = 'voided' WHERE id = ?").run(auth.id);
          released.push(auth.authorization_id);
        } else if (auth.status === 'captured' && auth.amount_cents > (auth.refunded_cents || 0)) {
          const amountToRefund = auth.amount_cents - (auth.refunded_cents || 0);
          await paypal.refundCapture(auth.capture_id, { amountCents: amountToRefund, currency: summary.tab.currency });
          db.prepare("UPDATE authorizations SET status = 'refunded', refunded_cents = amount_cents WHERE id = ?").run(
            auth.id
          );
          refunded.push({ capture_id: auth.capture_id, amount_cents: amountToRefund });
        }
      } catch (err) {
        failed.push({
          authorization_id: auth.authorization_id,
          capture_id: auth.capture_id || null,
          error: err.details || err.message,
        });
      }
    }

    res.json({ released, refunded, failed, summary: getTabSummary(id) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Failed to release holds', details: err.details || err.message });
  }
});

/**
 * DELETE /api/tabs/:id/items/:itemId
 * Removes one order_item row (one "Add" click = one row). Only allowed
 * while the tab is still open — once it's closed/cancelled, the order is
 * final.
 */
router.delete('/tabs/:id/items/:itemId', (req, res) => {
  const { id, itemId } = req.params;
  const summary = getTabSummary(id);
  if (!summary) return res.status(404).json({ error: 'Tab not found' });
  if (summary.tab.status !== 'open') {
    return res.status(409).json({ error: `Tab is ${summary.tab.status}, items can no longer be changed` });
  }
  if (summary.cancel_locked) {
    return res.status(403).json({ error: 'Menu cancellation is disabled by the restaurant for this order.' });
  }

  const row = db.prepare('SELECT * FROM order_items WHERE id = ? AND tab_id = ?').get(itemId, id);
  if (!row) return res.status(404).json({ error: 'Order item not found on this tab' });

  db.prepare('DELETE FROM order_items WHERE id = ?').run(itemId);
  res.json(getTabSummary(id));
});

module.exports = { router, getTabSummary };
