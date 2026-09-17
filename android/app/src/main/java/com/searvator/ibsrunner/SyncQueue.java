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
 * Actions that carry a photo (the delivery proof, the odometer shot) are not put in this
 * JSON queue. They are held as a pending upload with the file path and retried until the
 * upload succeeds, because the photo itself has to travel as multipart.
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
                    if (id.equals(r.optString("id"))) { handled = true; break; }
                }
                if (!handled) keep.put(item);
            }
            prefs.setActionQueue(keep.toString());
        } catch (Exception ignored) { }
    }

    public synchronized void clear() { prefs.setActionQueue("[]"); }

    private static String newId() {
        return Long.toString(System.currentTimeMillis(), 36) + "-" + (int) (Math.random() * 100000);
    }
}
