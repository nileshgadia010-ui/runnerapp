package com.searvator.ibsrunner;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;

import org.json.JSONObject;

/**
 * The screen that wakes the phone when the desk assigns a job.
 *
 * The alarm sound is played by DutyService on the ALARM stream, which Android does not mute
 * in silent mode, at full volume, on a loop, and it keeps going until this screen is answered.
 * The back button does nothing here on purpose - a job is accepted or declined, not dismissed.
 */
public class AlertActivity extends BaseActivity {

    private Api api;
    private SyncQueue queue;
    private JSONObject trip;
    private String tripId;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private long shownAt = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        api = new Api(this);
        queue = new SyncQueue(this);
        Clock.restore(this);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_alert);
        load(getIntent());
        ui.post(waiting);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        load(intent);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        ui.removeCallbacks(waiting);
    }

    /** A visible counter of how long the job has been ringing unanswered. */
    private final Runnable waiting = new Runnable() {
        @Override public void run() {
            TextView t = findViewById(R.id.alertWaiting);
            if (t != null && shownAt > 0) {
                long s = (Clock.now() - shownAt) / 1000;
                t.setText(getString(R.string.ringing_for, Clock.hms(s)));
            }
            ui.postDelayed(this, 1000);
        }
    };

    private void load(Intent intent) {
        String raw = intent == null ? null : intent.getStringExtra("trip");
        if (raw == null) { finish(); return; }
        try { trip = new JSONObject(raw); } catch (Exception e) { finish(); return; }

        tripId = trip.optString("id");
        shownAt = Clock.now();

        try {
            api.post("/api/runner/alert-seen", new JSONObject().put("tripId", tripId), (ok, d, e) -> { });
        } catch (Exception ignored) { }

        boolean sample = "SAMPLE_PICKUP".equals(trip.optString("type"));
        JSONObject target = trip.optJSONObject("target");
        if (target == null) target = sample ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");

        ((TextView) findViewById(R.id.alertKind)).setText(getString(sample ? R.string.go_collect_sample : R.string.go_deliver_blood));
        ((TextView) findViewById(R.id.alertPlace)).setText(target != null ? target.optString("name") : "");
        ((TextView) findViewById(R.id.alertArea)).setText(target != null ? target.optString("area") : "");
        ((TextView) findViewById(R.id.alertPatient)).setText(trip.optString("patientName"));
        ((TextView) findViewById(R.id.alertMeta)).setText(join(trip));

        String priority = trip.optString("priority", "ROUTINE");
        TextView pr = findViewById(R.id.alertPriority);
        pr.setText(priority);
        pr.setBackgroundResource("EMERGENCY".equals(priority) ? R.drawable.chip_red
                : "URGENT".equals(priority) ? R.drawable.chip_amber : R.drawable.chip_grey);

        // How far he is being asked to go, before he says yes.
        TextView dist = findViewById(R.id.alertDistance);
        if (!trip.isNull("targetKm")) {
            double km = trip.optDouble("targetKm", 0);
            int eta = trip.optInt("targetEtaMin", 0);
            dist.setText("≈ " + getString(R.string.km_away, String.format(java.util.Locale.US, "%.1f", km), eta));
            dist.setVisibility(View.VISIBLE);
        } else {
            dist.setVisibility(View.GONE);
        }

        Button accept = findViewById(R.id.acceptBtn);
        Button decline = findViewById(R.id.declineBtn);
        Anim.press(accept, decline);
        accept.setOnClickListener(v -> accept());
        decline.setOnClickListener(v -> decline());
    }

    private static String join(JSONObject t) {
        StringBuilder sb = new StringBuilder();
        String[] fields = {"patientAge", "patientGender", "bloodGroup", "component"};
        for (String f : fields) {
            String v = t.optString(f, "");
            if (!v.isEmpty() && !"null".equals(v)) { if (sb.length() > 0) sb.append("  |  "); sb.append(v); }
        }
        int units = t.optInt("units", 0);
        if (units > 0) sb.append(sb.length() > 0 ? "  |  " : "").append(units).append(" unit(s)");
        return sb.toString();
    }

    /**
     * Accepting stops the alarm and opens the job immediately. The server call runs behind
     * that; with no network the acceptance is queued with the time he actually tapped, which
     * is the number the accept-time SLA is measured on.
     */
    private void accept() {
        DutyService.silence(this);
        findViewById(R.id.acceptBtn).setEnabled(false);

        final String at = Clock.nowIso();
        try {
            JSONObject body = new JSONObject().put("stage", "ACCEPTED").put("at", at);
            api.post("/api/runner/trip/" + tripId + "/stage", body, (ok, data, err) -> {
                if (!ok) {
                    if (Api.isNetwork(err)) {
                        queue.addStage(tripId, "ACCEPTED", 0, 0, null, null, null);
                        Toast.makeText(this, R.string.accepted_saved, Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(this, Api.text(err), Toast.LENGTH_LONG).show();
                        findViewById(R.id.acceptBtn).setEnabled(true);
                        return;
                    }
                }
                openTrip();
            });
        } catch (Exception e) {
            openTrip();
        }
    }

    /**
     * Where he lands after accepting.
     *
     * A first job opens straight away - that is the job, there is nothing to choose between.
     * A job that lines up behind one he is already doing sends him home instead, where he
     * can see both and pick which to head for. Dropping him into the new job's screen while
     * he is carrying something else invites him to start the wrong one.
     */
    private void openTrip() {
        Intent i = getIntent().getBooleanExtra("queued", false)
                ? new Intent(this, HomeActivity.class)
                : new Intent(this, TripActivity.class).putExtra("tripId", tripId);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(i);
        finish();
    }

    private void decline() {
        final EditText input = new EditText(this);
        input.setHint(R.string.decline_hint);
        new AlertDialog.Builder(this)
                .setTitle(R.string.decline_title)
                .setView(input)
                .setPositiveButton(R.string.decline, (d, w) -> {
                    DutyService.silence(this);
                    final String note = input.getText().toString().trim();
                    try {
                        JSONObject body = new JSONObject()
                                .put("stage", "REJECTED")
                                .put("at", Clock.nowIso())
                                .put("note", note);
                        api.post("/api/runner/trip/" + tripId + "/stage", body, (ok, data, err) -> {
                            if (!ok) queue.addStage(tripId, "REJECTED", 0, 0, null, null, note);
                            Toast.makeText(this, R.string.desk_told, Toast.LENGTH_LONG).show();
                            finish();
                        });
                    } catch (Exception e) { finish(); }
                })
                .setNegativeButton(R.string.go_back, null)
                .show();
    }

    @Override
    public void onBackPressed() {
        Toast.makeText(this, R.string.accept_first, Toast.LENGTH_SHORT).show();
    }
}
