package com.searvator.ibsrunner;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.core.app.ActivityCompat;

import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.Map;

/**
 * The working screen for one job: details, navigation and the stage buttons.
 *
 * The stage buttons are optimistic. Tapping one moves the screen forward immediately and the
 * request goes out behind it. If the network is down the stage is written into SyncQueue with
 * the time it was pressed, so the office eventually sees the real timeline and the runner is
 * never stuck waiting for a bar of signal on a hospital staircase.
 *
 * One stage is deliberately not optimistic: the delivery handover. That needs a photo, and a
 * photo cannot be faked forward - so it holds until the upload actually succeeds.
 */
public class TripActivity extends BaseActivity {

    private static final int REQ_PHOTO = 21;

    private Api api;
    private SyncQueue queue;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private String tripId;
    private JSONObject trip;
    private File photoFile;

    /** Set locally when a stage is tapped, so the screen does not wait for the server. */
    private String localStatus = null;
    private String localStatusAt = null;

    private TextView headline, patient, meta, ward, pickupName, pickupSub, dropName, dropSub,
            stageText, stageTimer, totalTimer, remarks, barcodeLine, distanceLine, offlineNote;
    private Button actionBtn, navBtn, callBtn;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        api = new Api(this);
        queue = new SyncQueue(this);
        Clock.restore(this);
        setContentView(R.layout.activity_trip);

        tripId = getIntent().getStringExtra("tripId");

        headline = findViewById(R.id.tHeadline);
        patient = findViewById(R.id.tPatient);
        meta = findViewById(R.id.tMeta);
        ward = findViewById(R.id.tWard);
        pickupName = findViewById(R.id.tPickupName);
        pickupSub = findViewById(R.id.tPickupSub);
        dropName = findViewById(R.id.tDropName);
        dropSub = findViewById(R.id.tDropSub);
        stageText = findViewById(R.id.tStage);
        stageTimer = findViewById(R.id.tStageTimer);
        totalTimer = findViewById(R.id.tTotalTimer);
        remarks = findViewById(R.id.tRemarks);
        barcodeLine = findViewById(R.id.tBarcode);
        distanceLine = findViewById(R.id.tDistance);
        offlineNote = findViewById(R.id.tOffline);
        actionBtn = findViewById(R.id.tAction);
        navBtn = findViewById(R.id.tNavigate);
        callBtn = findViewById(R.id.tCall);

        Anim.press(actionBtn, navBtn, callBtn);

        findViewById(R.id.tBack).setOnClickListener(v -> finish());
        navBtn.setOnClickListener(v -> navigate());
        callBtn.setOnClickListener(v -> call());
        actionBtn.setOnClickListener(v -> advance());

        load();
        ui.post(ticker);
    }

    @Override protected void onDestroy() { super.onDestroy(); ui.removeCallbacks(ticker); }

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            paintTimers();
            ui.postDelayed(this, 1000);
        }
    };

    private void load() {
        api.get("/api/runner/trip/active", (ok, data, err) -> {
            if (!ok || data == null || data.optString("id").isEmpty()) {
                // Offline? Keep whatever we already drew instead of throwing him out.
                if (trip != null) { paintOfflineNote(); return; }
                Toast.makeText(this, ok ? getString(R.string.this_job_finished) : Api.text(err), Toast.LENGTH_SHORT).show();
                finish();
                return;
            }
            trip = data;
            tripId = data.optString("id");
            // The server has caught up with the local tap - drop the optimistic state.
            if (localStatus != null && localStatus.equals(data.optString("status"))) {
                localStatus = null;
                localStatusAt = null;
            }
            paint();
        });
    }

    /** The status to draw: whatever the runner last tapped, else what the server says. */
    private String status() {
        return localStatus != null ? localStatus : trip.optString("status");
    }

    private void paint() {
        if (trip == null) return;
        boolean sample = "SAMPLE_PICKUP".equals(trip.optString("type"));

        headline.setText(trip.optString("headline") + "  ·  " + trip.optString("tripNo"));
        patient.setText(trip.optString("patientName"));
        meta.setText(metaLine());

        String w = trip.optString("wardBed", "");
        ward.setText(w.isEmpty() ? "" : getString(R.string.ward_bed, w));
        ward.setVisibility(w.isEmpty() ? View.GONE : View.VISIBLE);

        JSONObject pick = trip.optJSONObject("pickup");
        JSONObject drop = trip.optJSONObject("drop");
        pickupName.setText(pick != null ? pick.optString("name") : "");
        pickupSub.setText(pick != null ? pick.optString("area") : "");
        dropName.setText(drop != null ? drop.optString("name") : "");
        dropSub.setText(drop != null ? drop.optString("area") : "");

        // How far the next point is, worked out by the server from his last known position.
        if (!trip.isNull("targetKm")) {
            double km = trip.optDouble("targetKm", 0);
            int eta = trip.optInt("targetEtaMin", 0);
            JSONObject target = trip.optJSONObject("target");
            String name = target != null ? target.optString("name") : "";
            distanceLine.setText("≈ " + getString(R.string.km_to_stop,
                    String.format(java.util.Locale.US, "%.1f", km), name, eta));
            Anim.show(distanceLine, true);
        } else {
            Anim.show(distanceLine, false);
        }

        stageText.setText(stageLabel(sample, status()));

        String r = trip.optString("remarks", "");
        remarks.setText(r.isEmpty() ? "" : getString(R.string.desk_note, r));
        remarks.setVisibility(r.isEmpty() ? View.GONE : View.VISIBLE);

        String bc = trip.optString("sampleBarcode", "");
        barcodeLine.setText(bc.isEmpty() ? "" : getString(R.string.sample_barcode, bc));
        barcodeLine.setVisibility(bc.isEmpty() ? View.GONE : View.VISIBLE);

        String[] next = nextStage(trip.optString("type"), status());
        if (next == null) {
            Anim.show(actionBtn, false);
            stageText.setText(getString(sample ? R.string.job_done_sample : R.string.job_done_blood));
        } else {
            actionBtn.setVisibility(View.VISIBLE);
            actionBtn.setEnabled(true);
            actionBtn.setText(next[1]);
        }

        paintOfflineNote();
        paintTimers();
    }

    private void paintOfflineNote() {
        int pending = queue.size();
        if (!api.online() || pending > 0) {
            offlineNote.setText(pending > 0
                    ? getString(R.string.offline_steps_saved, pending)
                    : getString(R.string.offline_keep_pressing));
            Anim.show(offlineNote, true);
        } else {
            Anim.show(offlineNote, false);
        }
    }

    private String metaLine() {
        StringBuilder sb = new StringBuilder();
        String[] fields = {"patientAge", "patientGender", "bloodGroup", "component"};
        for (String f : fields) {
            String v = trip.optString(f, "");
            if (!v.isEmpty() && !"null".equals(v)) { if (sb.length() > 0) sb.append("  |  "); sb.append(v); }
        }
        int units = trip.optInt("units", 0);
        if (units > 0) sb.append(sb.length() > 0 ? "  |  " : "").append(getString(R.string.units_count, units));
        return sb.toString();
    }

    private void paintTimers() {
        if (trip == null) return;
        long total = Clock.since(trip.optString("assignedAt"));
        totalTimer.setText(total >= 0 ? Clock.hms(total / 1000) : "--:--");

        // Which timestamp the current stage started from. When the runner has just tapped a
        // stage that has not reached the server yet, the local tap time is the anchor.
        String stamp = localStatusAt;
        if (stamp == null) {
            String s = trip.optString("status");
            stamp = "ACCEPTED".equals(s) || "EN_ROUTE_PICKUP".equals(s) ? trip.optString("acceptedAt")
                    : "AT_PICKUP".equals(s) ? trip.optString("atPickupAt")
                    : "PICKED".equals(s) || "EN_ROUTE_DROP".equals(s) ? trip.optString("pickedAt")
                    : "AT_DROP".equals(s) ? trip.optString("atDropAt")
                    : trip.optString("assignedAt");
        }
        long stage = Clock.since(stamp);
        stageTimer.setText(stage >= 0 ? Clock.hms(stage / 1000) : "--:--");
    }

    private String stageLabel(boolean sample, String stage) {
        switch (stage) {
            case "ASSIGNED": return getString(R.string.st_new_job);
            case "ACCEPTED": return getString(R.string.st_accepted);
            case "EN_ROUTE_PICKUP": return getString(sample ? R.string.st_enroute_hosp : R.string.st_enroute_centre);
            case "AT_PICKUP": return getString(sample ? R.string.st_at_hosp : R.string.st_at_centre);
            case "PICKED": return getString(sample ? R.string.st_sample_taken : R.string.st_units_loaded);
            case "EN_ROUTE_DROP": return getString(sample ? R.string.st_return_centre : R.string.st_enroute_hosp);
            case "AT_DROP": return getString(sample ? R.string.st_at_centre : R.string.st_at_hosp);
            case "COMPLETED": return getString(sample ? R.string.st_sample_handed : R.string.st_blood_delivered);
            default: return stage;
        }
    }

    /** The one place that decides what the big button does next. */
    String[] nextStage(String type, String status) {
        boolean sample = "SAMPLE_PICKUP".equals(type);
        switch (status) {
            case "ASSIGNED": return new String[]{"ACCEPTED", getString(R.string.btn_accept_job)};
            case "ACCEPTED": return new String[]{"EN_ROUTE_PICKUP", getString(sample ? R.string.btn_start_hosp : R.string.btn_start_centre)};
            case "EN_ROUTE_PICKUP": return new String[]{"AT_PICKUP", getString(sample ? R.string.btn_reached_hosp : R.string.btn_reached_centre)};
            case "AT_PICKUP": return new String[]{"PICKED", getString(sample ? R.string.btn_sample_collected : R.string.btn_units_collected)};
            case "PICKED": return new String[]{"EN_ROUTE_DROP", getString(sample ? R.string.btn_start_back_centre : R.string.btn_start_hosp)};
            case "EN_ROUTE_DROP": return new String[]{"AT_DROP", getString(sample ? R.string.btn_reached_centre : R.string.btn_reached_hosp)};
            case "AT_DROP": return new String[]{"COMPLETED", getString(sample ? R.string.btn_sample_handed : R.string.btn_take_photo)};
            default: return null;
        }
    }

    private void advance() {
        String[] next = nextStage(trip.optString("type"), status());
        if (next == null) return;
        String stage = next[0];
        boolean sample = "SAMPLE_PICKUP".equals(trip.optString("type"));

        if ("PICKED".equals(stage)) { askExtra(sample); return; }
        if ("COMPLETED".equals(stage) && !sample) { takePhoto(); return; }
        send(stage, null, null, null);
    }

    /** Barcode on the sample leg, unit count on the delivery leg. */
    private void askExtra(boolean sample) {
        EditText input = new EditText(this);
        if (sample) input.setHint(R.string.barcode_hint);
        else { input.setHint(R.string.units_hint); input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER); }

        new AlertDialog.Builder(this)
                .setTitle(getString(sample ? R.string.btn_sample_collected : R.string.units_collected_title))
                .setView(input)
                .setPositiveButton(R.string.save, (d, w) -> {
                    String v = input.getText().toString().trim();
                    send("PICKED", sample ? v : null, sample ? null : v, null);
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void takePhoto() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, 31);
            return;
        }
        try {
            photoFile = Photos.newFile(this, "proof");
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, Photos.uriFor(this, photoFile));
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(i, REQ_PHOTO);
        } catch (Exception e) {
            Toast.makeText(this, R.string.camera_not_open, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] p, int[] r) {
        super.onRequestPermissionsResult(code, p, r);
        if (code == 31 && r.length > 0 && r[0] == PackageManager.PERMISSION_GRANTED) takePhoto();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PHOTO) return;
        if (res != RESULT_OK || photoFile == null || !photoFile.exists()) {
            Toast.makeText(this, R.string.photo_not_taken, Toast.LENGTH_LONG).show();
            return;
        }
        Photos.shrink(photoFile);
        send("COMPLETED", null, null, photoFile);
    }

    /**
     * Sends one stage. Everything except the photo handover moves the screen first.
     */
    private void send(final String stage, final String barcode, final String units, final File photo) {
        final boolean needsPhoto = photo != null;
        final Location l = lastLocation();
        final double lat = l != null ? l.getLatitude() : 0;
        final double lng = l != null ? l.getLongitude() : 0;

        Map<String, String> fields = new HashMap<>();
        fields.put("stage", stage);
        fields.put("at", Clock.nowIso());
        if (barcode != null && !barcode.isEmpty()) fields.put("barcode", barcode);
        if (units != null && !units.isEmpty()) fields.put("units", units);
        if (l != null) { fields.put("lat", String.valueOf(lat)); fields.put("lng", String.valueOf(lng)); }

        if (needsPhoto) {
            // Hold the screen: a handover is only real once the photo is actually delivered.
            actionBtn.setEnabled(false);
            actionBtn.setText(R.string.uploading_photo);
            api.postPhoto("/api/runner/trip/" + tripId + "/stage", fields, photo, (ok, data, err) -> {
                if (!ok) {
                    actionBtn.setEnabled(true);
                    actionBtn.setText(R.string.btn_take_photo);
                    new AlertDialog.Builder(this)
                            .setTitle(R.string.photo_not_sent_title)
                            .setMessage(getString(R.string.photo_not_sent_msg,
                                    Api.text(err)))
                            .setPositiveButton(R.string.ok, null)
                            .show();
                    return;
                }
                trip = data;
                Toast.makeText(this, R.string.job_finished, Toast.LENGTH_LONG).show();
                finish();
            });
            return;
        }

        // 1. Screen moves now.
        localStatus = stage;
        localStatusAt = Clock.nowIso();
        paint();

        // 2. Request follows.
        try {
            JSONObject body = new JSONObject();
            for (Map.Entry<String, String> e : fields.entrySet()) body.put(e.getKey(), e.getValue());

            api.post("/api/runner/trip/" + tripId + "/stage", body, (ok, data, err) -> {
                if (ok) {
                    trip = data;
                    localStatus = null;
                    localStatusAt = null;
                    if ("COMPLETED".equals(stage)) {
                        Toast.makeText(this, R.string.job_finished, Toast.LENGTH_LONG).show();
                        finish();
                        return;
                    }
                    paint();
                    return;
                }

                if (Api.isNetwork(err)) {
                    // Keep the screen where the runner put it and let the queue carry it.
                    queue.addStage(tripId, stage, lat, lng, barcode, units, null);
                    paintOfflineNote();
                    Toast.makeText(this, R.string.saved_on_phone, Toast.LENGTH_SHORT).show();
                } else {
                    // A real refusal from the server - roll the screen back and say why.
                    localStatus = null;
                    localStatusAt = null;
                    Toast.makeText(this, Api.text(err), Toast.LENGTH_LONG).show();
                    load();
                }
            });
        } catch (Exception e) {
            localStatus = null;
            localStatusAt = null;
            paint();
        }
    }

    private void navigate() {
        JSONObject target = trip.optJSONObject("target");
        if (target == null) target = headingToPickup() ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");
        if (target == null) return;
        String q = target.optDouble("lat", 0) + "," + target.optDouble("lng", 0);
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + q));
            i.setPackage("com.google.android.apps.maps");
            startActivity(i);
        } catch (Exception e) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("geo:" + q + "?q=" + q)));
        }
    }

    private boolean headingToPickup() {
        String s = status();
        return "ACCEPTED".equals(s) || "EN_ROUTE_PICKUP".equals(s) || "AT_PICKUP".equals(s) || "ASSIGNED".equals(s);
    }

    private void call() {
        String number = trip.optString("attendantPhone", "");
        if (number.isEmpty() || "null".equals(number)) {
            JSONObject target = trip.optJSONObject("target");
            if (target == null) target = headingToPickup() ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");
            if (target != null) number = target.optString("phone", "");
        }
        if (number.isEmpty() || "null".equals(number)) {
            Toast.makeText(this, R.string.no_phone_number, Toast.LENGTH_SHORT).show();
            return;
        }
        startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number)));
    }

    private Location lastLocation() {
        Location fromService = DutyService.fix();
        if (fromService != null) return fromService;
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null;
        try {
            LocationManager lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            Location gps = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location net = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (gps == null) return net;
            if (net == null) return gps;
            return gps.getTime() > net.getTime() ? gps : net;
        } catch (Exception e) { return null; }
    }
}
