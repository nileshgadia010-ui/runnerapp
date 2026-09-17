package com.searvator.ibsrunner;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Plain HttpURLConnection client. No third party libraries, so the APK stays small and the
 * command line build has nothing extra to download.
 *
 * Every response that carries serverTime feeds Clock, which is how the app's timers stay
 * correct on a phone whose own date and time are wrong.
 */
public class Api {
    public interface Cb { void done(boolean ok, JSONObject data, String error); }

    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private final Context ctx;
    private final Prefs prefs;

    public Api(Context c) {
        this.ctx = c.getApplicationContext();
        this.prefs = new Prefs(c);
    }

    /* ---- connectivity ---- */

    public boolean online() { return online(ctx); }

    public static boolean online(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected();
        } catch (Exception e) { return false; }
    }

    /* ---- async ---- */

    public void get(String path, Cb cb) { run("GET", path, null, cb); }
    public void post(String path, JSONObject body, Cb cb) { run("POST", path, body, cb); }

    /* ---- blocking, for the service loop only ---- */

    public JSONObject postSync(String path, JSONObject body) {
        try { return call("POST", path, body); } catch (Exception e) { return null; }
    }
    public JSONObject getSync(String path) {
        try { return call("GET", path, null); } catch (Exception e) { return null; }
    }

    private void run(String method, String path, JSONObject body, Cb cb) {
        POOL.execute(() -> {
            JSONObject out;
            String err = null;
            try {
                out = call(method, path, body);
                if (out != null && out.has("__error")) { err = out.optString("__error"); out = null; }
            } catch (Exception e) {
                out = null;
                err = friendly(ctx, e);
            }
            final JSONObject result = out;
            final String error = err;
            MAIN.post(() -> cb.done(result != null, result, error));
        });
    }

    private JSONObject call(String method, String path, JSONObject body) throws Exception {
        URL url = new URL(prefs.server() + path);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(12000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("X-App-Version", BuildConfig.VERSION_NAME);
        if (prefs.token().length() > 0) c.setRequestProperty("Authorization", "Bearer " + prefs.token());

        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            OutputStream os = c.getOutputStream();
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            os.close();
        }

        int code = c.getResponseCode();
        String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();

        if (text == null || text.length() == 0) text = "{}";
        JSONObject json = text.trim().startsWith("[")
                ? new JSONObject().put("list", new JSONArray(text))
                : new JSONObject(text);

        // Keep the app's idea of the real time anchored to the server.
        if (json.has("serverTime")) Clock.syncFromServer(ctx, json.optString("serverTime"));

        if (code == 401) return new JSONObject().put("__error", "__auth");
        if (code >= 400) return new JSONObject().put("__error", json.optString("error", "Server said no (" + code + ")"));
        return json;
    }

    /* ---- multipart, for photos ---- */

    /** Used for the handover photo and the odometer photo. */
    public void postPhoto(String path, Map<String, String> fields, File photo, Cb cb) {
        POOL.execute(() -> {
            JSONObject out = null;
            String err = null;
            try {
                out = photoCall(path, fields, photo);
                if (out != null && out.has("__error")) { err = out.optString("__error"); out = null; }
            } catch (Exception e) {
                err = friendly(ctx, e);
            }
            final JSONObject r = out;
            final String e2 = err;
            MAIN.post(() -> cb.done(r != null, r, e2));
        });
    }

    /** Blocking version, used when the service retries a pending photo upload. */
    public JSONObject postPhotoSync(String path, Map<String, String> fields, File photo) {
        try { return photoCall(path, fields, photo); } catch (Exception e) { return null; }
    }

    private JSONObject photoCall(String path, Map<String, String> fields, File photo) throws Exception {
        String boundary = "----ibs" + System.currentTimeMillis();
        HttpURLConnection c = (HttpURLConnection) new URL(prefs.server() + path).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        c.setRequestProperty("X-App-Version", BuildConfig.VERSION_NAME);
        if (prefs.token().length() > 0) c.setRequestProperty("Authorization", "Bearer " + prefs.token());

        DataOutputStream out = new DataOutputStream(c.getOutputStream());
        if (fields != null) {
            for (Map.Entry<String, String> e : fields.entrySet()) {
                if (e.getValue() == null) continue;
                out.writeBytes("--" + boundary + "\r\n");
                out.writeBytes("Content-Disposition: form-data; name=\"" + e.getKey() + "\"\r\n\r\n");
                out.write(e.getValue().getBytes(StandardCharsets.UTF_8));
                out.writeBytes("\r\n");
            }
        }
        if (photo != null && photo.exists()) {
            out.writeBytes("--" + boundary + "\r\n");
            out.writeBytes("Content-Disposition: form-data; name=\"photo\"; filename=\"" + photo.getName() + "\"\r\n");
            out.writeBytes("Content-Type: image/jpeg\r\n\r\n");
            FileInputStream fis = new FileInputStream(photo);
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) out.write(buf, 0, n);
            fis.close();
            out.writeBytes("\r\n");
        }
        out.writeBytes("--" + boundary + "--\r\n");
        out.flush();
        out.close();

        int code = c.getResponseCode();
        String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();
        JSONObject json = new JSONObject(text == null || text.isEmpty() ? "{}" : text);
        if (json.has("serverTime")) Clock.syncFromServer(ctx, json.optString("serverTime"));
        if (code >= 400) return new JSONObject().put("__error", json.optString("error", "Upload failed"));
        return json;
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.toString();
    }

    /** Plain language, and never blames the runner for something the network did. */
    private static String friendly(Context c, Exception e) {
        String m = e.getMessage() == null ? "" : e.getMessage();
        if (!online(c)) return "No internet. Your work is saved on the phone and will be sent automatically.";
        if (m.contains("timed out") || m.contains("timeout")) return "Server is slow to answer. Trying again.";
        if (m.contains("Unable to resolve host") || m.contains("Failed to connect")) return "Cannot reach the server right now.";
        return "Could not reach the server.";
    }
}
