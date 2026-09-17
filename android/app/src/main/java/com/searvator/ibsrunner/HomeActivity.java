package com.searvator.ibsrunner;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * The runner's home screen.
 *
 * Design rules that drove this file:
 *
 *  - Nothing waits for the network. Every tap changes the screen at once and the request
 *    goes out behind it; if there is no data, the action sits in SyncQueue and uploads
 *    itself later. That is why the buttons feel instant now.
 *
 *  - Timers count from a start timestamp, not from a minute figure the server rounded. They
 *    only ever go up. See Clock for the detail.
 *
 *  - The screen is readable offline. The last poll, summary and trip list are cached, so
 *    opening the app in a basement still shows the job and the day's numbers.
 */
public class HomeActivity extends AppCompatActivity {

    private static final int REQ_ODO_IN = 61;
    private static final int REQ_ODO_OUT = 62;

    private Prefs prefs;
    private Api api;
    private SyncQueue queue;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView hello, empLine, dutyChip, dutyTimer, dutyCaption, tripsToday, kmToday, hoursWeek,
            jobTitle, jobSub, jobStage, jobTimer, jobDistance, freeNote, offlineBanner, warnBanner, tripEmpty;
    private Button punchBtn, breakBtn, openJobBtn;
    private LinearLayout jobCard, tripList;

    private JSONObject state = new JSONObject();
    private String activeTripId = null;

    /** Anchors for the two running clocks. Null means the clock is not running. */
    private String dutyStartedAt = null;
    private long dutyMinutesBefore = 0;
    private String jobAnchorAt = null;

    /** Set the moment a punch button is tapped, so the UI can lead the server. */
    private Boolean optimisticOnDuty = null;
    private long optimisticUntil = 0;

    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            String payload = i.getStringExtra("payload");
            if (payload != null) {
                try { render(new JSONObject(payload)); } catch (Exception ignored) { }
            }
            if (i.hasExtra("synced")) {
                paintBanners();
                loadSummary();
                loadTrips();
            }
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        api = new Api(this);
        queue = new SyncQueue(this);
        Clock.restore(this);

        if (!prefs.signedIn()) {
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_home);
        bind();

        hello.setText("Hello, " + firstName(prefs.name()));
        empLine.setText(prefs.empCode().isEmpty() ? "IBS Runner" : "IBS Runner  •  " + prefs.empCode());

        Anim.press(punchBtn, breakBtn, openJobBtn);
        Anim.enter(findViewById(R.id.tileKm), 80);
        Anim.enter(findViewById(R.id.tileTrips), 130);
        Anim.enter(findViewById(R.id.tileHours), 180);

        punchBtn.setOnClickListener(v -> togglePunch());
        breakBtn.setOnClickListener(v -> toggleBreak());
        openJobBtn.setOnClickListener(v -> openTrip());
        jobCard.setOnClickListener(v -> openTrip());
        findViewById(R.id.signOutBtn).setOnClickListener(v -> signOut());

        // Draw from cache immediately so the screen is never blank while the first call runs.
        restoreCached();
        askPermissions();
    }

    private void bind() {
        hello = findViewById(R.id.hello);
        empLine = findViewById(R.id.empLine);
        dutyChip = findViewById(R.id.dutyChip);
        dutyTimer = findViewById(R.id.dutyTimer);
        dutyCaption = findViewById(R.id.dutyCaption);
        tripsToday = findViewById(R.id.tripsToday);
        kmToday = findViewById(R.id.kmToday);
        hoursWeek = findViewById(R.id.hoursWeek);
        jobCard = findViewById(R.id.jobCard);
        jobTitle = findViewById(R.id.jobTitle);
        jobSub = findViewById(R.id.jobSub);
        jobStage = findViewById(R.id.jobStage);
        jobTimer = findViewById(R.id.jobTimer);
        jobDistance = findViewById(R.id.jobDistance);
        freeNote = findViewById(R.id.freeNote);
        offlineBanner = findViewById(R.id.offlineBanner);
        warnBanner = findViewById(R.id.warnBanner);
        tripList = findViewById(R.id.tripList);
        tripEmpty = findViewById(R.id.tripEmpty);
        punchBtn = findViewById(R.id.punchBtn);
        breakBtn = findViewById(R.id.breakBtn);
        openJobBtn = findViewById(R.id.openJobBtn);
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerUpdates();
        ui.post(poll);
        ui.post(ticker);
        loadSummary();
        loadTrips();
        checkVpn();
    }

    /**
     * The three-argument registerReceiver with flags only exists from API 26, and the
     * NOT_EXPORTED flag is only required from API 33. minSdk here is 24, so calling the
     * flagged version unconditionally would crash on an older phone with NoSuchMethodError.
     */
    private void registerUpdates() {
        IntentFilter filter = new IntentFilter(DutyService.BROADCAST_UPDATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(updates, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updates, filter);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { unregisterReceiver(updates); } catch (Exception ignored) { }
        ui.removeCallbacks(poll);
        ui.removeCallbacks(ticker);
    }

    /* ---------------- loops ---------------- */

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            api.get("/api/runner/poll", (ok, data, err) -> { if (ok) render(data); else paintBanners(); });
            ui.postDelayed(this, 6000);
        }
    };

    /** One tick a second keeps both clocks moving smoothly without any network traffic. */
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            paintTimers();
            ui.postDelayed(this, 1000);
        }
    };

    /* ---------------- drawing ---------------- */

    private void restoreCached() {
        try {
            if (!prefs.lastPoll().isEmpty()) render(new JSONObject(prefs.lastPoll()));
            if (!prefs.lastSummary().isEmpty()) renderSummary(new JSONObject(prefs.lastSummary()));
            if (!prefs.lastTrips().isEmpty()) renderTrips(new JSONObject(prefs.lastTrips()));
        } catch (Exception ignored) { }
    }

    private void render(JSONObject data) {
        state = data;
        prefs.setLastPoll(data.toString());

        boolean onDuty = data.optBoolean("onDuty", false);

        // If the runner just tapped punch, trust the screen for a few seconds rather than
        // letting a stale poll flip the button back and forth under his finger.
        if (optimisticOnDuty != null) {
            if (Clock.now() < optimisticUntil && onDuty != optimisticOnDuty) onDuty = optimisticOnDuty;
            else optimisticOnDuty = null;
        }

        prefs.setOnDuty(onDuty);
        String duty = data.optString("dutyState", "OFF_DUTY");
        if (onDuty) DutyService.start(this);

        dutyStartedAt = data.isNull("dutyStartedAt") ? null : data.optString("dutyStartedAt", null);
        dutyMinutesBefore = data.optLong("dutyMinutesBefore", 0);

        int trips = data.optInt("tripsToday", 0);
        tripsToday.setText(String.valueOf(trips));
        double km = data.optDouble("kmToday", 0);
        kmToday.setText(String.format(java.util.Locale.US, "%.1f", km));

        punchBtn.setText(onDuty ? "PUNCH OUT" : "PUNCH IN");
        punchBtn.setBackgroundResource(onDuty ? R.drawable.btn_dark : R.drawable.btn_red);
        Anim.show(breakBtn, onDuty);
        breakBtn.setText("BREAK".equals(duty) ? "End break" : "Take a break");

        dutyChip.setText(label(duty));
        dutyChip.setBackgroundResource("AVAILABLE".equals(duty) ? R.drawable.chip_green
                : "ON_TRIP".equals(duty) ? R.drawable.chip_blue
                : "BREAK".equals(duty) ? R.drawable.chip_amber : R.drawable.chip_grey);

        JSONObject trip = data.optJSONObject("trip");
        if (trip != null) {
            boolean wasHidden = jobCard.getVisibility() != View.VISIBLE;
            activeTripId = trip.optString("id");
            jobCard.setVisibility(View.VISIBLE);
            Anim.show(freeNote, false);
            if (wasHidden) Anim.enter(jobCard);

            jobTitle.setText(trip.optString("headline") + "  •  " + trip.optString("patientName"));

            JSONObject target = trip.optJSONObject("target");
            String where = target != null ? target.optString("name") : "";
            String bg = trip.optString("bloodGroup", "");
            jobSub.setText(where + (bg.isEmpty() ? "" : "\n" + bg + " " + trip.optString("component")));
            jobStage.setText(trip.optString("statusLabel", "RUNNING JOB").toUpperCase());

            // The desk's distance estimate, so he knows what he is accepting.
            if (!trip.isNull("targetKm")) {
                double d = trip.optDouble("targetKm", 0);
                int eta = trip.optInt("targetEtaMin", 0);
                jobDistance.setText("≈ " + String.format(java.util.Locale.US, "%.1f", d) + " km  •  about " + eta + " min");
                Anim.show(jobDistance, true);
            } else {
                Anim.show(jobDistance, false);
            }

            jobAnchorAt = trip.optString("assignedAt", null);
        } else {
            activeTripId = null;
            jobAnchorAt = null;
            Anim.show(jobCard, false);
            Anim.show(freeNote, true);
            freeNote.setText(onDuty
                    ? "You are free.\nThe phone will ring when a job comes."
                    : "Punch in to start your shift.");
        }

        paintTimers();
        paintBanners();
    }

    private void paintTimers() {
        // Duty clock: closed sessions + however long the open session has been running.
        long seconds = dutyMinutesBefore * 60;
        if (dutyStartedAt != null && prefs.onDuty()) {
            long ms = Clock.since(dutyStartedAt);
            if (ms > 0) seconds += ms / 1000;
        }
        dutyTimer.setText(Clock.hms(seconds));
        dutyCaption.setText(prefs.onDuty() ? "TODAY ON DUTY" : "TODAY ON DUTY (SHIFT CLOSED)");

        if (jobAnchorAt != null) {
            long ms = Clock.since(jobAnchorAt);
            jobTimer.setText(ms >= 0 ? Clock.hms(ms / 1000) : "--:--");
        }
    }

    private void paintBanners() {
        int pending = queue.size();
        boolean offline = !api.online();

        if (offline || pending > 0) {
            String msg;
            if (offline && pending > 0) {
                msg = "No internet. " + pending + " " + (pending == 1 ? "action is" : "actions are")
                        + " saved on your phone and will be sent automatically when the network returns.";
            } else if (offline) {
                msg = "No internet right now. Your work is being saved on the phone - keep going as normal.";
            } else {
                msg = "Sending " + pending + " saved " + (pending == 1 ? "action" : "actions") + " to the office...";
            }
            offlineBanner.setText(msg);
            Anim.show(offlineBanner, true);
        } else {
            Anim.show(offlineBanner, false);
        }

        if (Guard.vpnOn(this)) {
            warnBanner.setText(Guard.MSG_VPN);
            Anim.show(warnBanner, true);
        } else {
            Anim.show(warnBanner, false);
        }
    }

    /* ---------------- summary and trip list ---------------- */

    private void loadSummary() {
        api.get("/api/runner/summary?days=5", (ok, data, err) -> {
            if (!ok || data == null) return;
            prefs.setLastSummary(data.toString());
            renderSummary(data);
        });
    }

    private void renderSummary(JSONObject data) {
        JSONObject totals = data.optJSONObject("totals");
        if (totals != null) {
            long mins = totals.optLong("minutes", 0);
            hoursWeek.setText(Clock.hm(mins));
        }
    }

    private void loadTrips() {
        api.get("/api/runner/trips?days=5", (ok, data, err) -> {
            if (!ok || data == null) return;
            prefs.setLastTrips(data.toString());
            renderTrips(data);
        });
    }

    private void renderTrips(JSONObject data) {
        JSONArray days = data.optJSONArray("days");
        String today = data.optString("today", "");
        tripList.removeAllViews();

        if (days == null || days.length() == 0) {
            Anim.show(tripEmpty, true);
            return;
        }
        Anim.show(tripEmpty, false);

        LayoutInflater inf = LayoutInflater.from(this);
        for (int i = 0; i < days.length(); i++) {
            JSONObject day = days.optJSONObject(i);
            if (day == null) continue;

            View header = inf.inflate(R.layout.item_day, tripList, false);
            TextView label = header.findViewById(R.id.dayLabel);
            TextView stats = header.findViewById(R.id.dayStats);
            label.setText(Clock.dayLabel(day.optString("date"), today));
            stats.setText(day.optInt("done") + " of " + day.optInt("total") + " done");
            tripList.addView(header);

            JSONArray trips = day.optJSONArray("trips");
            for (int j = 0; trips != null && j < trips.length(); j++) {
                JSONObject t = trips.optJSONObject(j);
                if (t == null) continue;
                tripList.addView(tripRow(inf, t));
            }
        }
    }

    private View tripRow(LayoutInflater inf, final JSONObject t) {
        View row = inf.inflate(R.layout.item_trip, tripList, false);
        TextView title = row.findViewById(R.id.rowTitle);
        TextView sub = row.findViewById(R.id.rowSub);
        TextView meta = row.findViewById(R.id.rowMeta);
        TextView chip = row.findViewById(R.id.rowChip);
        View bar = row.findViewById(R.id.rowBar);

        String status = t.optString("status");
        boolean done = "COMPLETED".equals(status);
        boolean dead = "REJECTED".equals(status) || "CANCELLED".equals(status);
        boolean live = !done && !dead;

        title.setText(t.optString("headline") + "  •  " + t.optString("patientName"));

        JSONObject target = t.optJSONObject("target");
        JSONObject drop = t.optJSONObject("drop");
        JSONObject where = target != null ? target : drop;
        sub.setText(where != null ? where.optString("name") : t.optString("caseNo"));

        String when = Clock.clockTime(t.optString("assignedAt"));
        if (done) {
            JSONObject tat = t.optJSONObject("tat");
            String total = "";
            if (tat != null) {
                JSONObject parts = tat.optJSONObject("parts");
                if (parts != null && parts.optJSONObject("total") != null) {
                    double v = parts.optJSONObject("total").optDouble("value", 0);
                    total = "  •  took " + Clock.hm(Math.round(v));
                }
            }
            meta.setText(when + total);
        } else {
            meta.setText(when + "  •  " + t.optString("statusLabel"));
        }

        chip.setText(done ? "DONE" : dead ? "CLOSED" : "LIVE");
        chip.setBackgroundResource(done ? R.drawable.chip_green : dead ? R.drawable.chip_grey : R.drawable.chip_red);
        chip.setTextColor(getResources().getColor(done ? R.color.jade : dead ? R.color.muted : R.color.crimson));
        bar.setBackgroundResource(done ? R.drawable.chip_green : dead ? R.drawable.chip_grey : R.drawable.chip_red);

        if (live) {
            Anim.press(row);
            row.setOnClickListener(v -> {
                Intent i = new Intent(this, TripActivity.class);
                i.putExtra("tripId", t.optString("id"));
                startActivity(i);
            });
        }
        return row;
    }

    /* ---------------- actions ---------------- */

    private void togglePunch() {
        boolean onDuty = prefs.onDuty();

        if (!onDuty) {
            Location l = lastLocation();
            if (l == null) {
                new AlertDialog.Builder(this)
                        .setTitle("લોકેશન ચાલુ કરો")
                        .setMessage(Guard.MSG_LOCATION_OFF)
                        .setPositiveButton("Open settings", (d, w) ->
                                startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)))
                        .setNegativeButton("Cancel", null)
                        .show();
                return;
            }
            if (!checkVpn()) return;

            // First punch of the day needs the meter photo; a later one in the same day does not.
            Intent i = new Intent(this, OdometerActivity.class);
            i.putExtra(OdometerActivity.EXTRA_MODE, "in");
            i.putExtra(OdometerActivity.EXTRA_MIN, 0);
            startActivityForResult(i, REQ_ODO_IN);
            return;
        }

        if (activeTripId != null) {
            Toast.makeText(this, "Finish your running job before punching out", Toast.LENGTH_LONG).show();
            return;
        }

        Intent i = new Intent(this, OdometerActivity.class);
        i.putExtra(OdometerActivity.EXTRA_MODE, "out");
        i.putExtra(OdometerActivity.EXTRA_MIN, state.optInt("odoStart", 0));
        startActivityForResult(i, REQ_ODO_OUT);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK || data == null) return;
        if (req != REQ_ODO_IN && req != REQ_ODO_OUT) return;

        boolean in = req == REQ_ODO_IN;
        int odo = data.getIntExtra(OdometerActivity.RESULT_ODO, 0);
        String photoPath = data.getStringExtra(OdometerActivity.RESULT_PHOTO);
        sendPunch(in, odo, photoPath);
    }

    /**
     * The punch itself. The screen flips first and the upload follows, so the runner is never
     * left staring at a spinner on a weak signal. A punch always carries a photo, so it goes
     * as multipart; if that fails the action is queued without the photo and the office still
     * gets the punch, the reading and the time - only the picture waits for a better network.
     */
    private void sendPunch(final boolean in, final int odo, final String photoPath) {
        Location l = lastLocation();
        double lat = l != null ? l.getLatitude() : 0;
        double lng = l != null ? l.getLongitude() : 0;

        // 1. UI leads.
        optimisticOnDuty = in;
        optimisticUntil = Clock.now() + 12000;
        prefs.setOnDuty(in);
        prefs.setLastOdo(odo);
        punchBtn.setText(in ? "PUNCH OUT" : "PUNCH IN");
        punchBtn.setBackgroundResource(in ? R.drawable.btn_dark : R.drawable.btn_red);
        if (in) {
            dutyStartedAt = Clock.nowIso();
            DutyService.start(this);
        } else {
            dutyStartedAt = null;
            DutyService.stop(this);
        }
        paintTimers();
        Toast.makeText(this, in ? "Punched in" : "Punched out", Toast.LENGTH_SHORT).show();

        // 2. Upload behind it.
        Map<String, String> fields = new HashMap<>();
        fields.put("lat", String.valueOf(lat));
        fields.put("lng", String.valueOf(lng));
        fields.put("odo", String.valueOf(odo));
        fields.put("at", Clock.nowIso());
        File photo = photoPath != null ? new File(photoPath) : null;

        api.postPhoto(in ? "/api/runner/punch-in" : "/api/runner/punch-out", fields, photo, (ok, resp, err) -> {
            if (ok) {
                ui.post(poll);
                loadSummary();
                loadTrips();
                return;
            }
            // Server said no for a real reason (already punched in, job still running):
            // undo the optimistic flip so the screen tells the truth.
            if (err != null && !err.startsWith("No internet") && !err.startsWith("Cannot reach")
                    && !err.startsWith("Server is slow")) {
                optimisticOnDuty = null;
                prefs.setOnDuty(!in);
                Toast.makeText(this, err, Toast.LENGTH_LONG).show();
                ui.post(poll);
                return;
            }
            // Network problem: keep the punch, queue it, tell him it is safe.
            queue.addPunch(in, lat, lng, odo);
            paintBanners();
            Toast.makeText(this, "Saved on your phone. It will reach the office automatically.",
                    Toast.LENGTH_LONG).show();
        });
    }

    private void toggleBreak() {
        final boolean onBreak = "BREAK".equals(state.optString("dutyState"));
        breakBtn.setText(onBreak ? "Take a break" : "End break");
        try {
            api.post("/api/runner/break", new JSONObject().put("on", !onBreak), (ok, data, err) -> {
                if (!ok) {
                    if (err != null && err.startsWith("No internet")) {
                        queue.addBreak(!onBreak);
                        paintBanners();
                    } else {
                        Toast.makeText(this, err, Toast.LENGTH_LONG).show();
                    }
                }
                ui.post(poll);
            });
        } catch (Exception ignored) { }
    }

    private void openTrip() {
        if (activeTripId == null) return;
        Intent i = new Intent(this, TripActivity.class);
        i.putExtra("tripId", activeTripId);
        startActivity(i);
    }

    private void signOut() {
        if (prefs.onDuty()) {
            Toast.makeText(this, "Punch out before signing out", Toast.LENGTH_LONG).show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Sign out?")
                .setMessage("You will have to enter your user ID and password again.")
                .setPositiveButton("Sign out", (d, w) -> {
                    DutyService.stop(this);
                    prefs.clearSession();
                    prefs.setOnDuty(false);
                    startActivity(new Intent(this, LoginActivity.class));
                    finish();
                })
                .setNegativeButton("Stay", null)
                .show();
    }

    /** Returns false and warns when a VPN is on. */
    private boolean checkVpn() {
        if (!Guard.vpnOn(this)) return true;
        new AlertDialog.Builder(this)
                .setTitle("VPN બંધ કરો")
                .setMessage(Guard.MSG_VPN)
                .setCancelable(false)
                .setPositiveButton("Settings", (d, w) -> {
                    try { startActivity(new Intent(Settings.ACTION_VPN_SETTINGS)); }
                    catch (Exception e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
                })
                .setNegativeButton("OK", null)
                .show();
        paintBanners();
        return false;
    }

    /* ---------------- helpers ---------------- */

    private static String firstName(String full) {
        if (full == null || full.isEmpty()) return "Runner";
        int sp = full.indexOf(' ');
        return sp > 0 ? full.substring(0, sp) : full;
    }

    static String label(String duty) {
        switch (duty) {
            case "AVAILABLE": return "Free";
            case "ON_TRIP": return "On a job";
            case "BREAK": return "On break";
            default: return "Off duty";
        }
    }

    private Location lastLocation() {
        Location fromService = DutyService.fix();
        if (fromService != null) return fromService;
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null;
        try {
            LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            Location gps = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (gps == null) return net;
            if (net == null) return gps;
            return gps.getTime() > net.getTime() ? gps : net;
        } catch (Exception e) { return null; }
    }

    /* ---------------- permissions ---------------- */

    private void askPermissions() {
        java.util.List<String> need = new java.util.ArrayList<>();
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
                ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.CAMERA);
        }
        if (!need.isEmpty()) ActivityCompat.requestPermissions(this, need.toArray(new String[0]), 11);
        else askBackgroundAndBattery();
    }

    @Override
    public void onRequestPermissionsResult(int code, @NonNull String[] p, @NonNull int[] r) {
        super.onRequestPermissionsResult(code, p, r);
        if (code == 11) askBackgroundAndBattery();
    }

    private void askBackgroundAndBattery() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            new AlertDialog.Builder(this)
                    .setTitle("Keep location on in the background")
                    .setMessage("The desk needs to see where you are even when the screen is off. On the next screen choose Allow all the time.")
                    .setPositiveButton("Continue", (d, w) ->
                            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, 12))
                    .setNegativeButton("Later", (d, w) -> batteryPrompt())
                    .show();
        } else {
            batteryPrompt();
        }
    }

    private void batteryPrompt() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                new AlertDialog.Builder(this)
                        .setTitle("Stop the phone from closing the app")
                        .setMessage("Allow the IBS Runner app to keep running in the background, otherwise the job alarm may not ring.")
                        .setPositiveButton("Allow", (d, w) -> {
                            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                            i.setData(Uri.parse("package:" + getPackageName()));
                            try { startActivity(i); } catch (Exception ignored) { }
                        })
                        .setNegativeButton("Later", null)
                        .show();
            }
        } catch (Exception ignored) { }
    }
}
