package com.searvator.ibsrunner;

import android.content.Context;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.os.Build;

import java.util.Locale;

/**
 * Language handling for the whole app.
 *
 * Deliberately NOT tied to the phone's system language. These phones are often set up by
 * whoever sold them, get handed between people, and frequently sit in a language the runner
 * cannot read. So the app asks once, stores the answer, and uses it everywhere - regardless
 * of what the phone itself is set to.
 *
 * Every activity and the duty service run their base context through apply(), which is what
 * makes a switch take effect instantly rather than after a reinstall.
 */
public class LocaleHelper {

    public static final String EN = "en";
    public static final String HI = "hi";
    public static final String GU = "gu";

    private static final String PREF = "ibs_runner";
    private static final String KEY = "lang";

    /** The language the runner picked, or English until he picks one. */
    public static String current(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, EN);
    }

    public static boolean chosen(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE).contains(KEY);
    }

    public static void save(Context c, String lang) {
        c.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().putString(KEY, lang).apply();
    }

    /** Wraps a context so every getString() in it comes back in the chosen language. */
    public static Context apply(Context base) {
        return wrap(base, current(base));
    }

    public static Context wrap(Context base, String lang) {
        Locale locale = new Locale(lang);
        Locale.setDefault(locale);

        Resources res = base.getResources();
        Configuration cfg = new Configuration(res.getConfiguration());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            cfg.setLocale(locale);
            return base.createConfigurationContext(cfg);
        }
        cfg.locale = locale;
        res.updateConfiguration(cfg, res.getDisplayMetrics());
        return base;
    }

    /** Names shown in the picker, each written in its own script. */
    public static String[] codes() { return new String[]{ EN, HI, GU }; }

    public static String labelFor(String code) {
        if (HI.equals(code)) return "हिंदी";
        if (GU.equals(code)) return "ગુજરાતી";
        return "English";
    }

    /** Short tag for the corner of the sign-in screen. */
    public static String shortLabel(String code) {
        if (HI.equals(code)) return "हिं";
        if (GU.equals(code)) return "ગુ";
        return "EN";
    }

    public static int indexOf(String code) {
        String[] all = codes();
        for (int i = 0; i < all.length; i++) if (all[i].equals(code)) return i;
        return 0;
    }
}
