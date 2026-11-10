// Proposes a shopping cart from the menu that fits inside the remaining
// authorized budget. Two modes:
//
//  - Rule-based fallback (no AI key needed): greedy pick within budget,
//    respecting simple preference keywords (e.g. "vegetarian", "no spicy").
//  - AI-assisted (set AI_PROVIDER + AI_API_KEY in .env): sends the menu,
//    budget, and the buyer's request to the model and asks it to return
//    JSON only. The model's picks still pass through the exact same
//    server-side budget check as a manual order — the model proposes,
//    the server disposes. This is the guardrail: an agent can never
//    spend more than the buyer has already authorized with PayPal.

function parsePreferences(text = '') {
  const t = text.toLowerCase();
  return {
    vegetarian: /vegetarian|no meat|tanpa daging/.test(t),
    noSpicy: /no spicy|not spicy|tidak pedas|gak pedas/.test(t),
    noPeanut: /no peanut|peanut allergy|alergi kacang/.test(t),
    drinkWanted: /drink|minum|thirsty/.test(t) || true,
  };
}

function ruleBasedPick(menuItems, budgetCents, preferences) {
  let pool = menuItems.filter((m) => {
    const tags = (m.tags || '').split(',');
    if (preferences.vegetarian && !tags.includes('vegetarian')) return false;
    if (preferences.noSpicy && tags.includes('spicy')) return false;
    if (preferences.noPeanut && tags.includes('peanut')) return false;
    return true;
  });
  if (pool.length === 0) pool = menuItems;

  // Greedy: prioritize mains/grill/soup first, then one drink, then sides,
  // while staying inside budget.
  const rank = (m) => {
    const tags = (m.tags || '').split(',');
    if (tags.includes('rice') || tags.includes('grill') || tags.includes('soup')) return 0;
    if (tags.includes('drink')) return 1;
    return 2;
  };
  const sorted = [...pool].sort((a, b) => rank(a) - rank(b) || a.price_cents - b.price_cents);

  const picks = [];
  let spent = 0;
  let drinkPicked = false;
  for (const item of sorted) {
    const isDrink = (item.tags || '').includes('drink');
    if (isDrink && drinkPicked) continue;
    if (spent + item.price_cents <= budgetCents) {
      picks.push({ menu_item_id: item.id, name: item.name, price_cents: item.price_cents, quantity: 1 });
      spent += item.price_cents;
      if (isDrink) drinkPicked = true;
    }
  }
  return {
    picks,
    total_cents: spent,
    note: 'Rule-based pick (no AI_PROVIDER configured): greedy selection within budget and stated preferences.',
  };
}

/**
 * @param {object} args
 * @param {Array}  args.menuItems   rows from menu_items
 * @param {number} args.budgetCents remaining authorized budget for this tab
 * @param {string} args.request     free-text buyer request, e.g. "lunch for 2, no spicy"
 */
async function proposeOrder({ menuItems, budgetCents, request }) {
  const preferences = parsePreferences(request);
  const provider = process.env.AI_PROVIDER;

  if (!provider || !process.env.AI_API_KEY) {
    return ruleBasedPick(menuItems, budgetCents, preferences);
  }

  // Example wiring for a real model. Kept provider-agnostic on purpose —
  // fill in the fetch call for whichever API you want to demo with.
  // The model MUST return JSON only: { picks: [{menu_item_id, quantity}], note }
  try {
    const prompt = buildPrompt(menuItems, budgetCents, request);
    const aiResult = await callModel(provider, prompt);
    return validateAndPrice(aiResult, menuItems, budgetCents);
  } catch (err) {
    console.error('AI agent call failed, falling back to rule-based pick:', err.message);
    return ruleBasedPick(menuItems, budgetCents, preferences);
  }
}

function buildPrompt(menuItems, budgetCents, request) {
  const menuForPrompt = menuItems.map((m) => ({
    id: m.id,
    name: m.name,
    price_cents: m.price_cents,
    tags: m.tags,
  }));
  return [
    'You are a food-ordering assistant for a single diner or small group.',
    `Remaining authorized budget: ${budgetCents} cents.`,
    `Buyer request: ${JSON.stringify(request || '')}`,
    `Menu: ${JSON.stringify(menuForPrompt)}`,
    'Return ONLY JSON: {"picks":[{"menu_item_id":number,"quantity":number}],"note":string}.',
    'The sum of price_cents * quantity across picks MUST NOT exceed the budget.',
  ].join('\n');
}

async function callModel(provider, prompt) {
  // Fill this in for the provider you choose to demo with, e.g.:
  //
  // const res = await fetch('https://api.openai.com/v1/chat/completions', {
  //   method: 'POST',
  //   headers: {
  //     Authorization: `Bearer ${process.env.AI_API_KEY}`,
  //     'Content-Type': 'application/json',
  //   },
  //   body: JSON.stringify({
  //     model: 'gpt-4o-mini',
  //     messages: [{ role: 'user', content: prompt }],
  //     response_format: { type: 'json_object' },
  //   }),
  // });
  
  // const data = await res.json();
  // return JSON.parse(data.choices[0].message.content);
  throw new Error(`No model wiring implemented for provider "${provider}" yet`);
}

/** Re-prices the model's picks from the real menu and rejects anything over budget. */
function validateAndPrice(aiResult, menuItems, budgetCents) {
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  const picks = [];
  let total = 0;
  for (const p of aiResult.picks || []) {
    const item = byId.get(p.menu_item_id);
    if (!item) continue;
    const qty = Math.max(1, Number(p.quantity) || 1);
    const lineTotal = item.price_cents * qty;
    if (total + lineTotal > budgetCents) break; // hard stop: never exceed budget
    picks.push({ menu_item_id: item.id, name: item.name, price_cents: item.price_cents, quantity: qty });
    total += lineTotal;
  }
  return { picks, total_cents: total, note: aiResult.note || 'AI-assisted pick, server-validated against budget.' };
}

module.exports = { proposeOrder };
