package com.kitchenbook.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts listening for orders again after the phone restarts or the app is updated. */
public class StartReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String code = context.getSharedPreferences(OrderAlertService.PREFS, Context.MODE_PRIVATE).getString("code", "");
        if (!code.isEmpty()) {
            try {
                OrderAlertService.start(context);
            } catch (Exception ignored) {
            }
        }
    }
}
