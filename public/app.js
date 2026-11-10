// ==========================================
// DECIMAL.JS SETUP
// ==========================================
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

let tabId = null;
let currency = 'USD';
let menuItems = [];
let currentSummary = null;
let budgetChart = null;

let cart = [];

// ==========================================
// DECIMAL HELPERS
// ==========================================
const cents = (c) => {
  if (c === null || c === undefined) return '0.00';
  return new Decimal(c).div(100).toFixed(2);
};

const toCents = (amount) => {
  return new Decimal(amount).mul(100).round().toNumber();
};

const addCents = (a, b) => new Decimal(a).plus(b).toNumber();
const subCents = (a, b) => new Decimal(a).minus(b).toNumber();
const mulCents = (c, qty) => new Decimal(c).mul(qty).toNumber();
const gtCents = (a, b) => new Decimal(a).gt(b);
const ltCents = (a, b) => new Decimal(a).lt(b);
const gteCents = (a, b) => new Decimal(a).gte(b);
const minCents = (a, b) => Decimal.min(new Decimal(a), new Decimal(b)).toNumber();
const formatCents = (c, curr = currency) => `${cents(c)} ${curr}`;

// ==========================================
// BUDGET MURNI (TANPA CART)
// ==========================================
function getBudgetRemaining(summary = currentSummary) {
  if (!summary) return 0;
  const authorized = new Decimal(summary.authorized_cents || 0);
  const ordered = new Decimal(summary.ordered_cents || 0);
  const fees = new Decimal(summary.extra_fee_cents || 0);
  return authorized.minus(ordered).minus(fees).toNumber();
}

// ==========================================
// REMAINING BUDGET (TERMASUK CART)
// ==========================================
function computeRemaining(summary) {
  if (!summary) {
    return { remaining: 0, authorized: 0, ordered: 0, fees: 0, cart: 0, simulatedOrdered: 0 };
  }

  const authorized = new Decimal(summary.authorized_cents || 0);
  const ordered = new Decimal(summary.ordered_cents || 0);
  const cartTotal = new Decimal(cartTotalCents());

  const fees = (summary.extra_fees || []).reduce(
    (sum, fee) => sum.plus(new Decimal(fee.amount_cents || 0)),
    new Decimal(0)
  );

  const simulatedOrdered = ordered.plus(cartTotal);
  const remaining = authorized.minus(simulatedOrdered).minus(fees);

  return {
    remaining: remaining.toNumber(),
    authorized: authorized.toNumber(),
    ordered: ordered.toNumber(),
    fees: fees.toNumber(),
    cart: cartTotal.toNumber(),
    simulatedOrdered: simulatedOrdered.toNumber(),
  };
}

// ==========================================
// CEK APAKAH TOP-UP BOLEH
// ==========================================
function canTopup(summary = currentSummary) {
  if (!summary) return false;

  const tabStatus = summary.tab?.status;
  const hasLockedItems = (summary.ordered_cents || 0) > 0;

  // Transaksi sudah selesai
  if (tabStatus === 'closed' || tabStatus === 'cancelled') return false;

  // Sedang pending cancel
  if (tabStatus === 'pending_cancel') return false;

  // Sudah ada menu terkunci
  if (hasLockedItems) return false;

  return true;
}

// ==========================================
// RENDER BUDGET CHART
// ==========================================
function renderBudgetChart(summary) {
  const canvas = document.getElementById('budget-chart');
  if (!canvas) return;

  const { remaining, authorized, ordered, fees, cart } = computeRemaining(summary);

  const hasCart = cart > 0;

  const labels = hasCart
    ? ['Remaining Budget', 'Locked Items', 'Cart (not locked)', 'Extra Fees']
    : ['Remaining Budget', 'Total Items', 'Extra Fees'];

  const dataValues = hasCart
    ? [
        Math.max(remaining, 0) / 100,
        ordered / 100,
        cart / 100,
        fees / 100,
      ]
    : [
        Math.max(remaining, 0) / 100,
        ordered / 100,
        fees / 100,
      ];

  const bgColors = hasCart
    ? ['#10B981', '#E8590C', '#3B82F6', '#F59E0B']
    : ['#10B981', '#E8590C', '#F59E0B'];

  if (budgetChart) {
    budgetChart.data.labels = labels;
    budgetChart.data.datasets[0].data = dataValues;
    budgetChart.data.datasets[0].backgroundColor = bgColors;
    budgetChart.options.plugins.centerText = { remaining, currency };
    budgetChart.update();
    return;
  }

  const ctx = canvas.getContext('2d');

  budgetChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: dataValues,
          backgroundColor: bgColors,
          borderColor: '#ffffff',
          borderWidth: 3,
          hoverOffset: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font: { family: 'Inter', size: 12, weight: '600' },
            padding: 14,
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const value = context.parsed;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
              return `${context.label}: ${value.toFixed(2)} ${currency} (${pct}%)`;
            },
          },
        },
      },
      animation: {
        animateScale: true,
        animateRotate: true,
      },
    },
    plugins: [
      {
        id: 'centerText',
        beforeDraw(chart) {
          const { ctx, chartArea } = chart;
          if (!chartArea) return;

          const centerX = (chartArea.left + chartArea.right) / 2;
          const centerY = (chartArea.top + chartArea.bottom) / 2;

          const current = computeRemaining(currentSummary);

          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          ctx.font = '600 11px Inter, sans-serif';
          ctx.fillStyle = '#5A6A7A';
          ctx.fillText('Remaining Budget', centerX, centerY - 14);

          ctx.font = '800 20px Inter, sans-serif';
          ctx.fillStyle = current.remaining > 0 ? '#10B981' : '#E8590C';
          ctx.fillText(`${cents(current.remaining)}`, centerX, centerY + 6);

          if (current.cart > 0) {
            ctx.font = '600 9px Inter, sans-serif';
            ctx.fillStyle = '#3B82F6';
            ctx.fillText('(includes cart)', centerX, centerY + 22);
          }

          ctx.restore();
        },
      },
    ],
  });
}

// ==========================================
// API
// ==========================================
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    const routeFile = path.replace(/^\//, '').split(/[/?]/)[0] || 'tabs';
    const hint =
      res.status === 404
        ? `Endpoint /api${path} not found (404). Check routes/${routeFile}.js`
        : `Server returned a non-JSON response (HTTP ${res.status}).`;
    throw Object.assign(new Error(hint), { data: { error: hint, raw } });
  }

  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data });
  return data;
}

// ==========================================
// ESCAPE HTML
// ==========================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==========================================
// STORAGE
// ==========================================
const STORAGE_KEY = 'Dropfirst_tab_id';
function saveTabId(id) { try { localStorage.setItem(STORAGE_KEY, id); } catch {} }
function clearSavedTabId() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }
function getSavedTabId() { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } }

// ==========================================
// AGGREGATE ORDER ITEMS
// ==========================================
function aggregateOrderItems(items) {
  const map = new Map();
  for (const it of items) {
    const key = `${it.menu_item_id}|${it.price_cents}|${it.rejected ? 'r' : 'a'}`;
    if (!map.has(key)) {
      map.set(key, {
        menu_item_id: it.menu_item_id,
        name: it.name,
        price_cents: it.price_cents,
        quantity: 0,
        rowIds: [],
        rejected: !!it.rejected,
        reject_reason: it.reject_reason || null,
      });
    }
    const group = map.get(key);
    group.quantity += it.quantity;
    group.rowIds.push(it.id);
  }
  return Array.from(map.values());
}

// ==========================================
// PAYPAL SDK
// ==========================================
async function loadPayPalSdk(clientId, curr) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${curr}&intent=authorize`;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function renderPayPalButtons(container, { getAmountCents, onApproved }) {
  container.innerHTML = '';
  window.paypal
    .Buttons({
      createOrder: async () => {
        const amountCents = getAmountCents();
        const body = { amount_cents: amountCents };
        if (!tabId) {
          const tableInput = document.getElementById('initial-table-id');
          if (tableInput && tableInput.value.trim()) body.table_identifier = tableInput.value.trim();
        }
        const endpoint = tabId ? `/tabs/${tabId}/topup` : '/tabs';
        const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
        if (!tabId) {
          tabId = data.tab_id;
          saveTabId(tabId);
        }
        return data.paypal_order_id;
      },
      onApprove: async (data) => {
        const summary = tabId
          ? await api(`/tabs/${tabId}/authorize`, {
              method: 'POST',
              body: JSON.stringify({ order_id: data.orderID }),
            })
          : null;
        onApproved(summary);
      },
    })
    .render(container);
}

// ==========================================
// RENDER MENU
// ==========================================
function renderMenu() {
  const menuEl = document.getElementById('menu');
  menuEl.innerHTML = '';
  for (const item of menuItems) {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'menu-item';
    row.innerHTML = `
      <div>
        <strong class="menu-name" data-detail-for="${item.id}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${escapeHtml(item.name)}</strong>
        <span class="pill">${cents(item.price_cents)} ${currency}</span>
        <div class="desc">${escapeHtml(item.description || '')}</div>
      </div>
      <button data-id="${item.id}">＋ Add</button>
    `;
    row.querySelector('button').addEventListener('click', () => addToCart(item.id));

    const detail = document.createElement('div');
    detail.id = `menu-detail-${item.id}`;
    detail.style.display = 'none';
    detail.innerHTML =
      item.ingredients && item.ingredients.length
        ? `<div class="desc" style="padding:4px 0 12px">Ingredients: ${item.ingredients
            .map((i) => `<span class="pill" style="margin-right:4px">${escapeHtml(i)}</span>`)
            .join('')}</div>`
        : `<div class="desc" style="padding:4px 0 12px;opacity:.6">Ingredient information not available.</div>`;

    row.querySelector('.menu-name').addEventListener('click', () => {
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });

    wrap.appendChild(row);
    wrap.appendChild(detail);
    menuEl.appendChild(wrap);
  }
}

// ==========================================
// ADD TO CART (DIPERBAIKI)
// ==========================================
function addToCart(menuItemId) {
  const menuItem = menuItems.find((m) => m.id === menuItemId);
  if (!menuItem) return;

  const budgetRemaining = getBudgetRemaining();
  const currentCartTotal = new Decimal(cartTotalCents());
  const newItemPrice = new Decimal(menuItem.price_cents);
  const newCartTotal = currentCartTotal.plus(newItemPrice);

  if (gtCents(newCartTotal.toNumber(), budgetRemaining)) {
    const logEl = document.getElementById('cart-log');
    if (logEl) {
      logEl.textContent = `⚠️ Cannot add "${menuItem.name}" — would exceed your remaining budget of ${formatCents(budgetRemaining)}.`;
      logEl.style.color = '#E8590C';
      setTimeout(() => {
        logEl.textContent = '';
        logEl.style.color = '';
      }, 4000);
    }
    return;
  }

  const existing = cart.find((c) => c.menu_item_id === menuItemId);
  if (existing) existing.quantity += 1;
  else cart.push({ menu_item_id: menuItemId, name: menuItem.name, price_cents: menuItem.price_cents, quantity: 1 });

  renderCart();
}

function cartTotalCents() {
  return cart.reduce((sum, c) => addCents(sum, mulCents(c.price_cents, c.quantity)), 0);
}

// ==========================================
// RENDER CART (DENGAN VALIDASI TOP-UP)
// ==========================================
function renderCart() {
  const container = document.getElementById('cart-list');
  const lockBtn = document.getElementById('lock-cart-btn');
  const topupBtn = document.getElementById('topup-btn');
  if (!container || !lockBtn) return;

  // ==========================================
  // CEK APAKAH TOP-UP BOLEH DILAKUKAN
  // ==========================================
  const topupAllowed = canTopup(currentSummary);

  if (topupBtn) {
    if (!topupAllowed) {
      topupBtn.disabled = true;
      topupBtn.style.opacity = '0.5';
      topupBtn.style.cursor = 'not-allowed';
      
      const tabStatus = currentSummary?.tab?.status;
      const hasLockedItems = (currentSummary?.ordered_cents || 0) > 0;
      
      if (tabStatus === 'closed') {
        topupBtn.title = 'Transaction is already closed';
      } else if (tabStatus === 'cancelled') {
        topupBtn.title = 'Transaction has been cancelled';
      } else if (tabStatus === 'pending_cancel') {
        topupBtn.title = 'Cancellation is pending approval';
      } else if (hasLockedItems) {
        topupBtn.title = 'Cannot add funds after items are locked';
      }
    } else {
      topupBtn.disabled = false;
      topupBtn.style.opacity = '1';
      topupBtn.style.cursor = 'pointer';
      topupBtn.title = '';
    }
  }

  if (cart.length === 0) {
    container.innerHTML = '<p class="log" style="margin-top:12px">No items selected to lock yet.</p>';
    lockBtn.disabled = true;

    if (currentSummary) {
      renderBudgetChart(currentSummary);
    }
    return;
  }

  const total = cartTotalCents();

  container.innerHTML =
    cart
      .map(
        (c, idx) => `
      <div class="menu-item">
        <div>
          <strong>${c.quantity}× ${escapeHtml(c.name)}</strong>
          <div class="desc">${cents(c.price_cents)} ${currency} / portion</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="pill">${formatCents(mulCents(c.price_cents, c.quantity))}</span>
          <button class="ghost" data-cart-idx="${idx}" data-action="cart-minus" style="padding:6px 12px;font-size:13px">−1</button>
          <button class="ghost" data-cart-idx="${idx}" data-action="cart-remove" style="padding:6px 12px;font-size:13px;color:var(--danger)">✕</button>
        </div>
      </div>`
      )
      .join('') +
    `<div class="menu-item"><strong>Cart Total</strong><span class="pill">${formatCents(total)}</span></div>`;

  container.querySelectorAll('[data-action="cart-minus"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.cartIdx);
      cart[idx].quantity -= 1;
      if (cart[idx].quantity <= 0) cart.splice(idx, 1);
      renderCart();
    });
  });
  container.querySelectorAll('[data-action="cart-remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cart.splice(Number(btn.dataset.cartIdx), 1);
      renderCart();
    });
  });

  lockBtn.disabled = false;

  if (currentSummary) {
    renderBudgetChart(currentSummary);
  }
}

async function lockCart() {
  const logEl = document.getElementById('cart-log');
  const lockBtn = document.getElementById('lock-cart-btn');
  if (cart.length === 0) return;

  if (gtCents(cartTotalCents(), currentSummary?.remaining_budget_cents ?? 0)) {
    logEl.textContent = '⚠️ Cart exceeds remaining budget. Remove items or add funds first.';
    return;
  }

  lockBtn.disabled = true;
  logEl.textContent = 'Locking order…';

  const remaining = [...cart];
  while (remaining.length > 0) {
    const line = remaining[0];
    try {
      await api(`/tabs/${tabId}/items`, {
        method: 'POST',
        body: JSON.stringify({ menu_item_id: line.menu_item_id, quantity: line.quantity, added_by: 'buyer' }),
      });
      remaining.shift();
    } catch (e) {
      cart = remaining;
      renderCart();
      logEl.textContent =
        '❌ ' + (e.data?.error || e.message) + ' — remaining cart items not locked, adjust and retry.';
      await refreshSummary();
      return;
    }
  }

  cart = [];
  renderCart();
  logEl.textContent = '✅ Order locked. You can add more items for the next round.';
  await refreshSummary();
}

// ==========================================
// RENDER ORDER LIST
// ==========================================
function renderOrderList() {
  const container = document.getElementById('order-list');
  if (!container) return;

  const items = currentSummary?.items || [];
  const canEdit = currentSummary?.tab?.status === 'open' && !currentSummary?.cancel_locked;

  if (items.length === 0) {
    container.innerHTML = '<p class="log" style="margin-top:12px">No orders yet — pick from the menu above.</p>';
    return;
  }

  const aggregated = aggregateOrderItems(items);
  container.innerHTML = aggregated
    .map((it, idx) => {
      if (it.rejected) {
        return `
          <div class="menu-item">
            <div>
              <strong style="text-decoration:line-through;opacity:.6">${it.quantity}× ${it.name ?? 'Item #' + it.menu_item_id}</strong>
              <div class="desc" style="color:var(--danger)">❌ Rejected by restaurant: ${escapeHtml(it.reject_reason || 'no reason given')}</div>
            </div>
            <span class="pill" style="opacity:.6">not charged</span>
          </div>`;
      }
      return `
      <div class="menu-item">
        <div>
          <strong>${it.quantity}× ${it.name ?? 'Item #' + it.menu_item_id}</strong>
          <div class="desc">${cents(it.price_cents)} ${currency} / portion</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="pill">${formatCents(mulCents(it.price_cents, it.quantity))}</span>
          ${
            canEdit
              ? `<button class="ghost" data-action="minus" data-idx="${idx}" title="Remove 1" style="padding:6px 12px;font-size:13px">−1</button>
                 <button class="ghost" data-action="remove" data-idx="${idx}" title="Cancel this item" style="padding:6px 12px;font-size:13px;color:var(--danger)">✕</button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');

  if (currentSummary?.cancel_locked && currentSummary?.tab?.status === 'open') {
    container.innerHTML += '<p class="log" style="margin-top:8px">🔒 Item cancellation is disabled by the restaurant for this order.</p>';
  }

  if (!canEdit) return;

  container.querySelectorAll('[data-action="minus"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = aggregated[Number(btn.dataset.idx)];
      removeOrderRow(group.rowIds[group.rowIds.length - 1]);
    });
  });
  container.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = aggregated[Number(btn.dataset.idx)];
      if (confirm(`Cancel all ${group.name}? (${group.quantity}×)`)) {
        removeOrderGroup(group.rowIds);
      }
    });
  });
}

async function removeOrderRow(rowId) {
  if (rowId == null) {
    console.error('removeOrderRow: rowId is undefined.');
    alert('Cannot remove this item — its id is missing.');
    return;
  }
  try {
    await api(`/tabs/${tabId}/items/${rowId}`, { method: 'DELETE' });
    await refreshSummary();
  } catch (e) {
    alert(e.data?.error || e.message);
  }
}

async function removeOrderGroup(rowIds) {
  if (rowIds.some((r) => r == null)) {
    console.error('removeOrderGroup: one or more rowIds is undefined.');
    alert('Cannot cancel this item — its id is missing.');
    return;
  }
  try {
    for (const rowId of rowIds) {
      await api(`/tabs/${tabId}/items/${rowId}`, { method: 'DELETE' });
    }
    await refreshSummary();
  } catch (e) {
    alert(e.data?.error || e.message);
  }
}

// ==========================================
// TABLE ID
// ==========================================
function renderTableIdBlock() {
  const container = document.getElementById('table-id-block');
  if (!container) return;

  const tab = currentSummary?.tab;
  const editable = currentSummary?.table_id_editable;
  const value = tab?.table_identifier || '';
  const isOpen = tab?.status === 'open';

  if (!isOpen) {
    container.innerHTML = value
      ? `<div class="pill" style="font-size:14px;padding:8px 14px;display:inline-block">🍽️ Table: <strong>${escapeHtml(value)}</strong></div>`
      : '';
    return;
  }

  if (value && !editable) {
    container.innerHTML = `<div class="pill" style="font-size:14px;padding:8px 14px;display:inline-block">🍽️ Table: <strong>${escapeHtml(value)}</strong> <span style="opacity:.7">(locked)</span></div>`;
    return;
  }

  container.innerHTML = `
    <div class="hold-row" style="margin-bottom:8px">
      <input id="table-id-input" type="text" placeholder="Table number (optional)" value="${escapeHtml(value)}" style="width:200px;font-size:15px;padding:10px 14px">
      <button class="ghost" id="table-id-save-btn" style="padding:10px 18px">Save</button>
    </div>
    <p class="log" id="table-id-log"></p>
  `;
  document.getElementById('table-id-save-btn').addEventListener('click', saveTableId);
}

async function saveTableId() {
  const input = document.getElementById('table-id-input');
  const logEl = document.getElementById('table-id-log');
  const value = input.value.trim();
  if (!value) {
    logEl.textContent = 'Please enter a table number first.';
    return;
  }
  try {
    const summary = await api(`/tabs/${tabId}/table`, {
      method: 'PATCH',
      body: JSON.stringify({ table_identifier: value }),
    });
    currentSummary = summary;
    renderTableIdBlock();
  } catch (e) {
    logEl.textContent = '❌ ' + (e.data?.error || e.message);
  }
}

// ==========================================
// REFRESH SUMMARY
// ==========================================
async function refreshSummary() {
  const summary = await api(`/tabs/${tabId}`);
  currentSummary = summary;

  const { remaining } = computeRemaining(summary);

  const remainingEl = document.getElementById('remaining');
  if (remainingEl) {
    remainingEl.textContent = formatCents(remaining);
    remainingEl.classList.toggle('low', ltCents(remaining, 500));
  }

  const orderedEl = document.getElementById('ordered-total');
  if (orderedEl) {
    orderedEl.textContent = formatCents(summary.ordered_cents);
  }

  renderBudgetChart(summary);
  renderCart();           // ← Update top-up button state
  renderOrderList();
  renderTableIdBlock();
  return summary;
}

// ==========================================
// EVENT LISTENERS
// ==========================================
document.getElementById('lock-cart-btn').addEventListener('click', lockCart);

document.getElementById('topup-btn').addEventListener('click', () => {
  // ==========================================
  // VALIDASI TOP-UP
  // ==========================================
  if (!canTopup(currentSummary)) {
    const tabStatus = currentSummary?.tab?.status;
    const hasLockedItems = (currentSummary?.ordered_cents || 0) > 0;

    if (tabStatus === 'closed') {
      alert('Transaction is already closed. You cannot add funds anymore.');
    } else if (tabStatus === 'cancelled') {
      alert('Transaction has been cancelled. You cannot add funds anymore.');
    } else if (tabStatus === 'pending_cancel') {
      alert('Your cancellation request is pending. Please wait for staff approval.');
    } else if (hasLockedItems) {
      alert('Cannot add funds after items are locked. Please close the tab to pay, or cancel to start over.');
    }
    return;
  }

  // ==========================================
  // LANJUTKAN TOP-UP
  // ==========================================
  const extra = prompt('How much more would you like to authorize?', '10');
  if (!extra) return;
  const amountCents = toCents(extra);
  const container = document.createElement('div');
  container.id = 'paypal-buttons';
  document.getElementById('step-order').appendChild(container);
  renderPayPalButtons(container, {
    getAmountCents: () => amountCents,
    onApproved: async () => {
      await refreshSummary();
      container.remove();
    },
  });
});

document.getElementById('agent-btn').addEventListener('click', async () => {
  const request = document.getElementById('agent-request').value;
  const resultEl = document.getElementById('agent-result');
  resultEl.textContent = 'Thinking…';
  const proposal = await api(`/tabs/${tabId}/agent`, {
    method: 'POST',
    body: JSON.stringify({ request }),
  });
  resultEl.innerHTML =
    `<p class="log">${proposal.note}</p>` +
    proposal.picks
      .map((p) => `<div>${p.quantity}x ${p.name} — ${formatCents(mulCents(p.price_cents, p.quantity))}</div>`)
      .join('') +
    `<button id="confirm-agent" style="margin-top:12px">Add these to my order</button>`;
  document.getElementById('confirm-agent').addEventListener('click', () => {
    for (const p of proposal.picks) {
      const existing = cart.find((c) => c.menu_item_id === p.menu_item_id);
      if (existing) existing.quantity += p.quantity;
      else cart.push({ menu_item_id: p.menu_item_id, name: p.name, price_cents: p.price_cents, quantity: p.quantity });
    }
    renderCart();
    resultEl.textContent = 'Added to cart — click "Lock Order" to confirm.';
  });
});

// ==========================================
// CLOSE MODAL
// ==========================================
function openConfirmModal() {
  const modal = document.getElementById('confirm-modal');
  const summaryEl = document.getElementById('modal-summary');
  const summary = currentSummary || {};

  const { remaining } = computeRemaining(summary);

  const feeLines = (summary.extra_fees || [])
    .map(
      (fee) => `
      <div class="modal-summary-row" style="align-items:flex-start">
        <span>
          ${escapeHtml(fee.label)}
          ${fee.description ? `<span style="display:block;font-size:12px;color:var(--ink-soft);font-weight:400">${escapeHtml(fee.description)}</span>` : ''}
        </span>
        <span>${formatCents(fee.amount_cents)}</span>
      </div>`
    )
    .join('');

  summaryEl.innerHTML = `
    <div class="modal-summary-row">
      <span>Total items</span>
      <span>${formatCents(summary.ordered_cents || 0)}</span>
    </div>
    ${feeLines}
    <div class="modal-summary-row">
      <span>Remaining budget (will be released)</span>
      <span>${formatCents(remaining)}</span>
    </div>
    <div class="modal-summary-row total">
      <span>Total to pay</span>
      <span>${formatCents(summary.total_due_cents ?? summary.ordered_cents ?? 0)}</span>
    </div>
  `;

  modal.classList.add('active');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('active');
}

async function attemptClose() {
  const logEl = document.getElementById('close-log');
  const retryBtn = document.getElementById('retry-close-btn');
  logEl.textContent = 'Capturing final bill…';
  retryBtn.style.display = 'none';

  try {
    const summary = await api(`/tabs/${tabId}/close`, { method: 'POST' });

    logEl.textContent = `✅ Tab closed. Charged ${formatCents(summary.captured_cents)}. Thank you!`;
    document.getElementById('download-invoice-btn').style.display = 'inline-block';
    document.getElementById('close-btn').disabled = true;
    document.getElementById('cancel-btn').disabled = true;
    currentSummary = summary;

    // ==========================================
    // SEMBUNYIKAN TOP-UP SETELAH CLOSE
    // ==========================================
    const topupBtn = document.getElementById('topup-btn');
    if (topupBtn) topupBtn.style.display = 'none';

    renderOrderList();
    renderCart();
    clearSavedTabId();

    window.finalInvoice = {
      tabId: tabId,
      captured: summary.captured_cents,
      currency: currency,
      date: new Date().toLocaleString(),
      items: summary.items || [],
      extraFees: summary.extra_fees || [],
      tableIdentifier: summary.tab?.table_identifier || '',
    };
  } catch (e) {
    logEl.textContent = '❌ ' + (e.data?.error || e.message) + ' — no double charge, safe to retry.';
    retryBtn.style.display = 'inline-block';
  }
}

async function confirmClose() {
  closeConfirmModal();
  await attemptClose();
}

document.getElementById('retry-close-btn').addEventListener('click', attemptClose);

// ==========================================
// CANCEL TAB
// ==========================================
function openCancelModal() {
  const modal = document.getElementById('cancel-modal');
  const summaryEl = document.getElementById('cancel-modal-summary');
  const summary = currentSummary || {};

  summaryEl.innerHTML = `
    <div class="modal-summary-row">
      <span>Currently held funds</span>
      <span>${formatCents(summary.authorized_cents || 0)}</span>
    </div>
    <div class="modal-summary-row">
      <span>Orders to be cancelled</span>
      <span>${formatCents(summary.ordered_cents || 0)}</span>
    </div>
  `;
  modal.classList.add('active');
}

function closeCancelModal() {
  document.getElementById('cancel-modal').classList.remove('active');
}

async function confirmCancel() {
  closeCancelModal();
  const logEl = document.getElementById('cancel-log');
  const retryBtn = document.getElementById('retry-release-btn');
  logEl.textContent = 'Processing…';
  retryBtn.style.display = 'none';

  try {
    const result = await api(`/tabs/${tabId}/cancel`, { method: 'POST' });
    currentSummary = result;

    if (result.tab.status === 'pending_cancel') {
      showPendingCancelState();
      startCancelPolling();
      return;
    }

    if (result.failed && result.failed.length > 0) {
      logEl.textContent = `⚠️ ${result.released.length} funds released, ${result.failed.length} failed — retry below.`;
      retryBtn.style.display = 'inline-block';
    } else {
      logEl.textContent = '✅ All held funds released. This tab has been cancelled.';
      document.getElementById('close-btn').disabled = true;
      document.getElementById('cancel-btn').disabled = true;

      // ==========================================
      // SEMBUNYIKAN TOP-UP SETELAH CANCEL
      // ==========================================
      const topupBtn = document.getElementById('topup-btn');
      if (topupBtn) topupBtn.style.display = 'none';

      renderCart();
      clearSavedTabId();
    }
  } catch (e) {
    logEl.textContent = '❌ ' + (e.data?.error || e.message);
  }
}

// ==========================================
// PENDING CANCELLATION
// ==========================================
let cancelPollTimer = null;

function showPendingCancelState() {
  const logEl = document.getElementById('cancel-log');
  document.getElementById('cancel-btn').disabled = true;
  document.getElementById('close-btn').disabled = true;
  logEl.textContent = '⏳ Waiting for staff approval to cancel this order — please keep this page open.';

  // Disable top-up saat pending cancel
  const topupBtn = document.getElementById('topup-btn');
  if (topupBtn) {
    topupBtn.disabled = true;
    topupBtn.style.opacity = '0.5';
    topupBtn.style.cursor = 'not-allowed';
    topupBtn.title = 'Cancellation is pending approval';
  }
}

function startCancelPolling() {
  stopCancelPolling();
  cancelPollTimer = setInterval(async () => {
    try {
      const summary = await api(`/tabs/${tabId}`);
      currentSummary = summary;
      const logEl = document.getElementById('cancel-log');

      if (summary.tab.status === 'cancelled') {
        logEl.textContent = '✅ Cancellation approved by staff. All held funds released.';
        clearSavedTabId();
        stopCancelPolling();

        // Sembunyikan top-up
        const topupBtn = document.getElementById('topup-btn');
        if (topupBtn) topupBtn.style.display = 'none';
      } else if (summary.tab.status === 'open') {
        logEl.textContent = `❌ Cancellation denied: ${summary.tab.cancel_deny_reason || 'no reason given'}`;
        document.getElementById('cancel-btn').disabled = false;
        document.getElementById('close-btn').disabled = false;
        stopCancelPolling();
        await refreshSummary();
      }
    } catch (e) {
      // Network hiccup — retry next tick.
    }
  }, 8000);
}

function stopCancelPolling() {
  if (cancelPollTimer) clearInterval(cancelPollTimer);
  cancelPollTimer = null;
}

async function retryReleaseHolds() {
  const logEl = document.getElementById('cancel-log');
  const retryBtn = document.getElementById('retry-release-btn');
  logEl.textContent = 'Retrying to release remaining funds…';

  try {
    const result = await api(`/tabs/${tabId}/release-holds`, { method: 'POST' });
    if (result.failed && result.failed.length > 0) {
      logEl.textContent = `⚠️ ${result.released.length} released, ${result.failed.length} still failing — retry later.`;
    } else {
      logEl.textContent = '✅ All held funds released.';
      retryBtn.style.display = 'none';
      document.getElementById('close-btn').disabled = true;
      document.getElementById('cancel-btn').disabled = true;
      clearSavedTabId();
    }
  } catch (e) {
    logEl.textContent = '❌ ' + (e.data?.error || e.message);
  }
}

document.getElementById('cancel-btn').addEventListener('click', openCancelModal);
document.getElementById('retry-release-btn').addEventListener('click', retryReleaseHolds);

// ==========================================
// DOWNLOAD INVOICE PDF
// ==========================================
document.getElementById('download-invoice-btn').addEventListener('click', () => {
  const inv = window.finalInvoice;
  if (!inv) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginLeft = 20;
  const marginRight = 20;
  const contentWidth = pageWidth - marginLeft - marginRight;

  let y = 20;

  // HEADER
  doc.setFillColor(232, 89, 12);
  doc.roundedRect(marginLeft, y, 14, 14, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('FT', marginLeft + 4, y + 9.5);

  doc.setTextColor(20, 33, 61);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('Dropfirst', marginLeft + 18, y + 7);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90, 106, 122);
  doc.text('Pay as you can afford', marginLeft + 18, y + 12);

  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(232, 89, 12);
  doc.text('INVOICE', pageWidth - marginRight, y + 7, { align: 'right' });

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90, 106, 122);
  doc.text(`#${inv.tabId.slice(0, 8).toUpperCase()}`, pageWidth - marginRight, y + 12, { align: 'right' });
  if (inv.tableIdentifier) {
    doc.text(`Table ${inv.tableIdentifier}`, pageWidth - marginRight, y + 17, { align: 'right' });
  }

  y += 22;

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 10;

  // INFO
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(90, 106, 122);
  doc.text('DATE', marginLeft, y);
  doc.text('STATUS', marginLeft + contentWidth / 2, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(20, 33, 61);
  doc.setFontSize(10);
  doc.text(inv.date, marginLeft, y);

  doc.setFillColor(198, 246, 213);
  doc.roundedRect(marginLeft + contentWidth / 2, y - 3.5, 28, 6, 2, 2, 'F');
  doc.setTextColor(34, 84, 61);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('PAID', marginLeft + contentWidth / 2 + 14, y, { align: 'center' });

  y += 12;

  // TABLE ITEMS
  doc.setFillColor(241, 243, 248);
  doc.rect(marginLeft, y, contentWidth, 8, 'F');
  doc.setTextColor(90, 106, 122);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text('ITEM', marginLeft + 3, y + 5.5);
  doc.text('QTY', marginLeft + contentWidth - 65, y + 5.5, { align: 'center' });
  doc.text('PRICE', marginLeft + contentWidth - 35, y + 5.5, { align: 'right' });
  doc.text('SUBTOTAL', marginLeft + contentWidth - 3, y + 5.5, { align: 'right' });
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(20, 33, 61);

  const items = aggregateOrderItems((inv.items || []).filter((i) => !i.rejected));

  if (items.length === 0) {
    doc.setTextColor(150, 150, 150);
    doc.setFont('helvetica', 'italic');
    doc.text('No items', marginLeft + 3, y + 6);
    y += 10;
  } else {
    items.forEach((item, index) => {
      if (index % 2 === 0) {
        doc.setFillColor(250, 251, 253);
        doc.rect(marginLeft, y, contentWidth, 9, 'F');
      }

      doc.setTextColor(20, 33, 61);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);

      const maxNameWidth = contentWidth - 80;
      let itemName = item.name || `Item #${item.menu_item_id}`;
      if (doc.getTextWidth(itemName) > maxNameWidth) {
        while (doc.getTextWidth(itemName + '...') > maxNameWidth && itemName.length > 0) {
          itemName = itemName.slice(0, -1);
        }
        itemName += '...';
      }

      doc.text(itemName, marginLeft + 3, y + 6);
      doc.text(String(item.quantity), marginLeft + contentWidth - 65, y + 6, { align: 'center' });
      doc.text(cents(item.price_cents), marginLeft + contentWidth - 35, y + 6, { align: 'right' });

      doc.setFont('helvetica', 'bold');
      doc.text(cents(mulCents(item.price_cents, item.quantity)), marginLeft + contentWidth - 3, y + 6, { align: 'right' });

      y += 9;
    });
  }

  (inv.extraFees || []).forEach((fee) => {
    doc.setFillColor(250, 251, 253);
    doc.rect(marginLeft, y, contentWidth, 9, 'F');
    doc.setTextColor(20, 33, 61);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.text(fee.label, marginLeft + 3, y + 6);
    doc.setFont('helvetica', 'bold');
    doc.text(cents(fee.amount_cents), marginLeft + contentWidth - 3, y + 6, { align: 'right' });
    y += 9;
  });

  // TOTAL
  y += 3;
  doc.setDrawColor(20, 33, 61);
  doc.setLineWidth(1);
  doc.line(marginLeft + contentWidth - 90, y, pageWidth - marginRight, y);
  y += 8;

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20, 33, 61);
  doc.text('TOTAL PAID', marginLeft + contentWidth - 90, y);

  doc.setFontSize(16);
  doc.setTextColor(232, 89, 12);
  doc.text(`${cents(inv.captured)} ${inv.currency}`, pageWidth - marginRight, y, { align: 'right' });

  y += 20;

  // FOOTER
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(marginLeft, y, pageWidth - marginRight, y);
  y += 8;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(90, 106, 122);
  doc.text('Thank you for using Dropfirst', pageWidth / 2, y, { align: 'center' });

  y += 5;
  doc.setFontSize(8);
  doc.text('This invoice is generated automatically by the system.', pageWidth / 2, y, { align: 'center' });

  doc.save(`invoice-Dropfirst-${inv.tabId.slice(0, 8)}.pdf`);
});

// ==========================================
// MODAL CLOSE LISTENERS
// ==========================================
document.getElementById('close-btn').addEventListener('click', async () => {
  try {
    await refreshSummary();
  } catch {}
  openConfirmModal();
});

document.getElementById('confirm-modal').addEventListener('click', (e) => {
  if (e.target.id === 'confirm-modal') closeConfirmModal();
});
document.getElementById('cancel-modal').addEventListener('click', (e) => {
  if (e.target.id === 'cancel-modal') closeCancelModal();
});

// ==========================================
// RESUME TAB
// ==========================================
function enterOrderingView() {
  document.getElementById('step-order').style.display = 'block';
  // document.getElementById('step-agent').style.display = 'block';
  document.getElementById('step-close').style.display = 'block';
  renderMenu();
  renderCart();           // ← Update top-up button state
}

async function tryResumeSavedTab() {
  const savedId = getSavedTabId();
  if (!savedId) return false;

  try {
    const summary = await api(`/tabs/${savedId}`);
    if (summary.tab.status !== 'open' && summary.tab.status !== 'pending_cancel') {
      clearSavedTabId();
      return false;
    }

    tabId = savedId;
    currentSummary = summary;
    document.getElementById('step-hold').style.display = 'none';

    const banner = document.getElementById('resume-banner');
    if (banner) banner.style.display = 'block';

    enterOrderingView();
    await refreshSummary();

    if (summary.tab.status === 'pending_cancel') {
      showPendingCancelState();
      startCancelPolling();
    }
    return true;
  } catch (e) {
    clearSavedTabId();
    return false;
  }
}

// ==========================================
// UPFRONT FEES
// ==========================================
async function renderUpfrontFees() {
  const container = document.getElementById('upfront-fees');
  if (!container) return;
  try {
    const { fees } = await api('/fees');
    if (fees.length === 0) {
      container.innerHTML = '';
      return;
    }

    const totalFeeCents = fees
      .reduce(
        (sum, f) => sum.plus(new Decimal(f.amount_cents || 0)),
        new Decimal(0)
      )
      .toNumber();

    container.innerHTML = `
      <div class="upfront-fees-box">
        <div class="upfront-fees-header">
          <span class="upfront-fees-icon">ℹ️</span>
          <span class="upfront-fees-title">Extra fees applied when the tab is closed</span>
          <span class="upfront-fees-total">${cents(totalFeeCents)} ${currency}</span>
        </div>
        <div class="upfront-fees-list">
          ${fees
            .map(
              (f) => `
            <div class="upfront-fee-row">
              <div class="upfront-fee-info">
                <span class="upfront-fee-label">${escapeHtml(f.label)}</span>
                ${
                  f.description
                    ? `<span class="upfront-fee-desc">${escapeHtml(f.description)}</span>`
                    : ''
                }
              </div>
              <span class="upfront-fee-amount">${cents(f.amount_cents)} ${currency}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = '';
  }
}

// ==========================================
// INIT
// ==========================================
async function init() {
  const config = await api('/config');
  currency = config.currency;
  document.getElementById('hold-currency').textContent = currency;

  const { items } = await api('/menu');
  menuItems = items;

  renderUpfrontFees();

  if (!config.clientId) {
    document.getElementById('hold-log').textContent =
      'Set PAYPAL_CLIENT_ID in your .env to enable the PayPal buttons.';
    return;
  }

  const resumed = await tryResumeSavedTab();
  if (resumed) return;

  await loadPayPalSdk(config.clientId, currency);
  renderPayPalButtons(document.getElementById('paypal-buttons'), {
    getAmountCents: () => toCents(document.getElementById('hold-amount').value),
    onApproved: async () => {
      document.getElementById('step-hold').querySelector('#paypal-buttons')?.remove();
      document.getElementById('hold-log').textContent = '✅ Funds authorized — order away.';
      enterOrderingView();
      await refreshSummary();
    },
  });
}

init();