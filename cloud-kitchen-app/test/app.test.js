import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test run gets a fresh database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kitchen-test-'));
process.env.TIME_ZONE = 'Asia/Kolkata';

const { db } = await import('../src/db.js');
const { parseExport, importExport } = await import('../src/importer.js');
const { runExtraction, setClient, setMenuPrice } = await import('../src/extractor.js');
const { buildRecap, buildReminder } = await import('../src/recap.js');
const { localDate, localTime } = await import('../src/time.js');

const sample = fs.readFileSync(new URL('./fixtures/sample-chat.txt', import.meta.url), 'utf8');

test('parses an Android chat export', () => {
  const msgs = parseExport(sample);
  // 14 lines, minus the encryption notice and the media placeholder.
  assert.equal(msgs.length, 11);
  assert.equal(msgs[0].sender, 'Rahul');
  assert.equal(localDate(msgs[0].ts), '2026-10-01');
  assert.equal(localTime(msgs[0].ts), '10:05');
  const kapoor = msgs.find((m) => m.text.includes('Mrs Kapoor'));
  assert.match(kapoor.text, /delivered by 8:30/, 'continuation lines join the message');
});

test('parses an iPhone chat export with 12-hour times', () => {
  const ios = [
    '[02/10/26, 9:05:12 PM] Amit: Swiggy - 1 biryani',
    '[02/10/26, 12:15:00 AM] Priya: late order',
    '‎[02/10/26, 9:06:00 PM] Amit: ‎image omitted',
  ].join('\n');
  const msgs = parseExport(ios);
  assert.equal(msgs.length, 2);
  assert.equal(localTime(msgs[0].ts), '21:05');
  assert.equal(localTime(msgs[1].ts), '00:15');
});

test('detects month/day order', () => {
  const us = '10/13/2026, 09:00 - Amit: hello\n10/14/2026, 09:00 - Amit: hi';
  assert.equal(localDate(parseExport(us)[0].ts), '2026-10-13');
});

test('re-importing the same export adds nothing', () => {
  const first = importExport(sample);
  assert.equal(first.added, 11);
  const again = importExport(sample);
  assert.equal(again.added, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM people').get().n, 3);
});

test('extraction turns messages into sales, prices, expenses and open items', async () => {
  setMenuPrice('Chicken biryani', 200, 'setup');
  setMenuPrice('Paneer tikka', 180, 'setup');

  const replies = {
    '2026-10-01': {
      sales: [
        { ref: 'm4', item: 'Chicken biryani', qty: 2, unit_price: 0, total: 0, customer: '', channel: 'Swiggy', notes: '' },
        { ref: 'm4', item: 'Paneer tikka', qty: 1, unit_price: 180, total: 0, customer: '', channel: 'Swiggy', notes: '' },
        { ref: 'm8', item: 'Chicken biryani', qty: 4, unit_price: 0, total: 880, customer: 'Mrs Kapoor', channel: 'direct', notes: 'party' },
      ],
      expenses: [{ ref: 'm5', item: 'Chicken 10kg', amount: 1850, vendor: 'Sharma ji', paid_by: '', notes: '' }],
      price_changes: [{ ref: 'm3', item: 'chicken biryani', new_price: 220, note: 'chicken cost up' }],
      new_open_items: [{ ref: 'm6', title: 'Get packaging vendor quote', details: 'Needed by tomorrow', owner: 'Rahul' }],
      closed_items: [],
    },
    '2026-10-02': {
      sales: [
        { ref: 'm3', item: 'Paneer tikka', qty: 1, unit_price: 0, total: 0, customer: '', channel: 'Zomato', notes: '' },
        { ref: 'm3', item: 'Dal makhani', qty: 1, unit_price: 160, total: 160, customer: '', channel: 'Zomato', notes: '' },
      ],
      expenses: [],
      price_changes: [],
      new_open_items: [{ ref: 'm2', title: 'Book gas cylinder', details: 'Cylinder running out', owner: '' }],
      closed_items: [{ id: 1, ref: 'm1', note: 'Quote received: ₹3.5/box' }],
    },
  };
  const requests = [];
  setClient({
    beta: {
      messages: {
        async create(params) {
          requests.push(params);
          const day = params.messages[0].content.match(/Date of these messages: (\S+)/)[1];
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(replies[day]) }] };
        },
      },
    },
  });

  const summary = await runExtraction();
  assert.equal(summary.batches, 2, 'one request per day, oldest first');
  assert.deepEqual(
    { sales: summary.sales, expenses: summary.expenses, price_changes: summary.price_changes, opened: summary.opened, closed: summary.closed },
    { sales: 5, expenses: 1, price_changes: 1, opened: 2, closed: 1 },
  );
  assert.equal(requests[0].model, 'claude-opus-5-5');
  assert.match(requests[1].messages[0].content, /id 1: Get packaging vendor quote/, 'day 2 sees the open items from day 1');

  // Missing prices are filled from the menu; totals from qty × price.
  const day1 = db.prepare("SELECT item, qty, unit_price, total FROM sales WHERE date = '2026-10-01' ORDER BY id").all();
  assert.deepEqual(day1.map((s) => s.total), [400, 180, 880]);
  assert.equal(day1[2].unit_price, 220);

  // The price change updated the existing menu item (case-insensitive) and the history.
  assert.equal(db.prepare("SELECT price FROM menu WHERE item = 'Chicken biryani'").get().price, 220);
  const hist = db.prepare("SELECT * FROM price_history WHERE decided_by = 'Priya'").get();
  assert.equal(hist.old_price, 200);

  // Open items: assigned to the named person, or to whoever raised it.
  const items = db.prepare('SELECT * FROM open_items ORDER BY id').all();
  assert.equal(items[0].owner_name, 'Rahul');
  assert.equal(items[0].status, 'done');
  assert.match(items[0].closed_note, /Rahul/);
  assert.equal(items[1].owner_name, 'Amit');
  assert.equal(items[1].status, 'open');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE processed = 0').get().n, 0);
  assert.equal((await runExtraction()).batches, 0, 'nothing is processed twice');
});

test('recap lists sales and tags owners who have a number', () => {
  db.prepare("UPDATE people SET phone = '919800000001' WHERE name = 'Amit'").run();
  const recap = buildRecap('2026-10-01');
  assert.match(recap.text, /Sales:\* ₹1,460 from 3 item lines/);
  assert.match(recap.text, /Expenses:\* ₹1,850/);
  assert.match(recap.text, /Chicken biryani: ₹200 → ₹220 \(Priya\)/);
  assert.match(recap.text, /Book gas cylinder — @919800000001/);
  assert.deepEqual(recap.mentions, ['919800000001@s.whatsapp.net']);

  const item = db.prepare("SELECT * FROM open_items WHERE status = 'open'").get();
  const reminder = buildReminder(item);
  assert.match(reminder.text, /^@919800000001 reminder: \*Book gas cylinder\*/);
});

test('a refused batch is marked and skipped, not retried forever', async () => {
  db.prepare("INSERT INTO messages (id, ts, sender_jid, sender_name, text, source) VALUES ('x1', ?, 'name:Amit', 'Amit', 'hello', 'live')").run(Date.now());
  setClient({ beta: { messages: { create: async () => ({ stop_reason: 'refusal', stop_details: { category: null }, content: [] }) } } });
  const summary = await runExtraction({ error() {} });
  assert.equal(summary.failed, 1);
  assert.equal(db.prepare("SELECT processed FROM messages WHERE id = 'x1'").get().processed, 2);
});
