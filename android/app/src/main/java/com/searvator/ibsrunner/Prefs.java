package com.searvator.ibsrunner;

import android.content.Context;
import android.content.SharedPreferences;

/** Small wrapper around SharedPreferences so the rest of the app stays readable. */
public class Prefs {
    private static final String FILE = "ibs_runner";
    private final SharedPreferences sp;

    public Prefs(Context c) {
        sp = c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public String server() { return sp.getString("server", BuildConfig.DEFAULT_SERVER); }
    public void setServer(String v) { sp.edit().putString("server", trimSlash(v)).apply(); }

    public String token() { return sp.getString("token", ""); }
    public String name() { return sp.getString("name", ""); }
    public String userId() { return sp.getString("userId", ""); }

    public void setSession(String token, String userId, String name) {
        sp.edit().putString("token", token).putString("userId", userId).putString("name", name).apply();
    }
    public void clearSession() { sp.edit().remove("token").remove("userId").remove("name").apply(); }
    public boolean signedIn() { return token().length() > 0; }

    public int pollSeconds() { return sp.getInt("poll", 5); }
    public int pingSeconds() { return sp.getInt("ping", 20); }
    public void setIntervals(int poll, int ping) {
        sp.edit().putInt("poll", Math.max(3, poll)).putInt("ping", Math.max(10, ping)).apply();
    }

    public boolean onDuty() { return sp.getBoolean("onDuty", false); }
    public void setOnDuty(boolean v) { sp.edit().putBoolean("onDuty", v).apply(); }

    public String queue() { return sp.getString("pingQueue", "[]"); }
    public void setQueue(String json) { sp.edit().putString("pingQueue", json).apply(); }

    private static String trimSlash(String s) {
        String v = s == null ? "" : s.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }
}
