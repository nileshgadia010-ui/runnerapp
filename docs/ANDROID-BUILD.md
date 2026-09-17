# Building the IBS Runner APK (command line, no Android Studio)

This matches the toolchain already installed on your Windows PC.

| Tool | Version / path |
|---|---|
| JDK | Adoptium **JDK 17** |
| Gradle | `C:\Gradle\gradle-9.6.1\bin` on PATH |
| Android SDK | `ANDROID_HOME=C:\Android` |
| Platform | `platforms;android-34` |
| Build tools | `build-tools;34.0.0` |

---

## Step 1 — set the server URL

Open `android\app\build.gradle` and change this line to your server:

```gradle
buildConfigField "String", "DEFAULT_SERVER", "\"http://192.168.1.10:5000\""
```

- Testing on office wifi → your PC's LAN IP, e.g. `http://192.168.1.10:5000`
- Live → `https://ibs.yourdomain.com`

This is only the **default**. On the login screen, long-press the IBS logo to reveal the
**Server** field — a runner can be pointed to a different server without a rebuild.

> If you use a plain `http://` server (not https), cleartext is already allowed in the manifest.
> Once you move to https you can leave it as is — https works either way.

---

## Step 2 — build

```powershell
cd C:\ibs\android
gradle assembleDebug
```

APK lands at:

```
app\build\outputs\apk\debug\app-debug.apk
```

First build downloads AGP + dependencies (a few minutes). After that it's ~30 seconds.

### If Gradle 9.6.1 rejects AGP 8.5.2

Gradle 9.x is strict about plugin versions. Two options:

**Option A — use a wrapper pinned to Gradle 8.9 (recommended, one time):**

```powershell
cd C:\ibs\android
gradle wrapper --gradle-version 8.9
.\gradlew assembleDebug
```

From then on always use `.\gradlew` instead of `gradle`.

**Option B — bump AGP.** In `android\build.gradle`, change:

```gradle
classpath 'com.android.tools.build:gradle:8.5.2'
```

to a version that supports Gradle 9 (`8.9.0` or newer), then `gradle assembleDebug` again.

---

## Step 3 — signed release APK (for the real rollout)

Debug APKs expire-ish and look scary on install. Make a release key once:

```powershell
keytool -genkey -v -keystore C:\ibs\ibs-runner.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ibs
```

Add to `android\app\build.gradle` inside `android { }`:

```gradle
signingConfigs {
    release {
        storeFile file('C:/ibs/ibs-runner.jks')
        storePassword 'YOUR_PASSWORD'
        keyAlias 'ibs'
        keyPassword 'YOUR_PASSWORD'
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

Then:

```powershell
gradle assembleRelease
# app\build\outputs\apk\release\app-release.apk
```

**Keep `ibs-runner.jks` safe.** Lose it and you cannot push updates over the installed app.

---

## Step 4 — install on the runner phones

You prefer file transfer over adb, so:

1. Copy `app-debug.apk` (or `app-release.apk`) to Google Drive / WhatsApp / a USB cable.
2. On the phone: open the file → allow "Install unknown apps" for that app → Install.
3. Then follow **[PHONE-SETUP.md](PHONE-SETUP.md)** — this part is not optional, the ring
   and the background tracking depend on it.

For updates later, just send a new APK with a higher `versionCode` in `app\build.gradle`
(signed with the same key) — it installs over the old one and keeps the login.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `SDK location not found` | Create `android\local.properties` with `sdk.dir=C\:\\Android` |
| `Failed to find Build Tools revision 34.0.0` | `sdkmanager "build-tools;34.0.0" "platforms;android-34"` |
| `Unsupported class file major version` | Gradle is picking up the wrong JDK — set `JAVA_HOME` to the Adoptium 17 folder |
| App opens but says "Cannot reach server" | Phone and server must be on the same network; check the URL in the hidden Server field; check Windows Firewall allows port 5000 |
| Login says "Not a runner account" | That username is an admin/coordinator — the app only accepts `role: runner` |
