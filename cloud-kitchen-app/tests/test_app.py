import os
import sys
from datetime import date

import pytest

os.environ["KITCHEN_NO_AUTOAPP"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as kitchen  # noqa: E402
import db  # noqa: E402
import reminders  # noqa: E402


@pytest.fixture
def app(tmp_path):
    return kitchen.create_app({"TESTING": True, "DATABASE": str(tmp_path / "test.db"), "SECRET_KEY": "test"})


@pytest.fixture
def client(app):
    return app.test_client()


def token(client):
    with client.session_transaction() as s:
        s.setdefault("csrf_token", "tok")
        return s["csrf_token"]


def post(client, url, **data):
    return client.post(url, data={"csrf_token": token(client), **data}, follow_redirects=True)


def login(client, name, pin):
    conn = db.connect(client.application.config["DATABASE"])
    uid = conn.execute("SELECT id FROM users WHERE name = ?", (name,)).fetchone()[0]
    conn.close()
    return post(client, f"/login/{uid}", pin=pin)


def setup_owner(client):
    post(client, "/setup", name="Papa", pin="1234", phone="+919800000000")
    login(client, "Papa", "1234")


def add_person(client, name, pin, **flags):
    return post(client, "/people/new", name=name, pin=pin, reminders_enabled="1", **flags)


def test_first_run_goes_to_setup_then_login(client):
    assert client.get("/").headers["Location"].endswith("/login")
    assert client.get("/login").headers["Location"].endswith("/setup")
    setup_owner(client)
    page = client.get("/").get_data(as_text=True)
    assert "Namaste, Papa" in page and "Today's Sales" in page and "People" in page


def test_wrong_pin_rejected(client):
    post(client, "/setup", name="Papa", pin="1234")
    assert "Wrong PIN" in login(client, "Papa", "9999").get_data(as_text=True)
    assert client.get("/").status_code == 302


def test_post_without_csrf_token_is_rejected(client):
    setup_owner(client)
    client.post("/sales", data={"orders_count": "5"})
    conn = db.connect(client.application.config["DATABASE"])
    assert conn.execute("SELECT COUNT(*) FROM finance_entries").fetchone()[0] == 0


def test_sales_and_expenses(client):
    setup_owner(client)
    page = post(client, "/sales", orders_count="42", sales_amount="12,500", money_received="9000",
                money_receivable="3500").get_data(as_text=True)
    assert "Saved" in page
    # saving again for the same day updates instead of duplicating
    post(client, "/sales", orders_count="43", sales_amount="12600", money_received="9100", money_receivable="3500")
    page = post(client, "/spent", amount="800", category="Packaging", note="boxes").get_data(as_text=True)
    assert "₹800" in page
    assert "Please type only numbers" in post(client, "/sales", orders_count="abc").get_data(as_text=True)
    report = client.get("/report").get_data(as_text=True)
    assert "₹12,600" in report and "₹11,800" in report  # sales and sales - spent
    csv_text = client.get("/report/download").get_data(as_text=True)
    assert "43" in csv_text and "Packaging" in csv_text


def test_stock_and_buy_list(client):
    setup_owner(client)
    post(client, "/stock/new", name="Onion", unit="kg", quantity="20", reorder_level="5")
    conn = db.connect(client.application.config["DATABASE"])
    item_id = conn.execute("SELECT id FROM inventory_items").fetchone()[0]
    post(client, "/stock", **{f"qty_{item_id}": "3"})
    page = client.get("/buy").get_data(as_text=True)
    assert "Running low" in page and "Onion" in page
    post(client, "/buy", item_name="Onion", quantity="10", unit="kg")
    req_id = conn.execute("SELECT id FROM inventory_requests").fetchone()[0]
    post(client, f"/buy/{req_id}/bought")
    assert conn.execute("SELECT quantity FROM inventory_items").fetchone()[0] == 13


def test_access_is_split_between_money_and_stock_people(client):
    setup_owner(client)
    add_person(client, "Ravi", "1111", can_inventory="1")
    add_person(client, "Meena", "2222", can_finance="1")
    post(client, "/logout")

    login(client, "Ravi", "1111")
    home = client.get("/").get_data(as_text=True)
    assert "Stock Left" in home and "Today's Sales" not in home
    assert client.get("/sales").status_code == 302
    assert client.get("/report").status_code == 302
    assert client.get("/people").status_code == 302
    assert client.get("/stock").status_code == 200
    post(client, "/logout")

    login(client, "Meena", "2222")
    assert client.get("/stock").status_code == 302
    assert client.get("/buy").status_code == 302
    assert client.get("/sales").status_code == 200


def test_reminders_content_and_dedupe(app, client):
    setup_owner(client)
    add_person(client, "Ravi", "1111", can_inventory="1")
    conn = db.connect(app.config["DATABASE"])
    day = date(2026, 10, 21)

    first = reminders.send_daily_reminders(conn, app.config, day)
    assert sorted(n for n, _ in first) == ["Papa", "Ravi"]
    assert all(r == "logged only" for _, r in first)  # no WhatsApp/email configured
    assert reminders.send_daily_reminders(conn, app.config, day) == []  # only once per day
    assert len(reminders.send_daily_reminders(conn, app.config, day, force=True)) == 2

    ravi = conn.execute("SELECT * FROM users WHERE name = 'Ravi'").fetchone()
    subject, body, pending = reminders.build_message(ravi, reminders.daily_status(conn, day))
    assert pending == 1 and "Stock left" in body and "sales" not in body.lower()

    papa = conn.execute("SELECT * FROM users WHERE name = 'Papa'").fetchone()
    _, body, pending = reminders.build_message(papa, reminders.daily_status(conn, day))
    assert pending == 3 and "❌ Today's sales and money" in body


def test_reminders_sent_by_whatsapp_when_configured(app, client, monkeypatch):
    setup_owner(client)
    sent = []
    monkeypatch.setattr(reminders, "send_whatsapp", lambda cfg, phone, body: sent.append(phone))
    app.config["TWILIO_ACCOUNT_SID"] = "AC123"
    conn = db.connect(app.config["DATABASE"])
    results = reminders.send_daily_reminders(conn, app.config, date(2026, 10, 21))
    assert results == [("Papa", "sent by whatsapp")] and sent == ["+919800000000"]


def test_pages_render(client):
    setup_owner(client)
    for url in ["/", "/sales", "/sales?day=2000-01-01", "/spent", "/report", "/stock", "/stock/new",
                "/buy", "/people", "/people/new", "/account", "/manifest.webmanifest"]:
        assert client.get(url).status_code == 200, url
