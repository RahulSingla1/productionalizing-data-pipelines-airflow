# Kitchen Desk

A small web app for running a cloud kitchen from a WhatsApp group. A bot reads the
partners' group chat and keeps track of:

- **Sales**: orders and items sold, with prices filled in from the menu
- **Expenses**: purchases and payments mentioned in the chat
- **Menu & prices**: the current price list, with a history of every change and who decided it
- **Open items**: questions and tasks raised in the chat that nobody has closed yet, with the person responsible

Every evening the bot posts a recap in the group (sales, expenses, price changes and
open items) and @-tags whoever still has something open. Any partner can open the app
on their phone to see the numbers, fix mistakes, mark items done, or send a reminder.

Claude reads the messages, so Hinglish and shorthand are fine.

## How it works

```
WhatsApp group ──► bot (spare number) ──► messages ──► Claude ──► sales / expenses / prices / open items
                                                                        │
                       partners' phones ◄── web app ◄───────────────────┘
                       WhatsApp group  ◄── nightly recap + reminders
```

- New messages are read every 15 minutes.
- Past chats can be loaded from WhatsApp's **Export chat** file (More → Import chat).
- Everything is stored in one SQLite file in `data/`. Back that folder up.

## Run it

You need **Node.js 22.13 or newer** and a **Claude API key** from <https://console.anthropic.com>.

```bash
cd cloud-kitchen-app
npm install
cp .env.example .env      # then edit .env: set APP_PASSWORD and ANTHROPIC_API_KEY
npm start
```

Open <http://localhost:3000> and log in with `APP_PASSWORD`.

### Load your past chats

1. In WhatsApp, open the group → ⋮ → More → **Export chat** → **Without media**.
2. In the app: **More → Import chat**, choose the `.txt` file, press **Import**.
3. The bot reads one day at a time. Check **Today**, **Sales**, **Open** and **Menu**, and fix anything it got wrong.

Importing the same chat again later is safe: messages already loaded are skipped.

### Connect the WhatsApp bot

> ⚠️ This uses an unofficial WhatsApp Web connection ([Baileys](https://github.com/WhiskeySockets/Baileys)).
> It works like WhatsApp Web, but WhatsApp may ban numbers it thinks are bots.
> **Use a spare SIM, never your main business number.** If the number is banned, put WhatsApp on a new SIM and link again.

1. Put WhatsApp on a spare phone/SIM and **add that number to your group**.
2. In the app: **More → WhatsApp bot → Connect**. A QR code appears.
3. On the spare phone: WhatsApp → Settings → **Linked devices** → **Link a device**, and scan it.
4. Press **Choose group** and pick your partners' group.
5. Set the recap time (default 10:00 PM) and leave **Automatic** on.

The bot only reads the group you pick. It never replies to chats, apart from the recap and reminders you send.

### People and tagging

The bot tags people with their WhatsApp number. People who only appear in an imported
chat have no number yet, so under **More → People**, add each partner's number with the
country code (e.g. `919876543210`). People who write in the group after the bot is linked
are picked up automatically.

## Put it online

The app needs to run all the time, so put it on a small server rather than a laptop.
A basic VPS (1 GB RAM, e.g. DigitalOcean, Hetzner, AWS Lightsail in Mumbai) costs about
₹400–800 a month. On an Ubuntu server:

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git

git clone <this repo> && cd <repo>/cloud-kitchen-app
npm install --omit=dev
cp .env.example .env && nano .env

# keep it running and restart on reboot
sudo npm install -g pm2
pm2 start npm --name kitchen -- start
pm2 save && pm2 startup
```

Then give it a web address with HTTPS. The simplest option is [Caddy](https://caddyserver.com):
point a domain (e.g. `kitchen.yourbrand.in`) at the server, install Caddy, and put this in
`/etc/caddy/Caddyfile`:

```
kitchen.yourbrand.in {
  reverse_proxy localhost:3000
}
```

On each partner's phone, open the address and use **Add to Home screen**. It then opens like an app.

**Back up `data/` regularly.** It holds the database and the bot's WhatsApp login.

## Settings (`.env`)

| Variable | What it does | Default |
|---|---|---|
| `APP_PASSWORD` | Shared login password (required) | — |
| `ANTHROPIC_API_KEY` | Claude API key, needed to read the chat | — |
| `PORT` | Web port | `3000` |
| `TIME_ZONE` | Kitchen's time zone | `Asia/Kolkata` |
| `RECAP_TIME` | Default recap time (also editable in the app) | `22:00` |
| `EXTRACT_EVERY_MIN` | How often new messages are read | `15` |
| `DATE_ORDER` | `DMY` or `MDY` for chat exports | auto-detect |
| `DATA_DIR` | Where the database and WhatsApp login live | `./data` |
| `CLAUDE_MODEL` | Claude model used to read messages | `claude-opus-5-5` |
| `WHATSAPP` | Set to `off` to disable the bot | on |

## Costs

- **Server:** about ₹400–800/month.
- **Claude:** each 15-minute check sends only the new messages, plus the menu and open items. A busy group should cost a few hundred rupees a month. Importing months of old chat once costs more. Check usage at <https://console.anthropic.com>.

## Fixing mistakes

- Tap any sale, expense, open item or menu item to edit or delete it.
- **More → Chat log** shows every message the bot has read, by day.
- **More → Import chat → Re-read everything** clears what the bot extracted and reads the whole chat again. Entries you added by hand stay.

## Development

```bash
npm test     # parser, extraction (with a stubbed Claude), recap
```

Code layout: `src/server.js` (API, login, scheduler), `src/extractor.js` (Claude),
`src/whatsapp.js` (bot), `src/importer.js` (chat export parser), `src/recap.js`
(recap and reminder text), `public/` (the app, plain HTML/CSS/JS, no build step).
