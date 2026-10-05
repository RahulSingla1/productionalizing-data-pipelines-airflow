import crypto from 'node:crypto';
import { db, upsertPerson, transaction } from './db.js';
import { zonedTimestamp } from './time.js';

// Matches the start of a message line in both export styles:
//   Android: 05/10/2026, 14:32 - Ravi: text      or  5/10/26, 2:32 pm - Ravi: text
//   iPhone:  [05/10/26, 2:32:10 PM] Ravi: text
const LINE_START = new RegExp(
  '^\\[?(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2,4}),?\\s+' +
  '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?' +
  '[\\s\\u202f\\u00a0]*([AaPp]\\.?\\s?[Mm]\\.?)?\\]?\\s*(?:-\\s*)?(.*)$'
);

const SKIP_TEXT = [
  /^<media omitted>$/i,
  /^(image|video|audio|sticker|gif|document) omitted$/i,
  /^this message was deleted$/i,
  /^you deleted this message$/i,
  /^null$/i,
];

function clean(s) {
  return s.replace(/[‎‏‪-‮]/g, '').replace(/<this message was edited>/i, '').trim();
}

/**
 * Parse the text of a WhatsApp "Export chat" file into messages.
 * Returns [{ ts, sender, text }]. System lines (joins, encryption notice) are dropped.
 */
export function parseExport(raw, dateOrder = process.env.DATE_ORDER || 'auto') {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^[‎﻿]+/, ''));

  // Work out whether dates are day/month or month/day. India uses day/month.
  let order = dateOrder.toUpperCase();
  if (order === 'AUTO') {
    order = 'DMY';
    for (const line of lines) {
      const m = line.match(LINE_START);
      if (!m) continue;
      if (Number(m[2]) > 12) { order = 'MDY'; break; }
      if (Number(m[1]) > 12) { order = 'DMY'; break; }
    }
  }

  const out = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(LINE_START);
    if (!m) {
      // Continuation of a multi-line message.
      if (current && line.trim()) current.text += '\n' + clean(line);
      continue;
    }
    let [, a, b, y, hh, mm, ss, ampm, rest] = m;
    let day = Number(order === 'DMY' ? a : b);
    let month = Number(order === 'DMY' ? b : a);
    let year = Number(y);
    if (year < 100) year += 2000;
    let hour = Number(hh);
    if (ampm) {
      const pm = /^p/i.test(ampm);
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    rest = clean(rest);
    const sep = rest.indexOf(': ');
    current = null;
    if (sep <= 0) continue; // system message, no sender
    const sender = rest.slice(0, sep).trim();
    const text = rest.slice(sep + 2);
    current = {
      ts: zonedTimestamp(year, month, day, hour, Number(mm), Number(ss || 0)),
      sender,
      text,
    };
    out.push(current);
  }
  return out.filter((msg) => msg.text && !SKIP_TEXT.some((re) => re.test(msg.text.trim())));
}

/** Store parsed export messages. Re-importing the same export is safe: duplicates are skipped. */
export function importExport(raw) {
  const parsed = parseExport(raw);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO messages (id, ts, sender_jid, sender_name, text, source)
     VALUES (?, ?, ?, ?, ?, 'import')`
  );
  let added = 0;
  transaction(() => {
    for (const msg of parsed) {
      const jid = personJidForName(msg.sender);
      upsertPerson(jid, msg.sender);
      const id = 'imp_' + crypto.createHash('sha1').update(`${msg.ts}|${msg.sender}|${msg.text}`).digest('hex').slice(0, 20);
      added += Number(insert.run(id, msg.ts, jid, msg.sender, msg.text).changes);
    }
  });
  const first = parsed[0]?.ts ?? null;
  const last = parsed.at(-1)?.ts ?? null;
  return { parsed: parsed.length, added, first, last };
}

// An exported chat shows names (or phone numbers) but no WhatsApp ids. Reuse a person
// already known by that name or number, otherwise create a "name:" placeholder.
function personJidForName(name) {
  const digits = name.replace(/[^\d]/g, '');
  if (digits.length >= 10 && /^[+\d\s-]+$/.test(name)) {
    const byPhone = db.prepare('SELECT jid FROM people WHERE phone = ? OR jid = ?').get(digits, `${digits}@s.whatsapp.net`);
    return byPhone ? byPhone.jid : `${digits}@s.whatsapp.net`;
  }
  const byName = db.prepare('SELECT jid FROM people WHERE name = ? COLLATE NOCASE').get(name);
  return byName ? byName.jid : `name:${name}`;
}
