// Minimal wrapper around the PayPal Orders v2 + Payments v2 REST APIs.
// Docs: https://developer.paypal.com/docs/api/orders/v2/
//       https://developer.paypal.com/docs/api/payments/v2/
//
// Flow used by this app:
//   1. createOrder(amount)      -> intent AUTHORIZE, buyer approves via PayPal buttons
//   2. authorizeOrder(orderId)  -> turns the approved order into a held authorization
//   3. captureAuthorization(id, finalAmount) -> charges only what the final bill is
//   4. voidAuthorization(id)    -> releases any unused hold

const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) {
    throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env');
  }

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function ppFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`PayPal API error ${res.status} on ${path}`);
    err.details = data;
    throw err;
  }
  return data;
}

function centsToAmount(cents, currency) {
  return { currency_code: currency, value: (cents / 100).toFixed(2) };
}

/** Step 1: create an order with intent AUTHORIZE for the hold amount. */
async function createOrder({ amountCents, currency, tabId }) {
  return ppFetch('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: tabId,
          description: `Dropfirst hold for tab ${tabId}`,
          amount: centsToAmount(amountCents, currency),
        },
      ],
    }),
  });
}

/** Step 2: after the buyer approves via the PayPal buttons, authorize the order. */
async function authorizeOrder(orderId) {
  const data = await ppFetch(`/v2/checkout/orders/${orderId}/authorize`, { method: 'POST' });
  const authorizationId =
    data?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  return { authorizationId, raw: data };
}

/** Step 3: capture only the final bill amount from a held authorization. */
async function captureAuthorization(authorizationId, { amountCents, currency, finalCapture = true }) {
  return ppFetch(`/v2/payments/authorizations/${authorizationId}/capture`, {
    method: 'POST',
    body: JSON.stringify({
      amount: centsToAmount(amountCents, currency),
      final_capture: finalCapture,
    }),
  });
}

/** Step 4: release an authorization that is not being used (or its leftover). */
async function voidAuthorization(authorizationId) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2/payments/authorizations/${authorizationId}/void`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Void failed: ${res.status} ${await res.text()}`);
  }
  return true;
}

/**
 * Refunds money that was already captured (actually charged), as opposed
 * to voidAuthorization which only releases a hold that was never charged.
 * Needed for the edge case where a tab is cancelled after a close() that
 * partially succeeded — some of the buyer's money was genuinely taken and
 * must be sent back, not just "un-held".
 */
async function refundCapture(captureId, { amountCents, currency }) {
  return ppFetch(`/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ amount: centsToAmount(amountCents, currency) }),
  });
}

module.exports = {
  getAccessToken,
  createOrder,
  authorizeOrder,
  captureAuthorization,
  voidAuthorization,
  refundCapture,
};
