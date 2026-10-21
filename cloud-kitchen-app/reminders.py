"""Daily reminders: works out what each person still has to fill in and messages them.

Messages go by WhatsApp (via Twilio) when the person has a phone number, and by
email when they have an email address. If neither service is set up, the
message is printed to the app log so you can still see what would be sent.

Used three ways:
  * the built-in background scheduler (started by app.py),
  * the `flask --app app send-reminders` command (for cron / Airflow),
  * the "Send reminders now" button on the People page.
"""
import base64
import json
import logging
import smtplib
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime
from email.message import EmailMessage
from zoneinfo import ZoneInfo

import db

log = logging.getLogger(__name__)


def user_areas(user):
    """Which sections a person looks after. The owner sees everything."""
    owner = bool(user["is_admin"])
    return {
        "finance": owner or bool(user["can_finance"]),
        "inventory": owner or bool(user["can_inventory"]),
    }


def daily_status(conn, day):
    """What has (and hasn't) been filled in for `day`."""
    d = day.isoformat()
    sales = conn.execute("SELECT * FROM finance_entries WHERE entry_date = ?", (d,)).fetchone()
    expense_count = conn.execute("SELECT COUNT(*) FROM expenses WHERE expense_date = ?", (d,)).fetchone()[0]
    stock_updates = conn.execute(
        "SELECT COUNT(DISTINCT item_id) FROM inventory_log WHERE log_date = ?", (d,)
    ).fetchone()[0]
    item_count = conn.execute("SELECT COUNT(*) FROM inventory_items").fetchone()[0]
    low_stock = conn.execute(
        "SELECT name FROM inventory_items WHERE quantity <= reorder_level ORDER BY name"
    ).fetchall()
    to_buy = conn.execute(
        "SELECT item_name FROM inventory_requests WHERE status = 'open' ORDER BY created_at"
    ).fetchall()
    return {
        "day": day,
        "sales": sales,
        "sales_done": sales is not None,
        "expenses_done": expense_count > 0,
        "expense_count": expense_count,
        "stock_done": item_count > 0 and stock_updates > 0,
        "item_count": item_count,
        "low_stock": [r["name"] for r in low_stock],
        "to_buy": [r["item_name"] for r in to_buy],
    }


def checklist(user, status):
    """List of (label, done) for the things this person is responsible for."""
    areas = user_areas(user)
    items = []
    if areas["finance"]:
        items.append(("Today's sales and money", status["sales_done"]))
        items.append(("Money spent today", status["expenses_done"]))
    if areas["inventory"]:
        items.append(("Stock left in kitchen", status["stock_done"]))
    return items


def build_message(user, status, app_url=""):
    """Short, plain message suitable for WhatsApp. Returns (subject, body, pending_count)."""
    items = checklist(user, status)
    pending = sum(1 for _, done in items if not done)
    lines = [f"Hello {user['name']} 🙏", ""]
    if pending:
        lines.append("Please fill today's kitchen details:")
    else:
        lines.append("Everything is filled for today. Thank you! 👍")
    for label, done in items:
        lines.append(f"{'✅' if done else '❌'} {label}")

    if user_areas(user)["inventory"]:
        buy = list(dict.fromkeys(status["to_buy"] + status["low_stock"]))
        if buy:
            lines += ["", "🛒 Need to buy: " + ", ".join(buy[:10])]

    if app_url:
        lines += ["", f"Open: {app_url}"]

    day_label = status["day"].strftime("%d %b")
    subject = f"Kitchen: {pending} thing(s) to fill for {day_label}" if pending else f"Kitchen: all done for {day_label}"
    return subject, "\n".join(lines), pending


def send_whatsapp(config, phone, body):
    sid, token, sender = config.get("TWILIO_ACCOUNT_SID"), config.get("TWILIO_AUTH_TOKEN"), config.get("TWILIO_WHATSAPP_FROM")
    data = urllib.parse.urlencode({
        "From": sender if sender.startswith("whatsapp:") else f"whatsapp:{sender}",
        "To": f"whatsapp:{phone}",
        "Body": body,
    }).encode()
    req = urllib.request.Request(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data=data)
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode())
    with urllib.request.urlopen(req, timeout=30) as resp:
        json.load(resp)


def send_email(config, to, subject, body):
    msg = EmailMessage()
    msg["From"] = config.get("SMTP_FROM") or config.get("SMTP_USER")
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    port = int(config.get("SMTP_PORT") or 587)
    if port == 465:
        server = smtplib.SMTP_SSL(config["SMTP_HOST"], port, timeout=30)
    else:
        server = smtplib.SMTP(config["SMTP_HOST"], port, timeout=30)
        server.starttls()
    with server:
        if config.get("SMTP_USER"):
            server.login(config["SMTP_USER"], config.get("SMTP_PASSWORD", ""))
        server.send_message(msg)


def deliver(config, user, subject, body):
    """Send on every channel available for this person. Returns a short result string."""
    sent = []
    if user["phone"] and config.get("TWILIO_ACCOUNT_SID"):
        send_whatsapp(config, user["phone"], body)
        sent.append("whatsapp")
    if user["email"] and config.get("SMTP_HOST"):
        send_email(config, user["email"], subject, body)
        sent.append("email")
    if not sent:
        log.warning("No WhatsApp/email set up for %s - reminder would be:\n%s", user["name"], body)
        return "logged only"
    return "sent by " + " + ".join(sent)


def send_daily_reminders(conn, config, day, force=False):
    """Send today's reminder to every active person who has reminders on.

    Each (person, day) is claimed in reminder_log before sending, so running
    this from several places (scheduler, cron, button) never double-sends
    unless `force` is set.
    """
    status = daily_status(conn, day)
    users = conn.execute("SELECT * FROM users WHERE active = 1 AND reminders_enabled = 1").fetchall()
    results = []
    for user in users:
        if not checklist(user, status):
            continue
        if force:
            conn.execute("DELETE FROM reminder_log WHERE user_id = ? AND sent_date = ?", (user["id"], day.isoformat()))
        claimed = conn.execute(
            "INSERT OR IGNORE INTO reminder_log (user_id, sent_date) VALUES (?, ?)", (user["id"], day.isoformat())
        ).rowcount
        conn.commit()
        if not claimed:
            continue
        subject, body, _ = build_message(user, status, config.get("APP_URL", ""))
        try:
            result = deliver(config, user, subject, body)
        except Exception as exc:  # keep going for the other people
            log.exception("Reminder to %s failed", user["name"])
            result = f"failed: {exc}"
        conn.execute(
            "UPDATE reminder_log SET status = ?, detail = ?, sent_at = CURRENT_TIMESTAMP "
            "WHERE user_id = ? AND sent_date = ?",
            (result, subject, user["id"], day.isoformat()),
        )
        conn.commit()
        results.append((user["name"], result))
    return results


def local_now(config):
    return datetime.now(ZoneInfo(config.get("TIMEZONE", "UTC")))


def start_scheduler(config, interval=60):
    """Background thread: once local time passes REMINDER_TIME, send today's reminders."""
    hour, minute = (int(x) for x in config.get("REMINDER_TIME", "20:00").split(":"))

    def loop():
        while True:
            try:
                now = local_now(config)
                if (now.hour, now.minute) >= (hour, minute):
                    conn = db.connect(config["DATABASE"])
                    try:
                        send_daily_reminders(conn, config, now.date())
                    finally:
                        conn.close()
            except Exception:
                log.exception("Reminder scheduler error")
            time.sleep(interval)

    thread = threading.Thread(target=loop, name="reminder-scheduler", daemon=True)
    thread.start()
    return thread
