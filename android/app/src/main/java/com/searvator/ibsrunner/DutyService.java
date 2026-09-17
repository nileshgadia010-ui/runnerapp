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
 *  - keeps a GPS fix and pushes it to the server, batching whatever the network refused
 *  - drains the offline action queue the moment data comes back
 *  - asks the server every few seconds whether a new job has been assigned
 *  - when a job arrives it plays an alarm on the ALARM stream, so it is heard even if the
 *    phone is on silent, and throws up a full screen alert that keeps ringing until the
 *    runner accepts or declines
 *  - reports VPN / fake-GPS / root signals so the desk can see them
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

    /** Latest fix, readable by the activities without asking the system again. */
    private static volatile Location lastFix = null;
    public static Location fix() { return lastFix; }

    private Prefs prefs;
    private Api api;
    private SyncQueue queue;
    private LocationManager lm;
    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wake;
    private AudioManager audio;

    private final Handler loop = new Handler(Looper.getMainLooper());
    private long lastPingAt = 0;
    private long lastIntegrityAt = 0;
    private String ringingTripId = null;
    private boolean alarmPlaying = false;
    private boolean running = false;

    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location location) { lastFix = location; }
        @Override public void onProviderEnabled(String p) { }
        @Override public void onProviderDisabled(String p) { }
        @Override public void onStatusChanged(String p, int s, android.os.Bundle e) { }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = new Prefs(this);
        api = new Api(this);
        queue = new SyncQueue(this);
        Clock.restore(this);
        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
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
            if (lastFix == null) lastFix = gps != null ? gps : net;
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

        long now = System.currentTimeMillis();

        // 1. Location. Always queued first, then flushed - so a dead network loses nothing.
        if (lastFix != null && now - lastPingAt >= prefs.pingSeconds() * 1000L) {
            lastPingAt = now;
            queuePing(lastFix);
        }
        if (api.online()) {
            flushPings();
            flushActions();
        }

        // 2. Environment signals, every two minutes. Cheap, and worth the record.
        if (now - lastIntegrityAt > 120000 && api.online()) {
            lastIntegrityAt = now;
            reportIntegrity();
        }

        // 3. Ask for work.
        JSONObject poll = api.getSync("/api/runner/poll");
        if (poll == null || poll.has("__error")) return;
        prefs.setLastPoll(poll.toString());

        JSONObject cfg = poll.optJSONObject("config");
        if (cfg != null) prefs.setIntervals(cfg.optInt("pollInterval", 5), cfg.optInt("pingInterval", 20));

        JSONObject trip = poll.optJSONObject("trip");
        boolean ring = poll.optBoolean("ring", false);

        Intent b = new Intent(BROADCAST_UPDATE);
        b.setPackage(getPackageName());
        b.putExtra("payload", poll.toString());
        sendBroadcast(b);

        if (ring && trip != null) {
            final String tripId = trip.optString("id");
            // New job, or the same job still unanswered and the alarm has somehow stopped
            // (a phone can kill a MediaPlayer). Either way: ring.
            if (!tripId.equals(ringingTripId) || !alarmPlaying) {
                ringingTripId = tripId;
                new Handler(Looper.getMainLooper()).post(() -> raiseAlarm(trip));
            }
        } else if (!ring) {
            ringingTripId = null;
            if (alarmPlaying) stopAlarm();
        }

        String duty = poll.optString("dutyState", "");
        String head = trip != null ? trip.optString("headline") + " - " + trip.optString("statusLabel") : "No job right now";
        int pending = queue.size();
        if (pending > 0) head = head + "  (" + pending + " waiting to upload)";
        updateDutyNotification("AVAILABLE".equals(duty) ? "On duty, free" : "On duty", head);
    }

    /* ---------------- queues ---------------- */

    private void queuePing(Location l) {
        try {
            JSONArray q = new JSONArray(prefs.pingQueue());
            JSONObject p = new JSONObject();
            p.put("lat", l.getLatitude());
            p.put("lng", l.getLongitude());
            p.put("accuracy", l.getAccuracy());
            p.put("speed", l.getSpeed());
            p.put("battery", batteryLevel());
            p.put("mock", Guard.isMock(l));
            p.put("at", Clock.iso(l.getTime()));
            q.put(p);
            // Keep at most 500 offline points, drop the oldest.
            while (q.length() > 500) q.remove(0);
            prefs.setPingQueue(q.toString());
        } catch (Exception ignored) { }
    }

    private void flushPings() {
        try {
            JSONArray q = new JSONArray(prefs.pingQueue());
            if (q.length() == 0) return;
            JSONObject res = api.postSync("/api/runner/ping", new JSONObject().put("pings", q));
            if (res != null && !res.has("__error")) prefs.setPingQueue("[]");
        } catch (Exception ignored) { }
    }

    /**
     * Sends everything the runner did while the phone had no data. The server applies each
     * entry with the time it originally happened and answers per entry, so a single bad
     * action never blocks the rest of the queue.
     */
    private void flushActions() {
        try {
            JSONArray items = queue.read();
            if (items.length() == 0) return;
            JSONObject res = api.postSync("/api/runner/sync", new JSONObject().put("items", items));
            if (res == null || res.has("__error")) return;
            JSONArray results = res.optJSONArray("results");
            if (results != null) {
                queue.removeIds(results);
                Intent b = new Intent(BROADCAST_UPDATE);
                b.setPackage(getPackageName());
                b.putExtra("synced", results.length());
                sendBroadcast(b);
            }
        } catch (Exception ignored) { }
    }

    private void reportIntegrity() {
        try {
            Guard.Flags f = Guard.scan(this, lastFix);
            JSONObject body = new JSONObject();
            body.put("vpn", f.vpn);
            body.put("mockLocation", f.mockLocation);
            body.put("rooted", f.rooted);
            body.put("devMode", f.devMode);
            body.put("appVersion", BuildConfig.VERSION_NAME);
            api.postSync("/api/runner/integrity", body);
        } catch (Exception ignored) { }
    }

    private int batteryLevel() {
        try {
            BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
            return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        } catch (Exception e) { return 0; }
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
        JSONObject target = trip.optJSONObject("target");
        String where = target != null ? target.optString("name", "") : "";

        Notification n = new NotificationCompat.Builder(this, CH_JOB)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle("New job: " + trip.optString("headline"))
                .setContentText(patient + " - " + where)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(pi, true)
                .setContentIntent(pi)
                .setAutoCancel(false)
                .setOngoing(true)
                .build();

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTE_JOB, n);

        // Some phones block a background activity launch; this covers that case.
        try { startActivity(full); } catch (Exception ignored) { }
    }

    /**
     * Why this rings on a silent phone: the sound plays on the ALARM stream, which Android
     * does not mute in silent mode, and the volume is pushed to maximum first. The channel
     * also asks to bypass Do Not Disturb. A looping vibration runs alongside in case the
     * runner keeps the phone in a pocket on a noisy road.
     */
    private void playAlarm() {
        stopAlarm();
        try {
            audio.setStreamVolume(AudioManager.STREAM_ALARM,
                    audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);

            android.net.Uri tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (tone == null) tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (tone == null) tone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);

            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            player.setDataSource(this, tone);
            player.setLooping(true);
            player.setVolume(1f, 1f);
            player.prepare();
            player.start();
            alarmPlaying = true;
        } catch (Exception ignored) { }

        try {
            long[] pattern = {0, 800, 400};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0),
                        new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception ignored) { }
    }

    public void stopAlarm() {
        alarmPlaying = false;
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
        duty.setShowBadge(false);
        nm.createNotificationChannel(duty);

        NotificationChannel job = new NotificationChannel(CH_JOB, "New job alarm", NotificationManager.IMPORTANCE_HIGH);
        job.setDescription("Rings when the desk assigns you a job");
        job.setBypassDnd(true);
        job.enableVibration(true);
        job.setVibrationPattern(new long[]{0, 800, 400});
        job.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        job.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
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
