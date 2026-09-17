# IBS Runner Dispatch, Live Tracking & TAT System

Built for **Indian Blood Service (IBS)** — the runner company that moves blood samples and
blood units between hospitals and the blood centre.

Three parts, one system:

| Part | What it is | Who uses it |
|---|---|---|
| `backend/` | Node 18 + Express + MongoDB + Socket.IO API and TAT engine | (server) |
| `dashboard/` | Web control room — live map, dispatch, TAT reports | 2 desk coordinators + admin |
| `android/` | Native Android runner app (Java, no Play Services, no Firebase) | runners on the road |

---

## 1. The real-world cycle this system encodes

```
Hospital / customer inquiry
        ↓
Blood centre → forwards to IBS desk
        ↓
Desk creates a CASE (patient name, blood group, component, units, hospital)
        ↓
TRIP 1  ── SAMPLE PICKUP ──  hospital  →  blood centre
        ↓
CROSSMATCH at the centre (lab leg — desk starts and ends it)
        ↓
TRIP 2  ── BLOOD DELIVERY ── blood centre  →  hospital
        ↓
Runner clicks proof photo of the handed-over pack  →  CASE CLOSED
```

The old WhatsApp/Telegram photo step is now **inside the app** — the delivery trip cannot be
marked COMPLETE without a proof photo, and that photo is attached to the case forever.

### Trip stage machine (same for both legs)

```
ASSIGNED → ACCEPTED → EN_ROUTE_PICKUP → AT_PICKUP → PICKED → EN_ROUTE_DROP → AT_DROP → COMPLETED
                                                                       (or REJECTED / CANCELLED)
```

Forward-only. Every stage change stores a timestamp **and** the GPS point where it happened,
so nobody can back-date a trip.

---

## 2. Backend setup (local)

Needs **Node 18+** and **MongoDB** running.

```bash
cd backend
cp .env.example .env          # edit MONGO_URI and JWT_SECRET
npm install
npm run seed                  # creates users + 5 sample Ahmedabad locations
npm start                     # http://localhost:5000
```

`npm run seed` creates:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | admin |
| `priya` | `ibs123` | coordinator (desk) |
| `desk2` | `ibs123` | coordinator (desk) |
| `runner1` | `runner123` | runner |
| `runner2` | `runner123` | runner |
| `runner3` | `runner123` | runner |

Change all of these from **Runners & Staff → Edit** before going live.

The dashboard is served by the same Express process — open `http://localhost:5000` in the browser
and sign in. No separate frontend server needed.

Health check: `GET /api/health`.

---

## 3. Deploy

Two supported ways:

- **Render** (GitHub-connected, fastest to get live) — **[docs/RENDER-DEPLOY.md](docs/RENDER-DEPLOY.md)**. Needs MongoDB Atlas plus a Render Disk for proof photos.
- **Hostinger VPS** (full control, cheaper long-run) — below.

### Hostinger VPS

```bash
# on the VPS
git clone <your-repo> /var/www/ibs
cd /var/www/ibs/backend
cp .env.example .env
nano .env                     # MONGO_URI, a long random JWT_SECRET, BASE_URL=https://ibs.yourdomain.com
npm install --omit=dev
npm run seed
pm2 start server.js --name ibs
pm2 save
```

Nginx reverse proxy — **Socket.IO needs the upgrade headers**, don't skip them:

```nginx
server {
    server_name ibs.yourdomain.com;

    client_max_body_size 12M;          # proof photos

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then `certbot --nginx -d ibs.yourdomain.com`. Put the **https URL** into the Android app
(`DEFAULT_SERVER` in `app/build.gradle`, or type it in the app's hidden Server field).

Proof photos are written to `backend/uploads/` — back that folder up along with MongoDB.

---

## 4. Android runner app

Full build instructions with your exact toolchain: **[docs/ANDROID-BUILD.md](docs/ANDROID-BUILD.md)**
Phone-side settings so the ring works on silent: **[docs/PHONE-SETUP.md](docs/PHONE-SETUP.md)**

Short version:

```powershell
cd C:\ibs\android
# set the server URL first, in app\build.gradle → DEFAULT_SERVER
gradle assembleDebug
# APK → app\build\outputs\apk\debug\app-debug.apk
```

No Firebase, no Play Services, no third-party libraries — only `appcompat` and `core`.
The app polls the server every 5 seconds over plain HTTP, so there is nothing to configure
with Google and nothing that can be blocked by a Chinese-phone push restriction.

### How the ring works even on silent / DND

Four things stacked together, because one alone is not reliable on Indian phones:

1. The alert sound plays on `AudioAttributes.USAGE_ALARM` — the **alarm stream ignores silent mode**.
2. Alarm volume is force-raised to maximum just before playing.
3. A looping vibration pattern runs alongside.
4. The notification channel is `IMPORTANCE_HIGH` with `setBypassDnd(true)` and fires a
   **full-screen intent** that opens `AlertActivity` with `showWhenLocked` + `turnScreenOn` —
   so the job screen appears even on a locked phone.

The alarm keeps ringing until the runner taps **ACCEPT** or **DECLINE**. Back button is blocked.
If the runner ignores it, the desk sees "not accepted" on the live board and can hit **Re-ping**
(rings the phone again) or **Reassign** to another runner.

---

## 5. What the desk sees

**Live board** — Leaflet/OpenStreetMap map, one pin per runner coloured by duty state
(grey = off duty, green = available, blue = on trip, amber = on break, red = signal lost > 3 min),
breadcrumb trail of where he has been, a dashed line to his current target and the geofence circle
around it. Zomato-style. Right dock lists every running job with a live timer, sorted breach-first.

**Cases** — create a case, pick the hospital from a dropdown (all saved places), assign a runner,
run crossmatch start/done, close the case. Live TAT columns.

**Trips & TAT** — stage-by-stage sheet: accept time, time to reach pickup, dwell at pickup,
time to reach drop, dwell at drop, total. Green / amber (>80% of target) / red (breach). CSV export.

**Runners** — who is free right now, who is on a ride, trips done today, km covered, average TAT,
breach count.

**Hospitals & Places** — add any hospital, blood centre or lab by dropping a pin on the map or
typing lat/lng, plus a geofence radius (default 200 m). These are the dropdown options the desk
picks from when creating a case, and what "reached the hospital" is measured against.

**Attendance** — punch in / punch out per runner per day, total duty hours, trips done. CSV export.

---

## 6. TAT and SLA

Every target is in **minutes** and lives in `backend/.env` — change a number, restart, done.
Full explanation of each clock: **[docs/TAT-SLA.md](docs/TAT-SLA.md)**

| Setting | Default | Meaning |
|---|---|---|
| `SLA_ACCEPT` | 3 | assigned → runner accepts |
| `SLA_REACH_PICKUP` | 45 | accepted → reached pickup point |
| `SLA_PICKUP_DWELL` | 10 | time spent at the pickup point |
| `SLA_REACH_DROP` | 45 | picked up → reached drop point |
| `SLA_DROP_DWELL` | 10 | time spent at the drop point |
| `SLA_TRIP_TOTAL` | 110 | whole leg, door to door |
| `SLA_CROSSMATCH` | 60 | lab leg between the two trips |
| `SLA_CASE_TOTAL` | 240 | inquiry → blood delivered |

Start with these, run two weeks, then look at **Reports → Trip TAT** and tune to your real
Ahmedabad traffic numbers.

---

## 7. Folder map

```
ibs/
├── backend/
│   ├── server.js            Express + Socket.IO entry
│   ├── seed.js              demo users + places
│   ├── config/              db.js, sla.js
│   ├── models/              User, Location, Case, Trip, LocationPing, Attendance, Counter
│   ├── services/            geo.js, tat.js, dispatch.js, realtime.js
│   ├── middleware/auth.js   JWT + role guard
│   ├── routes/              auth, users, locations, cases, trips, runner, reports
│   └── uploads/             proof photos (created at runtime)
├── dashboard/
│   ├── index.html           sign in
│   ├── app.html             control room shell
│   ├── css/app.css
│   └── js/                  api, ui, live, cases, masters, reports, main
├── android/
│   ├── settings.gradle, build.gradle, gradle.properties
│   └── app/src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/searvator/ibsrunner/   Prefs, Api, DutyService, Login, Home, Alert, Trip, Boot
│       └── res/                            layout, values, drawable, xml
└── docs/
    ├── ANDROID-BUILD.md
    ├── PHONE-SETUP.md
    └── TAT-SLA.md
```

---

## 8. First-day test script

1. `npm run seed`, `npm start`, open `http://localhost:5000`, sign in as `priya` / `ibs123`.
2. **Hospitals & Places** → confirm the 5 seeded places; add one real hospital with a map pin.
3. **Runners & Staff** → create a real runner account, note username/password.
4. Install the APK on that runner's phone, sign in, tap **PUNCH IN** (needs location on).
5. Desk: **Cases → New Case** → patient details → hospital → assign the runner.
6. The phone should ring on the alarm stream even if the phone is on silent. Accept.
7. Walk through the stages on the phone; watch the pin move and the timers run on the live board.
8. Complete the sample trip → **Crossmatch Start** → **Crossmatch Done** → assign the delivery trip.
9. Complete the delivery with a proof photo → case closes.
10. **Reports → Trip TAT** → export CSV and check every stage duration is there.

---

Built by **Searvator IT Solutions Pvt. Ltd.**
