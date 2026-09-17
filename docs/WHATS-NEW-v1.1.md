# What changed in v1.1

App `versionCode 2`, `versionName 1.1`. Backend and app must be updated together — the new
app calls endpoints the old backend does not have.

---

## 1. The timer that went backwards — fixed

**What was wrong:** the server sent a whole-minute figure (`dutyMinutesToday`) on every poll
and the app added the seconds elapsed since that poll arrived. Because the minute figure was
rounded down, every new poll reset the seconds part, so the watch jumped back a few seconds
every six seconds.

**What it does now:** the server sends `dutyStartedAt` (a timestamp) plus `serverTime`, and the
app counts from that timestamp. A number counted from a fixed start can only go up.

The same fix carries a second benefit. `Clock.java` keeps an offset of
`serverTime − deviceTime`, refreshed on every API response, and every displayed time goes
through it. So the timers are right even on a phone whose own date and time are wrong — which
matters, because the whole TAT report is built on timing.

---

## 2. Buttons felt slow — fixed

Every tap used to wait for a network round trip before the screen changed. On a weak signal
inside a hospital that is two or three seconds of nothing, so runners tap again.

Now the screen moves first and the request follows:

| Action | Behaviour |
|---|---|
| Punch in / out | Screen flips instantly, upload follows |
| Accept a job | Alarm stops and the job opens instantly |
| Every stage button | Stage advances instantly |
| Break on / off | Toggles instantly |
| **Delivery handover** | **Deliberately waits** — see below |

The handover is the one exception. It needs a photo, and a photo cannot be faked forward, so
that button holds until the upload actually lands. If it fails, the photo stays on the phone
and the runner is told to move and press again.

If the server refuses an action for a real reason ("finish your running job first"), the
screen rolls back and shows the reason. Only network failures are treated as "keep going".

---

## 3. Offline mode

`SyncQueue` on the phone holds every action the network could not carry: punch in, punch out,
accept, decline, every stage, break. The moment data returns, `DutyService` posts the whole
queue to `POST /api/runner/sync` in one call.

**Each entry carries the time the runner actually pressed the button.** A stage pressed in a
basement at 3:04 and uploaded at 3:31 is recorded as 3:04, so the TAT report stays honest.
The server ignores a stated time that is in the future or more than 24 hours old and falls
back to its own clock.

Replaying a stage that already landed is not an error — the server treats it as already done.
So a half-sent queue can be retried safely.

Location pings already queued (500 points); that is unchanged.

The home screen shows a blue banner: *"No internet. 3 actions are saved on your phone and
will be sent automatically."* The runner is told his work is safe, in plain words.

The last poll, summary and trip list are cached on the phone, so opening the app with no
signal still shows the running job and the day's numbers instead of a blank screen.

---

## 4. Odometer photos

`OdometerActivity` runs before the first punch in and before the last punch out. It needs a
photo of the bike meter **and** the typed reading; neither alone is accepted.

Checks applied:

- the meter cannot read lower than the morning reading,
- more than 500 km in one day is rejected as a typing mistake (usually a digit typed twice),
- the photo is shrunk to 1280 px / JPEG 72 (roughly 150–250 KB) before upload.

The office now has two independent measures of the same day: **meter km** and **GPS km**.
The attendance table shows both, with the start → end readings underneath and links to both
photos. When they disagree by 15 km or more the row is flagged in red. A few km of gap is
normal — GPS smooths corners and loses signal indoors — but a large gap is a row worth asking
about.

---

## 5. VPN, fake GPS and root

The app checks its own environment and reports what it finds.

A VPN blocks sign-in with a Gujarati message:

> તમારા ફોનમાં VPN ચાલુ છે. VPN બંધ કરો, નહીં તો તમારો રિપોર્ટ ઓફિસ (એડમિન) ને
> મોકલવામાં આવશે.

The same message stays as a banner on the home screen while the VPN is on. Fake-GPS fixes are
detected per location fix and marked on the ping. Root and developer mode are reported too.

On the control room, a flagged runner gets a red `!` next to his name with the reason on
hover, and `runner:integrity` fires the moment a flag first appears.

**Read this part honestly.** Every one of those checks runs on the runner's own phone, so
somebody determined enough can defeat all of them. They are not a lock. Their value is the
record: a runner who keeps showing up flagged is a conversation the office can now have with
evidence.

The actual protection is on the server, and none of it can be touched from a phone:

- every timestamp is stamped server side; the phone's claimed time is only accepted if it is
  in the past and under 24 hours old,
- stage order is enforced server side — no skipping ahead, no going back,
- a trip can only be moved by the runner it is assigned to,
- a delivery cannot be completed without a photo landing on the server,
- the odometer must move forward and within a sane daily range,
- JWT on every call, `401` signs the phone out.

---

## 6. Screen changes

**Home** — dark hero with the big duty clock and three tiles: **km today**, **jobs done**,
**5-day hours**. Below it the running job with its distance and ETA, then the job list grouped
by day: today, yesterday, and the three days before, each with "3 of 4 done".

**Job alert** — now shows how far the job is *before* he accepts (`≈ 4.2 km away • about
12 min`), and a counter of how long it has been ringing.

**Job screen** — distance to the next stop, an offline note when there is no data, and the
stage timer anchored to the local tap when the server has not caught up yet.

**Login** — rebuilt: dark, fields in the lower half where a thumb reaches, show/hide password,
inline errors. The server address field is now hidden behind a long-press on the footer.

**Everywhere** — buttons squash under the finger and spring back, cards fade and lift in,
screens slide. This is not decoration: a runner with gloves on needs to know his tap landed,
or he taps again.

---

## 7. Distance estimates

Straight-line distance multiplied by 1.35, which is a reasonable factor for Indian city roads,
and an ETA at 22 km/h city speed. Paldi → Asarwa comes out at 8.5 km / 23 minutes, which is
about right.

No paid routing API is called. If you later want true road distance, the one place to change
is `roadKm()` in `backend/services/geo.js`.

---

## 8. Deploy order — do not skip

The app and backend changed together, so:

1. `git add . && git commit -m "v1.1" && git push`
2. Wait for Render to finish deploying (the build log should end with *Your service is live*).
3. Only then build and hand out the new APK.

An old APK against the new backend keeps working. A new APK against the old backend does not —
`/api/runner/sync`, `/summary`, `/trips` and `/integrity` would all 404.

No database migration is needed. The new Attendance fields default to 0 and fill in as runners
punch. The `mock` field on pings defaults to false.
