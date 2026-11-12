# Dropfirst

> **Status: Alpha** — Early-stage demo built for the PayPal AI Hackathon. Core features work end-to-end, but this is not production-ready (no authentication, single-tenant demo only).

**Pay as you can afford, settle what you actually owe.**

Dropfirst is a restaurant ordering system that lets buyers hold a budget with PayPal before ordering, lock in items in rounds, and only pay for what they actually consume. The restaurant is protected because funds are held before the meal starts, and the buyer never pays more than they chose to risk.

---

## Table of Contents

- [Inspiration](#inspiration)
- [The Idea](#the-idea)
- [Key Features](#key-features)
- [How It Uses PayPal](#how-it-uses-paypal)
- [AI in This Project](#ai-in-this-project)
- [Tech Stack](#tech-stack)
- [Setup](#setup)
- [Testing a Payment](#testing-a-payment)
- [The Dashboard](#the-dashboard)
- [Project Structure](#project-structure)
- [Demo Scope vs. Production Scope](#demo-scope-vs-production-scope)
- [License](#license)

---

## Inspiration

I was inspired by a simple eatery that's common where I am (Jakarta) called a warteg. There's a habit where customers come, order food, eat, and only when it's time to pay are they asked 'what did you eat?' This can be potentially problematic for both the customer and the seller because the customer might not know the prices and the seller could lose out if the customer doesn't have enough money or, in the worst case, lies. So I was inspired to create this to prevent potential losses for both sides and ensure price transparency.

## The Idea

Before ordering, the buyer authorizes a budget with PayPal (e.g. $30). They build up their order in a local cart, then **lock it in** — only at that point are items actually sent to the kitchen and counted against the budget. They can keep adding and locking more rounds as they go.

When the meal is over, Dropfirst captures exactly the final bill (food + any restaurant fees) from the held funds and releases whatever is left. Nobody pays more than they chose to risk, and the restaurant is protected because the funds were already held before the meal started.

If a buyer wants to cancel after items are already locked in, the request doesn't just void funds unilaterally — it pauses for the restaurant to approve or deny, with a **rule-based AI summary** helping staff decide quickly. If staff don't respond in time, the request is automatically **denied** (never auto-approved) so money is never moved without a human decision on one side or the other.

---

## Key Features

- **Cart → Lock Flow**: Items staged locally are free to adjust. Nothing is sent to the server (or shown to staff) until the buyer confirms a round.
- **Live Budget Enforcement**: The cart itself can never exceed what's left to spend. Fees are reserved from the start, not just checked at the end. All money calculations use **Decimal.js** to avoid floating-point errors.
- **Table / Seat Identifier**: Optional, settable once or freely editable depending on restaurant policy.
- **Multiple Itemized Fees**: The restaurant can configure any number of extra charges (service fee, packaging, etc.), each with its own label and explanation, shown to the buyer **before** they authorize funds.
- **Menu & Ingredients**: Full CRUD from the dashboard, including an ingredient tag list the buyer can view per dish before ordering.
- **Staff Item Rejection**: A locked item can be turned down (e.g. out of stock) with a reason, automatically adjusting the bill and budget.
- **Rule-Based AI Cancellation Advisor**: When a buyer requests to cancel after locking items, staff see a short summary of the situation alongside a recommendation. Staff always make the actual call — the advisor never approves or denies on its own.
- **Staff-Initiated Cancellation**: The restaurant can cancel an active order directly from the dashboard at any time, no approval loop needed.
- **Refund Safety Net**: If a payment partially succeeds before failing (e.g. a network hiccup mid-capture) and the order is then cancelled, any money already captured is refunded — not just the untouched holds released.

---

## How It Uses PayPal

Dropfirst uses the **PayPal Orders v2** and **Payments v2** REST APIs with the `AUTHORIZE` intent (not immediate capture):

1. `POST /v2/checkout/orders` (`intent: AUTHORIZE`) — buyer approves via the PayPal JS SDK buttons.
2. `POST /v2/checkout/orders/{id}/authorize` — turns the approved order into a held authorization.
3. Buyer locks items in rounds. Every item is checked against the remaining authorized amount (minus reserved fees) before it's accepted.
4. Buyer can top up with additional authorizations at any time while the tab is open.
5. `POST /v2/payments/authorizations/{id}/capture` — on "Finish eating", captures only the actual bill (food + fees). Any authorization (or unused portion of one) not needed is released with `POST /v2/payments/authorizations/{id}/void`.
6. `POST /v2/payments/captures/{id}/refund` — used if a cancellation happens after some amount was already captured, so the buyer always gets back everything they're owed, not just what's still on hold.

---

## AI in This Project

The AI component is a **Rule-Based AI (Expert System)** implemented in `lib/dispute-advisor.js`. It is **not** a large language model, and there is **no AI agent running on the client side**. All intelligence is deterministic, server-side logic that reads the tab's timeline and produces a recommendation for staff.

When a buyer requests to cancel a tab with locked items, the advisor:

- Reads the tab's timeline: when items were locked, whether any were already rejected, and how long the request has been waiting.
- Produces a short, human-readable summary plus a recommendation (e.g. *"Approve — locked only moments ago, kitchen likely hasn't started"*).

It ships with a rule-based implementation that works out of the box with **no API key required**. The advisor only ever **advises** — approving or denying is always a human click in the dashboard. If staff do not respond within the configured window, the request is automatically **denied**, never approved, so money is never moved without a deliberate human decision.

---

## Tech Stack

- **Node.js + Express** — server and REST API
- **better-sqlite3** — zero-setup local database
- **Vanilla JS** frontend + **PayPal JS SDK** buttons
- **Decimal.js** — all monetary calculations (cents, fees, subtotals, budget checks, chart data) use arbitrary-precision decimals to avoid floating-point rounding errors
- **Chart.js** — live budget breakdown (doughnut chart)
- **jsPDF** — downloadable invoice

---

## Setup

```bash
npm install
cp .env.example .env
```

## Edit .env:

PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret

Get free sandbox credentials at https://developer.paypal.com/dashboard/ → Apps & Credentials → Sandbox → create/select an app (type: Merchant) → copy the Client ID and Secret.

> PayPal does not support IDR. This demo uses CURRENCY=USD in .env.

## Run 

```bash 
npm start
```
Open http://localhost:3000 for the buyer app, and http://localhost:3000/dashboard.html for the restaurant dashboard.

## Testing a Payment
Use a PayPal sandbox personal (buyer) account to approve the hold — create one at https://developer.paypal.com/dashboard/accounts if you don't have one already. No real money moves; this is entirely in PayPal's sandbox environment.

## The Dashboard
dashboard.html is where the restaurant manages everything:

- Live orders (with the option to reject an item or cancel the whole order)

- Pending cancellation requests (with the rule-based advisor's input)

- The menu (add, edit, deactivate items and their ingredients)

- Extra fees

- Policy settings (whether cancellation is locked for buyers, whether the table identifier is editable, and how long staff have to respond to a cancellation request before it's auto-denied)

> **Note:** The dashboard currently has no authentication — anyone with the URL can change settings or act on orders. This is fine for a sandbox demo; add real auth before using it anywhere beyond that.

## Project Structure

server.js                  Express entry point
lib/db.js                   SQLite schema + seed menu
lib/paypal.js                PayPal REST API wrapper (authorize, capture, void, refund)
lib/settings.js               Restaurant-wide policy toggles
lib/fees.js                    Extra-fee list (can be more than one, each with its own description)
lib/dispute-advisor.js          Rule-based AI advisor for pending cancellation requests
routes/tabs.js                   Tab lifecycle: create, authorize, lock items, top up,
                                  close, cancel (buyer request + approve/deny + staff-direct),
                                  item rejection, recovery tools
routes/menu.js                    Menu CRUD (public read + dashboard management)
routes/settings.js                 Policy settings read/write
routes/fees.js                      Extra-fee CRUD
public/index.html                    Buyer-facing app
public/app.js                         Buyer-facing logic (uses Decimal.js for all money math)
public/dashboard.html                  Restaurant dashboard

## Demo Scope vs. Production Scope
This is an alpha version built for a hackathon, not a production payments system:

- Single demo restaurant with a seeded menu; no multi-merchant payouts.

- No authentication anywhere — a tab is identified by its UUID only, and the dashboard has no login at all.

- Cancellation approval and item rejection are checked lazily (on request), not via a background job — fine at this scale, would need a scheduler for real volume.

- The AI component is a rule-based advisor only; no LLM or external AI service is called, and no AI agent runs on the client.

- For a real deployment, funds would need to flow to the restaurant's own PayPal account (e.g. via PayPal for Platforms / Partner Referrals) rather than being captured to a single demo account.

## Acknowledgements

This project was built with the assistance of the following AI tools:

- **Claude (Anthropic)** — Used for code review, refactoring suggestions, and documentation drafting.
- **DeepSeek** — Used for brainstorming feature ideas and debugging assistance.

## License
MIT — see LICENSE.