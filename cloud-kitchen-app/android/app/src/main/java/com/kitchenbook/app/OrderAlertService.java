package com.kitchenbook.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.NumberFormat;
import java.util.Locale;

/**
 * Keeps a connection to the kitchen's private order topic while the phone is on, so a
 * notification appears for every order taken on another phone, even when the app is closed.
 * Received events are also kept in an inbox file that the app screens pick up when opened.
 */
public class OrderAlertService extends Service {
    static final String PREFS = "kitchen";
    private static final String CH_ORDERS = "orders";
    private static final String CH_QUIET = "listening";
    private static final int ONGOING_ID = 1;
    private static final Object INBOX_LOCK = new Object();

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private Thread worker;
    private int nextId = 100;

    static void start(Context c) {
        ContextCompat.startForegroundService(c, new Intent(c, OrderAlertService.class));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, OrderAlertService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel orders = new NotificationChannel(CH_ORDERS, "New orders", NotificationManager.IMPORTANCE_HIGH);
        orders.setDescription("A notification for every order taken on another phone");
        nm.createNotificationChannel(orders);
        NotificationChannel quiet = new NotificationChannel(CH_QUIET, "Ready for orders", NotificationManager.IMPORTANCE_MIN);
        quiet.setDescription("Shown while the app listens for orders");
        nm.createNotificationChannel(quiet);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification ongoing = new NotificationCompat.Builder(this, CH_QUIET)
                .setSmallIcon(R.drawable.ic_stat_order)
                .setContentTitle("Kitchen Book is ready for orders")
                .setContentIntent(openApp())
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0;
        ServiceCompat.startForeground(this, ONGOING_ID, ongoing, type);
        if (worker == null) {
            running = true;
            worker = new Thread(this::loop, "order-alerts");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void loop() {
        long wait = 5000;
        while (running) {
            try {
                SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
                String code = p.getString("code", "");
                if (code.isEmpty()) {
                    stopSelf();
                    return;
                }
                KitchenCrypto k = KitchenCrypto.forCode(code);
                String server = p.getString("server", "https://ntfy.sh");
                String since = p.getString("last", "");
                if (since.isEmpty()) since = "1m";
                URL url = new URL(server + "/" + k.topic + "/json?since=" + URLEncoder.encode(since, "UTF-8"));
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(120000);   // the server sends a keep-alive line every ~45 s
                try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    wait = 5000;
                    String line;
                    while (running && (line = r.readLine()) != null) handle(line, k, p);
                }
            } catch (Exception ignored) {
                // no internet or server busy: try again a little later
            } finally {
                HttpURLConnection c = conn;
                if (c != null) c.disconnect();
            }
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                return;
            }
            wait = Math.min(wait * 2, 60000);
        }
    }

    private void handle(String line, KitchenCrypto k, SharedPreferences p) {
        try {
            JSONObject m = new JSONObject(line);
            if (!"message".equals(m.optString("event"))) return;
            p.edit().putString("last", m.optString("id")).apply();
            String text = k.open(m.optString("message"));
            if (text == null) return;
            JSONObject ev = new JSONObject(text);
            addToInbox(this, ev);
            if (ev.optString("from").equals(p.getString("device", ""))) return;   // taken on this phone
            notifyFor(ev);
        } catch (Exception ignored) {
        }
    }

    private void notifyFor(JSONObject ev) {
        String t = ev.optString("t");
        String title, body;
        if ("order".equals(t)) {
            JSONObject o = ev.optJSONObject("o");
            if (o == null) return;
            String name = o.optString("name", "");
            title = "🛎️ New order · " + (name.isEmpty() ? "Customer" : name) + " · " + rupees(o.optDouble("total", 0));
            StringBuilder sb = new StringBuilder();
            JSONArray items = o.optJSONArray("items");
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                if (sb.length() > 0) sb.append(", ");
                sb.append(qty(it.optDouble("qty", 1))).append("× ").append(it.optString("name"));
            }
            if (!o.optBoolean("paid", true)) sb.append(" · pay later");
            String mobile = o.optString("mobile", "");
            if (!mobile.isEmpty()) sb.append(" · ").append(mobile);
            String by = ev.optString("by", "");
            if (!by.isEmpty()) sb.append(" · by ").append(by);
            body = sb.toString();
        } else if ("cancel".equals(t) || "undo".equals(t)) {
            String name = ev.optString("name", "");
            title = "❌ Order cancelled · " + (name.isEmpty() ? "Customer" : name);
            body = rupees(ev.optDouble("total", 0)) + ("undo".equals(t) ? " · removed right after taking it" : "");
        } else {
            return;   // payments etc. don't need a notification
        }
        Notification n = new NotificationCompat.Builder(this, CH_ORDERS)
                .setSmallIcon(R.drawable.ic_stat_order)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .build();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT < 33 || nm.areNotificationsEnabled()) nm.notify(nextId++, n);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static String rupees(double v) {
        NumberFormat f = NumberFormat.getNumberInstance(new Locale("en", "IN"));
        f.setMaximumFractionDigits(2);
        return "₹" + f.format(v);
    }

    private static String qty(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }

    // ---------- inbox shared with the app screens

    static void addToInbox(Context c, JSONObject ev) {
        synchronized (INBOX_LOCK) {
            try (FileOutputStream out = new FileOutputStream(new File(c.getFilesDir(), "inbox.jsonl"), true)) {
                out.write((ev.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {
            }
        }
    }

    static String takeInbox(Context c) {
        synchronized (INBOX_LOCK) {
            File f = new File(c.getFilesDir(), "inbox.jsonl");
            JSONArray all = new JSONArray();
            if (!f.exists()) return "[]";
            try {
                for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                    if (!line.trim().isEmpty()) all.put(new JSONObject(line));
                }
            } catch (Exception ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            return all.toString();
        }
    }
}
