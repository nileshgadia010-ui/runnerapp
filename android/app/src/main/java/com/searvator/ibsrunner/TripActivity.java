package com.searvator.ibsrunner;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;

/** The working screen for one job: details, navigation and the stage buttons. */
public class TripActivity extends AppCompatActivity {

    private static final int REQ_PHOTO = 21;

    private Api api;
    private Prefs prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private String tripId;
    private JSONObject trip;
    private File photoFile;

    private TextView headline, patient, meta, ward, pickupName, pickupSub, dropName, dropSub,
            stageText, stageTimer, totalTimer, remarks, barcodeLine;
    private Button actionBtn, navBtn, callBtn;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        api = new Api(this);
        prefs = new Prefs(this);
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
        actionBtn = findViewById(R.id.tAction);
        navBtn = findViewById(R.id.tNavigate);
        callBtn = findViewById(R.id.tCall);

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
                Toast.makeText(this, "This job is finished", Toast.LENGTH_SHORT).show();
                finish();
                return;
            }
            trip = data;
            tripId = data.optString("id");
            paint();
        });
    }

    private void paint() {
        boolean sample = "SAMPLE_PICKUP".equals(trip.optString("type"));
        headline.setText(trip.optString("headline") + "  ·  " + trip.optString("tripNo"));
        patient.setText(trip.optString("patientName"));
        meta.setText(AlertActivityMeta());
        String w = trip.optString("wardBed", "");
        ward.setText(w.isEmpty() ? "" : "Ward / bed: " + w);
        ward.setVisibility(w.isEmpty() ? View.GONE : View.VISIBLE);

        JSONObject pick = trip.optJSONObject("pickup");
        JSONObject drop = trip.optJSONObject("drop");
        pickupName.setText(pick != null ? pick.optString("name") : "");
        pickupSub.setText(pick != null ? pick.optString("area") : "");
        dropName.setText(drop != null ? drop.optString("name") : "");
        dropSub.setText(drop != null ? drop.optString("area") : "");

        stageText.setText(trip.optString("statusLabel"));
        String r = trip.optString("remarks", "");
        remarks.setText(r.isEmpty() ? "" : "Desk note: " + r);
        remarks.setVisibility(r.isEmpty() ? View.GONE : View.VISIBLE);

        String bc = trip.optString("sampleBarcode", "");
        barcodeLine.setText(bc.isEmpty() ? "" : "Sample barcode: " + bc);
        barcodeLine.setVisibility(bc.isEmpty() ? View.GONE : View.VISIBLE);

        String[] next = nextStage(trip.optString("type"), trip.optString("status"));
        if (next == null) {
            actionBtn.setVisibility(View.GONE);
            stageText.setText(sample ? "Sample handed over. Job done." : "Blood delivered. Job done.");
        } else {
            actionBtn.setVisibility(View.VISIBLE);
            actionBtn.setText(next[1]);
        }
        paintTimers();
    }

    private String AlertActivityMeta() {
        StringBuilder sb = new StringBuilder();
        String[] fields = {"patientAge", "patientGender", "bloodGroup", "component"};
        for (String f : fields) {
            String v = trip.optString(f, "");
            if (!v.isEmpty()) { if (sb.length() > 0) sb.append("  |  "); sb.append(v); }
        }
        int units = trip.optInt("units", 0);
        if (units > 0) sb.append(sb.length() > 0 ? "  |  " : "").append(units).append(" unit(s)");
        return sb.toString();
    }

    private void paintTimers() {
        if (trip == null) return;
        long total = since(trip.optString("assignedAt"));
        totalTimer.setText(HomeActivity.clock(total / 1000));

        String status = trip.optString("status");
        String stamp = "ACCEPTED".equals(status) || "EN_ROUTE_PICKUP".equals(status) ? trip.optString("acceptedAt")
                : "AT_PICKUP".equals(status) ? trip.optString("atPickupAt")
                : "PICKED".equals(status) || "EN_ROUTE_DROP".equals(status) ? trip.optString("pickedAt")
                : "AT_DROP".equals(status) ? trip.optString("atDropAt")
                : trip.optString("assignedAt");
        long stage = since(stamp);
        stageTimer.setText(HomeActivity.clock(stage / 1000));
    }

    private static long since(String iso) {
        if (iso == null || iso.isEmpty() || "null".equals(iso)) return 0;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            return System.currentTimeMillis() - f.parse(iso.substring(0, 19)).getTime();
        } catch (Exception e) { return 0; }
    }

    /** The one place that decides what the big button does next. */
    static String[] nextStage(String type, String status) {
        boolean sample = "SAMPLE_PICKUP".equals(type);
        switch (status) {
            case "ASSIGNED": return new String[]{"ACCEPTED", "Accept this job"};
            case "ACCEPTED": return new String[]{"EN_ROUTE_PICKUP", sample ? "Start for the hospital" : "Start for the blood centre"};
            case "EN_ROUTE_PICKUP": return new String[]{"AT_PICKUP", sample ? "I have reached the hospital" : "I have reached the blood centre"};
            case "AT_PICKUP": return new String[]{"PICKED", sample ? "Sample collected" : "Blood units collected"};
            case "PICKED": return new String[]{"EN_ROUTE_DROP", sample ? "Start back to the blood centre" : "Start for the hospital"};
            case "EN_ROUTE_DROP": return new String[]{"AT_DROP", sample ? "I have reached the blood centre" : "I have reached the hospital"};
            case "AT_DROP": return new String[]{"COMPLETED", sample ? "Sample handed over" : "Take the handover photo"};
            default: return null;
        }
    }

    private void advance() {
        String[] next = nextStage(trip.optString("type"), trip.optString("status"));
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
        if (sample) input.setHint("Sample barcode or tube number");
        else { input.setHint("How many units are you carrying?"); input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER); }

        new AlertDialog.Builder(this)
                .setTitle(sample ? "Sample collected" : "Units collected")
                .setView(input)
                .setPositiveButton("Save", (d, w) -> {
                    String v = input.getText().toString().trim();
                    send("PICKED", sample ? v : null, sample ? null : v, null);
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void takePhoto() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, 31);
            return;
        }
        try {
            File dir = new File(getFilesDir(), "photos");
            if (!dir.exists()) dir.mkdirs();
            photoFile = new File(dir, "proof_" + System.currentTimeMillis() + ".jpg");
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photoFile);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(i, REQ_PHOTO);
        } catch (Exception e) {
            Toast.makeText(this, "Camera could not open", Toast.LENGTH_LONG).show();
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
            Toast.makeText(this, "Photo not taken. The job needs a handover photo.", Toast.LENGTH_LONG).show();
            return;
        }
        shrink(photoFile);
        send("COMPLETED", null, null, photoFile);
    }

    /** Camera files are huge; 1280px wide is plenty for a proof shot. */
    private void shrink(File f) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = 2;
            Bitmap bm = BitmapFactory.decodeFile(f.getAbsolutePath(), o);
            if (bm == null) return;
            int w = 1280;
            int h = (int) (bm.getHeight() * (w / (float) bm.getWidth()));
            if (bm.getWidth() > w) bm = Bitmap.createScaledBitmap(bm, w, h, true);
            FileOutputStream out = new FileOutputStream(f);
            bm.compress(Bitmap.CompressFormat.JPEG, 72, out);
            out.close();
        } catch (Exception ignored) { }
    }

    private void send(String stage, String barcode, String units, File photo) {
        actionBtn.setEnabled(false);
        actionBtn.setText("Saving...");

        Location l = lastLocation();
        Map<String, String> fields = new HashMap<>();
        fields.put("stage", stage);
        if (barcode != null) fields.put("barcode", barcode);
        if (units != null) fields.put("units", units);
        if (l != null) { fields.put("lat", String.valueOf(l.getLatitude())); fields.put("lng", String.valueOf(l.getLongitude())); }

        Api.Cb after = (ok, data, err) -> {
            actionBtn.setEnabled(true);
            if (!ok) {
                Toast.makeText(this, err == null ? "Could not save" : err, Toast.LENGTH_LONG).show();
                paint();
                return;
            }
            trip = data;
            if ("COMPLETED".equals(stage)) {
                Toast.makeText(this, "Job finished. Well done.", Toast.LENGTH_LONG).show();
                finish();
            } else {
                Toast.makeText(this, data.optString("statusLabel", "Saved"), Toast.LENGTH_SHORT).show();
                paint();
            }
        };

        if (photo != null) {
            api.postPhoto("/api/runner/trip/" + tripId + "/stage", fields, photo, after);
        } else {
            try {
                JSONObject body = new JSONObject();
                for (Map.Entry<String, String> e : fields.entrySet()) body.put(e.getKey(), e.getValue());
                api.post("/api/runner/trip/" + tripId + "/stage", body, after);
            } catch (Exception e) { actionBtn.setEnabled(true); }
        }
    }

    private void navigate() {
        JSONObject target = headingToPickup() ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");
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
        String s = trip.optString("status");
        return "ACCEPTED".equals(s) || "EN_ROUTE_PICKUP".equals(s) || "AT_PICKUP".equals(s) || "ASSIGNED".equals(s);
    }

    private void call() {
        String number = trip.optString("attendantPhone", "");
        if (number.isEmpty()) {
            JSONObject target = headingToPickup() ? trip.optJSONObject("pickup") : trip.optJSONObject("drop");
            if (target != null) number = target.optString("phone", "");
        }
        if (number.isEmpty()) { Toast.makeText(this, "No phone number on this job", Toast.LENGTH_SHORT).show(); return; }
        startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number)));
    }

    private Location lastLocation() {
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
