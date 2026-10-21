# 🍳 Cloud Kitchen Manager

> **Want the offline phone app?** See [Kitchen Book, the Android app](#kitchen-book-android-app-works-offline) at the bottom.

A very simple app for a cloud kitchen's **daily money** and **stock**, with a
**daily WhatsApp/email reminder** for everyone who uses it.

- Opens in any browser, on **any phone or laptop**. Nothing needs to be installed.
  On a phone, use "Add to Home Screen" and it gets its own app icon.
- **No email or password to remember.** Tap your name, then type a 4-number PIN.
- **Big buttons, big text, simple words.** Each screen does one job.
- **Different people see different things.** For example, the cook sees only
  Stock, the cashier sees only Money, and the owner sees everything.

---

## How to use it (for everyone)

1. Open the app link and **tap your name**.
2. **Type your 4-number PIN.** The app remembers you on your own phone for 2 months.
3. On the home screen, **red boxes ❌ still need filling today** and green boxes ✅ are done.

| Button | What you do there |
|---|---|
| 💰 **Today's Sales** | Number of orders, total sales, money received, money still to come (Swiggy/Zomato/credit). |
| 🧾 **Money Spent** | Type the amount, tap what it was for (vegetables, gas, salary…), then press **Add**. Repeat for each expense. |
| 📦 **Stock Left** | Type how much of each item is left. Items running low turn red. |
| 🛒 **Need to Buy** | The shopping list. Tap **✓ Bought** when something arrives and it is added to stock. |
| 📊 **Reports** | This month's totals, where the money went, and the last 30 days. **Download for Excel** button included. |
| 👥 **People** *(owner only)* | Add people, set their PIN, and choose whether they see Money, Stock or both. |

Forgot to fill yesterday? Press **Yesterday** at the top of the Sales or Money Spent screen.

### Daily reminder

Every day at **8:00 pm** (you can change the time), each person gets a short message like this:

```
Hello Papa 🙏

Please fill today's kitchen details:
✅ Today's sales and money
❌ Money spent today
❌ Stock left in kitchen

🛒 Need to buy: Onion, Cooking oil

Open: https://your-kitchen-app.example.com
```

People only get reminded about their own part: a Stock person never sees money.
Anyone can turn their reminder off under **⚙️ My PIN & reminders**.

---

## Setting it up (for the person who installs it)

### Try it on your computer

```bash
cd cloud-kitchen-app
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000. The first screen asks for the **owner's name and PIN**.
Then add the other people from **👥 People**.

To use it from phones on the same Wi‑Fi, open `http://<your-computer's-IP>:5000`.

### Put it online so everyone can reach it from anywhere

Any host that runs Python or Docker works, for example Render, Railway, Fly.io,
PythonAnywhere or a small VPS. Two rules:

1. **Keep the database on a persistent disk.** Set `DATABASE=/data/kitchen.db`
   (or similar) on a disk that survives restarts. Otherwise data is lost on redeploy.
2. **Use HTTPS** (all the hosts above give you this for free) and set a fixed `SECRET_KEY`.

With Docker:

```bash
docker build -t kitchen .
docker run -d -p 8000:8000 -v kitchen-data:/data --env-file .env kitchen
```

### Settings

Copy `.env.example` to `.env` and fill it in. All settings are optional:

| Setting | Default | Meaning |
|---|---|---|
| `KITCHEN_NAME` | My Cloud Kitchen | Shown at the top of every screen |
| `CURRENCY` | ₹ | Money symbol |
| `TIMEZONE` | Asia/Kolkata | Decides what "today" means and when reminders go out |
| `REMINDER_TIME` | 20:00 | Daily reminder time (24-hour) |
| `APP_URL` | (empty) | Link included in reminders |
| `DATABASE` | `instance/kitchen.db` | Where data is stored (SQLite file) |
| `SECRET_KEY` | auto-generated | Keeps people logged in; set a fixed value when hosting |
| `ENABLE_SCHEDULER` | 1 | Set to `0` if you send reminders from cron/Airflow instead |

### Turning on WhatsApp reminders

WhatsApp messages are sent through [Twilio](https://www.twilio.com/whatsapp).

1. Create a Twilio account and enable WhatsApp. You can start with the free sandbox:
   each person sends the "join" code to the sandbox number once.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_WHATSAPP_FROM` (the Twilio WhatsApp number).
3. Make sure every person has their WhatsApp number with country code, e.g. `+919812345678`.
4. Press **📨 Send reminders now (test)** on the People page to check it works.

### Turning on email reminders

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM`.
For Gmail use `smtp.gmail.com`, port `587`, and a Gmail
[App Password](https://support.google.com/accounts/answer/185833). Then add an
email address for each person who wants email.

If neither WhatsApp nor email is set up, reminders are written to the app's log, and
everyone still sees the red ❌ boxes on their home screen.

### Sending reminders from cron or Airflow instead

```bash
flask --app app send-reminders          # sends today's reminders (only once per day)
flask --app app send-reminders --force  # send again
```

`airflow/kitchen_reminders_dag.py` is a ready-made Airflow DAG that runs this daily.
If you use it, set `ENABLE_SCHEDULER=0` on the web app.

### Someone forgot their PIN

The owner opens **👥 People → Change** and types a new PIN. If the **owner** forgot theirs:

```bash
flask --app app reset-pin "Papa" 1234
```

### Backups

All data is in one file (`DATABASE`). Copy it somewhere safe regularly. You can
also use **📊 Reports → Download for Excel**.

### Running the tests

```bash
pip install pytest
python -m pytest tests
```

---

## Kitchen Book, the Android app (works offline)

`android/` is a phone app that needs **no internet and no sign-in**. Everything is kept on the phone.

**Download:** on the Android phone open
https://github.com/RahulSingla1/productionalizing-data-pipelines-airflow/releases/download/kitchen-app/KitchenBook.apk
and install it. Android will ask you to allow "Install unknown apps" for your browser once.

What it does:
- Today's sales, money spent, stock left and need-to-buy, with big buttons.
- **Totals worked out automatically**: today, this month, and each day (Reports → ◀ ▶ to change month).
- **Every entry can be changed**: tap a day in Reports, or ✏️ Change on any expense, or "change item" in Stock.
- **📤 Send report** shares today's or the month's totals on WhatsApp.
- **💾 Backup** makes a file to send to yourself; **Bring back a backup** restores it on a new phone.

- **🛎️ Take an order**: customer name and mobile (both optional), then search the menu or tap a category and
  tap a size (Qtr / Half / Full) to add a dish; − / + changes how many. The full Swadishtam menu is in
  `android/app/src/main/assets/menu.js`, and prices can be changed in the app under **📖 Menu**. Automatic
  total, paid now / pay later. **↩️ Undo** for 2 minutes, **Cancel order** after that, **✓ Got payment** for pay-later.
  Orders are added to the day's and month's totals automatically.

**Order alerts on every phone (set up once, no accounts):**
1. On the first phone: 💾 Backup → **✨ Create kitchen code**.
2. On every other phone: 💾 Backup → type the same code → **✓ Join**, and allow notifications when asked.
3. Optional: tap **🔔 Keep order alerts on** so Android doesn't stop the alerts to save battery.

Orders travel through the free [ntfy.sh](https://ntfy.sh) service, scrambled with the kitchen code so it can't
read them. It keeps messages for about 12 hours, so open the app at least once a day on each phone so its totals
include every order (the background listener also saves them while the phone is on). The free service allows
roughly 250 messages a day per phone. Without internet, orders wait on the phone and are sent later.

Each phone still keeps its own data, so make a backup every week.

Any change pushed to `android/` rebuilds the app automatically (`.github/workflows/kitchen-android.yml`)
and replaces the download. New versions install over the old one and keep the data.
