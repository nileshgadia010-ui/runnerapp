# Deploying the IBS backend on Render

Two things Render does **not** give you, so arrange them first:

1. **MongoDB** — Render has no Mongo. Use **MongoDB Atlas** (free M0 tier is enough to start).
2. **Persistent storage** — Render's default filesystem is wiped on every redeploy. Proof
   photos must go on a **Render Disk**, otherwise every deploy deletes them.

---

## Step 1 — MongoDB Atlas

1. cloud.mongodb.com → free M0 cluster → region **Mumbai (ap-south-1)**.
2. Database Access → add user `ibs` with a strong password.
3. Network Access → Add IP → **0.0.0.0/0** (Render IPs are dynamic).
4. Connect → Drivers → copy the string, it looks like:

```
mongodb+srv://ibs:PASSWORD@cluster0.xxxxx.mongodb.net/ibs_runner?retryWrites=true&w=majority
```

Note the `/ibs_runner` before the `?` — that's the database name, don't leave it out.

---

## Step 2 — push the code to GitHub

From the extracted folder (`C:\ibs`):

```powershell
cd C:\ibs
git init
git add .
git commit -m "IBS runner dispatch and TAT system"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `.env`, `uploads/`, gradle build folders and
`*.jks`, so no secrets go up. **Make the repo Private** — Settings → General → Danger Zone →
Change visibility. A public repo means anyone can read your patient-flow logic and API routes.

---

## Step 3 — create the Render web service

Render's form must be filled like this. The defaults it guessed are wrong for this project:

| Field | Value |
|---|---|
| **Language / Runtime** | **Node** — *not Go* |
| Branch | `main` |
| Region | **Singapore** (closest to Ahmedabad; Oregon adds ~250 ms to every ping) |
| **Root Directory** | `backend` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| Health Check Path | `/api/health` |
| Instance type | Starter ($7) or above — the free tier sleeps after 15 min of no traffic, which kills live tracking |

> Root Directory is `backend` because the repo holds `backend/`, `dashboard/` and `android/`.
> The server serves the dashboard from `../dashboard`, so it still works — Render clones the
> whole repo and only *runs* from `backend`.

### Environment variables to add

| Key | Value |
|---|---|
| `MONGO_URI` | your Atlas string from Step 1 |
| `JWT_SECRET` | any long random string |
| `JWT_EXPIRES` | `30d` |
| `UPLOAD_DIR` | `/var/data/uploads` |
| `NODE_VERSION` | `20` |
| `SLA_ACCEPT` … `POLL_INTERVAL` | optional — defaults apply if you skip them |

### Disk (do not skip)

Advanced → **Add Disk**: name `ibs-uploads`, mount path `/var/data/uploads`, size 1 GB.
This is what `UPLOAD_DIR` points at. Without it, every redeploy deletes all proof photos.

Alternatively, use the included `render.yaml` blueprint: Render → New → **Blueprint** → pick the
repo, and everything above is filled in automatically. You only paste `MONGO_URI`.

---

## Step 4 — seed the first users

After the first successful deploy, Render dashboard → your service → **Shell**:

```bash
npm run seed
```

That creates `admin/admin123`, `priya/ibs123`, `desk2/ibs123`, `runner1-3/runner123` and the
5 sample Ahmedabad places. **Change every password immediately** from Runners & Staff.

---

## Step 5 — point the app and browser at it

- Dashboard: `https://<service>.onrender.com`
- Android: `android\app\build.gradle` → `DEFAULT_SERVER = "https://<service>.onrender.com"`,
  then `gradle assembleDebug`. Or leave the build alone and type the URL into the hidden
  Server field on the login screen (long-press the logo).

Socket.IO works on Render without extra config — websockets are supported by default.

---

## Local development stays the same

Render is only for the server. On your PC:

```powershell
cd C:\ibs\backend
copy .env.example .env
notepad .env          :: MONGO_URI = your local Mongo or the same Atlas string
npm install
npm run seed
npm start
```

You can point your local machine at the **same** Atlas database, so whatever you test locally
shows up on the live dashboard too. Handy while building, risky once real cases start —
make a second Atlas database (`ibs_runner_dev`) at that point.

---

## Things that will bite you on Render

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails with Go errors | Language left on Go | Settings → change runtime to Node, redeploy |
| `Cannot find module 'express'` | Root Directory not set | Set it to `backend` |
| App works, then 502 after a few minutes | Free instance sleeping | Move to the $7 Starter plan |
| `MongoServerError: bad auth` | Password has `@` or `/` unescaped in the URI | URL-encode it, or use a password with only letters and digits |
| Proof photos disappear after a deploy | No disk mounted | Add the disk and set `UPLOAD_DIR` |
| Dashboard loads but map is blank | Corporate firewall blocking OpenStreetMap tiles | Test on mobile data first |
| Runner app says cannot reach server | `http://` hardcoded but Render is `https://` | Update `DEFAULT_SERVER` |
