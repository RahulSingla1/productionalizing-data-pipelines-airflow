import path from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, isJidGroup, useMultiFileAuthState } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { db, getSetting, transaction } from './db.js';

const AUTH_DIR = path.join(process.env.DATA_DIR || './data', 'whatsapp-auth');
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

// What the Settings page shows about the bot's WhatsApp connection.
const state = { status: 'disconnected', qr: null, me: null, error: null };
let sock = null;
let starting = false;

export function whatsappState() {
  return { ...state, groupJid: getSetting('group_jid'), groupName: getSetting('group_name') };
}

export async function startWhatsApp() {
  if (starting || state.status === 'connected') return;
  starting = true;
  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({
      auth,
      logger,
      browser: Browsers.ubuntu('Kitchen Bot'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    state.status = 'connecting';
    state.error = null;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state.status = 'waiting_for_scan';
        state.qr = await QRCode.toDataURL(qr);
      }
      if (connection === 'open') {
        state.status = 'connected';
        state.qr = null;
        state.me = sock.user?.id ?? null;
        logger.warn('WhatsApp connected');
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        sock = null;
        state.qr = null;
        if (code === DisconnectReason.loggedOut) {
          state.status = 'logged_out';
          state.error = 'The bot was logged out. Delete data/whatsapp-auth and scan the QR code again.';
          return;
        }
        state.status = 'reconnecting';
        setTimeout(() => startWhatsApp().catch((e) => logger.error(e)), 3000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        try { storeMessage(msg); } catch (e) { logger.error(e, 'failed to store message'); }
      }
    });
  } finally {
    starting = false;
  }
}

function storeMessage(msg) {
  const groupJid = getSetting('group_jid');
  const remote = msg.key?.remoteJid;
  // Skip the bot's own recap and reminder messages.
  if (!groupJid || remote !== groupJid || !msg.message || msg.key.fromMe) return;
  const m = msg.message;
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption;
  if (!text) return;

  const senderJid = msg.key.participant;
  if (!senderJid) return;
  const phoneJid = msg.key.participantAlt?.endsWith('@s.whatsapp.net') ? msg.key.participantAlt : senderJid.endsWith('@s.whatsapp.net') ? senderJid : null;
  const name = msg.pushName || senderJid.split('@')[0];
  const ts = Number(msg.messageTimestamp) * 1000 || Date.now();

  transaction(() => {
    rememberPerson(senderJid, name, phoneJid);
    db.prepare(
      `INSERT OR IGNORE INTO messages (id, ts, sender_jid, sender_name, text, source)
       VALUES (?, ?, ?, ?, ?, 'live')`
    ).run(msg.key.id, ts, senderJid, displayName(senderJid, name), text);
  });
}

function displayName(jid, fallback) {
  return db.prepare('SELECT name FROM people WHERE jid = ?').get(jid)?.name ?? fallback;
}

// Record a live sender. If the same person was first seen in an imported chat (stored as
// "name:<Name>" or by phone number), move their history over to the real WhatsApp id.
function rememberPerson(jid, name, phoneJid) {
  if (db.prepare('SELECT 1 FROM people WHERE jid = ?').get(jid)) return;
  const phone = phoneJid ? phoneJid.split('@')[0] : null;
  const previous =
    (phoneJid && phoneJid !== jid && db.prepare('SELECT * FROM people WHERE jid = ?').get(phoneJid)) ||
    (phone && db.prepare('SELECT * FROM people WHERE phone = ?').get(phone)) ||
    db.prepare("SELECT * FROM people WHERE jid = ? COLLATE NOCASE").get(`name:${name}`);
  if (previous) {
    db.prepare('UPDATE people SET jid = ?, phone = COALESCE(phone, ?) WHERE jid = ?').run(jid, phone, previous.jid);
    db.prepare('UPDATE messages SET sender_jid = ? WHERE sender_jid = ?').run(jid, previous.jid);
    db.prepare('UPDATE open_items SET owner_jid = ? WHERE owner_jid = ?').run(jid, previous.jid);
  } else {
    db.prepare('INSERT INTO people (jid, name, phone) VALUES (?, ?, ?)').run(jid, name, phone);
  }
}

/** Groups the bot's number is in, for choosing which one to follow. */
export async function listGroups() {
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not connected');
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Post a message to the followed group, tagging the given ids. */
export async function sendToGroup(text, mentions = []) {
  const groupJid = getSetting('group_jid');
  if (!groupJid || !isJidGroup(groupJid)) throw new Error('No WhatsApp group selected');
  if (!sock || state.status !== 'connected') throw new Error('WhatsApp is not connected');
  await sock.sendMessage(groupJid, { text, mentions });
}

export async function logoutWhatsApp() {
  if (sock) await sock.logout().catch(() => {});
  sock = null;
  state.status = 'logged_out';
}
