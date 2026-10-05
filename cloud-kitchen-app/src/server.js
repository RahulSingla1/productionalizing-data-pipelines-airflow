import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, getSetting, setSetting } from './db.js';
import { extractionAvailable, runExtraction, setMenuPrice } from './extractor.js';
import { importExport } from './importer.js';
import { buildRecap, buildReminder } from './recap.js';
import { addDays, localDate, localTime, TIME_ZONE } from './time.js';
import { listGroups, logoutWhatsApp, sendToGroup, startWhatsApp, whatsappState } from './whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  console.error('Set APP_PASSWORD (the shared login password) in .env before starting.');
  process.exit(1);
}
const SESSION_TOKEN = crypto.createHmac('sha256', process.env.SESSION_SECRET || PASSWORD).update('kitchen-session-v1').digest('hex');
const EXTRACT_EVERY_MIN = Number(process.env.EXTRACT_EVERY_MIN || 15);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.text({ limit: '25mb', type: 'text/plain' }));

// ---- Login (one shared password) ----

function readCookie(req, name) {
  const match = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.post('/api/login', async (req, res) => {
  await new Promise((r) => setTimeout(r, 400)); // slow down password guessing
  if (!safeEqual(req.body?.password ?? '', PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `session=${SESSION_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 60}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const token = readCookie(req, 'session');
  if (token && safeEqual(token, SESSION_TOKEN)) return next();
  res.status(401).json({ error: 'Not logged in' });
});

// ---- Helpers ----

const num = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v) => (v == null ? '' : String(v).trim());
const range = (req) => ({
  from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : addDays(localDate(), -6),
  to: /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : localDate(),
});
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
  console.error(err);
  res.status(400).json({ error: err.message });
});

// ---- Dashboard ----

app.get('/api/today', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localDate();
  const sales = db.prepare('SELECT * FROM sales WHERE date = ? ORDER BY id DESC').all(date);
  const expenses = db.prepare('SELECT * FROM expenses WHERE date = ? ORDER BY id DESC').all(date);
  const open = db.prepare("SELECT * FROM open_items WHERE status = 'open' ORDER BY raised_at").all();
  const yesterdayTotal = db.prepare('SELECT COALESCE(SUM(total),0) t FROM sales WHERE date = ?').get(addDays(date, -1)).t;
  const prices = db.prepare('SELECT * FROM price_history ORDER BY ts DESC LIMIT 50').all().filter((p) => localDate(p.ts) === date);
  res.json({
    date,
    salesTotal: sales.reduce((s, r) => s + r.total, 0),
    expensesTotal: expenses.reduce((s, r) => s + r.amount, 0),
    yesterdayTotal,
    sales, expenses, open, prices,
  });
});

// ---- Sales & expenses ----

app.get('/api/sales', (req, res) => {
  const { from, to } = range(req);
  res.json(db.prepare('SELECT * FROM sales WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(from, to));
});

function saleFields(b) {
  const qty = num(b.qty, 1) || 1;
  let unit = num(b.unit_price);
  let total = num(b.total);
  if (!unit && !total) unit = db.prepare('SELECT price FROM menu WHERE item = ?').get(str(b.item))?.price ?? 0;
  if (!total) total = unit * qty;
  if (!unit) unit = total / qty;
  if (!str(b.item)) throw new Error('Item is required');
  return [b.date || localDate(), str(b.item), qty, unit, total, str(b.customer), str(b.channel), str(b.handled_by), str(b.notes)];
}

app.post('/api/sales', wrap((req, res) => {
  const r = db.prepare(
    `INSERT INTO sales (date, item, qty, unit_price, total, customer, channel, handled_by, notes, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'app', ?)`
  ).run(...saleFields(req.body), Date.now());
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/sales/:id', wrap((req, res) => {
  db.prepare(
    `UPDATE sales SET date = ?, item = ?, qty = ?, unit_price = ?, total = ?, customer = ?, channel = ?, handled_by = ?, notes = ? WHERE id = ?`
  ).run(...saleFields(req.body), Number(req.params.id));
  res.json({ ok: true });
}));

app.delete('/api/sales/:id', (req, res) => {
  db.prepare('DELETE FROM sales WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/expenses', (req, res) => {
  const { from, to } = range(req);
  res.json(db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC').all(from, to));
});

function expenseFields(b) {
  if (!str(b.item)) throw new Error('What was bought is required');
  return [b.date || localDate(), str(b.item), num(b.amount), str(b.vendor), str(b.paid_by), str(b.notes)];
}

app.post('/api/expenses', wrap((req, res) => {
  const r = db.prepare(
    `INSERT INTO expenses (date, item, amount, vendor, paid_by, notes, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'app', ?)`
  ).run(...expenseFields(req.body), Date.now());
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/expenses/:id', wrap((req, res) => {
  db.prepare('UPDATE expenses SET date = ?, item = ?, amount = ?, vendor = ?, paid_by = ?, notes = ? WHERE id = ?')
    .run(...expenseFields(req.body), Number(req.params.id));
  res.json({ ok: true });
}));

app.delete('/api/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Menu & prices ----

app.get('/api/menu', (req, res) => {
  res.json({
    items: db.prepare('SELECT * FROM menu ORDER BY item').all(),
    history: db.prepare('SELECT * FROM price_history ORDER BY ts DESC LIMIT 200').all(),
  });
});

app.put('/api/menu', wrap((req, res) => {
  const item = str(req.body.item);
  const price = num(req.body.price, NaN);
  if (!item || Number.isNaN(price)) throw new Error('Item and price are required');
  const previousName = str(req.body.previous_item);
  if (previousName && previousName.toLowerCase() !== item.toLowerCase()) {
    db.prepare('UPDATE menu SET item = ? WHERE item = ?').run(item, previousName);
  }
  setMenuPrice(item, price, 'App', str(req.body.note));
  res.json({ ok: true });
}));

app.delete('/api/menu/:item', (req, res) => {
  db.prepare('DELETE FROM menu WHERE item = ?').run(req.params.item);
  res.json({ ok: true });
});

// ---- Open items ----

app.get('/api/open', (req, res) => {
  const status = req.query.status === 'done' ? 'done' : 'open';
  const order = status === 'open' ? 'raised_at ASC' : 'closed_at DESC';
  res.json(db.prepare(`SELECT * FROM open_items WHERE status = ? ORDER BY ${order} LIMIT 300`).all(status));
});

function ownerFor(jid) {
  const person = jid ? db.prepare('SELECT jid, name FROM people WHERE jid = ?').get(jid) : null;
  return person ?? { jid: null, name: '' };
}

app.post('/api/open', wrap((req, res) => {
  if (!str(req.body.title)) throw new Error('Title is required');
  const owner = ownerFor(req.body.owner_jid);
  const r = db.prepare(
    `INSERT INTO open_items (title, details, owner_jid, owner_name, raised_at, source) VALUES (?, ?, ?, ?, ?, 'app')`
  ).run(str(req.body.title), str(req.body.details), owner.jid, owner.name, Date.now());
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/open/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM open_items WHERE id = ?').get(id);
  if (!item) throw new Error('Not found');
  const b = req.body;
  const owner = b.owner_jid !== undefined ? ownerFor(b.owner_jid) : { jid: item.owner_jid, name: item.owner_name };
  let { status, closed_at: closedAt, closed_note: closedNote } = item;
  if (b.status === 'done' && status !== 'done') { status = 'done'; closedAt = Date.now(); closedNote = str(b.closed_note) || 'Marked done in the app'; }
  if (b.status === 'open' && status !== 'open') { status = 'open'; closedAt = null; closedNote = ''; }
  db.prepare(
    'UPDATE open_items SET title = ?, details = ?, owner_jid = ?, owner_name = ?, status = ?, closed_at = ?, closed_note = ? WHERE id = ?'
  ).run(b.title !== undefined ? str(b.title) : item.title, b.details !== undefined ? str(b.details) : item.details,
    owner.jid, owner.name, status, closedAt, closedNote, id);
  res.json({ ok: true });
}));

app.delete('/api/open/:id', (req, res) => {
  db.prepare('DELETE FROM open_items WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/open/:id/remind', wrap(async (req, res) => {
  const item = db.prepare('SELECT * FROM open_items WHERE id = ?').get(Number(req.params.id));
  if (!item) throw new Error('Not found');
  const { text, mentions } = buildReminder(item);
  await sendToGroup(text, mentions);
  db.prepare('UPDATE open_items SET last_reminded_at = ? WHERE id = ?').run(Date.now(), item.id);
  res.json({ ok: true, text });
}));

// ---- People ----

app.get('/api/people', (req, res) => {
  res.json(db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM messages m WHERE m.sender_jid = p.jid) AS message_count
     FROM people p ORDER BY message_count DESC, name`
  ).all());
});

app.put('/api/people/:jid', wrap((req, res) => {
  const name = str(req.body.name);
  if (!name) throw new Error('Name is required');
  const phone = str(req.body.phone).replace(/\D/g, '') || null;
  db.prepare('UPDATE people SET name = ?, phone = ? WHERE jid = ?').run(name, phone, req.params.jid);
  db.prepare('UPDATE open_items SET owner_name = ? WHERE owner_jid = ?').run(name, req.params.jid);
  res.json({ ok: true });
}));

// ---- Reports ----

app.get('/api/reports', (req, res) => {
  const { from, to } = range(req);
  const salesByDay = db.prepare('SELECT date, SUM(total) total, COUNT(*) lines FROM sales WHERE date BETWEEN ? AND ? GROUP BY date').all(from, to);
  const expByDay = db.prepare('SELECT date, SUM(amount) total FROM expenses WHERE date BETWEEN ? AND ? GROUP BY date').all(from, to);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push({
      date: d,
      sales: salesByDay.find((r) => r.date === d)?.total ?? 0,
      lines: salesByDay.find((r) => r.date === d)?.lines ?? 0,
      expenses: expByDay.find((r) => r.date === d)?.total ?? 0,
    });
    if (days.length > 400) break;
  }
  res.json({
    from, to, days,
    topItems: db.prepare('SELECT item, SUM(qty) qty, SUM(total) total FROM sales WHERE date BETWEEN ? AND ? GROUP BY item COLLATE NOCASE ORDER BY total DESC LIMIT 15').all(from, to),
    byChannel: db.prepare("SELECT CASE WHEN channel = '' THEN 'Not specified' ELSE channel END channel, SUM(total) total, COUNT(*) lines FROM sales WHERE date BETWEEN ? AND ? GROUP BY 1 ORDER BY total DESC").all(from, to),
    expenseItems: db.prepare('SELECT item, SUM(amount) total FROM expenses WHERE date BETWEEN ? AND ? GROUP BY item COLLATE NOCASE ORDER BY total DESC LIMIT 15').all(from, to),
  });
});

// ---- Chat import & processing ----

app.post('/api/import', wrap((req, res) => {
  const raw = typeof req.body === 'string' ? req.body : req.body?.text;
  if (!raw) throw new Error('Upload the exported .txt file');
  const result = importExport(raw);
  if (result.parsed === 0) throw new Error('No messages found. Is this a WhatsApp "Export chat" .txt file?');
  runExtraction().catch((e) => console.error(e));
  res.json({ ...result, extracting: extractionAvailable() });
}));

app.post('/api/extract', (req, res) => {
  runExtraction().catch((e) => console.error(e));
  res.json({ started: extractionAvailable() });
});

app.post('/api/reprocess', wrap((req, res) => {
  // Re-read the chat from scratch: clears everything the bot extracted (manual entries stay).
  db.exec("DELETE FROM sales WHERE source = 'bot'; DELETE FROM expenses WHERE source = 'bot'; DELETE FROM open_items WHERE source = 'bot'; UPDATE messages SET processed = 0;");
  runExtraction().catch((e) => console.error(e));
  res.json({ started: extractionAvailable() });
}));

app.get('/api/messages', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localDate();
  const rows = db.prepare('SELECT * FROM messages WHERE ts BETWEEN ? AND ? ORDER BY ts').all(
    Date.parse(addDays(date, -1) + 'T00:00:00Z'), Date.parse(addDays(date, 1) + 'T23:59:59Z'));
  res.json(rows.filter((m) => localDate(m.ts) === date).map((m) => ({ ...m, time: localTime(m.ts) })));
});

// ---- Status, WhatsApp & recap ----

app.get('/api/status', (req, res) => {
  const counts = db.prepare('SELECT processed, COUNT(*) n FROM messages GROUP BY processed').all();
  const get = (p) => counts.find((c) => c.processed === p)?.n ?? 0;
  res.json({
    whatsapp: whatsappState(),
    claudeConfigured: extractionAvailable(),
    messages: { total: get(0) + get(1) + get(2), pending: get(0), failed: get(2) },
    lastExtraction: JSON.parse(getSetting('last_extraction', 'null')),
    recapTime: getSetting('recap_time', process.env.RECAP_TIME || '22:00'),
    autoRecap: getSetting('auto_recap', '1') === '1',
    lastRecapDate: getSetting('last_recap_date'),
    timeZone: TIME_ZONE,
  });
});

app.post('/api/whatsapp/connect', wrap(async (req, res) => {
  await startWhatsApp();
  res.json(whatsappState());
}));

app.post('/api/whatsapp/logout', wrap(async (req, res) => {
  await logoutWhatsApp();
  res.json(whatsappState());
}));

app.get('/api/whatsapp/groups', wrap(async (req, res) => res.json(await listGroups())));

app.post('/api/whatsapp/group', wrap((req, res) => {
  if (!/@g\.us$/.test(str(req.body.id))) throw new Error('Pick a group');
  setSetting('group_jid', str(req.body.id));
  setSetting('group_name', str(req.body.name));
  res.json(whatsappState());
}));

app.put('/api/settings', wrap((req, res) => {
  if (req.body.recapTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.recapTime)) throw new Error('Recap time must be HH:MM');
    setSetting('recap_time', req.body.recapTime);
  }
  if (req.body.autoRecap !== undefined) setSetting('auto_recap', req.body.autoRecap ? '1' : '0');
  res.json({ ok: true });
}));

app.get('/api/recap', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : localDate();
  res.json(buildRecap(date));
});

app.post('/api/recap/send', wrap(async (req, res) => {
  await runExtraction();
  const { text, mentions } = buildRecap(localDate());
  await sendToGroup(text, mentions);
  res.json({ ok: true });
}));

// ---- Front end ----

app.use(express.static(path.join(here, '..', 'public')));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));

// Bad request bodies and other errors: reply with a short JSON message, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'File is too large' : err.expose ? err.message : 'Something went wrong' });
});

// ---- Scheduler: process new messages regularly, post the recap at the set time ----

const addMinutes = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + mins, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

let minuteCount = 0;
async function tick() {
  minuteCount++;
  try {
    if (minuteCount % EXTRACT_EVERY_MIN === 0) await runExtraction();
    const recapTime = getSetting('recap_time', process.env.RECAP_TIME || '22:00');
    const today = localDate();
    const now = localTime();
    // Post within 30 minutes after the recap time, once a day (so a restart late at night doesn't post).
    if (getSetting('auto_recap', '1') === '1' && now >= recapTime && now <= addMinutes(recapTime, 30)
        && getSetting('last_recap_date') !== today
        && whatsappState().status === 'connected' && whatsappState().groupJid) {
      setSetting('last_recap_date', today);
      await runExtraction();
      const { text, mentions } = buildRecap(today);
      await sendToGroup(text, mentions);
      console.log(`Posted recap for ${today}`);
    }
  } catch (err) {
    console.error('Scheduled job failed:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Kitchen app running on http://localhost:${PORT}`);
  setInterval(tick, 60_000);
  // Reconnect WhatsApp on restart if it was set up before.
  const linked = fs.existsSync(path.join(process.env.DATA_DIR || './data', 'whatsapp-auth', 'creds.json'));
  if (process.env.WHATSAPP !== 'off' && linked) startWhatsApp().catch((e) => console.error(e));
});
