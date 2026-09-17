# Runner phone setup — do this on every phone, once

The runners are not technical. Do these settings **yourself** while handing over the phone,
then show them only two buttons: **PUNCH IN** and **PUNCH OUT**.

If these settings are skipped, the phone will look fine but will silently stop ringing and
stop sending location after 20–30 minutes. This is the single biggest cause of failure
in field apps in India.

---

## 1. Permissions (the app asks, you say yes)

| Prompt | Answer |
|---|---|
| Location | **Allow all the time** — not "only while using the app" |
| Notifications (Android 13+) | Allow |
| Battery optimisation | **Don't optimise / Allow** |

On Android 11+ the "Allow all the time" option is hidden behind a second screen:
tap **Allow only while using the app** first, then the app opens Settings → Location →
choose **Allow all the time**. The app prompts for this automatically after punch-in.

---

## 2. Let the alarm through Do Not Disturb

The app rings on the **alarm stream**, which normally ignores silent mode. But if the runner
has DND on with alarms muted, nothing plays. So:

**Settings → Sound → Do Not Disturb → Exceptions/Allow → Alarms = ON**

The app's notification channel also requests DND bypass, which most phones grant on install.
Verify once: **Settings → Apps → IBS Runner → Notifications → New Job → Override Do Not Disturb = ON**

---

## 3. Stop the phone from killing the app (per brand)

| Brand | Path |
|---|---|
| **Xiaomi / Redmi / POCO** | Security app → Permissions → **Autostart** → enable IBS Runner. Then Recents → hold the app card → **lock** icon. Then Settings → Apps → IBS Runner → Battery saver → **No restrictions** |
| **Realme / OPPO** | Settings → Battery → App Battery Management → IBS Runner → **Allow background activity** + **Allow auto launch** |
| **Vivo / iQOO** | Settings → Battery → High background power consumption → allow IBS Runner. Also i-Manager → Autostart → enable |
| **Samsung** | Settings → Battery → Background usage limits → **remove** IBS Runner from "Sleeping apps" and "Deep sleeping apps". Also Settings → Apps → IBS Runner → Battery → **Unrestricted** |
| **OnePlus** | Settings → Battery → Battery optimisation → IBS Runner → **Don't optimise**. Also Advanced → turn OFF "Deep optimisation" |
| **Motorola / Nokia / Pixel (stock Android)** | Settings → Apps → IBS Runner → Battery → **Unrestricted** is enough |

Rule of thumb: anywhere you see the words *autostart*, *background*, *battery saver* or
*sleeping apps* — give IBS Runner the most permissive option.

---

## 4. Basic things that still matter

- **GPS/Location toggle must stay ON.** Punch-in is blocked without a location fix — that is
  deliberate, so nobody punches in from home.
- **Data pack must be active.** If data drops, the app queues up to 500 location points offline
  and uploads them the moment the network comes back. Nothing is lost, but the desk sees the
  runner as "signal lost" (red pin) after 3 minutes without a ping.
- **Don't force-stop the app** from Recents by swiping. Teach the runner: PUNCH OUT, don't swipe.
- Keep the phone charged — continuous GPS is roughly 8–12% battery per hour on a mid-range phone.

---

## 5. What the runner actually does — the whole training, in 6 lines

1. Morning: open app → **PUNCH IN**.
2. Phone rings loudly → screen shows patient name and hospital → tap **ACCEPT**.
3. Tap **START** when leaving, **REACHED** when he arrives, **PICKED** after collecting.
4. Tap **REACHED** at the centre, then **COMPLETE**.
5. For a delivery, **COMPLETE** asks for a photo of the pack — click it, that's the WhatsApp
   photo, now it goes to the office automatically.
6. Evening: **PUNCH OUT**.

The timer on the screen is his — it shows how long this visit has taken and how long he has
been on duty today. The desk sees the same timer.
