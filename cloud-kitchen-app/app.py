"""Cloud Kitchen Manager - a very simple web app for daily kitchen money and stock.

Runs in any browser (phone or laptop). People log in by tapping their name and
typing a 4-digit PIN. What they can see depends on what the owner allows:
  * Money  - today's sales, money received / still to come, money spent
  * Stock  - how much is left, what needs to be bought
  * Owner  - everything, plus reports and adding people
"""
import csv
import io
import os
import secrets
from datetime import date, timedelta
from functools import wraps

import click
from flask import (Flask, Response, abort, flash, g, redirect, render_template,
                   request, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import db
import reminders

EXPENSE_CATEGORIES = [
    ("Vegetables & Groceries", "🥕"),
    ("Meat & Dairy", "🥛"),
    ("Gas & Electricity", "🔥"),
    ("Packaging", "📦"),
    ("Staff Salary", "👨‍🍳"),
    ("Rent", "🏠"),
    ("Delivery & Commission", "🛵"),
    ("Repairs", "🔧"),
    ("Other", "📝"),
]
UNITS = ["kg", "g", "litre", "ml", "pieces", "packets", "dozen", "boxes"]


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY") or stored_secret_key(app.instance_path),
        DATABASE=os.environ.get("DATABASE", os.path.join(app.instance_path, "kitchen.db")),
        KITCHEN_NAME=os.environ.get("KITCHEN_NAME", "My Cloud Kitchen"),
        CURRENCY=os.environ.get("CURRENCY", "₹"),
        TIMEZONE=os.environ.get("TIMEZONE", "Asia/Kolkata"),
        REMINDER_TIME=os.environ.get("REMINDER_TIME", "20:00"),
        ENABLE_SCHEDULER=os.environ.get("ENABLE_SCHEDULER", "1") == "1",
        APP_URL=os.environ.get("APP_URL", ""),
        SMTP_HOST=os.environ.get("SMTP_HOST", ""),
        SMTP_PORT=os.environ.get("SMTP_PORT", "587"),
        SMTP_USER=os.environ.get("SMTP_USER", ""),
        SMTP_PASSWORD=os.environ.get("SMTP_PASSWORD", ""),
        SMTP_FROM=os.environ.get("SMTP_FROM", ""),
        TWILIO_ACCOUNT_SID=os.environ.get("TWILIO_ACCOUNT_SID", ""),
        TWILIO_AUTH_TOKEN=os.environ.get("TWILIO_AUTH_TOKEN", ""),
        TWILIO_WHATSAPP_FROM=os.environ.get("TWILIO_WHATSAPP_FROM", ""),
        PERMANENT_SESSION_LIFETIME=timedelta(days=60),  # stay logged in on your own phone
    )
    if test_config:
        app.config.update(test_config)

    conn = db.connect(app.config["DATABASE"])
    db.init_db(conn)
    conn.close()

    register_helpers(app)
    register_routes(app)
    register_commands(app)

    if app.config["ENABLE_SCHEDULER"] and not app.config.get("TESTING"):
        reminders.start_scheduler(app.config)
    return app


# --------------------------------------------------------------------------- helpers

def stored_secret_key(folder):
    """Keep one random key on disk so people stay logged in after a restart."""
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


def get_db():
    if "db" not in g:
        from flask import current_app
        g.db = db.connect(current_app.config["DATABASE"])
    return g.db


def today():
    from flask import current_app
    return reminders.local_now(current_app.config).date()


def parse_number(value, label, whole=False):
    value = (value or "").replace(",", "").strip()
    if value == "":
        return 0
    try:
        number = int(value) if whole else round(float(value), 2)
    except ValueError:
        raise ValueError(f"Please type only numbers in '{label}'.")
    if number < 0:
        raise ValueError(f"'{label}' cannot be less than zero.")
    return number


def parse_day(value):
    try:
        day = date.fromisoformat(value) if value else today()
    except ValueError:
        day = today()
    return min(day, today())  # no entries for the future


def current_user():
    if "user" not in g:
        uid = session.get("user_id")
        g.user = None
        if uid:
            g.user = get_db().execute("SELECT * FROM users WHERE id = ? AND active = 1", (uid,)).fetchone()
    return g.user


def can(area):
    user = current_user()
    if user is None:
        return False
    if area == "owner":
        return bool(user["is_admin"])
    return reminders.user_areas(user)[area]


def requires(area=None):
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if current_user() is None:
                return redirect(url_for("login"))
            if area and not can(area):
                flash("Sorry, you don't have access to that page.", "error")
                return redirect(url_for("home"))
            return view(*args, **kwargs)
        return wrapped
    return decorator


def register_helpers(app):
    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.before_request
    def check_csrf():
        if request.method == "POST":
            token = session.get("csrf_token")
            if not token or token != request.form.get("csrf_token"):
                flash("The page was open too long. Please try again.", "error")
                return redirect(request.referrer or url_for("home"))

    def csrf_token():
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_hex(16)
        return session["csrf_token"]

    def money(value):
        value = value or 0
        text = f"{value:,.2f}".rstrip("0").rstrip(".") if value % 1 else f"{value:,.0f}"
        return f"{app.config['CURRENCY']}{text}"

    @app.context_processor
    def inject():
        return {
            "csrf_token": csrf_token,
            "me": current_user(),
            "can": can,
            "money": money,
            "kitchen_name": app.config["KITCHEN_NAME"],
            "currency": app.config["CURRENCY"],
            "today_date": today(),
            "timedelta": timedelta,
        }

    @app.template_filter("qty")
    def qty(value):
        return f"{value:g}"

    @app.template_filter("nice_date")
    def nice_date(value):
        day = date.fromisoformat(value) if isinstance(value, str) else value
        if day == today():
            return "Today"
        if day == today() - timedelta(days=1):
            return "Yesterday"
        return day.strftime("%a, %d %b")


# --------------------------------------------------------------------------- routes

def register_routes(app):
    # ---------- first-time setup, login, logout

    @app.route("/setup", methods=["GET", "POST"])
    def setup():
        conn = get_db()
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            return redirect(url_for("login"))
        if request.method == "POST":
            name = request.form.get("name", "").strip()
            pin = request.form.get("pin", "").strip()
            if not name or not (pin.isdigit() and len(pin) == 4):
                flash("Please type your name and a 4-digit PIN.", "error")
            else:
                conn.execute(
                    "INSERT INTO users (name, phone, pin_hash, is_admin, can_finance, can_inventory) "
                    "VALUES (?, ?, ?, 1, 1, 1)",
                    (name, request.form.get("phone", "").strip() or None, generate_password_hash(pin)),
                )
                conn.commit()
                flash("Done! Now log in with your PIN.", "ok")
                return redirect(url_for("login"))
        return render_template("setup.html")

    @app.route("/login")
    def login():
        conn = get_db()
        if not conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            return redirect(url_for("setup"))
        people = conn.execute("SELECT id, name FROM users WHERE active = 1 ORDER BY name").fetchall()
        return render_template("login.html", people=people)

    @app.route("/login/<int:user_id>", methods=["GET", "POST"])
    def login_pin(user_id):
        person = get_db().execute("SELECT * FROM users WHERE id = ? AND active = 1", (user_id,)).fetchone()
        if person is None:
            return redirect(url_for("login"))
        if request.method == "POST":
            if check_password_hash(person["pin_hash"], request.form.get("pin", "").strip()):
                session.clear()
                session.permanent = True
                session["user_id"] = person["id"]
                return redirect(url_for("home"))
            flash("Wrong PIN. Please try again.", "error")
        return render_template("pin.html", person=person)

    @app.route("/logout", methods=["POST"])
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---------- home

    @app.route("/")
    @requires()
    def home():
        status = reminders.daily_status(get_db(), today())
        return render_template("home.html", status=status, todo=reminders.checklist(current_user(), status))

    # ---------- money

    @app.route("/sales", methods=["GET", "POST"])
    @requires("finance")
    def sales():
        conn = get_db()
        day = parse_day(request.values.get("day"))
        if request.method == "POST":
            try:
                values = (
                    parse_number(request.form.get("orders_count"), "Number of orders", whole=True),
                    parse_number(request.form.get("sales_amount"), "Total sales"),
                    parse_number(request.form.get("money_received"), "Money received"),
                    parse_number(request.form.get("money_receivable"), "Money still to come"),
                )
            except ValueError as exc:
                flash(str(exc), "error")
                return render_template("sales.html", day=day, entry=request.form)
            conn.execute(
                """INSERT INTO finance_entries
                       (entry_date, orders_count, sales_amount, money_received, money_receivable, notes, updated_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(entry_date) DO UPDATE SET
                       orders_count = excluded.orders_count, sales_amount = excluded.sales_amount,
                       money_received = excluded.money_received, money_receivable = excluded.money_receivable,
                       notes = excluded.notes, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP""",
                (day.isoformat(), *values, request.form.get("notes", "").strip(), current_user()["id"]),
            )
            conn.commit()
            flash("Saved ✅", "ok")
            return redirect(url_for("home"))
        entry = conn.execute("SELECT * FROM finance_entries WHERE entry_date = ?", (day.isoformat(),)).fetchone()
        return render_template("sales.html", day=day, entry=entry)

    @app.route("/spent", methods=["GET", "POST"])
    @requires("finance")
    def spent():
        conn = get_db()
        day = parse_day(request.values.get("day"))
        if request.method == "POST":
            category = request.form.get("category", "")
            try:
                amount = parse_number(request.form.get("amount"), "Amount")
                if amount <= 0:
                    raise ValueError("Please type how much money was spent.")
                if category not in dict(EXPENSE_CATEGORIES):
                    raise ValueError("Please tap what the money was spent on.")
            except ValueError as exc:
                flash(str(exc), "error")
            else:
                conn.execute(
                    "INSERT INTO expenses (expense_date, category, amount, note, created_by) VALUES (?, ?, ?, ?, ?)",
                    (day.isoformat(), category, amount, request.form.get("note", "").strip(), current_user()["id"]),
                )
                conn.commit()
                flash(f"Saved ✅ {category}", "ok")
                return redirect(url_for("spent", day=day.isoformat()))
        items = conn.execute(
            "SELECT * FROM expenses WHERE expense_date = ? ORDER BY id DESC", (day.isoformat(),)
        ).fetchall()
        return render_template("spent.html", day=day, items=items, categories=EXPENSE_CATEGORIES,
                               total=sum(e["amount"] for e in items))

    @app.route("/spent/<int:expense_id>/delete", methods=["POST"])
    @requires("finance")
    def delete_spent(expense_id):
        conn = get_db()
        row = conn.execute("SELECT expense_date FROM expenses WHERE id = ?", (expense_id,)).fetchone()
        if row is None:
            abort(404)
        conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        conn.commit()
        flash("Removed.", "ok")
        return redirect(url_for("spent", day=row["expense_date"]))

    @app.route("/report")
    @requires("finance")
    def report():
        conn = get_db()
        end = today()
        start = end - timedelta(days=29)
        month_start = end.replace(day=1)
        sales_rows = {r["entry_date"]: r for r in conn.execute(
            "SELECT * FROM finance_entries WHERE entry_date BETWEEN ? AND ?", (start.isoformat(), end.isoformat()))}
        spent_rows = dict(conn.execute(
            "SELECT expense_date, SUM(amount) FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY expense_date",
            (start.isoformat(), end.isoformat())).fetchall())
        days = []
        for i in range(30):
            d = (end - timedelta(days=i)).isoformat()
            s = sales_rows.get(d)
            days.append({
                "date": d,
                "filled": s is not None,
                "orders": s["orders_count"] if s else 0,
                "sales": s["sales_amount"] if s else 0,
                "received": s["money_received"] if s else 0,
                "to_come": s["money_receivable"] if s else 0,
                "spent": spent_rows.get(d, 0),
            })
        month = [x for x in days if x["date"] >= month_start.isoformat()]
        totals = {k: sum(x[k] for x in month) for k in ("orders", "sales", "received", "to_come", "spent")}
        totals["profit"] = totals["sales"] - totals["spent"]
        by_category = conn.execute(
            "SELECT category, SUM(amount) AS total FROM expenses WHERE expense_date BETWEEN ? AND ? "
            "GROUP BY category ORDER BY total DESC", (month_start.isoformat(), end.isoformat())).fetchall()
        return render_template("report.html", days=days, totals=totals, by_category=by_category,
                               month_label=end.strftime("%B %Y"))

    @app.route("/report/download")
    @requires("finance")
    def report_download():
        conn = get_db()
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["Date", "Orders", "Sales", "Money received", "Money still to come", "Notes"])
        for r in conn.execute("SELECT * FROM finance_entries ORDER BY entry_date"):
            writer.writerow([r["entry_date"], r["orders_count"], r["sales_amount"], r["money_received"],
                             r["money_receivable"], r["notes"] or ""])
        writer.writerow([])
        writer.writerow(["Date", "Spent on", "Amount", "Note"])
        for r in conn.execute("SELECT * FROM expenses ORDER BY expense_date, id"):
            writer.writerow([r["expense_date"], r["category"], r["amount"], r["note"] or ""])
        return Response(out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=kitchen-money.csv"})

    # ---------- stock

    @app.route("/stock", methods=["GET", "POST"])
    @requires("inventory")
    def stock():
        conn = get_db()
        items = conn.execute("SELECT * FROM inventory_items ORDER BY name").fetchall()
        if request.method == "POST":
            changed = 0
            for item in items:
                raw = request.form.get(f"qty_{item['id']}")
                if raw is None or raw.strip() == "":
                    continue
                try:
                    new_qty = parse_number(raw, item["name"])
                except ValueError as exc:
                    flash(str(exc), "error")
                    return redirect(url_for("stock"))
                conn.execute(
                    "INSERT INTO inventory_log (item_id, log_date, old_qty, new_qty, user_id) VALUES (?, ?, ?, ?, ?)",
                    (item["id"], today().isoformat(), item["quantity"], new_qty, current_user()["id"]),
                )
                conn.execute(
                    "UPDATE inventory_items SET quantity = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (new_qty, current_user()["id"], item["id"]),
                )
                changed += 1
            conn.commit()
            flash(f"Saved ✅ ({changed} item(s) updated)" if changed else "Nothing was changed.", "ok")
            return redirect(url_for("home") if changed else url_for("stock"))
        updated_today = {r[0] for r in conn.execute(
            "SELECT DISTINCT item_id FROM inventory_log WHERE log_date = ?", (today().isoformat(),))}
        return render_template("stock.html", items=items, updated_today=updated_today)

    @app.route("/stock/new", methods=["GET", "POST"])
    @requires("inventory")
    def stock_new():
        conn = get_db()
        if request.method == "POST":
            name = request.form.get("name", "").strip()
            unit = request.form.get("unit", "kg")
            try:
                if not name:
                    raise ValueError("Please type the item name.")
                quantity = parse_number(request.form.get("quantity"), "How much do you have now")
                reorder = parse_number(request.form.get("reorder_level"), "Warn me when it goes below")
                conn.execute(
                    "INSERT INTO inventory_items (name, unit, quantity, reorder_level, updated_by) VALUES (?, ?, ?, ?, ?)",
                    (name, unit if unit in UNITS else "kg", quantity, reorder, current_user()["id"]),
                )
                conn.commit()
            except ValueError as exc:
                flash(str(exc), "error")
            except db.sqlite3.IntegrityError:
                flash(f"'{name}' is already in the list.", "error")
            else:
                flash(f"Added ✅ {name}", "ok")
                return redirect(url_for("stock_new") if request.form.get("again") else url_for("stock"))
        return render_template("stock_new.html", units=UNITS)

    @app.route("/stock/<int:item_id>/edit", methods=["GET", "POST"])
    @requires("inventory")
    def stock_edit(item_id):
        conn = get_db()
        item = conn.execute("SELECT * FROM inventory_items WHERE id = ?", (item_id,)).fetchone()
        if item is None:
            abort(404)
        if request.method == "POST":
            if request.form.get("delete"):
                conn.execute("DELETE FROM inventory_items WHERE id = ?", (item_id,))
                conn.commit()
                flash(f"Removed {item['name']}.", "ok")
                return redirect(url_for("stock"))
            try:
                name = request.form.get("name", "").strip() or item["name"]
                unit = request.form.get("unit", item["unit"])
                reorder = parse_number(request.form.get("reorder_level"), "Warn me when it goes below")
                conn.execute("UPDATE inventory_items SET name = ?, unit = ?, reorder_level = ? WHERE id = ?",
                             (name, unit if unit in UNITS else item["unit"], reorder, item_id))
                conn.commit()
            except ValueError as exc:
                flash(str(exc), "error")
            except db.sqlite3.IntegrityError:
                flash("Another item already has that name.", "error")
            else:
                flash("Saved ✅", "ok")
                return redirect(url_for("stock"))
        return render_template("stock_edit.html", item=item, units=UNITS)

    @app.route("/buy", methods=["GET", "POST"])
    @requires("inventory")
    def buy():
        conn = get_db()
        if request.method == "POST":
            name = request.form.get("item_name", "").strip()
            try:
                if not name:
                    raise ValueError("Please type what needs to be bought.")
                quantity = parse_number(request.form.get("quantity"), "How much")
            except ValueError as exc:
                flash(str(exc), "error")
            else:
                known = conn.execute("SELECT unit FROM inventory_items WHERE name = ?", (name,)).fetchone()
                conn.execute(
                    "INSERT INTO inventory_requests (item_name, quantity, unit, note, created_by) VALUES (?, ?, ?, ?, ?)",
                    (name, quantity, request.form.get("unit") or (known["unit"] if known else ""),
                     request.form.get("note", "").strip(), current_user()["id"]),
                )
                conn.commit()
                flash(f"Added ✅ {name}", "ok")
                return redirect(url_for("buy"))
        open_items = conn.execute(
            "SELECT r.*, u.name AS who FROM inventory_requests r LEFT JOIN users u ON u.id = r.created_by "
            "WHERE r.status = 'open' ORDER BY r.created_at").fetchall()
        on_list = {r["item_name"].lower() for r in open_items}
        low = [i for i in conn.execute(
            "SELECT * FROM inventory_items WHERE quantity <= reorder_level ORDER BY name") if i["name"].lower() not in on_list]
        bought = conn.execute(
            "SELECT * FROM inventory_requests WHERE status = 'received' ORDER BY id DESC LIMIT 10").fetchall()
        names = [r["name"] for r in conn.execute("SELECT name FROM inventory_items ORDER BY name")]
        return render_template("buy.html", open_items=open_items, low=low, bought=bought, names=names, units=UNITS)

    @app.route("/buy/<int:request_id>/<action>", methods=["POST"])
    @requires("inventory")
    def buy_action(request_id, action):
        conn = get_db()
        req = conn.execute("SELECT * FROM inventory_requests WHERE id = ?", (request_id,)).fetchone()
        if req is None or action not in ("bought", "remove"):
            abort(404)
        if action == "remove":
            conn.execute("UPDATE inventory_requests SET status = 'cancelled' WHERE id = ?", (request_id,))
            flash(f"Removed {req['item_name']} from the list.", "ok")
        else:
            conn.execute("UPDATE inventory_requests SET status = 'received' WHERE id = ?", (request_id,))
            item = conn.execute("SELECT * FROM inventory_items WHERE name = ?", (req["item_name"],)).fetchone()
            if item is not None:  # bought stock goes straight into the kitchen count
                new_qty = item["quantity"] + req["quantity"]
                conn.execute(
                    "INSERT INTO inventory_log (item_id, log_date, old_qty, new_qty, note, user_id) "
                    "VALUES (?, ?, ?, ?, 'bought', ?)",
                    (item["id"], today().isoformat(), item["quantity"], new_qty, current_user()["id"]),
                )
                conn.execute("UPDATE inventory_items SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                             (new_qty, item["id"]))
            flash(f"Bought ✅ {req['item_name']}", "ok")
        conn.commit()
        return redirect(url_for("buy"))

    # ---------- people (owner only) and own account

    @app.route("/people")
    @requires("owner")
    def people():
        conn = get_db()
        users = conn.execute("SELECT * FROM users ORDER BY active DESC, name").fetchall()
        last = {r["user_id"]: r for r in conn.execute(
            "SELECT * FROM reminder_log WHERE (user_id, sent_date) IN "
            "(SELECT user_id, MAX(sent_date) FROM reminder_log GROUP BY user_id)")}
        cfg = app.config
        return render_template("people.html", users=users, last=last,
                               whatsapp_on=bool(cfg["TWILIO_ACCOUNT_SID"]), email_on=bool(cfg["SMTP_HOST"]),
                               reminder_time=cfg["REMINDER_TIME"])

    @app.route("/people/new", methods=["GET", "POST"])
    @app.route("/people/<int:user_id>", methods=["GET", "POST"])
    @requires("owner")
    def person(user_id=None):
        conn = get_db()
        person = None
        if user_id is not None:
            person = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if person is None:
                abort(404)
        if request.method == "POST":
            f = request.form
            name, pin = f.get("name", "").strip(), f.get("pin", "").strip()
            flags = {k: 1 if f.get(k) else 0 for k in ("is_admin", "can_finance", "can_inventory", "reminders_enabled", "active")}
            if person is None:
                flags["active"] = 1
            if person is not None and person["id"] == current_user()["id"]:
                flags["is_admin"], flags["active"] = 1, 1  # don't lock yourself out
            error = None
            if not name:
                error = "Please type a name."
            elif person is None and not pin:
                error = "Please give them a 4-digit PIN."
            elif pin and not (pin.isdigit() and len(pin) == 4):
                error = "The PIN must be exactly 4 numbers."
            if error:
                flash(error, "error")
                return render_template("person.html", person=f, is_new=person is None)
            values = dict(name=name, phone=f.get("phone", "").strip() or None,
                          email=f.get("email", "").strip() or None, **flags)
            try:
                if person is None:
                    values["pin_hash"] = generate_password_hash(pin)
                    cols = ", ".join(values)
                    conn.execute(f"INSERT INTO users ({cols}) VALUES ({', '.join('?' * len(values))})",
                                 tuple(values.values()))
                else:
                    if pin:
                        values["pin_hash"] = generate_password_hash(pin)
                    sets = ", ".join(f"{k} = ?" for k in values)
                    conn.execute(f"UPDATE users SET {sets} WHERE id = ?", (*values.values(), person["id"]))
                conn.commit()
            except db.sqlite3.IntegrityError:
                flash("Someone with that name already exists.", "error")
                return render_template("person.html", person=f, is_new=person is None)
            flash(f"Saved ✅ {name}", "ok")
            return redirect(url_for("people"))
        return render_template("person.html", person=person, is_new=person is None)

    @app.route("/people/remind-now", methods=["POST"])
    @requires("owner")
    def remind_now():
        results = reminders.send_daily_reminders(get_db(), app.config, today(), force=True)
        if results:
            flash("Reminders: " + "; ".join(f"{n} - {r}" for n, r in results), "ok")
        else:
            flash("Nobody has reminders turned on.", "error")
        return redirect(url_for("people"))

    @app.route("/account", methods=["GET", "POST"])
    @requires()
    def account():
        conn = get_db()
        me = current_user()
        if request.method == "POST":
            pin = request.form.get("pin", "").strip()
            if pin and not (pin.isdigit() and len(pin) == 4):
                flash("The PIN must be exactly 4 numbers.", "error")
                return redirect(url_for("account"))
            conn.execute("UPDATE users SET reminders_enabled = ?, phone = ? WHERE id = ?",
                         (1 if request.form.get("reminders_enabled") else 0,
                          request.form.get("phone", "").strip() or None, me["id"]))
            if pin:
                conn.execute("UPDATE users SET pin_hash = ? WHERE id = ?", (generate_password_hash(pin), me["id"]))
            conn.commit()
            flash("Saved ✅", "ok")
            return redirect(url_for("home"))
        return render_template("account.html")

    @app.route("/manifest.webmanifest")
    def manifest():
        return {
            "name": app.config["KITCHEN_NAME"],
            "short_name": "Kitchen",
            "start_url": "/",
            "display": "standalone",
            "background_color": "#fffaf3",
            "theme_color": "#e8590c",
            "icons": [{"src": url_for("static", filename="icon.svg"), "sizes": "any", "type": "image/svg+xml"}],
        }


# --------------------------------------------------------------------------- CLI

def register_commands(app):
    @app.cli.command("send-reminders")
    @click.option("--force", is_flag=True, help="Send again even if today's reminder already went out.")
    def send_reminders_command(force):
        """Send today's reminders (use from cron or Airflow instead of the built-in scheduler)."""
        conn = db.connect(app.config["DATABASE"])
        try:
            day = reminders.local_now(app.config).date()
            for name, result in reminders.send_daily_reminders(conn, app.config, day, force=force):
                click.echo(f"{name}: {result}")
        finally:
            conn.close()

    @app.cli.command("reset-pin")
    @click.argument("name")
    @click.argument("pin")
    def reset_pin_command(name, pin):
        """Reset someone's PIN if they (or the owner) forget it."""
        if not (pin.isdigit() and len(pin) == 4):
            raise click.BadParameter("PIN must be 4 digits")
        conn = db.connect(app.config["DATABASE"])
        changed = conn.execute("UPDATE users SET pin_hash = ?, active = 1 WHERE name = ?",
                               (generate_password_hash(pin), name)).rowcount
        conn.commit()
        conn.close()
        click.echo("PIN changed." if changed else f"No person called {name!r}.")


app = create_app() if os.environ.get("KITCHEN_NO_AUTOAPP") != "1" else None

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
