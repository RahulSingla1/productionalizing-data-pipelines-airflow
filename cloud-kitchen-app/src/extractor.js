import Anthropic from '@anthropic-ai/sdk';
import { db, setSetting, transaction } from './db.js';
import { localDate, localTime } from './time.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const MAX_BATCH = 300; // messages per Claude request
const CONTEXT_MESSAGES = 40; // already-processed messages shown for context

const SYSTEM_PROMPT = `You keep the books for a small cloud kitchen in India. The partners run the business in a WhatsApp group: they report orders and sales, agree on menu prices, mention purchases and payments, and ask each other to get things done. Messages are often in Hinglish or mixed Hindi and English, with typos and shorthand. Amounts are in rupees (₹, rs, /-).

You will receive a batch of NEW messages, each labelled like [m12], plus context: the current menu, the list of open items, and some earlier messages that were already processed (context only, never extract from them). Extract only what the NEW messages establish:

sales: each confirmed sale or order that was delivered or paid. One row per item line. Do not record enquiries, quotes, or plans. If the same order is mentioned twice (for example, confirmed and then marked delivered), record it once. qty defaults to 1. Use unit_price and total when stated; leave either as 0 when unknown and the system fills it from the menu. channel is where the order came from if mentioned (Swiggy, Zomato, direct, WhatsApp, phone), else "". ref is the message that reports the sale.

expenses: money the business spent: ingredients, packaging, gas, rent, salaries, vendor payments. amount in rupees. paid_by is the person who paid if mentioned, else "".

price_changes: menu prices the partners agreed on or announced as the selling price (for example "biryani 220 from today" or a final decision after a discussion). Not proposals that were not agreed. Use the item name as it appears on the current menu when it matches.

new_open_items: questions, requests and tasks that need follow-up and were NOT resolved within this batch, such as a vendor quote to get, a customer to call back, a decision someone asked for, a payment to collect. Skip greetings, chit-chat, and things answered later in the same batch. title is a short action phrase (under 10 words); details is one sentence of context. owner is the person responsible: if someone was asked or assigned (by name or @mention), that person's name from the people list; otherwise "" (the person who raised it).

closed_items: open items from the open-items list (by id) that a NEW message resolves: the task was done, the question was answered, or the partners dropped it. note says briefly how it was closed.

Be conservative. When a message is ambiguous, leave it out rather than guess. Return empty arrays when nothing applies.`;

const str = { type: 'string' };
const num = { type: 'number' };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const OUTPUT_SCHEMA = obj({
  sales: { type: 'array', items: obj({ ref: str, item: str, qty: num, unit_price: num, total: num, customer: str, channel: str, notes: str }) },
  expenses: { type: 'array', items: obj({ ref: str, item: str, amount: num, vendor: str, paid_by: str, notes: str }) },
  price_changes: { type: 'array', items: obj({ ref: str, item: str, new_price: num, note: str }) },
  new_open_items: { type: 'array', items: obj({ ref: str, title: str, details: str, owner: str }) },
  closed_items: { type: 'array', items: obj({ id: { type: 'integer' }, ref: str, note: str }) },
});

let client = null;
let running = false;

export function extractionAvailable() {
  return Boolean(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Tests use this to swap in a stub instead of calling Claude. */
export function setClient(c) {
  client = c;
}

/**
 * Process all unprocessed messages, oldest day first. Safe to call often: only one run
 * happens at a time, and each message is processed once.
 */
export async function runExtraction(log = console) {
  if (running) return { skipped: 'already running' };
  if (!extractionAvailable()) return { skipped: 'ANTHROPIC_API_KEY is not set' };
  running = true;
  client ??= new Anthropic();
  const summary = { batches: 0, sales: 0, expenses: 0, price_changes: 0, opened: 0, closed: 0, failed: 0 };
  try {
    for (;;) {
      const batch = nextBatch();
      if (batch.length === 0) break;
      try {
        const result = await extractBatch(batch);
        const applied = applyResult(batch, result);
        for (const k of Object.keys(applied)) summary[k] += applied[k];
        summary.batches++;
      } catch (err) {
        if (err instanceof Anthropic.APIError && (err.status === 429 || err.status >= 500 || err.status == null)) {
          // Temporary problem: leave the messages unprocessed and try again next run.
          log.error(`Extraction paused, will retry: ${err.message}`);
          summary.error = err.message;
          break;
        }
        // Permanent problem with this batch: mark it so we don't loop on it forever.
        log.error(`Extraction failed for a batch of ${batch.length} messages: ${err.message}`);
        markProcessed(batch, 2);
        summary.failed += batch.length;
        summary.error = err.message;
      }
    }
  } finally {
    running = false;
    setSetting('last_extraction', JSON.stringify({ at: Date.now(), ...summary }));
  }
  return summary;
}

// Unprocessed messages from the earliest local day that has any, so days are processed in order.
function nextBatch() {
  const first = db.prepare('SELECT ts FROM messages WHERE processed = 0 ORDER BY ts LIMIT 1').get();
  if (!first) return [];
  const day = localDate(first.ts);
  return db
    .prepare('SELECT * FROM messages WHERE processed = 0 ORDER BY ts LIMIT ?')
    .all(MAX_BATCH * 2)
    .filter((m) => localDate(m.ts) === day)
    .slice(0, MAX_BATCH);
}

async function extractBatch(batch) {
  const day = localDate(batch[0].ts);
  const people = db.prepare('SELECT name FROM people ORDER BY name').all().map((p) => p.name);
  const menu = db.prepare('SELECT item, price FROM menu ORDER BY item').all();
  const open = db.prepare("SELECT id, title, owner_name, raised_at FROM open_items WHERE status = 'open' ORDER BY id").all();
  const earlier = db
    .prepare('SELECT * FROM messages WHERE processed != 0 AND ts <= ? ORDER BY ts DESC LIMIT ?')
    .all(batch[0].ts, CONTEXT_MESSAGES)
    .reverse()
    .filter((m) => localDate(m.ts) === day);

  const line = (m) => `${localTime(m.ts)} ${m.sender_name}: ${m.text}`;
  const context = [
    `Date of these messages: ${day}`,
    `People in the group: ${people.join(', ') || '(none yet)'}`,
    `Current menu:\n${menu.map((m) => `- ${m.item}: ₹${m.price}`).join('\n') || '(empty)'}`,
    `Open items:\n${open.map((o) => `- id ${o.id}: ${o.title} (owner ${o.owner_name || 'unknown'}, raised ${localDate(o.raised_at)})`).join('\n') || '(none)'}`,
    `Earlier messages today (context only, already processed):\n${earlier.map(line).join('\n') || '(none)'}`,
  ].join('\n\n');
  const fresh = batch.map((m, i) => `[m${i + 1}] ${line(m)}`).join('\n');

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `<context>\n${context}\n</context>\n\n<new_messages>\n${fresh}\n</new_messages>`,
    }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined this batch (${response.stop_details?.category ?? 'no category'})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude response was cut off (max_tokens)');
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

function applyResult(batch, result) {
  const byRef = new Map(batch.map((m, i) => [`m${i + 1}`, m]));
  const msgFor = (ref) => byRef.get(String(ref).replace(/[[\]]/g, '')) ?? batch.at(-1);
  const now = Date.now();
  const counts = { sales: 0, expenses: 0, price_changes: 0, opened: 0, closed: 0 };

  const menuPrice = db.prepare('SELECT price FROM menu WHERE item = ?');
  const insertSale = db.prepare(
    `INSERT INTO sales (date, item, qty, unit_price, total, customer, channel, handled_by, notes, source, source_msg, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bot', ?, ?)`
  );
  const insertExpense = db.prepare(
    `INSERT INTO expenses (date, item, amount, vendor, paid_by, notes, source, source_msg, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'bot', ?, ?)`
  );
  const findPerson = db.prepare('SELECT jid, name FROM people WHERE name = ? COLLATE NOCASE');
  const insertOpen = db.prepare(
    `INSERT INTO open_items (title, details, owner_jid, owner_name, raised_at, source, source_msg)
     VALUES (?, ?, ?, ?, ?, 'bot', ?)`
  );
  const closeOpen = db.prepare(
    "UPDATE open_items SET status = 'done', closed_at = ?, closed_note = ? WHERE id = ? AND status = 'open'"
  );

  transaction(() => {
    for (const s of result.sales ?? []) {
      const msg = msgFor(s.ref);
      const qty = s.qty > 0 ? s.qty : 1;
      let unit = s.unit_price;
      let total = s.total;
      if (!unit && total) unit = total / qty;
      if (!unit && !total) unit = menuPrice.get(s.item)?.price ?? 0;
      if (!total) total = unit * qty;
      insertSale.run(localDate(msg.ts), s.item, qty, unit, total, s.customer, s.channel, msg.sender_name, s.notes, msg.id, now);
      counts.sales++;
    }
    for (const e of result.expenses ?? []) {
      const msg = msgFor(e.ref);
      insertExpense.run(localDate(msg.ts), e.item, e.amount, e.vendor, e.paid_by || msg.sender_name, e.notes, msg.id, now);
      counts.expenses++;
    }
    for (const p of result.price_changes ?? []) {
      const msg = msgFor(p.ref);
      setMenuPrice(p.item, p.new_price, msg.sender_name, p.note, msg.ts, msg.id);
      counts.price_changes++;
    }
    for (const o of result.new_open_items ?? []) {
      const msg = msgFor(o.ref);
      const owner = (o.owner && findPerson.get(o.owner)) || { jid: msg.sender_jid, name: msg.sender_name };
      insertOpen.run(o.title, o.details, owner.jid, owner.name, msg.ts, msg.id);
      counts.opened++;
    }
    for (const c of result.closed_items ?? []) {
      const msg = msgFor(c.ref);
      const note = c.note ? `${c.note} (${msg.sender_name})` : `Closed by ${msg.sender_name}`;
      counts.closed += Number(closeOpen.run(msg.ts, note, c.id).changes);
    }
    markProcessed(batch, 1);
  });
  return counts;
}

/** Set a menu price and record the change in the price history. */
export function setMenuPrice(item, price, by = '', note = '', ts = Date.now(), sourceMsg = null) {
  const existing = db.prepare('SELECT item, price FROM menu WHERE item = ?').get(item);
  if (existing && existing.price === price) return;
  db.prepare(
    `INSERT INTO menu (item, price, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(item) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(existing?.item ?? item, price, ts, by);
  db.prepare(
    'INSERT INTO price_history (item, old_price, new_price, ts, decided_by, note, source_msg) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(existing?.item ?? item, existing?.price ?? null, price, ts, by, note, sourceMsg);
}

function markProcessed(batch, state) {
  const stmt = db.prepare('UPDATE messages SET processed = ? WHERE id = ?');
  for (const m of batch) stmt.run(state, m.id);
}
