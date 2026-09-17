package com.searvator.ibsrunner;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** If the phone restarts while the runner is still punched in, bring duty tracking back up. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Prefs prefs = new Prefs(context);
        if (prefs.signedIn() && prefs.onDuty()) {
            DutyService.start(context);
        }
    }
}
