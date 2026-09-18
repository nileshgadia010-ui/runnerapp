package com.searvator.ibsrunner;

import android.content.Intent;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.appcompat.app.AlertDialog;

import org.json.JSONObject;

public class LoginActivity extends BaseActivity {

    private Prefs prefs;
    private Api api;

    private final android.os.Handler ui = new android.os.Handler(android.os.Looper.getMainLooper());

    private EditText username, password, serverUrl;
    private Button loginBtn;
    private TextView error, showPass, versionLine;
    private ProgressBar spin;
    private LinearLayout serverRow;
    private boolean passVisible = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        api = new Api(this);
        Clock.restore(this);

        // Already signed in - go straight through, no splash, no waiting.
        if (prefs.signedIn()) {
            startActivity(new Intent(this, HomeActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_login);

        username = findViewById(R.id.username);
        password = findViewById(R.id.password);
        serverUrl = findViewById(R.id.serverUrl);
        loginBtn = findViewById(R.id.loginBtn);
        error = findViewById(R.id.loginError);
        showPass = findViewById(R.id.showPass);
        spin = findViewById(R.id.loginSpin);
        serverRow = findViewById(R.id.serverRow);
        versionLine = findViewById(R.id.versionLine);

        serverUrl.setText(prefs.server());
        versionLine.setText(getString(R.string.footer_credit) + "  •  v" + BuildConfig.VERSION_NAME);

        Anim.press(loginBtn);
        Anim.enter(findViewById(R.id.loginHead), 60);
        Anim.enter(findViewById(R.id.loginSub), 120);

        // Language first: a runner who cannot read the form has to be able to change it
        // before signing in, not after.
        TextView lang = findViewById(R.id.langBtn);
        lang.setText(LocaleHelper.shortLabel(LocaleHelper.current(this)));
        Anim.press(lang);
        lang.setOnClickListener(v -> showLanguagePicker());

        loginBtn.setOnClickListener(v -> attempt());
        showPass.setOnClickListener(v -> togglePassword());

        // Long-press the footer to reveal the server field. Runners never find this by
        // accident; the office can use it to move a phone to another server without a rebuild.
        versionLine.setOnLongClickListener(v -> {
            Anim.show(serverRow, serverRow.getVisibility() != View.VISIBLE);
            return true;
        });

        // First run: ask the language before anything else. The three names are written in
        // their own scripts, so a runner who reads neither English nor the phone's current
        // language can still find his own and the rest of the app follows.
        if (!LocaleHelper.chosen(this)) ui.postDelayed(this::showLanguagePicker, 350);

        password.setOnEditorActionListener((v, actionId, e) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) { attempt(); return true; }
            return false;
        });
    }

    private void togglePassword() {
        passVisible = !passVisible;
        password.setInputType(passVisible
                ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setSelection(password.getText().length());
        showPass.setText(getString(passVisible ? R.string.hide : R.string.show));
    }

    private void attempt() {
        String u = username.getText().toString().trim();
        String p = password.getText().toString();

        if (TextUtils.isEmpty(u) || TextUtils.isEmpty(p)) {
            showError(getString(R.string.enter_credentials));
            return;
        }

        // A VPN between the phone and the server hides where the runner really is, which is
        // the one thing this whole system exists to show. Say so plainly, in Gujarati, and
        // do not let the sign-in proceed until it is off.
        if (Guard.vpnOn(this)) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.vpn_title)
                    .setMessage(R.string.vpn_msg)
                    .setCancelable(false)
                    .setPositiveButton(R.string.try_again, (d, w) -> attempt())
                    .setNegativeButton(R.string.cancel, null)
                    .show();
            return;
        }

        if (serverRow.getVisibility() == View.VISIBLE) {
            String s = serverUrl.getText().toString().trim();
            if (s.length() > 0) prefs.setServer(s);
        }

        busy(true);
        try {
            JSONObject body = new JSONObject().put("username", u).put("password", p);
            api.post("/api/auth/login", body, (ok, data, err) -> {
                busy(false);
                if (!ok) { showError(Api.text(err)); return; }

                JSONObject user = data.optJSONObject("user");
                if (user == null) { showError(getString(R.string.unexpected_reply)); return; }

                if (!"runner".equals(user.optString("role"))) {
                    showError(getString(R.string.not_runner));
                    return;
                }

                prefs.setSession(data.optString("token"), user.optString("id"),
                        user.optString("name"), user.optString("empCode"));

                startActivity(new Intent(this, HomeActivity.class));
                finish();
            });
        } catch (Exception e) {
            busy(false);
            showError(getString(R.string.something_wrong));
        }
    }

    private void busy(boolean on) {
        loginBtn.setEnabled(!on);
        loginBtn.setText(getString(on ? R.string.signing_in : R.string.sign_in_btn));
        spin.setVisibility(on ? View.VISIBLE : View.INVISIBLE);
    }

    private void showError(String msg) {
        error.setText(msg == null ? getString(R.string.could_not_sign_in) : msg);
        Anim.show(error, true);
    }
}
