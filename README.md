# Dropfirst — pay as you can afford, settle what you actually owe

Built for the **PayPal AI Hackathon** (Devpost).

## The idea

Before ordering, the buyer authorizes a budget with PayPal (e.g. $30).
They can order freely up to that limit — and only up to that limit, enforced
server-side. If they want more, they top up with another PayPal
authorization. When the meal is over, Dropfirst captures exactly the final
bill from the held funds and releases whatever is left. Nobody pays more
than they chose to risk, and the restaurant is protected because the funds
were already held before the meal started.

An AI agent can also order on the buyer's behalf from a free-text request
("lunch for 2, no spicy"). The agent only **proposes** a cart — the server
re-prices it against the real menu and refuses anything that would exceed
the remaining authorized budget before it's ever added to the tab. The
authorization is a hard safety rail for agentic spending, not just a UX
nicety.

## How it uses PayPal

Uses the PayPal Orders v2 and Payments v2 REST APIs with the
`AUTHORIZE` intent (not immediate capture):

1. `POST /v2/checkout/orders` (`intent: AUTHORIZE`) — buyer approves via the
   PayPal JS SDK buttons.
2. `POST /v2/checkout/orders/{id}/authorize` — turns the approved order into
   a held authorization.
3. Buyer orders; every item is checked against the remaining authorized
   amount before it's added.
4. Buyer can top up with additional authorizations at any time.
5. `POST /v2/payments/authorizations/{id}/capture` — on "close tab", captures
   only the actual bill. Any authorization (or portion of one) not needed is
   released with `POST /v2/payments/authorizations/{id}/void`.

## Tech stack

- Node.js + Express
- better-sqlite3 (zero-setup local database)
- Vanilla JS frontend + PayPal JS SDK buttons
- Pluggable AI agent (works out of the box with a rule-based picker; wire
  in any LLM provider by filling in `lib/agent.js#callModel`)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
```

Get free sandbox credentials at <https://developer.paypal.com/dashboard/> →
**Apps & Credentials** → **Sandbox** → create/select an app → copy the
Client ID and Secret.

> PayPal does not support IDR. This demo uses `CURRENCY=USD` in `.env`.

Run it:

```bash
npm start
```

Open <http://localhost:3000>.

### Testing a payment

Use a PayPal **sandbox personal (buyer) account** to approve the hold —
create one at <https://developer.paypal.com/dashboard/accounts> if you don't
have one already. No real money moves; this is entirely in PayPal's sandbox
environment.

## Project structure

```
server.js            Express entry point
lib/paypal.js         PayPal REST API wrapper (auth, authorize, capture, void)
lib/agent.js           AI agent: proposes a cart within budget (rule-based fallback)
lib/db.js              SQLite schema + seed menu
routes/menu.js          GET /api/menu
routes/tabs.js          Tab lifecycle: create, authorize, add items, top up, close
routes/agent.js         POST /api/tabs/:id/agent — AI-proposed order
public/                Demo frontend
```

## What's demo-scope vs. production-scope

This is a hackathon submission, not a production payments system:

- Single demo restaurant with a seeded menu; no multi-merchant payouts.
- No authentication — a tab is identified by its UUID only.
- Error handling favors clarity over exhaustive edge-case coverage.
- For a real deployment, funds would need to flow to the restaurant's own
  PayPal account (e.g. via PayPal for Platforms / Partner Referrals) rather
  than being captured to a single demo account.

## License

MIT — see [LICENSE](./LICENSE).
