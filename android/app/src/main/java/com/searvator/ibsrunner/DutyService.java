package com.searvator.ibsrunner;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Runs the whole time the runner is punched in.
 *
 *  - keeps a GPS fix and pushes it to the server every few seconds
 *  - asks the server every few seconds whether a new job has been assigned
 *  - when a job arrives it plays an alarm on the ALARM stream, so it is heard
 *    even if the phone is on silent, and throws up a full screen alert
 */
public class DutyService extends Service {

    public static final String ACTION_START = "start";
    public static final String ACTION_STOP = "stop";
    public static final String ACTION_STOP_ALARM = "stop_alarm";
    public static final String BROADCAST_UPDATE = "com.searvator.ibsrunner.UPDATE";

    private static final String CH_DUTY = "ibs_duty";
    private static final String CH_JOB = "ibs_job";
    private static final int NOTE_DUTY = 101;
    private static final int NOTE_JOB = 102;

    private Prefs prefs;
    private Api api;
    private LocationManager lm;
    private Location last;
    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wake;

    private final Handler loop = new Handler(Looper.getMainLooper());
    private long lastPingAt = 0;
    private String ringingTripId = null;
    private boolean running = false;

    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location location) { last = location; }
        @Override public void onProviderEnabled(String p) { }
        @Override public void onProviderDisabled(String p) { }
        @Override public void onStatusChanged(String p, int s, android.os.Bundle e) { }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        api = new Api(this);
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : String.valueOf(intent.getAction());

        if (ACTION_STOP.equals(action)) {
            stopAlarm();
            stopTracking();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP_ALARM.equals(action)) {
            stopAlarm();
            return START_STICKY;
        }

        startForeground(NOTE_DUTY, dutyNotification("On duty", "Location is being shared with the IBS desk"));
        startTracking();
        if (!running) {
            running = true;
            loop.post(tick);
        }
        return START_STICKY;
    }

    /* ---------------- location ---------------- */

    private void startTracking() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 8000, 15, listener, Looper.getMainLooper());
        } catch (Exception ignored) { }
        try {
            lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000, 25, listener, Looper.getMainLooper());
        } catch (Exception ignored) { }
        try {
            Location gps = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            last = gps != null ? gps : net;
        } catch (Exception ignored) { }

        if (wake == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ibs:duty");
            wake.acquire();
        }
    }

    private void stopTracking() {
        try { lm.removeUpdates(listener); } catch (Exception ignored) { }
        if (wake != null && wake.isHeld()) { wake.release(); wake = null; }
        running = false;
        loop.removeCallbacksAndMessages(null);
    }

    public Location lastLocation() { return last; }

    /* ---------------- the loop ---------------- */

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            new Thread(DutyService.this::cycle).start();
            loop.postDelayed(this, Math.max(3, prefs.pollSeconds()) * 1000L);
        }
    };

    private void cycle() {
        if (!prefs.signedIn()) return;

        // 1. push location (batched, so a dead network does not lose the trail)
        long now = System.currentTimeMillis();
        if (last != null && now - lastPingAt >= prefs.pingSeconds() * 1000L) {
            lastPingAt = now;
            queuePing(last);
            flushQueue();
        }

        // 2. ask for work
        JSONObject poll = api.getSync("/api/runner/poll");
        if (poll == null) return;

        if (poll.has("config")) {
            JSONObject cfg = poll.optJSONObject("config");
            if (cfg != null) prefs.setIntervals(cfg.optInt("pollInterval", 5), cfg.optInt("pingInterval", 20));
        }

        JSONObject trip = poll.optJSONObject("trip");
        boolean ring = poll.optBoolean("ring", false);

        Intent b = new Intent(BROADCAST_UPDATE);
        b.setPackage(getPackageName());
        b.putExtra("payload", poll.toString());
        sendBroadcast(b);

        if (ring && trip != null) {
            String tripId = trip.optString("id");
            if (!tripId.equals(ringingTripId)) {
                ringingTripId = tripId;
                new Handler(Looper.getMainLooper()).post(() -> raiseAlarm(trip));
            }
        } else if (!ring) {
            ringingTripId = null;
        }

        String duty = poll.optString("dutyState", "");
        String head = trip != null ? trip.optString("headline") + " - " + trip.optString("statusLabel") : "No job right now";
        updateDutyNotification("AVAILABLE".equals(duty) ? "On duty, free" : "On duty", head);
    }

    private void queuePing(Location l) {
        try {
            JSONArray q = new JSONArray(prefs.queue());
            JSONObject p = new JSONObject();
            p.put("lat", l.getLatitude());
            p.put("lng", l.getLongitude());
            p.put("accuracy", l.getAccuracy());
            p.put("speed", l.getSpeed());
            p.put("battery", batteryLevel());
            p.put("at", isoNow(l.getTime()));
            q.put(p);
            // Keep at most 500 offline points, drop the oldest.
            while (q.length() > 500) q.remove(0);
            prefs.setQueue(q.toString());
        } catch (Exception ignored) { }
    }

    private void flushQueue() {
        try {
            JSONArray q = new JSONArray(prefs.queue());
            if (q.length() == 0) return;
            JSONObject body = new JSONObject().put("pings", q);
            JSONObject res = api.postSync("/api/runner/ping", body);
            if (res != null && !res.has("__error")) prefs.setQueue("[]");
        } catch (Exception ignored) { }
    }

    private int batteryLevel() {
        try {
            BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
            return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        } catch (Exception e) { return 0; }
    }

    private static String isoNow(long ms) {
        java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new java.util.Date(ms));
    }

    /* ---------------- the alarm ---------------- */

    private void raiseAlarm(JSONObject trip) {
        playAlarm();

        Intent full = new Intent(this, AlertActivity.class);
        full.putExtra("trip", trip.toString());
        full.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pi = PendingIntent.getActivity(this, 1, full,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String patient = trip.optString("patientName", "");
        String where = trip.optJSONObject("pickup") != null ? trip.optJSONObject("pickup").optString("name", "") : "";

        Notification n = new NotificationCompat.Builder(this, CH_JOB)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("New job: " + trip.optString("headline"))
                .setContentText(patient + " - " + where)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(pi, true)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOngoing(true)
                .build();

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTE_JOB, n);

        // Some phones block a background activity launch; this covers that case.
        try { startActivity(full); } catch (Exception ignored) { }
    }

    private void playAlarm() {
        stopAlarm();
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            // The alarm stream is not muted by silent mode, so raise it to full.
            am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);

            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            player.setDataSource(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM));
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception ignored) { }

        try {
            long[] pattern = {0, 700, 500};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception ignored) { }
    }

    public void stopAlarm() {
        try { if (player != null) { player.stop(); player.release(); } } catch (Exception ignored) { }
        player = null;
        try { vibrator.cancel(); } catch (Exception ignored) { }
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.cancel(NOTE_JOB);
        } catch (Exception ignored) { }
    }

    /* ---------------- notifications ---------------- */

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        NotificationChannel duty = new NotificationChannel(CH_DUTY, "Duty status", NotificationManager.IMPORTANCE_LOW);
        duty.setDescription("Shows that location sharing is on while you are punched in");
        nm.createNotificationChannel(duty);

        NotificationChannel job = new NotificationChannel(CH_JOB, "New job alarm", NotificationManager.IMPORTANCE_HIGH);
        job.setDescription("Rings when the desk assigns you a job");
        job.setBypassDnd(true);
        job.enableVibration(true);
        job.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                new android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        nm.createNotificationChannel(job);
    }

    private Notification dutyNotification(String title, String text) {
        Intent open = new Intent(this, HomeActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CH_DUTY)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateDutyNotification(String title, String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTE_DUTY, dutyNotification(title, text));
        } catch (Exception ignored) { }
    }

    @Override
    public void onDestroy() {
        stopAlarm();
        stopTracking();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    /* ---------------- helpers used by the activities ---------------- */

    public static void start(Context c) {
        Intent i = new Intent(c, DutyService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
        else c.startService(i);
    }

    public static void stop(Context c) {
        c.startService(new Intent(c, DutyService.class).setAction(ACTION_STOP));
    }

    public static void silence(Context c) {
        c.startService(new Intent(c, DutyService.class).setAction(ACTION_STOP_ALARM));
    }
}
