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

    /**
     * Jobs whose alarm he has already answered.
     *
     * Silencing used to only stop the sound. The next poll, a few seconds later, still said
     * the job was unanswered - the server had not caught up - saw that nothing was playing,
     * and started the alarm again. From the runner's side the accept button simply did not
     * work. Remembering what he answered closes that window, however slow the network is.
     */
    private final java.util.LinkedHashSet<String> answered = new java.util.LinkedHashSet<>();
    private boolean alarmPlaying = false;
    private boolean onJob = false;
    private boolean running = false;

    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location location) { lastFix = location; }
        @Override public void onProviderEnabled(String p) { }
        @Override public void onProviderDisabled(String p) { }
        @Override public void onStatusChanged(String p, int s, android.os.Bundle e) { }
    };

    @Override
    protected void attachBaseContext(Context base) {
        // Notifications come from here, so the service needs the runner's language too -
        // otherwise the alarm banner arrives in English on a Gujarati phone.
        super.attachBaseContext(LocaleHelper.apply(base));
    }

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
            if (ringingTripId != null) {
                answered.add(ringingTripId);
                while (answered.size() > 40) answered.remove(answered.iterator().next());
            }
            ringingTripId = null;
            stopAlarm();
            return START_STICKY;
        }

        startForeground(NOTE_DUTY, dutyNotification(getString(R.string.note_on_duty), getString(R.string.note_location_shared)));
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

    /**
     * The location listener can go quiet - a phone asleep in a pocket, a provider that
     * stopped reporting after a doze window. Asking for the last known fix each cycle means
     * the desk keeps getting a position instead of the pin freezing where it last moved.
     */
    private void refreshFix() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        try {
            Location gps = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            Location best = gps == null ? net : (net == null ? gps : (gps.getTime() > net.getTime() ? gps : net));
            if (best == null) return;
            if (lastFix == null || best.getTime() > lastFix.getTime()) lastFix = best;
        } catch (Exception ignored) { }
    }

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
        //
        // Two rates on purpose. While he is carrying a job the desk is watching the pin move,
        // so positions go up every few seconds. Idle on duty, nobody is watching a stationary
        // pin, so we back off and save his battery for the ride that matters.
        refreshFix();
        int rate = onJob ? prefs.pingSeconds() : prefs.idlePingSeconds();
        if (lastFix != null && now - lastPingAt >= rate * 1000L) {
            lastPingAt = now;
            queuePing(lastFix);
        }
        if (api.online()) {
            flushPings();
            flushActions();
            flushPhotos();
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
        if (cfg != null) prefs.setIntervals(cfg.optInt("pollInterval", 5),
                cfg.optInt("pingInterval", 8), cfg.optInt("idlePingInterval", 30));

        JSONObject trip = poll.optJSONObject("trip");

        // The job waiting to be accepted is not always the one on screen. A runner already
        // carrying a sample can be handed the next errand, and it is THAT one he has to be
        // told about - ringing for the job in his hand tells him nothing he does not know.
        JSONObject ringTrip = poll.optJSONObject("ringTrip");
        if (ringTrip == null) ringTrip = trip;

        boolean ring = poll.optBoolean("ring", false);
        onJob = trip != null;

        Intent b = new Intent(BROADCAST_UPDATE);
        b.setPackage(getPackageName());
        b.putExtra("payload", poll.toString());
        sendBroadcast(b);

        if (ring && ringTrip != null) {
            final String tripId = ringTrip.optString("id");
            final JSONObject ringing = ringTrip;

            if (answered.contains(tripId)) {
                // He has already dealt with this one; the server just has not caught up.
                if (alarmPlaying) stopAlarm();
            } else if (!tripId.equals(ringingTripId) || !alarmPlaying) {
                // A new job, or the same one still unanswered and the alarm has somehow
                // stopped - a phone can kill a MediaPlayer. Either way: ring.
                ringingTripId = tripId;
                final boolean queued = trip != null && !tripId.equals(trip.optString("id"));
                new Handler(Looper.getMainLooper()).post(() -> raiseAlarm(ringing, queued));
            }
        } else if (!ring) {
            ringingTripId = null;
            // Nothing is waiting, so anything remembered can go. This is what lets a job
            // that is reassigned to him later ring properly all over again.
            answered.clear();
            if (alarmPlaying) stopAlarm();
        }

        String duty = poll.optString("dutyState", "");
        String head = trip != null
                ? trip.optString("headline") + " - " + trip.optString("statusLabel")
                : getString(R.string.note_no_job);
        int pending = queue.size() + queue.photoCount();
        if (pending > 0) head = head + "  (" + getString(R.string.note_waiting_upload, pending) + ")";
        updateDutyNotification(getString("AVAILABLE".equals(duty) ? R.string.note_on_duty_free : R.string.note_on_duty), head);
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

    /**
     * Sends the pictures that were taken while the phone had no data.
     *
     * One at a time and oldest first, because each one is a whole JPEG and a runner who has
     * been out of signal all morning should not have the service try to push six of them up
     * a weak connection at once. A failure simply leaves the entry where it is for the next
     * pass; a refusal from the server drops it, because retrying it forever would wedge the
     * queue behind a photo the server will never take.
     */
    private void flushPhotos() {
        try {
            JSONArray pend = queue.readPhotos();
            if (pend.length() == 0) return;

            JSONObject item = pend.getJSONObject(0);
            String id = item.optString("id");
            java.io.File f = new java.io.File(item.optString("file"));

            // The picture is gone from the phone - nothing left to send.
            if (!f.exists()) { queue.removePhoto(id, false); return; }

            java.util.Map<String, String> fields = new java.util.HashMap<>();
            JSONObject raw = item.optJSONObject("fields");
            if (raw != null) {
                java.util.Iterator<String> it = raw.keys();
                while (it.hasNext()) { String k = it.next(); fields.put(k, raw.optString(k)); }
            }
            fields.put("stage", item.optString("stage"));
            fields.put("at", item.optString("at"));

            JSONObject res = api.postPhotoSync(
                    "/api/runner/trip/" + item.optString("tripId") + "/stage", fields, f);

            // A null answer means the connection failed, so the entry stays for the next
            // pass. Anything else - accepted, or refused with a reason - is final: the entry
            // goes and the picture with it. Keeping a refused one would wedge every photo
            // behind it forever.
            if (res == null) return;
            queue.removePhoto(id, true);

            Intent b = new Intent(BROADCAST_UPDATE);
            b.setPackage(getPackageName());
            b.putExtra("photoSynced", 1);
            sendBroadcast(b);
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

    /**
     * @param queued true when this job is lining up behind one he is already doing, which
     *               changes where he lands after accepting it.
     */
    private void raiseAlarm(JSONObject trip, boolean queued) {
        playAlarm();

        Intent full = new Intent(this, AlertActivity.class);
        full.putExtra("trip", trip.toString());
        full.putExtra("queued", queued);
        full.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pi = PendingIntent.getActivity(this, 1, full,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String patient = trip.optString("patientName", "");
        JSONObject target = trip.optJSONObject("target");
        String where = target != null ? target.optString("name", "") : "";

        Notification n = new NotificationCompat.Builder(this, CH_JOB)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(getString(R.string.note_new_job, trip.optString("headline")))
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

        NotificationChannel duty = new NotificationChannel(CH_DUTY, getString(R.string.ch_duty_name), NotificationManager.IMPORTANCE_LOW);
        duty.setDescription(getString(R.string.ch_duty_desc));
        duty.setShowBadge(false);
        nm.createNotificationChannel(duty);

        NotificationChannel job = new NotificationChannel(CH_JOB, getString(R.string.ch_job_name), NotificationManager.IMPORTANCE_HIGH);
        job.setDescription(getString(R.string.ch_job_desc));
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
