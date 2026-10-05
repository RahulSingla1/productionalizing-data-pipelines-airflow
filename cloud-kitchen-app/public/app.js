// Kitchen Desk front end: a small hash-routed single-page app, no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const qtyLabel = (n) => (Number.isInteger(n) ? n : Number(n).toFixed(1));

function todayStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function prettyDate(date, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
}
function dayLabel(date) {
  const t = todayStr();
  if (date === t) return 'Today';
  if (date === addDays(t, -1)) return 'Yesterday';
  return prettyDate(date);
}
function ago(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: raw ? { 'Content-Type': 'text/plain' } : body ? { 'Content-Type': 'application/json' } : {},
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please log in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function setHeader(title, actionsHtml = '') {
  $('#page-title').textContent = title;
  $('#page-actions').innerHTML = actionsHtml;
  document.title = `${title} · Kitchen Desk`;
}

// A reusable form dialog. fields: [{ name, label, type, options, placeholder, half }]
function openForm({ title, fields, values = {}, onSave, onDelete, saveLabel = 'Save' }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-error').textContent = '';
  $('#dialog-save').textContent = saveLabel;
  const field = (f) => {
    const v = values[f.name] ?? f.default ?? '';
    const common = `name="${f.name}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}"`;
    let input;
    if (f.type === 'select') {
      input = `<select ${common}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea ${common}>${esc(v)}</textarea>`;
    } else {
      input = `<input type="${f.type || 'text'}" ${f.type === 'number' ? 'step="any" inputmode="decimal"' : ''} ${f.list ? `list="${f.list}"` : ''} value="${esc(v)}" ${common}>`;
    }
    return `<label>${esc(f.label)}${input}</label>`;
  };
  // Pair up consecutive "half" fields side by side.
  let html = '';
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].half && fields[i + 1]?.half) { html += `<div class="grid2">${field(fields[i])}${field(fields[i + 1])}</div>`; i++; }
    else html += field(fields[i]);
  }
  $('#dialog-body').innerHTML = `<div class="form">${html}</div>`;
  const del = $('#dialog-delete');
  del.hidden = !onDelete;
  del.onclick = async () => {
    if (!confirm('Delete this?')) return;
    try { await onDelete(); dlg.close(); route(); } catch (e) { $('#dialog-error').textContent = e.message; }
  };
  $('#dialog-cancel').onclick = () => dlg.close();
  $('#dialog-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target).entries());
    $('#dialog-save').disabled = true;
    try { await onSave(data); dlg.close(); route(); } catch (e) { $('#dialog-error').textContent = e.message; }
    finally { $('#dialog-save').disabled = false; }
  };
  dlg.showModal();
}

// Shared lookups for form dropdowns, refreshed on each page load.
let people = [];
let menuItems = [];
async function loadLookups() {
  [people, menuItems] = await Promise.all([api('/people'), api('/menu').then((m) => m.items)]);
  let dl = $('#menu-list');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'menu-list'; document.body.append(dl); }
  dl.innerHTML = menuItems.map((m) => `<option value="${esc(m.item)}">`).join('');
  let pl = $('#people-list');
  if (!pl) { pl = document.createElement('datalist'); pl.id = 'people-list'; document.body.append(pl); }
  pl.innerHTML = people.map((p) => `<option value="${esc(p.name)}">`).join('');
}
const personOptions = () => [{ value: '', label: '— Nobody yet —' }, ...people.map((p) => ({ value: p.jid, label: p.name }))];

// ---------- record forms ----------

const saleFields = [
  { name: 'item', label: 'Item', required: true, list: 'menu-list', placeholder: 'e.g. Chicken biryani' },
  { name: 'qty', label: 'Quantity', type: 'number', default: 1, half: true },
  { name: 'unit_price', label: 'Price each (₹)', type: 'number', placeholder: 'from menu', half: true },
  { name: 'total', label: 'Total (₹)', type: 'number', placeholder: 'auto', half: true },
  { name: 'date', label: 'Date', type: 'date', half: true },
  { name: 'channel', label: 'Channel', placeholder: 'Swiggy, Zomato, direct…', half: true },
  { name: 'customer', label: 'Customer', half: true },
  { name: 'handled_by', label: 'Handled by', list: 'people-list' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

function editSale(sale) {
  openForm({
    title: sale ? 'Edit sale' : 'Add sale',
    fields: saleFields,
    values: sale ?? { date: todayStr() },
    onSave: (d) => api(sale ? `/sales/${sale.id}` : '/sales', { method: sale ? 'PUT' : 'POST', body: d }).then(() => toast('Saved')),
    onDelete: sale && (() => api(`/sales/${sale.id}`, { method: 'DELETE' })),
  });
}

const expenseFields = [
  { name: 'item', label: 'What was bought / paid for', required: true, placeholder: 'e.g. Chicken 10kg' },
  { name: 'amount', label: 'Amount (₹)', type: 'number', required: true, half: true },
  { name: 'date', label: 'Date', type: 'date', half: true },
  { name: 'vendor', label: 'Vendor', half: true },
  { name: 'paid_by', label: 'Paid by', list: 'people-list', half: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

function editExpense(exp) {
  openForm({
    title: exp ? 'Edit expense' : 'Add expense',
    fields: expenseFields,
    values: exp ?? { date: todayStr() },
    onSave: (d) => api(exp ? `/expenses/${exp.id}` : '/expenses', { method: exp ? 'PUT' : 'POST', body: d }).then(() => toast('Saved')),
    onDelete: exp && (() => api(`/expenses/${exp.id}`, { method: 'DELETE' })),
  });
}

function editOpen(item) {
  const fields = [
    { name: 'title', label: 'What needs to happen', required: true },
    { name: 'details', label: 'Details', type: 'textarea' },
    { name: 'owner_jid', label: 'Who should close it', type: 'select', options: personOptions() },
  ];
  if (item) fields.push({ name: 'status', label: 'Status', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] });
  openForm({
    title: item ? 'Edit open item' : 'Add open item',
    fields,
    values: item ?? {},
    onSave: (d) => api(item ? `/open/${item.id}` : '/open', { method: item ? 'PUT' : 'POST', body: d }).then(() => toast('Saved')),
    onDelete: item && (() => api(`/open/${item.id}`, { method: 'DELETE' })),
  });
}

function editMenuItem(m) {
  openForm({
    title: m ? `Change price: ${m.item}` : 'Add menu item',
    fields: [
      { name: 'item', label: 'Item', required: true },
      { name: 'price', label: 'Price (₹)', type: 'number', required: true },
      { name: 'note', label: 'Reason (optional)', placeholder: 'e.g. chicken cost went up' },
    ],
    values: m ?? {},
    onSave: (d) => api('/menu', { method: 'PUT', body: { ...d, previous_item: m?.item } }).then(() => toast('Price saved')),
    onDelete: m && (() => api(`/menu/${encodeURIComponent(m.item)}`, { method: 'DELETE' })),
  });
}

// ---------- shared renderers ----------

function saleRow(s) {
  const meta = [s.channel, s.customer, s.handled_by && `by ${s.handled_by}`].filter(Boolean).join(' · ');
  return `<li class="clickable" data-sale="${s.id}">
    <div class="main"><div class="title">${esc(s.item)} <span class="muted">× ${qtyLabel(s.qty)}</span></div>
    <div class="meta">${esc(meta) || '&nbsp;'} ${s.source === 'bot' ? '<span class="badge bot">from chat</span>' : ''}</div></div>
    <div class="amount">${rupees(s.total)}</div></li>`;
}

function expenseRow(e) {
  const meta = [e.vendor, e.paid_by && `paid by ${e.paid_by}`].filter(Boolean).join(' · ');
  return `<li class="clickable" data-expense="${e.id}">
    <div class="main"><div class="title">${esc(e.item)}</div>
    <div class="meta">${esc(meta) || '&nbsp;'} ${e.source === 'bot' ? '<span class="badge bot">from chat</span>' : ''}</div></div>
    <div class="amount">${rupees(e.amount)}</div></li>`;
}

function openRow(o) {
  const stale = Date.now() - o.raised_at > 2 * 86400000;
  const owner = o.owner_name ? esc(o.owner_name) : '<span class="badge warn">no owner</span>';
  if (o.status === 'done') {
    return `<li class="clickable" data-open="${o.id}"><div class="main"><div class="title">${esc(o.title)}</div>
      <div class="meta">${owner} · closed ${ago(o.closed_at)}${o.closed_note ? ' · ' + esc(o.closed_note) : ''}</div></div>
      <span class="badge good">Done</span></li>`;
  }
  return `<li data-open-row="${o.id}"><div class="main clickable" data-open="${o.id}"><div class="title">${esc(o.title)}</div>
    <div class="meta">${owner} · raised ${ago(o.raised_at)} ${stale ? '<span class="badge warn">overdue</span>' : ''}
    ${o.last_reminded_at ? `· reminded ${ago(o.last_reminded_at)}` : ''}</div>
    ${o.details ? `<div class="meta">${esc(o.details)}</div>` : ''}</div>
    <div class="row" style="flex-wrap:nowrap">
      <button class="btn small" data-remind="${o.id}" title="Tag them in the WhatsApp group">Remind</button>
      <button class="btn small" data-done="${o.id}">Done</button>
    </div></li>`;
}

function bindRows(container, { sales = [], expenses = [], open = [] }) {
  container.querySelectorAll('[data-sale]').forEach((el) => el.onclick = () => editSale(sales.find((s) => s.id == el.dataset.sale)));
  container.querySelectorAll('[data-expense]').forEach((el) => el.onclick = () => editExpense(expenses.find((s) => s.id == el.dataset.expense)));
  container.querySelectorAll('[data-open]').forEach((el) => el.onclick = () => editOpen(open.find((s) => s.id == el.dataset.open)));
  container.querySelectorAll('[data-done]').forEach((el) => el.onclick = async () => {
    await api(`/open/${el.dataset.done}`, { method: 'PUT', body: { status: 'done' } });
    toast('Marked done');
    route();
  });
  container.querySelectorAll('[data-remind]').forEach((el) => el.onclick = async () => {
    el.disabled = true;
    try { await api(`/open/${el.dataset.remind}/remind`, { method: 'POST' }); toast('Reminder sent to the group'); route(); }
    catch (e) { toast(e.message); el.disabled = false; }
  });
}

const listCard = (rows, emptyText) => `<div class="card">${rows.length ? `<ul class="list">${rows.join('')}</ul>` : `<div class="empty">${emptyText}</div>`}</div>`;

// ---------- pages ----------

let todayDate = null;

async function pageToday() {
  const date = todayDate || todayStr();
  setHeader('Today', `<button class="btn small" id="add-sale">+ Sale</button>`);
  const [d, status] = await Promise.all([api(`/today?date=${date}`), api('/status')]);
  const diff = d.salesTotal - d.yesterdayTotal;
  const pending = status.messages.pending;
  view.innerHTML = `
    <div class="filters">
      <button class="btn small" id="prev-day">‹</button>
      <strong style="align-self:center;min-width:110px;text-align:center">${dayLabel(d.date)}</strong>
      <button class="btn small" id="next-day" ${d.date >= todayStr() ? 'disabled' : ''}>›</button>
      <span class="spacer"></span>
      <a class="btn small" href="#/whatsapp">Recap</a>
    </div>
    ${!status.claudeConfigured || status.whatsapp.status !== 'connected' || pending ? `<div class="card pad" style="margin-bottom:12px">
      ${pending ? `<div>⏳ Reading ${pending} new message${pending > 1 ? 's' : ''} from the chat…</div>` : ''}
      ${status.whatsapp.status !== 'connected' ? `<div>WhatsApp bot is not connected. <a href="#/whatsapp">Connect it</a> or <a href="#/import">import a chat export</a>.</div>` : ''}
      ${!status.claudeConfigured ? '<div class="muted">Reading the chat needs ANTHROPIC_API_KEY on the server. Manual entry works meanwhile.</div>' : ''}
    </div>` : ''}
    <div class="stats">
      <div class="card stat"><div class="label">Sales</div><div class="value">${rupees(d.salesTotal)}</div>
        <div class="sub">${d.sales.length} line${d.sales.length === 1 ? '' : 's'} · <span title="vs previous day">${diff >= 0 ? '▲' : '▼'} ${rupees(Math.abs(diff))}</span></div></div>
      <div class="card stat"><div class="label">Expenses</div><div class="value">${rupees(d.expensesTotal)}</div>
        <div class="sub">${d.expenses.length} entr${d.expenses.length === 1 ? 'y' : 'ies'}</div></div>
      <div class="card stat"><div class="label">Open items</div><div class="value">${d.open.length}</div>
        <div class="sub">${d.open.filter((o) => Date.now() - o.raised_at > 2 * 86400000).length} overdue</div></div>
    </div>

    <div class="section"><h2>Open items</h2><a href="#/open">All</a></div>
    <div id="open-box">${listCard(d.open.slice(0, 5).map(openRow), 'Nothing open. 👍')}</div>

    ${d.prices.length ? `<div class="section"><h2>Price changes</h2></div>
      ${listCard(d.prices.map((p) => `<li><div class="main"><div class="title">${esc(p.item)}</div>
        <div class="meta">${p.decided_by ? 'by ' + esc(p.decided_by) : ''} ${esc(p.note)}</div></div>
        <div class="amount">${p.old_price != null ? `<span class="muted">${rupees(p.old_price)} →</span> ` : ''}${rupees(p.new_price)}</div></li>`), '')}` : ''}

    <div class="section"><h2>Sales</h2><button class="btn small" id="add-sale-2">+ Add</button></div>
    <div id="sales-box">${listCard(d.sales.map(saleRow), 'No sales recorded yet.')}</div>

    <div class="section"><h2>Expenses</h2><button class="btn small" id="add-exp">+ Add</button></div>
    <div id="exp-box">${listCard(d.expenses.map(expenseRow), 'No expenses recorded.')}</div>`;
  bindRows(view, d);
  $('#prev-day').onclick = () => { todayDate = addDays(d.date, -1); route(); };
  $('#next-day').onclick = () => { todayDate = addDays(d.date, 1); route(); };
  $('#add-sale').onclick = $('#add-sale-2').onclick = () => editSale(null);
  $('#add-exp').onclick = () => editExpense(null);
}

let rangeChoice = '7';
function rangeFilter(onChange) {
  const opts = [['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
  return {
    html: `<div class="seg" id="range">${opts.map(([v, l]) => `<button data-v="${v}" class="${rangeChoice === v ? 'on' : ''}">${l}</button>`).join('')}</div>`,
    bind() { view.querySelectorAll('#range button').forEach((b) => b.onclick = () => { rangeChoice = b.dataset.v; onChange(); }); },
    query() { const to = todayStr(); return `from=${addDays(to, -(Number(rangeChoice) - 1))}&to=${to}`; },
  };
}

function groupByDate(rows, amountKey) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.date)) groups.set(r.date, []);
    groups.get(r.date).push(r);
  }
  return [...groups].map(([date, items]) => ({ date, items, total: items.reduce((s, r) => s + r[amountKey], 0) }));
}

async function pageSales() {
  setHeader('Sales', `<button class="btn small primary" id="add">+ Sale</button>`);
  const rf = rangeFilter(route);
  const sales = await api(`/sales?${rf.query()}`);
  const total = sales.reduce((s, r) => s + r.total, 0);
  view.innerHTML = `<div class="filters">${rf.html}</div>
    <div class="card stat" style="margin-bottom:8px"><div class="label">Total</div><div class="value">${rupees(total)}</div>
      <div class="sub">${sales.length} item lines</div></div>
    ${sales.length ? groupByDate(sales, 'total').map((g) => `<div class="section"><h2>${dayLabel(g.date)}</h2><span class="num">${rupees(g.total)}</span></div>
      ${listCard(g.items.map(saleRow), '')}`).join('') : listCard([], 'No sales in this period.')}`;
  rf.bind();
  bindRows(view, { sales });
  $('#add').onclick = () => editSale(null);
}

async function pageExpenses() {
  setHeader('Expenses', `<button class="btn small primary" id="add">+ Expense</button>`);
  const rf = rangeFilter(route);
  const expenses = await api(`/expenses?${rf.query()}`);
  const total = expenses.reduce((s, r) => s + r.amount, 0);
  view.innerHTML = `<div class="filters">${rf.html}</div>
    <div class="card stat" style="margin-bottom:8px"><div class="label">Total spent</div><div class="value">${rupees(total)}</div></div>
    ${expenses.length ? groupByDate(expenses, 'amount').map((g) => `<div class="section"><h2>${dayLabel(g.date)}</h2><span class="num">${rupees(g.total)}</span></div>
      ${listCard(g.items.map(expenseRow), '')}`).join('') : listCard([], 'No expenses in this period.')}`;
  rf.bind();
  bindRows(view, { expenses });
  $('#add').onclick = () => editExpense(null);
}

let openTab = 'open';
async function pageOpen() {
  setHeader('Open items', `<button class="btn small primary" id="add">+ Add</button>`);
  const items = await api(`/open?status=${openTab}`);
  const byOwner = new Map();
  for (const o of items) byOwner.set(o.owner_name || 'No owner', (byOwner.get(o.owner_name || 'No owner') || 0) + 1);
  view.innerHTML = `<div class="filters">
      <div class="seg" id="tab"><button data-v="open" class="${openTab === 'open' ? 'on' : ''}">Open</button><button data-v="done" class="${openTab === 'done' ? 'on' : ''}">Done</button></div>
    </div>
    ${openTab === 'open' && items.length ? `<div class="row" style="margin-bottom:12px">${[...byOwner].map(([n, c]) => `<span class="badge">${esc(n)}: ${c}</span>`).join('')}</div>` : ''}
    ${listCard(items.map(openRow), openTab === 'open' ? 'Nothing open. 👍' : 'Nothing closed yet.')}
    <p class="muted" style="font-size:13px">Items are picked up from the chat automatically. When someone replies in the group that it's done, it closes on its own. <b>Remind</b> tags the owner in the WhatsApp group.</p>`;
  view.querySelectorAll('#tab button').forEach((b) => b.onclick = () => { openTab = b.dataset.v; route(); });
  bindRows(view, { open: items });
  $('#add').onclick = () => editOpen(null);
}

async function pageMenu() {
  setHeader('Menu & prices', `<button class="btn small primary" id="add">+ Item</button>`);
  const { items, history } = await api('/menu');
  view.innerHTML = `
    ${listCard(items.map((m) => `<li class="clickable" data-item="${esc(m.item)}"><div class="main"><div class="title">${esc(m.item)}</div>
      <div class="meta">updated ${ago(m.updated_at)}${m.updated_by ? ' by ' + esc(m.updated_by) : ''}</div></div>
      <div class="amount">${rupees(m.price)}</div></li>`), 'No menu items yet. They are added when prices are agreed in the chat, or add them here.')}
    <div class="section"><h2>Price history</h2></div>
    ${listCard(history.map((h) => `<li><div class="main"><div class="title">${esc(h.item)}</div>
      <div class="meta">${new Date(h.ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}${h.decided_by ? ' · ' + esc(h.decided_by) : ''}${h.note ? ' · ' + esc(h.note) : ''}</div></div>
      <div class="amount">${h.old_price != null ? `<span class="muted">${rupees(h.old_price)} →</span> ` : ''}${rupees(h.new_price)}</div></li>`), 'No price changes yet.')}`;
  view.querySelectorAll('[data-item]').forEach((el) => el.onclick = () => editMenuItem(items.find((m) => m.item === el.dataset.item)));
  $('#add').onclick = () => editMenuItem(null);
}

async function pageMore() {
  setHeader('More');
  const links = [
    ['#/expenses', 'Expenses', 'Purchases and payments'],
    ['#/reports', 'Reports', 'Sales trends and top items'],
    ['#/whatsapp', 'WhatsApp bot', 'Connect, group, daily recap'],
    ['#/import', 'Import chat', 'Load an exported chat'],
    ['#/people', 'People', 'Names and phone numbers'],
    ['#/chat', 'Chat log', 'Messages the bot has read'],
  ];
  view.innerHTML = `<div class="more-grid">${links.map(([h, t, s]) => `<a class="card" href="${h}"><strong>${t}</strong><span>${s}</span></a>`).join('')}</div>
    <div style="margin-top:24px"><button class="btn" id="logout">Log out</button></div>`;
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };
}

// Daily sales bar chart (single series, so no legend; the section title names it).
function salesChart(days) {
  // Drawn at the real pixel width so text isn't stretched.
  const W = Math.max(Math.min(view.clientWidth, 860) - 50, 260), H = 220, padL = 40, padB = 22, padT = 8;
  const max = Math.max(...days.map((d) => d.sales), 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL) / days.length;
  const barW = Math.max(Math.min(bw - 2, 28), 2);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const labelEvery = Math.ceil(days.length / 8);
  let svg = '';
  for (let v = 0; v <= top; v += step) {
    svg += `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis-label" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? (v / 1000).toLocaleString('en-IN') + 'k' : v}</text>`;
  }
  days.forEach((d, i) => {
    const x = padL + i * bw + (bw - barW) / 2;
    const h = Math.max(y(0) - y(d.sales), d.sales > 0 ? 2 : 0);
    const r = Math.min(4, barW / 2, h);
    // Rounded top, square base anchored on the baseline.
    const path = h > 0 ? `M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z` : '';
    svg += `<rect class="bar-hit" data-i="${i}" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}"/>`;
    if (path) svg += `<path class="bar" data-bar="${i}" d="${path}"/>`;
    if (i % labelEvery === 0) svg += `<text class="axis-label" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${Number(d.date.slice(8))}/${Number(d.date.slice(5, 7))}</text>`;
  });
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Daily sales">${svg}</svg><div class="tooltip" hidden></div></div>`;
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || p * 10;
}
function bindChart(container, days) {
  const wrap = container.querySelector('.chart-wrap');
  if (!wrap) return;
  const tip = wrap.querySelector('.tooltip');
  wrap.querySelectorAll('.bar-hit').forEach((hit) => {
    const show = () => {
      const d = days[hit.dataset.i];
      wrap.querySelectorAll('.bar.hl').forEach((b) => b.classList.remove('hl'));
      wrap.querySelector(`[data-bar="${hit.dataset.i}"]`)?.classList.add('hl');
      const box = hit.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
      tip.innerHTML = `<strong>${rupees(d.sales)}</strong>${prettyDate(d.date)} · ${d.lines} lines`;
      const bar = wrap.querySelector(`[data-bar="${hit.dataset.i}"]`);
      const barTop = bar ? bar.getBoundingClientRect().top - wb.top : box.bottom - wb.top;
      tip.style.left = Math.min(Math.max(box.left - wb.left + box.width / 2, 70), wb.width - 70) + 'px';
      tip.style.top = Math.max(barTop - 6, 52) + 'px';
      tip.hidden = false;
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('click', show);
  });
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; wrap.querySelectorAll('.bar.hl').forEach((b) => b.classList.remove('hl')); });
}

async function pageReports() {
  setHeader('Reports');
  const rf = rangeFilter(route);
  if (rangeChoice === '1') rangeChoice = '7';
  const r = await api(`/reports?${rf.query()}`);
  const sales = r.days.reduce((s, d) => s + d.sales, 0);
  const exp = r.days.reduce((s, d) => s + d.expenses, 0);
  const activeDays = r.days.filter((d) => d.sales > 0).length;
  const table = (rows, cols) => `<div class="card scroll-x"><table class="data"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${cols.map((c) => `<td class="${c.r ? 'r' : ''}">${c.fmt ? c.fmt(row[c.key]) : esc(row[c.key])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">No data</td></tr>`}</tbody></table></div>`;
  view.innerHTML = `<div class="filters">${rf.html.replace('<button data-v="1"', '<button hidden data-v="1"')}</div>
    <div class="stats">
      <div class="card stat"><div class="label">Sales</div><div class="value">${rupees(sales)}</div><div class="sub">avg ${rupees(activeDays ? sales / activeDays : 0)} per selling day</div></div>
      <div class="card stat"><div class="label">Expenses</div><div class="value">${rupees(exp)}</div></div>
      <div class="card stat"><div class="label">Sales minus expenses</div><div class="value">${rupees(sales - exp)}</div></div>
    </div>
    <div class="section"><h2>Daily sales</h2><button class="btn small" id="toggle-table">Show table</button></div>
    <div class="card" id="chart-box">${salesChart(r.days)}</div>
    <div id="day-table" hidden>${table([...r.days].reverse(), [
      { key: 'date', label: 'Date', fmt: (v) => prettyDate(v) },
      { key: 'sales', label: 'Sales', r: 1, fmt: rupees },
      { key: 'expenses', label: 'Expenses', r: 1, fmt: rupees },
    ])}</div>
    <div class="section"><h2>Top items</h2></div>
    ${table(r.topItems, [{ key: 'item', label: 'Item' }, { key: 'qty', label: 'Qty', r: 1, fmt: qtyLabel }, { key: 'total', label: 'Sales', r: 1, fmt: rupees }])}
    <div class="section"><h2>By channel</h2></div>
    ${table(r.byChannel, [{ key: 'channel', label: 'Channel' }, { key: 'lines', label: 'Lines', r: 1 }, { key: 'total', label: 'Sales', r: 1, fmt: rupees }])}
    <div class="section"><h2>Biggest expenses</h2></div>
    ${table(r.expenseItems, [{ key: 'item', label: 'Item' }, { key: 'total', label: 'Spent', r: 1, fmt: rupees }])}`;
  rf.bind();
  bindChart(view, r.days);
  $('#toggle-table').onclick = (e) => {
    const t = $('#day-table');
    t.hidden = !t.hidden;
    e.target.textContent = t.hidden ? 'Show table' : 'Hide table';
  };
}

let waPoll;
async function pageWhatsApp() {
  setHeader('WhatsApp bot');
  const [s, recap] = await Promise.all([api('/status'), api('/recap')]);
  const wa = s.whatsapp;
  const labels = {
    connected: ['on', 'Connected'], waiting_for_scan: ['wait', 'Waiting for QR scan'], connecting: ['wait', 'Connecting…'],
    reconnecting: ['wait', 'Reconnecting…'], disconnected: ['', 'Not connected'], logged_out: ['', 'Logged out'],
  };
  const [dot, label] = labels[wa.status] || ['', wa.status];
  view.innerHTML = `
    <div class="card pad">
      <div class="row"><span class="status-dot ${dot}"></span><strong>${label}</strong>
        <span class="spacer"></span>
        ${wa.status === 'connected' ? '<button class="btn small danger" id="wa-logout">Unlink</button>' : '<button class="btn small primary" id="wa-connect">Connect</button>'}</div>
      ${wa.error ? `<p class="error">${esc(wa.error)}</p>` : ''}
      ${wa.qr ? `<p>On the <b>spare phone</b>: WhatsApp → Settings → Linked devices → Link a device, then scan:</p><img class="qr" src="${wa.qr}" alt="WhatsApp QR code">` : ''}
      ${wa.status !== 'connected' && !wa.qr ? '<p class="muted" style="margin-bottom:0">Use a spare SIM, not your main business number. Unofficial WhatsApp bots can get the number banned.</p>' : ''}
    </div>

    <div class="section"><h2>Group to follow</h2></div>
    <div class="card pad">
      <div>${wa.groupName ? `Following <b>${esc(wa.groupName)}</b>` : '<span class="muted">No group picked yet.</span>'}</div>
      ${wa.status === 'connected' ? '<div style="margin-top:10px"><button class="btn small" id="pick-group">Choose group</button></div><div id="groups"></div>' : ''}
    </div>

    <div class="section"><h2>Daily recap</h2></div>
    <div class="card pad form">
      <div class="grid2">
        <label>Post at<input type="time" id="recap-time" value="${esc(s.recapTime)}"></label>
        <label>Automatic<select id="auto-recap"><option value="1" ${s.autoRecap ? 'selected' : ''}>On</option><option value="0" ${!s.autoRecap ? 'selected' : ''}>Off</option></select></label>
      </div>
      <div class="muted" style="font-size:13px">Time zone ${esc(s.timeZone)}. ${s.lastRecapDate ? `Last posted ${prettyDate(s.lastRecapDate)}.` : ''}</div>
      <div class="row"><button class="btn small" id="save-recap">Save</button><span class="spacer"></span>
        <button class="btn small" id="copy-recap">Copy text</button>
        <button class="btn small primary" id="send-recap" ${wa.status === 'connected' && wa.groupJid ? '' : 'disabled'}>Post now</button></div>
      <div><div class="muted" style="font-size:13px;margin-bottom:6px">Preview of today's recap</div><pre class="recap">${esc(recap.text)}</pre></div>
    </div>`;

  $('#wa-connect')?.addEventListener('click', async () => { await api('/whatsapp/connect', { method: 'POST' }); setTimeout(route, 1500); });
  $('#wa-logout')?.addEventListener('click', async () => { if (confirm('Unlink the bot from WhatsApp?')) { await api('/whatsapp/logout', { method: 'POST' }); route(); } });
  $('#pick-group')?.addEventListener('click', async () => {
    const groups = await api('/whatsapp/groups');
    $('#groups').innerHTML = `<ul class="list" style="margin-top:8px">${groups.map((g) => `<li class="clickable" data-g="${esc(g.id)}"><div class="main"><div class="title">${esc(g.name)}</div><div class="meta">${g.size} members</div></div></li>`).join('') || '<li class="muted">The bot is not in any group yet. Add its number to your group first.</li>'}</ul>`;
    $('#groups').querySelectorAll('[data-g]').forEach((el) => el.onclick = async () => {
      const g = groups.find((x) => x.id === el.dataset.g);
      await api('/whatsapp/group', { method: 'POST', body: g });
      toast(`Following ${g.name}`);
      route();
    });
  });
  $('#save-recap').onclick = async () => {
    try { await api('/settings', { method: 'PUT', body: { recapTime: $('#recap-time').value, autoRecap: $('#auto-recap').value === '1' } }); toast('Saved'); }
    catch (e) { toast(e.message); }
  };
  $('#copy-recap').onclick = async () => { await navigator.clipboard.writeText(recap.text); toast('Copied. Paste it in the group.'); };
  $('#send-recap').onclick = async (e) => {
    e.target.disabled = true;
    try { await api('/recap/send', { method: 'POST' }); toast('Recap posted'); } catch (err) { toast(err.message); }
    e.target.disabled = false;
  };
  // While waiting for a QR scan, refresh so the page updates once linked.
  if (['waiting_for_scan', 'connecting', 'reconnecting'].includes(wa.status)) waPoll = setTimeout(() => location.hash === '#/whatsapp' && route(), 4000);
}

let importPoll;
async function pageImport() {
  setHeader('Import chat');
  const s = await api('/status');
  const last = s.lastExtraction;
  view.innerHTML = `
    <div class="card pad form">
      <div>Load an exported WhatsApp chat to pick up past sales, prices and open items.</div>
      <ol class="muted" style="margin:0;padding-left:20px;font-size:14px">
        <li>Open the group in WhatsApp → ⋮ → More → <b>Export chat</b> → <b>Without media</b>.</li>
        <li>Save the .txt file (or the .zip; unzip it first) and choose it below.</li>
      </ol>
      <input type="file" id="file" accept=".txt,text/plain">
      <div><button class="btn primary" id="upload">Import</button></div>
      <p class="muted" style="font-size:13px;margin:0">Importing the same chat again is safe: messages already loaded are skipped.</p>
    </div>
    <div class="section"><h2>Processing</h2></div>
    <div class="card pad form">
      <div><b>${s.messages.total}</b> messages loaded · <b>${s.messages.pending}</b> waiting to be read${s.messages.failed ? ` · <span class="error">${s.messages.failed} could not be read</span>` : ''}</div>
      ${last ? `<div class="muted" style="font-size:13px">Last run ${ago(last.at)}: ${last.sales} sales, ${last.expenses} expenses, ${last.price_changes} price changes, ${last.opened} items opened, ${last.closed} closed${last.error ? `<br><span class="error">${esc(last.error)}</span>` : ''}</div>` : ''}
      ${!s.claudeConfigured ? '<div class="error">ANTHROPIC_API_KEY is not set on the server, so messages cannot be read yet.</div>' : ''}
      <div class="row">
        <button class="btn small" id="run" ${s.messages.pending ? '' : 'disabled'}>Read pending now</button>
        <button class="btn small danger" id="reprocess" ${s.messages.total ? '' : 'disabled'}>Re-read everything</button>
      </div>
    </div>`;
  $('#upload').onclick = async () => {
    const file = $('#file').files[0];
    if (!file) return toast('Choose the exported .txt file first');
    $('#upload').disabled = true;
    try {
      const r = await api('/import', { method: 'POST', raw: await file.text() });
      toast(`Imported ${r.added} new messages (${r.parsed - r.added} already loaded)`);
      route();
    } catch (e) { toast(e.message); $('#upload').disabled = false; }
  };
  $('#run').onclick = async () => { await api('/extract', { method: 'POST' }); toast('Reading messages…'); setTimeout(route, 1500); };
  $('#reprocess').onclick = async () => {
    if (!confirm('This deletes everything the bot picked up from the chat (sales, expenses, open items) and reads the whole chat again. Entries you added by hand stay. Continue?')) return;
    await api('/reprocess', { method: 'POST' });
    toast('Re-reading the chat…');
    route();
  };
  if (s.messages.pending && s.claudeConfigured) importPoll = setTimeout(() => location.hash === '#/import' && route(), 5000);
}

async function pagePeople() {
  setHeader('People');
  const list = await api('/people');
  view.innerHTML = `<p class="muted" style="margin-top:0;font-size:14px">Everyone who has written in the group. Add a phone number (with country code, e.g. 919876543210) for people from an imported chat so the bot can tag them.</p>
    ${listCard(list.map((p) => `<li class="clickable" data-p="${esc(p.jid)}"><div class="main"><div class="title">${esc(p.name)}</div>
      <div class="meta">${p.phone ? '+' + esc(p.phone) : p.jid.startsWith('name:') ? '<span class="badge warn">no number, can\'t be tagged</span>' : 'WhatsApp linked'} · ${p.message_count} messages</div></div></li>`), 'Nobody yet. Import a chat or connect the bot.')}`;
  view.querySelectorAll('[data-p]').forEach((el) => el.onclick = () => {
    const p = list.find((x) => x.jid === el.dataset.p);
    openForm({
      title: 'Edit person',
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'WhatsApp number (with country code)', type: 'tel', placeholder: '919876543210' }],
      values: p,
      onSave: (d) => api(`/people/${encodeURIComponent(p.jid)}`, { method: 'PUT', body: d }).then(() => toast('Saved')),
    });
  });
}

let chatDate = null;
async function pageChat() {
  const date = chatDate || todayStr();
  setHeader('Chat log');
  const msgs = await api(`/messages?date=${date}`);
  const state = { 0: '<span class="badge warn">pending</span>', 2: '<span class="badge warn">not read</span>' };
  view.innerHTML = `<div class="filters"><input type="date" id="chat-date" value="${date}"></div>
    ${listCard(msgs.map((m) => `<li><div class="main chat"><span class="muted num">${m.time}</span> <span class="who">${esc(m.sender_name)}:</span> ${esc(m.text).replace(/\n/g, '<br>')} ${state[m.processed] || ''}</div></li>`), 'No messages on this day.')}`;
  $('#chat-date').onchange = (e) => { chatDate = e.target.value; route(); };
}

// ---------- routing & login ----------

const routes = {
  today: pageToday, sales: pageSales, expenses: pageExpenses, open: pageOpen, menu: pageMenu, more: pageMore,
  reports: pageReports, whatsapp: pageWhatsApp, import: pageImport, people: pagePeople, chat: pageChat,
};
const tabFor = { expenses: 'more', reports: 'more', whatsapp: 'more', import: 'more', people: 'more', chat: 'more' };

async function route() {
  clearTimeout(waPoll);
  clearTimeout(importPoll);
  const name = (location.hash.replace(/^#\//, '') || 'today').split('?')[0];
  const page = routes[name] || pageToday;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tabFor[name] || name)));
  try {
    await loadLookups();
    await page();
  } catch (e) {
    if (e.message !== 'Please log in') view.innerHTML = `<div class="card pad error">${esc(e.message)}</div>`;
  }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    $('#login').hidden = true;
    $('#app').hidden = false;
    route();
  } catch (err) { $('#login-error').textContent = err.message; }
};

window.addEventListener('hashchange', route);
(async () => {
  try {
    await api('/status');
    $('#app').hidden = false;
    route();
  } catch { showLogin(); }
})();
