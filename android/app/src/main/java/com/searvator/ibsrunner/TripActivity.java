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
import android.widget.LinearLayout;
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
            stageText, stageTimer, totalTimer, remarks, barcodeLine, distanceLine, offlineNote, stepLine;
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
        stepLine = findViewById(R.id.tStep);
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
            markArrivalAtDrop();
            ui.postDelayed(this, 1000);
        }
    };

    /** Set once the drop arrival has been recorded, so it is never sent twice. */
    private boolean dropArrivalSent = false;

    /**
     * Records arrival at the drop point on its own, from the geofence.
     *
     * Collapsing the trip to three taps costs one measurement: with a single tap at the end,
     * the minutes he spends waiting at the counter get counted as riding time, and the desk
     * loses the ability to say "the hospital kept him waiting". That number is worth having,
     * and it does not need a button - the phone already knows when it crossed the geofence.
     *
     * This is safe to infer where completing the job is not. It moves no work forward and
     * hands nothing over; it only marks a moment, and the runner still has to say he handed
     * over. If GPS is optimistic the dwell reads a minute long, which is a far smaller error
     * than not measuring it at all.
     */
    private void markArrivalAtDrop() {
        if (dropArrivalSent || trip == null || tripId == null) return;

        String st = status();
        if (!"PICKED".equals(st) && !"EN_ROUTE_DROP".equals(st)) return;
        if (!atTarget()) return;

        dropArrivalSent = true;
        Location l = lastLocation();
        try {
            JSONObject body = new JSONObject().put("stage", "AT_DROP").put("at", Clock.nowIso());
            if (l != null) { body.put("lat", l.getLatitude()); body.put("lng", l.getLongitude()); }
            api.post("/api/runner/trip/" + tripId + "/stage", body, (ok, data, err) -> {
                if (ok) { trip = data; paint(); }
                else if (Api.isNetwork(err)) {
                    queue.addStage(tripId, "AT_DROP",
                            l != null ? l.getLatitude() : 0, l != null ? l.getLongitude() : 0,
                            null, null, null);
                }
                // A refusal from the server means the stage moved on already - nothing to do.
            });
        } catch (Exception ignored) { }
    }

    private void load() {
        api.get("/api/runner/trip/active", (ok, data, err) -> {
            if (!ok || data == null || data.optString("id").isEmpty()) {
                // Offline? Keep whatever we already drew instead of throwing him out.
                if (trip != null) { paintOfflineNote(); return; }
                Toast.makeText(this, ok ? getString(R.string.this_job_finished) : Api.text(err), Toast.LENGTH_SHORT).show();
                finish();
                return;
            }
            if (!data.optString("id").equals(tripId)) dropArrivalSent = false;
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
        int step = stepNumber(status());
        if (step > 0 && next != null) {
            stepLine.setText(getString(R.string.step_of, step));
            Anim.show(stepLine, true);
        } else {
            Anim.show(stepLine, false);
        }

        if (next == null) {
            Anim.show(actionBtn, false);
            stageText.setText(getString(isBlood()
                    ? (sample ? R.string.job_done_sample : R.string.job_done_blood)
                    : R.string.job_done_generic));
        } else {
            actionBtn.setVisibility(View.VISIBLE);
            actionBtn.setEnabled(true);
            actionBtn.setText(next[1]);

            // Once he is actually standing at the place, the button turns green and says so.
            // It does not press itself - a GPS fix is not proof of arrival, and a wrong
            // timestamp in the TAT report is worse than one extra tap - but it removes the
            // hesitation about whether this is the right moment.
            boolean here = atTarget();
            actionBtn.setBackgroundResource(here ? R.drawable.btn_green : R.drawable.btn_red);
            if (here && "AT_PICKUP".equals(next[0])) {
                JSONObject t = trip.optJSONObject("target");
                String nm = t != null ? t.optString("name", "") : "";
                if (!nm.isEmpty()) {
                    stepLine.setText(getString(R.string.near_target, nm));
                    Anim.show(stepLine, true);
                }
            }
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

    /**
     * The line under the name. A blood job shows the clinical detail the runner has to match
     * at the counter; a payment job shows the amount; a parcel shows what is inside. Nothing
     * else is sent to the phone, so nothing else can appear here.
     */
    private String metaLine() {
        StringBuilder sb = new StringBuilder();

        String type = trip.optString("type");
        if ("PAYMENT_COLLECT".equals(type)) {
            String amt = trip.optString("amount", "");
            if (!amt.isEmpty() && !"null".equals(amt)) sb.append(getString(R.string.amount_to_collect, amt));
            String against = trip.optString("amountAgainst", "");
            if (!against.isEmpty() && !"null".equals(against)) {
                if (sb.length() > 0) sb.append("  |  ");
                sb.append(getString(R.string.amount_against, against));
            }
            return sb.toString();
        }
        if ("PACKAGE_DELIVER".equals(type)) {
            String what = trip.optString("packageDetails", "");
            return what.isEmpty() || "null".equals(what) ? "" : getString(R.string.package_is, what);
        }

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

    /** True for the two blood legs; the other three job types are plain errands. */
    private boolean isBlood() {
        String t = trip.optString("type");
        return "SAMPLE_PICKUP".equals(t) || "BLOOD_DELIVERY".equals(t);
    }

    private String stageLabel(boolean sample, String stage) {
        String type = trip.optString("type");
        boolean payment = "PAYMENT_COLLECT".equals(type);
        boolean parcel = "PACKAGE_DELIVER".equals(type);

        switch (stage) {
            case "ASSIGNED": return getString(R.string.st_new_job);
            case "ACCEPTED": return getString(R.string.st_accepted);
            case "EN_ROUTE_PICKUP": return getString(sample ? R.string.st_enroute_hosp : R.string.st_enroute_centre);
            case "AT_PICKUP": return getString(sample ? R.string.st_at_hosp : R.string.st_at_centre);
            case "PICKED":
                if (payment) return getString(R.string.st_payment_taken);
                if (parcel) return getString(R.string.st_package_taken);
                return getString(sample || !isBlood() ? R.string.st_sample_taken : R.string.st_units_loaded);
            case "EN_ROUTE_DROP": return getString(sample ? R.string.st_return_centre : R.string.st_enroute_hosp);
            case "AT_DROP": return getString(sample ? R.string.st_at_centre : R.string.st_at_hosp);
            case "COMPLETED":
                if (payment) return getString(R.string.st_payment_handed);
                if (parcel) return getString(R.string.st_package_handed);
                return getString(sample || !isBlood() ? R.string.st_sample_handed : R.string.st_blood_delivered);
            default: return stage;
        }
    }

    /*
     * The one place that decides what the big button does next.
     *
     * The stage machine has seven stops, but a runner only ever has three things to tell us:
     * he arrived, he has the thing and is leaving, he handed it over. Pressing a button for
     * "I am on my way" twice per trip is work that buys nobody anything - the server infers
     * those two stages from the ones either side, so the TAT report is unchanged while the
     * runner presses three buttons instead of seven.
     *
     * Returns { stage to send, button label }.
     */
    String[] nextStage(String type, String status) {
        boolean sample = "SAMPLE_PICKUP".equals(type);
        boolean bloodJob = sample || "BLOOD_DELIVERY".equals(type);
        boolean payment = "PAYMENT_COLLECT".equals(type);
        boolean parcel = "PACKAGE_DELIVER".equals(type);

        switch (status) {
            case "ASSIGNED":
                return new String[]{"ACCEPTED", getString(R.string.btn_accept_job)};

            // 2 of 3 - reached the place, with the camera. One press says both "I am here"
            // and "I have it in my hand", so the separate "leaving now" button is gone.
            case "ACCEPTED":
            case "EN_ROUTE_PICKUP":
                return new String[]{"AT_PICKUP", reachedLabel(true)};


            // Only reached by a job started on an older build, which stopped at AT_PICKUP
            // before those two were joined. Let him finish it the way it began.
            case "AT_PICKUP":
                if (payment) return new String[]{"PICKED", getString(R.string.btn_money_going)};
                if (parcel) return new String[]{"PICKED", getString(R.string.btn_parcel_going)};
                if (bloodJob && !sample) return new String[]{"PICKED", getString(R.string.btn_units_going)};
                return new String[]{"PICKED", getString(R.string.btn_got_it_going)};

            // 3 of 3 - handed over. AT_DROP is stamped at the same moment.
            case "PICKED":
            case "EN_ROUTE_DROP":
            case "AT_DROP":
                return new String[]{"COMPLETED", needsProof(type)
                        ? getString(R.string.btn_photo_done)
                        : getString(R.string.btn_handed_over)};

            default:
                return null;
        }
    }

    /**
     * Is he inside the geofence of the place he is heading for? The radius comes from the
     * place record, so the desk controls how tight it is per hospital - a small clinic and a
     * sprawling civil hospital do not deserve the same circle.
     */
    private boolean atTarget() {
        JSONObject target = trip.optJSONObject("target");
        if (target == null) return false;
        Location l = lastLocation();
        if (l == null) return false;

        double tLat = target.optDouble("lat", 0), tLng = target.optDouble("lng", 0);
        if (tLat == 0 && tLng == 0) return false;

        float[] out = new float[1];
        Location.distanceBetween(l.getLatitude(), l.getLongitude(), tLat, tLng, out);
        double radius = target.optDouble("geofence", 200);
        if (radius <= 0) radius = 200;
        return out[0] <= radius;
    }

    /**
     * Which step of three he is on, for the small line above the button.
     *
     * Accepting is step one, reaching the place is step two, handing over is step three -
     * which is now exactly three presses, with nothing in between.
     */
    private int stepNumber(String status) {
        switch (status) {
            case "ASSIGNED": return 1;
            case "ACCEPTED": case "EN_ROUTE_PICKUP": return 2;
            case "AT_PICKUP": case "PICKED": case "EN_ROUTE_DROP": case "AT_DROP": return 3;
            default: return 0;
        }
    }

    /**
     * "I have reached Civil Hospital" reads better than "I have reached" on its own, and it
     * is also a check: the name on the button is the place he is meant to be standing in.
     */
    private String reachedLabel(boolean pickup) {
        JSONObject target = trip.optJSONObject("target");
        if (target == null) target = trip.optJSONObject(pickup ? "pickup" : "drop");
        String name = target != null ? target.optString("name", "") : "";
        return name.isEmpty() ? getString(R.string.btn_reached) : getString(R.string.btn_reached_at, name);
    }

    /**
     * A photo at the handover, for the two jobs where something physical changes hands and
     * somebody might later dispute it: blood units at a bedside, and a parcel. A sample going
     * back to our own centre and cash handed to our own office do not need a second one.
     *
     * This is separate from the arrival photo below, which every job now takes.
     */
    private boolean needsProof(String type) {
        return "BLOOD_DELIVERY".equals(type) || "PACKAGE_DELIVER".equals(type);
    }

    /**
     * The arrival shot, and it is not optional for anybody.
     *
     * "I reached Trimurti Hospital at 10:40" is the single claim the whole TAT report rests
     * on, and until now nothing backed it up. A picture taken at the counter does - it has a
     * time, it has the phone's own position stamped beside it, and it is something a
     * coordinator can open six weeks later when a hospital says nobody came.
     */
    private boolean arrivalPhoto(String stage) {
        return "AT_PICKUP".equals(stage);
    }

    private void advance() {
        String type = trip.optString("type");
        String[] next = nextStage(type, status());
        if (next == null) return;
        String stage = next[0];

        // Arriving: camera first. What he is carrying is asked afterwards, on the way back
        // from the camera, so he is never standing at a counter answering a dialog with the
        // phone already raised.
        if (arrivalPhoto(stage)) { photoStage = stage; takePhoto(); return; }

        if ("PICKED".equals(stage)) { askExtra(type); return; }
        if ("COMPLETED".equals(stage) && needsProof(type)) { photoStage = stage; takePhoto(); return; }

        send(stage, null, null, null);
    }

    /** Which stage the camera was opened for, so the result knows what to do with itself. */
    private String photoStage = null;

    /**
     * What to capture when the runner says he has the thing in his hand.
     *
     * Only asked where the number IS the job - how much money, how many units. A tube
     * barcode is useful but not worth standing in a hospital corridor for, so the stage is
     * sent first and the barcode asked afterwards; dismissing that box costs him nothing and
     * the trip has already moved on. A parcel is asked nothing at all.
     */
    private void askExtra(String type) {
        if ("PACKAGE_DELIVER".equals(type)) { send("PICKED", null, null, null); return; }
        if ("PAYMENT_COLLECT".equals(type)) { askPayment(); return; }

        boolean sample = "SAMPLE_PICKUP".equals(type) || "COLLECTION_SAMPLE".equals(type);

        if (sample) {
            // Move first, ask second.
            send("PICKED", null, null, null);
            askBarcodeLater();
            return;
        }

        final EditText input = new EditText(this);
        input.setHint(R.string.units_hint);
        input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        new AlertDialog.Builder(this)
                .setTitle(R.string.units_collected_title)
                .setView(input)
                .setPositiveButton(R.string.save, (d, w) ->
                        send("PICKED", null, input.getText().toString().trim(), null))
                .setNegativeButton(R.string.skip, (d, w) -> send("PICKED", null, null, null))
                .show();
    }

    /** Optional, and never in the way - the trip has already advanced by the time this shows. */
    private void askBarcodeLater() {
        final EditText input = new EditText(this);
        input.setHint(R.string.barcode_optional);
        new AlertDialog.Builder(this)
                .setTitle(R.string.barcode_optional)
                .setView(input)
                .setPositiveButton(R.string.save, (d, w) -> {
                    String v = input.getText().toString().trim();
                    if (v.isEmpty() || tripId == null) return;
                    try {
                        JSONObject body = new JSONObject().put("stage", status())
                                .put("barcode", v).put("at", Clock.nowIso());
                        api.post("/api/runner/trip/" + tripId + "/note", body, (ok, d2, e2) -> { });
                    } catch (Exception ignored) { }
                })
                .setNegativeButton(R.string.skip, null)
                .show();
    }

    /** Amount plus how it was paid, so the office can reconcile it the same evening. */
    private void askPayment() {
        final EditText amount = new EditText(this);
        amount.setHint(R.string.amount_hint);
        amount.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);

        final String[] modes = { "CASH", "CHEQUE", "UPI", "OTHER" };
        final String[] labels = {
                getString(R.string.mode_cash), getString(R.string.mode_cheque),
                getString(R.string.mode_upi), getString(R.string.mode_other)
        };
        final int[] picked = { 0 };

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(getResources().getDisplayMetrics().density * 20);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(amount);

        new AlertDialog.Builder(this)
                .setTitle(R.string.amount_title)
                .setView(box)
                .setSingleChoiceItems(labels, 0, (d, which) -> picked[0] = which)
                .setCancelable(false)
                .setPositiveButton(R.string.save, (d, w) -> {
                    String v = amount.getText().toString().trim();
                    sendPayment(v, modes[picked[0]]);
                })
                .setNegativeButton(R.string.cancel, (d, w) -> sendPayment("", modes[0]))
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

        final String stage = photoStage == null ? "COMPLETED" : photoStage;
        photoStage = null;

        // The handover photo ends the job, so it still blocks the screen until it lands.
        if (!"AT_PICKUP".equals(stage)) { send(stage, null, null, photoFile); return; }

        // The arrival photo does not. Ask what he is carrying, then move the screen on and
        // let the picture upload behind him - a runner in a hospital basement must not be
        // held at a spinner because the building has no signal.
        askExtraThenArrive(trip.optString("type"));
    }

    /**
     * The arrival press, once the picture is taken.
     *
     * Whatever the job needs counting - how much cash, how many units - is asked here, and
     * then a single request carries the photo, the count and both stages together.
     */
    private void askExtraThenArrive(String type) {
        if ("PAYMENT_COLLECT".equals(type)) {
            askPayment();
            return;
        }
        if ("BLOOD_DELIVERY".equals(type)) {
            final EditText input = new EditText(this);
            input.setHint(R.string.units_hint);
            input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
            new AlertDialog.Builder(this)
                    .setTitle(R.string.units_collected_title)
                    .setView(input)
                    .setCancelable(false)
                    .setPositiveButton(R.string.save, (d, w) ->
                            arrive(null, input.getText().toString().trim()))
                    .setNegativeButton(R.string.skip, (d, w) -> arrive(null, null))
                    .show();
            return;
        }
        // A sample or a parcel: nothing to count. Move now, ask the barcode afterwards.
        arrive(null, null);
        if ("SAMPLE_PICKUP".equals(type) || "COLLECTION_SAMPLE".equals(type)) askBarcodeLater();
    }

    /**
     * Sends "reached, and I have it" as one request, with the picture attached.
     *
     * The screen moves first and the upload follows. If it cannot go now it is written into
     * the photo queue with the file, and the service pushes it the moment there is data - so
     * the compulsory photo never becomes a compulsory network connection.
     */
    private void arrive(String barcode, String units) {
        final Location l = lastLocation();

        Map<String, String> fields = new HashMap<>();
        fields.put("stage", "AT_PICKUP");
        fields.put("andPicked", "1");
        fields.put("at", Clock.nowIso());
        if (barcode != null && !barcode.isEmpty()) fields.put("barcode", barcode);
        if (units != null && !units.isEmpty()) fields.put("units", units);
        if (pendingAmount != null && !pendingAmount.isEmpty()) {
            fields.put("amount", pendingAmount);
            fields.put("paymentMode", pendingMode == null ? "CASH" : pendingMode);
        }
        if (l != null) {
            fields.put("lat", String.valueOf(l.getLatitude()));
            fields.put("lng", String.valueOf(l.getLongitude()));
        }

        // 1. Screen moves now. PICKED, not AT_PICKUP - one press covers both.
        localStatus = "PICKED";
        localStatusAt = Clock.nowIso();
        paint();

        final File shot = photoFile;
        final Map<String, String> sent = fields;

        // 2. Upload follows, and is queued if it cannot go.
        api.postPhoto("/api/runner/trip/" + tripId + "/stage", sent, shot, (ok, data, err) -> {
            if (ok) {
                trip = data;
                localStatus = null;
                localStatusAt = null;
                pendingAmount = null;
                pendingMode = null;
                try { if (shot != null) shot.delete(); } catch (Exception ignored) { }
                paint();
                return;
            }
            // Hold on to it. The service retries until it lands.
            queue.addPhotoStage(tripId, "AT_PICKUP", sent, shot == null ? "" : shot.getAbsolutePath());
            pendingAmount = null;
            pendingMode = null;
            paintOfflineNote();
        });
    }

    /**
     * Sends one stage. Everything except the photo handover moves the screen first.
     */
    private String pendingAmount = null, pendingMode = null;

    /**
     * The amount goes with whichever press asked for it - the arrival now, or the older
     * "leaving with it" button on a job that began before the two were joined.
     */
    private void sendPayment(String amount, String mode) {
        pendingAmount = amount;
        pendingMode = mode;
        if (photoFile != null && photoFile.exists()) { arrive(null, null); return; }
        send("PICKED", null, null, null);
    }

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
        if (pendingAmount != null && !pendingAmount.isEmpty()) {
            fields.put("amount", pendingAmount);
            fields.put("paymentMode", pendingMode == null ? "CASH" : pendingMode);
        }
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
                    pendingAmount = null;
                    pendingMode = null;
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
