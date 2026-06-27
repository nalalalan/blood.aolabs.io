# Blood Android Bridge

This Android bridge reads a nearby CONTOUR NEXT ONE meter over the Bluetooth Glucose service and posts readings to `blood.aolabs.io`. It also reads Health Connect heart rate, HRV, steps, and sleep records and posts them to Blood. Health Connect `BloodGlucoseRecord` remains a backup glucose source only when another app actually writes glucose there. The bridge cannot read the Contour app's private storage.

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

The primary automatic glucose path is the meter itself:

`CONTOUR NEXT ONE -> Bluetooth -> Blood Bridge -> blood.aolabs.io`

The health metrics path is:

`Health Connect HR / HRV / steps / sleep -> Blood Bridge -> blood.aolabs.io`

Manual entry and Contour CSV import are fallback tools only when the automatic meter bridge is blocked.

Default endpoint:

`https://blood.aolabs.io/api/ingest/glucose-readings`

The released APK carries the Blood upload token through generated `BuildConfig` from the GitHub Actions `BLOOD_BRIDGE_TOKEN` secret. The bridge seeds the token into Android shared preferences on first open and preserves it when advanced settings are saved. Token entry is not part of normal setup.

The bridge stores the glucose endpoint and ingest token locally in Android shared preferences. The metrics endpoint is derived from that URL by replacing `/api/ingest/glucose-readings` with `/api/ingest/health-metrics`. Background sync runs through WorkManager after permissions are granted and automatic upload is started.

On Android 14 and newer, Health Connect is reached from Settings -> Security and privacy -> Privacy Controls -> Health Connect. It may not appear as a normal app icon. Grant Blood Bridge blood glucose, heart rate, HRV, steps, sleep, and background Health Connect access.
