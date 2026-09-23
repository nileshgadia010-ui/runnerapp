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

    /* ---- server + session ---- */

    public String server() { return sp.getString("server", BuildConfig.DEFAULT_SERVER); }
    public void setServer(String v) { sp.edit().putString("server", trimSlash(v)).apply(); }

    public String token() { return sp.getString("token", ""); }
    public String name() { return sp.getString("name", ""); }
    public String userId() { return sp.getString("userId", ""); }
    public String empCode() { return sp.getString("empCode", ""); }

    public void setSession(String token, String userId, String name, String empCode) {
        sp.edit().putString("token", token).putString("userId", userId)
                .putString("name", name).putString("empCode", empCode == null ? "" : empCode).apply();
    }
    public void clearSession() {
        sp.edit().remove("token").remove("userId").remove("name").remove("empCode").apply();
    }
    public boolean signedIn() { return token().length() > 0; }

    /* ---- intervals ---- */

    public int pollSeconds() { return sp.getInt("poll", 5); }

    /** How often to upload a position while carrying a job. */
    public int pingSeconds() { return sp.getInt("ping", 8); }

    /** The slower rate used when the runner is punched in but has nothing to do. */
    public int idlePingSeconds() { return sp.getInt("pingIdle", 30); }

    public void setIntervals(int poll, int ping, int idlePing) {
        sp.edit().putInt("poll", Math.max(3, poll))
                .putInt("ping", Math.max(5, ping))
                .putInt("pingIdle", Math.max(10, idlePing)).apply();
    }

    /* ---- duty state ---- */

    public boolean onDuty() { return sp.getBoolean("onDuty", false); }
    public void setOnDuty(boolean v) { sp.edit().putBoolean("onDuty", v).apply(); }

    /** Last odometer reading we sent, so the next screen can pre-check a silly entry. */
    public int lastOdo() { return sp.getInt("lastOdo", 0); }
    public void setLastOdo(int v) { sp.edit().putInt("lastOdo", v).apply(); }

    /* ---- clock offset ----
     * serverMillis - deviceMillis at the moment of the last successful call. Timers add this
     * to the device clock so they stay right even if the runner's phone date is wrong. */
    public long clockOffset() { return sp.getLong("clockOffset", 0L); }
    public void setClockOffset(long v) { sp.edit().putLong("clockOffset", v).apply(); }

    /* ---- offline queues ---- */

    /** Location pings that could not be uploaded yet. */
    public String pingQueue() { return sp.getString("pingQueue", "[]"); }
    public void setPingQueue(String json) { sp.edit().putString("pingQueue", json).apply(); }

    /** Actions (punch in/out, stage changes, break) that could not be uploaded yet. */
    public String actionQueue() { return sp.getString("actionQueue", "[]"); }
    public void setActionQueue(String json) { sp.edit().putString("actionQueue", json).apply(); }

    /** Cached copy of the last /poll response, so the home screen has something to draw offline. */
    public String lastPoll() { return sp.getString("lastPoll", ""); }
    public void setLastPoll(String json) { sp.edit().putString("lastPoll", json).apply(); }

    /** Cached day summary, same reason. */
    public String lastSummary() { return sp.getString("lastSummary", ""); }
    public void setLastSummary(String json) { sp.edit().putString("lastSummary", json).apply(); }

    /** Cached trip list. */
    public String lastTrips() { return sp.getString("lastTrips", ""); }
    public void setLastTrips(String json) { sp.edit().putString("lastTrips", json).apply(); }

    private static String trimSlash(String s) {
        String v = s == null ? "" : s.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }
}
