import { db } from './db.js';
import { localDate } from './time.js';

const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

/** The WhatsApp id to @mention for a person, or null if we don't know their number. */
export function mentionJid(jid) {
  if (!jid) return null;
  if (jid.startsWith('name:')) {
    const person = db.prepare('SELECT phone FROM people WHERE jid = ?').get(jid);
    const digits = person?.phone?.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
  }
  return jid;
}

// WhatsApp renders "@<id>" as a tag when the id is also passed in `mentions`.
function tag(jid, name, mentions) {
  const m = mentionJid(jid);
  if (!m) return name || 'someone';
  mentions.add(m);
  return '@' + m.split('@')[0];
}

/** Build the end-of-day recap for a date. Returns { text, mentions }. */
export function buildRecap(date = localDate()) {
  const mentions = new Set();
  const sales = db.prepare('SELECT item, SUM(qty) qty, SUM(total) total FROM sales WHERE date = ? GROUP BY item ORDER BY total DESC').all(date);
  const salesTotal = sales.reduce((s, r) => s + r.total, 0);
  const orders = db.prepare('SELECT COUNT(*) n FROM sales WHERE date = ?').get(date).n;
  const expenses = db.prepare('SELECT COALESCE(SUM(amount), 0) total FROM expenses WHERE date = ?').get(date).total;
  const prices = db.prepare('SELECT item, old_price, new_price, decided_by, ts FROM price_history ORDER BY ts').all()
    .filter((p) => localDate(p.ts) === date);
  const closed = db.prepare("SELECT title, owner_name, closed_at FROM open_items WHERE status = 'done' AND closed_at IS NOT NULL").all()
    .filter((o) => localDate(o.closed_at) === date);
  const open = db.prepare("SELECT id, title, owner_jid, owner_name, raised_at FROM open_items WHERE status = 'open' ORDER BY raised_at").all();

  const lines = [`*Daily recap — ${formatDate(date)}*`, ''];
  lines.push(`*Sales:* ${rupees(salesTotal)} from ${orders} item line${orders === 1 ? '' : 's'}`);
  for (const s of sales.slice(0, 5)) lines.push(`  • ${s.item} × ${trimNum(s.qty)} = ${rupees(s.total)}`);
  if (sales.length > 5) lines.push(`  • …and ${sales.length - 5} more`);
  lines.push(`*Expenses:* ${rupees(expenses)}`);

  if (prices.length) {
    lines.push('', '*Price changes:*');
    for (const p of prices) {
      lines.push(`  • ${p.item}: ${p.old_price != null ? rupees(p.old_price) + ' → ' : ''}${rupees(p.new_price)}${p.decided_by ? ` (${p.decided_by})` : ''}`);
    }
  }
  if (closed.length) {
    lines.push('', `*Closed today:* ${closed.length}`);
    for (const c of closed) lines.push(`  ✓ ${c.title}`);
  }
  if (open.length) {
    lines.push('', `*Still open (${open.length}):*`);
    for (const o of open) {
      lines.push(`  • ${o.title} — ${tag(o.owner_jid, o.owner_name, mentions)} (since ${ageLabel(o.raised_at)})`);
    }
    lines.push('', 'Reply here once something is done and it will be closed automatically.');
  } else {
    lines.push('', 'No open items. 👍');
  }
  return { text: lines.join('\n'), mentions: [...mentions] };
}

/** A reminder message for one open item. Returns { text, mentions }. */
export function buildReminder(item) {
  const mentions = new Set();
  const who = tag(item.owner_jid, item.owner_name, mentions);
  const text = `${who} reminder: *${item.title}* is still open (raised ${ageLabel(item.raised_at)}).` +
    (item.details ? `\n${item.details}` : '') +
    '\nPlease reply here when it is done.';
  return { text, mentions: [...mentions] };
}

function ageLabel(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function formatDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const trimNum = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
