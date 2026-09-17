package com.searvator.ibsrunner;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Camera file handling shared by the proof photo and the odometer photo.
 *
 * Phone cameras produce 4-6 MB files. On a runner's data pack that is both slow and
 * expensive, and the office only ever looks at these on a screen, so every shot is scaled
 * down to 1280 px on its long edge and saved at JPEG quality 72 - roughly 150-250 KB, still
 * easily readable for a meter dial or a blood bag label.
 */
public class Photos {

    private static final int MAX_EDGE = 1280;
    private static final int QUALITY = 72;

    /** Creates an empty file in the app's own folder and the content Uri the camera writes to. */
    public static File newFile(Context c, String prefix) {
        File dir = new File(c.getFilesDir(), "photos");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, prefix + "-" + System.currentTimeMillis() + ".jpg");
    }

    public static Uri uriFor(Context c, File f) {
        return FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", f);
    }

    /**
     * Shrinks the file the camera just wrote, in place. Honours the EXIF rotation flag so a
     * photo taken in portrait does not arrive at the office lying on its side.
     */
    public static boolean shrink(File f) {
        try {
            if (f == null || !f.exists()) return false;

            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), probe);

            int longEdge = Math.max(probe.outWidth, probe.outHeight);
            int sample = 1;
            while (longEdge / sample > MAX_EDGE * 2) sample *= 2;

            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), opts);
            if (bmp == null) return false;

            float scale = (float) MAX_EDGE / Math.max(bmp.getWidth(), bmp.getHeight());
            if (scale < 1f) {
                bmp = Bitmap.createScaledBitmap(bmp,
                        Math.round(bmp.getWidth() * scale), Math.round(bmp.getHeight() * scale), true);
            }

            bmp = applyExifRotation(f, bmp);

            FileOutputStream out = new FileOutputStream(f);
            bmp.compress(Bitmap.CompressFormat.JPEG, QUALITY, out);
            out.flush();
            out.close();
            bmp.recycle();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static Bitmap applyExifRotation(File f, Bitmap bmp) {
        try {
            ExifInterface exif = new ExifInterface(f.getAbsolutePath());
            int o = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            int deg = 0;
            if (o == ExifInterface.ORIENTATION_ROTATE_90) deg = 90;
            else if (o == ExifInterface.ORIENTATION_ROTATE_180) deg = 180;
            else if (o == ExifInterface.ORIENTATION_ROTATE_270) deg = 270;
            if (deg == 0) return bmp;
            Matrix m = new Matrix();
            m.postRotate(deg);
            return Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
        } catch (Exception e) {
            return bmp;
        }
    }

    /** A small bitmap for the on-screen preview, so we never hold a full photo in memory. */
    public static Bitmap thumb(File f, int maxEdge) {
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(f.getAbsolutePath(), probe);
            int sample = 1;
            while (Math.max(probe.outWidth, probe.outHeight) / sample > maxEdge * 2) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            return BitmapFactory.decodeFile(f.getAbsolutePath(), opts);
        } catch (Exception e) {
            return null;
        }
    }
}
