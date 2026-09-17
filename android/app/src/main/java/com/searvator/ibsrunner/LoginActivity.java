package com.searvator.ibsrunner;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

public class LoginActivity extends AppCompatActivity {

    private Prefs prefs;
    private Api api;
    private EditText server, user, pass;
    private Button signIn;
    private TextView error;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        api = new Api(this);

        // Already signed in - go straight in, the runner never types his password twice.
        if (prefs.signedIn()) {
            startActivity(new Intent(this, HomeActivity.class));
            finish();
            return;
        }

        setContentView(R.layout.activity_login);
        server = findViewById(R.id.server);
        user = findViewById(R.id.username);
        pass = findViewById(R.id.password);
        signIn = findViewById(R.id.signIn);
        error = findViewById(R.id.error);

        server.setText(prefs.server());
        findViewById(R.id.serverToggle).setOnClickListener(v -> {
            View row = findViewById(R.id.serverRow);
            row.setVisibility(row.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        });

        signIn.setOnClickListener(v -> submit());
    }

    private void submit() {
        String u = user.getText().toString().trim();
        String p = pass.getText().toString();
        if (u.isEmpty() || p.isEmpty()) { show("Enter your user ID and password"); return; }

        prefs.setServer(server.getText().toString());
        signIn.setEnabled(false);
        signIn.setText("Signing in...");
        error.setVisibility(View.GONE);

        try {
            JSONObject body = new JSONObject().put("username", u).put("password", p);
            api.post("/api/auth/login", body, (ok, data, err) -> {
                signIn.setEnabled(true);
                signIn.setText("Sign in");
                if (!ok) { show(err == null ? "Sign in failed" : err); return; }

                JSONObject userObj = data.optJSONObject("user");
                if (userObj == null || !"runner".equals(userObj.optString("role"))) {
                    show("This app is for runners only");
                    return;
                }
                JSONObject cfg = data.optJSONObject("config");
                if (cfg != null) prefs.setIntervals(cfg.optInt("pollInterval", 5), cfg.optInt("pingInterval", 20));
                prefs.setSession(data.optString("token"), userObj.optString("id"), userObj.optString("name"));

                Toast.makeText(this, "Welcome, " + userObj.optString("name"), Toast.LENGTH_SHORT).show();
                startActivity(new Intent(this, HomeActivity.class));
                finish();
            });
        } catch (Exception e) {
            signIn.setEnabled(true);
            signIn.setText("Sign in");
            show("Something went wrong, try again");
        }
    }

    private void show(String message) {
        error.setText(message);
        error.setVisibility(View.VISIBLE);
    }
}
