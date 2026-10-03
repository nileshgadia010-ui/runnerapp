package com.searvator.ibsrunner;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The offline brain of the app.
 *
 * Every action the runner takes - punch in, punch out, accept, reached, picked, delivered,
 * break - is written into this queue first and only then sent. That ordering is the whole
 * trick:
 *
 *   - the screen updates immediately, because it never waits for the network,
 *   - if the network is missing the action simply stays in the queue,
 *   - the moment the phone gets data back, DutyService posts the whole queue in one call,
 *   - each entry carries the time the runner actually pressed the button, so a stage that
 *     was pressed in a basement at 3:04 and uploaded at 3:31 is still recorded as 3:04.
 *
 * Actions that carry a photo (the arrival shot, the delivery proof) cannot ride in this JSON
 * queue, because the picture itself has to travel as multipart. They go into a second queue
 * alongside it which keeps the file path on the phone and retries the upload until it lands -
 * so a compulsory photo never stops a runner who is standing in a basement with no signal.
 */
public class SyncQueue {

    private static final int MAX = 300;

    private final Prefs prefs;

    public SyncQueue(Context c) { this.prefs = new Prefs(c); }

    /* ---- adding ---- */

    public synchronized String addStage(String tripId, String stage, double lat, double lng,
                                        String barcode, String units, String note) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", newId());
            o.put("kind", "stage");
            o.put("tripId", tripId);
            o.put("stage", stage);
            if (lat != 0 || lng != 0) { o.put("lat", lat); o.put("lng", lng); }
            if (barcode != null && barcode.length() > 0) o.put("barcode", barcode);
            if (units != null && units.length() > 0) o.put("units", units);
            if (note != null && note.length() > 0) o.put("note", note);
            o.put("at", Clock.nowIso());
            push(o);
            return o.getString("id");
        } catch (Exception e) { return null; }
    }

    /**
     * A stage with the two extras the plain version cannot carry: "and I have it in my hand"
     * (one press for arrive + collect), and which job it was collected together with, so the
     * server can file the one photo against both.
     */
    public synchronized String addStageFull(String tripId, String stage, double lat, double lng,
                                            String units, String note, boolean andPicked, String withTrip) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", newId());
            o.put("kind", "stage");
            o.put("tripId", tripId);
            o.put("stage", stage);
            if (lat != 0 || lng != 0) { o.put("lat", lat); o.put("lng", lng); }
            if (units != null && units.length() > 0) o.put("units", units);
            if (note != null && note.length() > 0) o.put("note", note);
            if (andPicked) o.put("andPicked", true);
            if (withTrip != null && withTrip.length() > 0) o.put("withTrip", withTrip);
            o.put("at", Clock.nowIso());
            push(o);
            return o.getString("id");
        } catch (Exception e) { return null; }
    }

    /** A stage with every field the screen collected (amount, mode, barcode, units, ...). */
    public synchronized String addStageMap(String tripId, String stage, java.util.Map<String, String> fields) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", newId());
            o.put("kind", "stage");
            o.put("tripId", tripId);
            for (java.util.Map.Entry<String, String> e : fields.entrySet()) {
                if (e.getValue() != null && !e.getValue().isEmpty()) o.put(e.getKey(), e.getValue());
            }
            o.put("stage", stage);
            if (!o.has("at")) o.put("at", Clock.nowIso());
            push(o);
            return o.getString("id");
        } catch (Exception e) { return null; }
    }

    public synchronized String addPunch(boolean in, double lat, double lng, int odo) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", newId());
            o.put("kind", in ? "punch-in" : "punch-out");
            o.put("lat", lat);
            o.put("lng", lng);
            if (odo > 0) o.put("odo", odo);
            o.put("at", Clock.nowIso());
            push(o);
            return o.getString("id");
        } catch (Exception e) { return null; }
    }

    public synchronized void addBreak(boolean on) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", newId());
            o.put("kind", "break");
            o.put("on", on);
            o.put("at", Clock.nowIso());
            push(o);
        } catch (Exception ignored) { }
    }

    private void push(JSONObject o) throws Exception {
        JSONArray arr = read();
        arr.put(o);
        // Keep the newest MAX entries if a phone has been offline for a very long time.
        while (arr.length() > MAX) arr.remove(0);
        prefs.setActionQueue(arr.toString());
    }

    /* ---- reading and clearing ---- */

    public synchronized JSONArray read() {
        try { return new JSONArray(prefs.actionQueue()); }
        catch (Exception e) { return new JSONArray(); }
    }

    public synchronized int size() { return read().length(); }
    public synchronized boolean isEmpty() { return size() == 0; }

    /**
     * Removes the entries the server confirmed. Anything the server rejected with a real
     * error is also dropped - retrying it forever would block the queue - but a network
     * failure never reaches here, so those entries stay and are retried next time.
     */
    public synchronized void removeIds(JSONArray results) {
        try {
            JSONArray keep = new JSONArray();
            JSONArray current = read();
            for (int i = 0; i < current.length(); i++) {
                JSONObject item = current.getJSONObject(i);
                String id = item.optString("id");
                boolean handled = false;
                for (int j = 0; j < results.length(); j++) {
                    JSONObject r = results.getJSONObject(j);
                    // "retry" means the server hit a problem of its own - keep it and resend.
                    if (id.equals(r.optString("id"))) { handled = !r.optBoolean("retry", false); break; }
                }
                if (!handled) keep.put(item);
            }
            prefs.setActionQueue(keep.toString());
        } catch (Exception ignored) { }
    }

    public synchronized void clear() { prefs.setActionQueue("[]"); }

    /* ------------------------------------------------------------------ *
     * Photo queue
     *
     * Same idea as above, but the entry points at a JPEG sitting in the app's own folder.
     * The screen moves the moment the shutter closes; the upload happens whenever there is
     * a network, which may be an hour later in a hospital basement.
     * ------------------------------------------------------------------ */

    public synchronized String addPhotoStage(String tripId, String stage, java.util.Map<String, String> fields,
                                             String filePath) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", newId());
            o.put("tripId", tripId);
            o.put("stage", stage);
            o.put("file", filePath);
            JSONObject f = new JSONObject();
            for (java.util.Map.Entry<String, String> e : fields.entrySet()) f.put(e.getKey(), e.getValue());
            o.put("fields", f);
            // The moment he pressed, not the moment the upload gave up - that can be over a
            // minute later on a slow connection, and it is the press the TAT report measures.
            String pressed = fields.get("at");
            o.put("at", pressed != null && !pressed.isEmpty() ? pressed : Clock.nowIso());

            JSONArray arr = readPhotos();
            arr.put(o);
            while (arr.length() > 60) arr.remove(0);
            prefs.setPhotoQueue(arr.toString());
            return o.getString("id");
        } catch (Exception e) { return null; }
    }

    public synchronized JSONArray readPhotos() {
        try { return new JSONArray(prefs.photoQueue()); }
        catch (Exception e) { return new JSONArray(); }
    }

    public synchronized int photoCount() { return readPhotos().length(); }

    /** Drops one entry and deletes the picture it was holding on to. */
    public synchronized void removePhoto(String id, boolean deleteFile) {
        try {
            JSONArray keep = new JSONArray();
            JSONArray current = readPhotos();
            for (int i = 0; i < current.length(); i++) {
                JSONObject item = current.getJSONObject(i);
                if (id.equals(item.optString("id"))) {
                    if (deleteFile) {
                        try { new java.io.File(item.optString("file")).delete(); } catch (Exception ignored) { }
                    }
                    continue;
                }
                keep.put(item);
            }
            prefs.setPhotoQueue(keep.toString());
        } catch (Exception ignored) { }
    }

    /* ------------------------------------------------------------------ *
     * What is still on the phone
     * ------------------------------------------------------------------ */

    /**
     * Jobs he has finished on this phone whose "handed over" has not reached the server yet.
     *
     * Without this the home screen kept showing a delivered job at the top - the server still
     * thought it was running - and the job he actually had to do next sat underneath it.
     */
    public synchronized java.util.Set<String> pendingFinished() {
        java.util.Set<String> out = new java.util.HashSet<>();
        try {
            JSONArray a = read();
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                if ("stage".equals(o.optString("kind")) && "COMPLETED".equals(o.optString("stage"))) {
                    out.add(o.optString("tripId"));
                }
            }
            JSONArray p = readPhotos();
            for (int i = 0; i < p.length(); i++) {
                JSONObject o = p.getJSONObject(i);
                if ("COMPLETED".equals(o.optString("stage"))) out.add(o.optString("tripId"));
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** Time of the oldest waiting action, or null. ISO strings compare correctly as text. */
    public synchronized String oldestActionAt() {
        JSONArray a = read();
        return a.length() == 0 ? null : a.optJSONObject(0).optString("at", "");
    }

    public synchronized String oldestPhotoAt() {
        JSONArray a = readPhotos();
        return a.length() == 0 ? null : a.optJSONObject(0).optString("at", "");
    }

    private static String newId() {
        return Long.toString(System.currentTimeMillis(), 36) + "-" + (int) (Math.random() * 100000);
    }
}
