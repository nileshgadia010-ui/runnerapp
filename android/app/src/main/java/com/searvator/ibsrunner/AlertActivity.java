package com.searvator.ibsrunner;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

/**
 * The screen that wakes the phone when the desk assigns a job.
 * The alarm sound itself is played by DutyService on the alarm stream, so a silent
 * or vibrate-only phone still makes noise.
 */
public class AlertActivity extends AppCompatActivity {

    private Api api;
    private JSONObject trip;
    private String tripId;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        api = new Api(this);

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
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        load(intent);
    }

    private void load(Intent intent) {
        String raw = intent == null ? null : intent.getStringExtra("trip");
        if (raw == null) { finish(); return; }
        try { trip = new JSONObject(raw); } catch (Exception e) { finish(); return; }

        tripId = trip.optString("id");
        try { api.post("/api/runner/alert-seen", new JSONObject().put("tripId", tripId), (ok, d, e) -> { }); } catch (Exception ignored) { }

        boolean sample = "SAMPLE_PICKUP".equals(trip.optString("type"));
        JSONObject target = sample ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");

        ((TextView) findViewById(R.id.alertKind)).setText(sample ? "Go and collect a sample" : "Go and deliver blood");
        ((TextView) findViewById(R.id.alertPlace)).setText(target != null ? target.optString("name") : "");
        ((TextView) findViewById(R.id.alertArea)).setText(target != null ? target.optString("area") : "");
        ((TextView) findViewById(R.id.alertPatient)).setText(trip.optString("patientName"));
        ((TextView) findViewById(R.id.alertMeta)).setText(join(trip));
        ((TextView) findViewById(R.id.alertPriority)).setText(trip.optString("priority", "ROUTINE"));

        String priority = trip.optString("priority", "ROUTINE");
        findViewById(R.id.alertPriority).setBackgroundResource(
                "EMERGENCY".equals(priority) ? R.drawable.chip_red
                        : "URGENT".equals(priority) ? R.drawable.chip_amber : R.drawable.chip_grey);

        Button accept = findViewById(R.id.acceptBtn);
        Button decline = findViewById(R.id.declineBtn);
        accept.setOnClickListener(v -> accept());
        decline.setOnClickListener(v -> decline());
    }

    private static String join(JSONObject t) {
        StringBuilder sb = new StringBuilder();
        String[] fields = {"patientAge", "patientGender", "bloodGroup", "component"};
        for (String f : fields) {
            String v = t.optString(f, "");
            if (!v.isEmpty()) { if (sb.length() > 0) sb.append("  |  "); sb.append(v); }
        }
        int units = t.optInt("units", 0);
        if (units > 0) sb.append(sb.length() > 0 ? "  |  " : "").append(units).append(" unit(s)");
        return sb.toString();
    }

    private void accept() {
        DutyService.silence(this);
        findViewById(R.id.acceptBtn).setEnabled(false);
        try {
            JSONObject body = new JSONObject().put("stage", "ACCEPTED");
            api.post("/api/runner/trip/" + tripId + "/stage", body, (ok, data, err) -> {
                if (!ok) {
                    Toast.makeText(this, err == null ? "Could not accept" : err, Toast.LENGTH_LONG).show();
                    findViewById(R.id.acceptBtn).setEnabled(true);
                    return;
                }
                Intent i = new Intent(this, TripActivity.class);
                i.putExtra("tripId", tripId);
                i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                startActivity(i);
                finish();
            });
        } catch (Exception e) { findViewById(R.id.acceptBtn).setEnabled(true); }
    }

    private void decline() {
        EditText input = new EditText(this);
        input.setHint("Why can you not take this job?");
        new AlertDialog.Builder(this)
                .setTitle("Decline this job")
                .setView(input)
                .setPositiveButton("Decline", (d, w) -> {
                    DutyService.silence(this);
                    try {
                        JSONObject body = new JSONObject()
                                .put("stage", "REJECTED")
                                .put("note", input.getText().toString().trim());
                        api.post("/api/runner/trip/" + tripId + "/stage", body, (ok, data, err) -> {
                            Toast.makeText(this, ok ? "The desk has been told" : String.valueOf(err), Toast.LENGTH_LONG).show();
                            finish();
                        });
                    } catch (Exception e) { finish(); }
                })
                .setNegativeButton("Go back", null)
                .show();
    }

    @Override
    public void onBackPressed() {
        Toast.makeText(this, "Accept or decline the job first", Toast.LENGTH_SHORT).show();
    }
}
