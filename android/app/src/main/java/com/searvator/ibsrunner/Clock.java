package com.searvator.ibsrunner;

import android.content.Context;
import android.os.SystemClock;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Time handling for every on-screen counter.
 *
 * Two problems this solves:
 *
 * 1. The old timers rebuilt themselves from a whole-minute figure the server sent on every
 *    poll ("42 minutes") and then added the seconds since that poll landed. Because the
 *    server figure was rounded down, the watch jumped backwards every few seconds. Now the
 *    server sends the *start timestamp* and the app counts from that, so the number only
 *    ever goes up.
 *
 * 2. A runner's phone clock can be minutes or hours off, and the whole TAT report depends on
 *    timing. So we keep an offset (serverTime - deviceTime) captured on every API call and
 *    add it wherever a time is needed. The elapsed part of a running timer is measured with
 *    elapsedRealtime(), which no setting on the phone can move.
 */
public class Clock {

    private static long offsetMillis = 0;      // serverTime - deviceTime
    private static long offsetTakenAtBoot = 0; // elapsedRealtime when the offset was captured
    private static boolean haveOffset = false;

    /** Called after every successful API response that carried serverTime. */
    public static synchronized void syncFromServer(Context c, String serverIso) {
        Long server = parseIso(serverIso);
        if (server == null) return;
        offsetMillis = server - System.currentTimeMillis();
        offsetTakenAtBoot = SystemClock.elapsedRealtime();
        haveOffset = true;
        if (c != null) new Prefs(c).setClockOffset(offsetMillis);
    }

    /** Restores the last known offset when the app starts, before the first call returns. */
    public static synchronized void restore(Context c) {
        if (haveOffset) return;
        offsetMillis = new Prefs(c).clockOffset();
        offsetTakenAtBoot = SystemClock.elapsedRealtime();
    }

    /** Best guess at the real time right now, in millis. */
    public static synchronized long now() {
        return System.currentTimeMillis() + offsetMillis;
    }

    /** Milliseconds elapsed since an ISO timestamp, never negative. */
    public static long since(String iso) {
        Long t = parseIso(iso);
        if (t == null) return -1;
        long d = now() - t;
        return d < 0 ? 0 : d;
    }

    /** ISO-8601 UTC string for right now, for actions queued offline. */
    public static String nowIso() { return iso(now()); }

    public static String iso(long millis) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(millis));
    }

    /** Parses the ISO strings Mongo/Express hand out. Returns null on anything unexpected. */
    public static Long parseIso(String iso) {
        if (iso == null || iso.length() < 19) return null;
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.parse(iso.substring(0, 19)).getTime();
        } catch (Exception e) {
            return null;
        }
    }

    /** 1:04:09 or 04:09 - a running counter that always moves forward. */
    public static String hms(long seconds) {
        if (seconds < 0) seconds = 0;
        long h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60;
        return (h > 0 ? h + ":" : "") + String.format(Locale.US, "%02d:%02d", m, s);
    }

    /** 7h 24m - for totals that are read, not watched. */
    public static String hm(long minutes) {
        if (minutes < 0) minutes = 0;
        long h = minutes / 60, m = minutes % 60;
        return h > 0 ? h + "h " + m + "m" : m + "m";
    }

    /** 3:45 PM in the phone's own timezone. */
    public static String clockTime(String iso) {
        Long t = parseIso(iso);
        if (t == null) return "--:--";
        SimpleDateFormat f = new SimpleDateFormat("h:mm a", Locale.US);
        return f.format(new Date(t));
    }

    /** Friendly day label for the trip list: Today / Yesterday / Mon 15 Sep. */
    public static String dayLabel(String yyyymmdd, String todayStr) {
        if (yyyymmdd == null) return "";
        if (yyyymmdd.equals(todayStr)) return "Today";
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            Date d = in.parse(yyyymmdd);
            Date today = in.parse(todayStr);
            long diff = (today.getTime() - d.getTime()) / (24L * 3600 * 1000);
            if (diff == 1) return "Yesterday";
            return new SimpleDateFormat("EEE d MMM", Locale.US).format(d);
        } catch (Exception e) {
            return yyyymmdd;
        }
    }
}
