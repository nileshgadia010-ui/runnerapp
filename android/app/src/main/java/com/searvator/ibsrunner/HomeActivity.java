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
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;

import org.json.JSONObject;

public class HomeActivity extends AppCompatActivity {

    private Prefs prefs;
    private Api api;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView hello, dutyChip, dutyTimer, tripsToday, jobTitle, jobSub, jobStage, jobTimer, freeNote;
    private Button punchBtn, breakBtn, openJobBtn;
    private View jobCard;

    private JSONObject state = new JSONObject();
    private long dutyMinutesAtLoad = 0;
    private long loadedAt = 0;
    private String activeTripId = null;

    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            try { render(new JSONObject(i.getStringExtra("payload"))); } catch (Exception ignored) { }
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        api = new Api(this);

        if (!prefs.signedIn()) {
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_home);
        hello = findViewById(R.id.hello);
        dutyChip = findViewById(R.id.dutyChip);
        dutyTimer = findViewById(R.id.dutyTimer);
        tripsToday = findViewById(R.id.tripsToday);
        jobCard = findViewById(R.id.jobCard);
        jobTitle = findViewById(R.id.jobTitle);
        jobSub = findViewById(R.id.jobSub);
        jobStage = findViewById(R.id.jobStage);
        jobTimer = findViewById(R.id.jobTimer);
        freeNote = findViewById(R.id.freeNote);
        punchBtn = findViewById(R.id.punchBtn);
        breakBtn = findViewById(R.id.breakBtn);
        openJobBtn = findViewById(R.id.openJobBtn);

        hello.setText("Hello, " + prefs.name());
        punchBtn.setOnClickListener(v -> togglePunch());
        breakBtn.setOnClickListener(v -> toggleBreak());
        openJobBtn.setOnClickListener(v -> openTrip());
        jobCard.setOnClickListener(v -> openTrip());
        findViewById(R.id.signOutBtn).setOnClickListener(v -> signOut());

        askPermissions();
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerReceiver(updates, new IntentFilter(DutyService.BROADCAST_UPDATE),
                Build.VERSION.SDK_INT >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0);
        ui.post(poll);
        ui.post(ticker);
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { unregisterReceiver(updates); } catch (Exception ignored) { }
        ui.removeCallbacks(poll);
        ui.removeCallbacks(ticker);
    }

    /* ---------------- polling ---------------- */

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            api.get("/api/runner/poll", (ok, data, err) -> { if (ok) render(data); });
            ui.postDelayed(this, 6000);
        }
    };

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            paintTimers();
            ui.postDelayed(this, 1000);
        }
    };

    private void render(JSONObject data) {
        state = data;
        dutyMinutesAtLoad = data.optLong("dutyMinutesToday", 0);
        loadedAt = System.currentTimeMillis();

        boolean onDuty = data.optBoolean("onDuty", false);
        prefs.setOnDuty(onDuty);
        String duty = data.optString("dutyState", "OFF_DUTY");

        if (onDuty) DutyService.start(this);

        tripsToday.setText(String.valueOf(data.optInt("tripsToday", 0)));
        punchBtn.setText(onDuty ? "Punch out" : "Punch in");
        punchBtn.setBackgroundResource(onDuty ? R.drawable.btn_dark : R.drawable.btn_red);
        breakBtn.setVisibility(onDuty ? View.VISIBLE : View.GONE);
        breakBtn.setText("BREAK".equals(duty) ? "End break" : "Take a break");

        dutyChip.setText(label(duty));
        dutyChip.setBackgroundResource("AVAILABLE".equals(duty) ? R.drawable.chip_green
                : "ON_TRIP".equals(duty) ? R.drawable.chip_blue
                : "BREAK".equals(duty) ? R.drawable.chip_amber : R.drawable.chip_grey);

        JSONObject trip = data.optJSONObject("trip");
        if (trip != null) {
            activeTripId = trip.optString("id");
            jobCard.setVisibility(View.VISIBLE);
            freeNote.setVisibility(View.GONE);
            jobTitle.setText(trip.optString("headline") + " - " + trip.optString("patientName"));

            JSONObject target = "SAMPLE_PICKUP".equals(trip.optString("type")) ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");
            String where = target != null ? target.optString("name") : "";
            jobSub.setText(where + (trip.optString("bloodGroup").isEmpty() ? "" : "  |  " + trip.optString("bloodGroup") + " " + trip.optString("component")));
            jobStage.setText(trip.optString("statusLabel"));
        } else {
            activeTripId = null;
            jobCard.setVisibility(View.GONE);
            freeNote.setVisibility(View.VISIBLE);
            freeNote.setText(onDuty ? "You are free. The phone will ring when a job comes." : "Punch in to start your shift.");
        }
        paintTimers();
    }

    private void paintTimers() {
        long extra = loadedAt == 0 ? 0 : (System.currentTimeMillis() - loadedAt) / 1000;
        long dutySeconds = dutyMinutesAtLoad * 60 + (prefs.onDuty() ? extra : 0);
        dutyTimer.setText(clock(dutySeconds));

        JSONObject trip = state.optJSONObject("trip");
        if (trip != null) {
            long since = sinceMillis(trip.optString("assignedAt"));
            jobTimer.setText(since > 0 ? clock(since / 1000) : "--:--");
        }
    }

    private static long sinceMillis(String iso) {
        if (iso == null || iso.isEmpty()) return 0;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            java.util.Date d = f.parse(iso.substring(0, 19));
            return System.currentTimeMillis() - d.getTime();
        } catch (Exception e) { return 0; }
    }

    static String clock(long seconds) {
        if (seconds < 0) seconds = 0;
        long h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60;
        return (h > 0 ? h + ":" : "") + String.format(java.util.Locale.US, "%02d:%02d", m, s);
    }

    static String label(String duty) {
        switch (duty) {
            case "AVAILABLE": return "Free";
            case "ON_TRIP": return "On a job";
            case "BREAK": return "On break";
            default: return "Off duty";
        }
    }

    /* ---------------- actions ---------------- */

    private void togglePunch() {
        boolean onDuty = prefs.onDuty();
        Location l = lastLocation();
        if (!onDuty && l == null) {
            Toast.makeText(this, "Turn on location, then punch in", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
            return;
        }

        punchBtn.setEnabled(false);
        try {
            JSONObject body = new JSONObject();
            if (l != null) { body.put("lat", l.getLatitude()); body.put("lng", l.getLongitude()); }

            api.post(onDuty ? "/api/runner/punch-out" : "/api/runner/punch-in", body, (ok, data, err) -> {
                punchBtn.setEnabled(true);
                if (!ok) { Toast.makeText(this, err, Toast.LENGTH_LONG).show(); return; }
                Toast.makeText(this, data.optString("message", "Done"), Toast.LENGTH_SHORT).show();
                prefs.setOnDuty(!onDuty);
                if (onDuty) DutyService.stop(this); else DutyService.start(this);
                ui.post(poll);
            });
        } catch (Exception e) { punchBtn.setEnabled(true); }
    }

    private void toggleBreak() {
        boolean onBreak = "BREAK".equals(state.optString("dutyState"));
        try {
            api.post("/api/runner/break", new JSONObject().put("on", !onBreak), (ok, data, err) -> {
                if (!ok) Toast.makeText(this, err, Toast.LENGTH_LONG).show();
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

    private Location lastLocation() {
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
