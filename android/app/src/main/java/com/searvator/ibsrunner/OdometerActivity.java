package com.searvator.ibsrunner;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;


import java.io.File;

/**
 * Captures the bike meter reading with a photo.
 *
 * Shown twice a day: before the first punch in and before the last punch out. The photo is
 * the point - a typed number alone can be anything, a photo of the dial next to a timestamp
 * and a GPS fix is something the office can actually check against the GPS kilometres.
 *
 * Returns the reading and the photo path to whoever started it; it does not talk to the
 * server itself, because the punch call has to carry both together.
 */
public class OdometerActivity extends BaseActivity {

    public static final String EXTRA_MODE = "mode";          // "in" or "out"
    public static final String EXTRA_MIN = "min";            // reading cannot be below this
    public static final String RESULT_ODO = "odo";
    public static final String RESULT_PHOTO = "photoPath";

    private static final int REQ_CAMERA = 51;

    private EditText value;
    private ImageView preview;
    private TextView placeholder, hint, error, head, sub;
    private Button photoBtn, saveBtn;

    private File photo = null;
    private boolean punchIn = true;
    private int minReading = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_odometer);

        punchIn = !"out".equals(getIntent().getStringExtra(EXTRA_MODE));
        minReading = getIntent().getIntExtra(EXTRA_MIN, 0);

        head = findViewById(R.id.odoHead);
        sub = findViewById(R.id.odoSub);
        value = findViewById(R.id.odoValue);
        preview = findViewById(R.id.odoPreview);
        placeholder = findViewById(R.id.odoPlaceholder);
        hint = findViewById(R.id.odoHint);
        error = findViewById(R.id.odoError);
        photoBtn = findViewById(R.id.odoPhotoBtn);
        saveBtn = findViewById(R.id.odoSaveBtn);

        head.setText(getString(punchIn ? R.string.odo_start_title : R.string.odo_end_title));
        sub.setText(getString(punchIn ? R.string.odo_start_sub : R.string.odo_end_sub));
        saveBtn.setText(getString(punchIn ? R.string.punch_in : R.string.punch_out));

        if (minReading > 0) {
            hint.setText(getString(R.string.odo_morning_was, minReading));
            hint.setVisibility(View.VISIBLE);
        }

        Anim.press(photoBtn, saveBtn);
        Anim.enter(head, 40);
        Anim.enter(sub, 90);

        photoBtn.setOnClickListener(v -> takePhoto());
        saveBtn.setOnClickListener(v -> finishUp());
        findViewById(R.id.odoCancel).setOnClickListener(v -> { setResult(RESULT_CANCELED); finish(); });
    }

    private void takePhoto() {
        try {
            photo = Photos.newFile(this, punchIn ? "odo-in" : "odo-out");
            Uri uri = Photos.uriFor(this, photo);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(i, REQ_CAMERA);
        } catch (Exception e) {
            showError(getString(R.string.camera_not_open));
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_CAMERA) return;
        if (res != Activity.RESULT_OK || photo == null || !photo.exists()) {
            photo = null;
            return;
        }
        Photos.shrink(photo);
        Bitmap thumb = Photos.thumb(photo, 600);
        if (thumb != null) {
            preview.setImageBitmap(thumb);
            preview.setVisibility(View.VISIBLE);
            placeholder.setVisibility(View.GONE);
            Anim.enter(preview);
        }
        photoBtn.setText(R.string.retake_photo);
    }

    private void finishUp() {
        String raw = value.getText().toString().trim();
        if (raw.isEmpty()) { showError(getString(R.string.odo_type_reading)); return; }

        int odo;
        try { odo = Integer.parseInt(raw); }
        catch (Exception e) { showError(getString(R.string.odo_numbers_only)); return; }

        if (odo <= 0) { showError(getString(R.string.odo_real_reading)); return; }
        if (minReading > 0 && odo < minReading) {
            showError(getString(R.string.odo_backwards, minReading));
            return;
        }
        // A bike does not do 500 km in one shift. Almost always a digit typed twice.
        if (minReading > 0 && odo - minReading > 500) {
            showError(getString(R.string.odo_too_far, odo - minReading));
            return;
        }
        if (photo == null || !photo.exists()) {
            showError(getString(R.string.odo_photo_needed));
            return;
        }

        Intent out = new Intent();
        out.putExtra(RESULT_ODO, odo);
        out.putExtra(RESULT_PHOTO, photo.getAbsolutePath());
        setResult(RESULT_OK, out);
        finish();
    }

    private void showError(String msg) {
        error.setText(msg);
        Anim.show(error, true);
    }
}
