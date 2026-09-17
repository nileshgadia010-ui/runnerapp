package com.searvator.ibsrunner;

import android.content.Context;
import android.location.Location;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.provider.Settings;

import java.io.File;

/**
 * Environment checks the app can make about the phone it is running on.
 *
 * Be clear about what this is and is not. Every one of these checks runs on the runner's own
 * device, so a determined person with the right tools can defeat all of them. The value is
 * not that they block anything - it is that the desk gets a record. A runner who turns on a
 * VPN or a fake-GPS app shows up flagged on the control room screen, which is exactly the
 * conversation the office wants to be able to have.
 *
 * The real protection lives on the server: every timestamp is stamped server side, stage
 * order is enforced server side, and a stage can only be moved by the runner it is assigned
 * to. Nothing the phone claims is taken on trust.
 */
public class Guard {

    /* ---- messages shown to the runner, in Gujarati ---- */

    public static final String MSG_VPN =
            "તમારા ફોનમાં VPN ચાલુ છે.\n\n" +
            "VPN બંધ કરો, નહીં તો તમારો રિપોર્ટ ઓફિસ (એડમિન) ને મોકલવામાં આવશે.\n\n" +
            "VPN બંધ કર્યા પછી જ કામ ચાલુ થશે.";

    public static final String MSG_MOCK =
            "ફોનમાં નકલી લોકેશન (Fake GPS) એપ ચાલુ છે.\n\n" +
            "તે બંધ કરો, નહીં તો તમારો રિપોર્ટ ઓફિસ (એડમિન) ને મોકલવામાં આવશે.";

    public static final String MSG_NO_NET =
            "ઇન્ટરનેટ નથી.\n\n" +
            "ચિંતા ન કરો - તમારું કામ ફોનમાં સેવ થઈ ગયું છે અને નેટ આવતાં જ ઓફિસે પહોંચી જશે.";

    public static final String MSG_LOCATION_OFF =
            "લોકેશન (GPS) બંધ છે.\n\nપંચ ઇન કરવા માટે લોકેશન ચાલુ કરો.";

    /* ---- VPN ---- */

    /** True when any active network is running through a VPN tunnel. */
    public static boolean vpnOn(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                for (Network n : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                    if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return true;
                }
                return false;
            }
            // Older phones: look for a tunnel interface.
            java.util.Enumeration<java.net.NetworkInterface> list = java.net.NetworkInterface.getNetworkInterfaces();
            while (list != null && list.hasMoreElements()) {
                java.net.NetworkInterface ni = list.nextElement();
                if (!ni.isUp()) continue;
                String name = ni.getName();
                if (name.startsWith("tun") || name.startsWith("ppp") || name.startsWith("pptp")) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    /* ---- fake GPS ---- */

    /** True when this particular fix was produced by a fake-GPS app. */
    public static boolean isMock(Location l) {
        if (l == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return l.isMock();
            return l.isFromMockProvider();
        } catch (Exception e) { return false; }
    }

    /* ---- developer options ---- */

    public static boolean devModeOn(Context c) {
        try {
            return Settings.Secure.getInt(c.getContentResolver(),
                    Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1;
        } catch (Exception e) { return false; }
    }

    /* ---- root ---- */

    private static final String[] SU_PATHS = {
            "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su",
            "/vendor/bin/su", "/su/bin/su", "/data/local/xbin/su", "/data/local/bin/su"
    };

    /** A light root check: the usual su binaries, test-keys builds, and known manager apps. */
    public static boolean rooted(Context c) {
        try {
            for (String p : SU_PATHS) if (new File(p).exists()) return true;
            String tags = Build.TAGS;
            if (tags != null && tags.contains("test-keys")) return true;
            String[] managers = { "com.topjohnwu.magisk", "eu.chainfire.supersu", "com.koushikdutta.superuser" };
            for (String m : managers) {
                try { c.getPackageManager().getPackageInfo(m, 0); return true; } catch (Exception ignored) { }
            }
        } catch (Exception ignored) { }
        return false;
    }

    /** One call that collects everything, used by the duty service on its reporting loop. */
    public static Flags scan(Context c, Location lastFix) {
        Flags f = new Flags();
        f.vpn = vpnOn(c);
        f.mockLocation = isMock(lastFix);
        f.rooted = rooted(c);
        f.devMode = devModeOn(c);
        return f;
    }

    public static class Flags {
        public boolean vpn, mockLocation, rooted, devMode;
        public boolean anySerious() { return vpn || mockLocation || rooted; }
    }
}
