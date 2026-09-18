package com.searvator.ibsrunner;

import android.content.Context;
import android.content.Intent;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Every screen extends this so the chosen language is applied before any view is inflated.
 * It also holds the language picker, since more than one screen offers it.
 */
public class BaseActivity extends AppCompatActivity {

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(LocaleHelper.apply(base));
    }

    /**
     * Shows the three languages, each written in its own script - a runner who cannot read
     * English can still find his own. Switching restarts the screen so every label changes
     * at once instead of leaving half the page in the old language.
     */
    protected void showLanguagePicker() {
        final String[] codes = LocaleHelper.codes();
        final String[] labels = new String[codes.length];
        for (int i = 0; i < codes.length; i++) labels[i] = LocaleHelper.labelFor(codes[i]);

        new AlertDialog.Builder(this)
                .setTitle(R.string.choose_language)
                .setSingleChoiceItems(labels, LocaleHelper.indexOf(LocaleHelper.current(this)), (d, which) -> {
                    d.dismiss();
                    if (codes[which].equals(LocaleHelper.current(this))) return;
                    LocaleHelper.save(this, codes[which]);
                    restartForLanguage();
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    /** Relaunches this screen with the new language, keeping the person where they were. */
    protected void restartForLanguage() {
        Intent i = getIntent();
        i.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        finish();
        overridePendingTransition(0, 0);
        startActivity(i);
        overridePendingTransition(0, 0);
    }
}
