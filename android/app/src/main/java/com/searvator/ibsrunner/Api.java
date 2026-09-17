package com.searvator.ibsrunner;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

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
 * Plain HttpURLConnection client. No third party libraries, so the APK stays small
 * and the command line build has nothing extra to download.
 */
public class Api {
    public interface Cb { void done(boolean ok, JSONObject data, String error); }

    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private final Prefs prefs;

    public Api(Context c) { this.prefs = new Prefs(c); }

    public void get(String path, Cb cb) { run("GET", path, null, cb); }
    public void post(String path, JSONObject body, Cb cb) { run("POST", path, body, cb); }

    /** Blocking call - only use it from inside the service loop. */
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
                err = friendly(e);
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
                ? new JSONObject().put("list", new org.json.JSONArray(text))
                : new JSONObject(text);

        if (code >= 400) return new JSONObject().put("__error", json.optString("error", "Server said no (" + code + ")"));
        return json;
    }

    /** Used for the handover photo. */
    public void postPhoto(String path, Map<String, String> fields, File photo, Cb cb) {
        POOL.execute(() -> {
            String err = null;
            JSONObject out = null;
            try {
                String boundary = "----ibs" + System.currentTimeMillis();
                HttpURLConnection c = (HttpURLConnection) new URL(prefs.server() + path).openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setConnectTimeout(15000);
                c.setReadTimeout(40000);
                c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                if (prefs.token().length() > 0) c.setRequestProperty("Authorization", "Bearer " + prefs.token());

                DataOutputStream out2 = new DataOutputStream(c.getOutputStream());
                for (Map.Entry<String, String> e : fields.entrySet()) {
                    if (e.getValue() == null) continue;
                    out2.writeBytes("--" + boundary + "\r\n");
                    out2.writeBytes("Content-Disposition: form-data; name=\"" + e.getKey() + "\"\r\n\r\n");
                    out2.write(e.getValue().getBytes(StandardCharsets.UTF_8));
                    out2.writeBytes("\r\n");
                }
                if (photo != null && photo.exists()) {
                    out2.writeBytes("--" + boundary + "\r\n");
                    out2.writeBytes("Content-Disposition: form-data; name=\"photo\"; filename=\"" + photo.getName() + "\"\r\n");
                    out2.writeBytes("Content-Type: image/jpeg\r\n\r\n");
                    FileInputStream fis = new FileInputStream(photo);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = fis.read(buf)) > 0) out2.write(buf, 0, n);
                    fis.close();
                    out2.writeBytes("\r\n");
                }
                out2.writeBytes("--" + boundary + "--\r\n");
                out2.flush();
                out2.close();

                int code = c.getResponseCode();
                String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                c.disconnect();
                JSONObject json = new JSONObject(text == null || text.isEmpty() ? "{}" : text);
                if (code >= 400) err = json.optString("error", "Upload failed");
                else out = json;
            } catch (Exception e) {
                err = friendly(e);
            }
            final JSONObject r = out;
            final String e2 = err;
            MAIN.post(() -> cb.done(r != null, r, e2));
        });
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

    private static String friendly(Exception e) {
        String m = e.getMessage() == null ? "" : e.getMessage();
        if (m.contains("timed out") || m.contains("timeout")) return "Server is not answering. Check your internet.";
        if (m.contains("Unable to resolve host") || m.contains("Failed to connect")) return "No internet connection.";
        return "Could not reach the server.";
    }
}
