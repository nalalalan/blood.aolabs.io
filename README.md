# blood.aolabs.io

Blood is an AO Labs health record for glucose readings captured by a CONTOUR NEXT ONE meter plus Health Connect HR, HRV, sleep, and steps.

The public page renders a clear glucose graph, current health metrics, and a personal anxiety estimate from the Blood API. Viewing the graph is public so it works from any device; writing records requires the ingest token.

## Data path

Automatic target path:

`CONTOUR NEXT ONE -> Blood Android bridge over Bluetooth -> Blood API -> glucose graph`

Health metrics path:

`Health Connect HR / HRV / sleep / steps -> Blood Android bridge -> Blood API -> health strip + anxiety estimate`

Backup glucose path:

`CONTOUR NEXT ONE -> Contour app -> Health Connect, only if Contour writes blood glucose there -> Blood Android bridge -> Blood API -> graph`

Fallbacks only:

`Contour CSV export -> blood.aolabs.io Contour export form -> Blood API -> graph`

`Manual mg/dL entry -> blood.aolabs.io Write path form -> Blood API -> graph`

The website cannot directly read another phone app's private storage. Glucose comes from the meter's Bluetooth service. HR, HRV, sleep, and steps come from Health Connect after the phone grants those permissions and another phone/wearable source writes records there.

## Phone setup

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

1. Install or update Blood Bridge on the Android phone.
2. Do not paste a token. The current APK is built with the Blood upload token from the GitHub Actions `BLOOD_BRIDGE_TOKEN` secret, which is synced from Railway `BLOOD_INGEST_TOKEN`.
3. Tap `Grant Bluetooth permission`.
4. Tap `Grant Health Connect metrics permission`.
5. Tap `Start automatic upload`.
6. Leave the `Blood Bridge automatic upload` notification running.
7. Keep the CONTOUR NEXT ONE near the phone after a reading.
8. Open `https://blood.aolabs.io/`.

The always-on service scans for the meter and posts stored readings in the background. A 15-minute WorkManager job is also scheduled as a backup. `Run one upload check now` is diagnostic only; it is not the normal workflow.

Health Connect metrics:

1. Android 14+: open Settings -> Security and privacy -> Privacy Controls -> Health Connect.
2. Android 13 or lower: install Health Connect from the Play Store, then open it from Settings -> Apps -> Health Connect.
3. Confirm the phone has sources for heart rate, HRV, steps, and sleep.
4. Tap `Grant Health Connect metrics permission` in Blood Bridge.

## Local

```powershell
npm install
$env:BLOOD_INGEST_TOKEN = "local-ingest-token"
npm run dev
```

Then open `http://127.0.0.1:3057/`.

## API

`POST /api/ingest/glucose-readings`

Authorization: `Bearer $BLOOD_INGEST_TOKEN`

```json
{
  "source": "health-connect",
  "capturedAt": "2026-06-26T15:00:00.000Z",
  "readings": [
    {
      "clientRecordId": "health-connect-record-id",
      "sourcePackage": "com.example.contour",
      "measuredAt": "2026-06-26T12:12:00.000Z",
      "zoneOffset": "-04:00",
      "valueMgDl": 104,
      "relationToMeal": "before_meal",
      "mealType": "breakfast",
      "specimenSource": "capillary_blood"
    }
  ]
}
```

`POST /api/ingest/contour-csv`

Authorization: `Bearer $BLOOD_INGEST_TOKEN`

Body: CSV text with date/time and glucose columns. The public page posts this only from the fallback Contour export form when an operator supplies the ingest token; the normal Android APK path already carries its upload token. The parser accepts common Contour-style columns such as `Date`, `Time`, `Reading (mg/dL)`, `Meal Marker`, and `Notes`.

`POST /api/ingest/health-metrics`

Authorization: `Bearer $BLOOD_INGEST_TOKEN`

```json
{
  "source": "health-connect",
  "capturedAt": "2026-06-27T12:00:00.000Z",
  "heartRate": [{ "measuredAt": "2026-06-27T11:58:00.000Z", "valueBpm": 82 }],
  "hrv": [{ "measuredAt": "2026-06-27T07:30:00.000Z", "rmssdMs": 41 }],
  "steps": [{ "startTime": "2026-06-27T08:00:00.000Z", "endTime": "2026-06-27T12:00:00.000Z", "count": 2300 }],
  "sleepSessions": [{ "startTime": "2026-06-27T03:00:00.000Z", "endTime": "2026-06-27T09:20:00.000Z", "stages": [] }]
}
```

`GET /api/blood/summary`

Public. Used by the website on any device.

`GET /api/blood/export`

Authorization: `Bearer $BLOOD_READ_TOKEN` when raw export access is needed.

## Railway

Set these variables on the Railway service:

- `BLOOD_INGEST_TOKEN`
- `BLOOD_READ_TOKEN` only for raw export access; the website summary is public.
- `BLOOD_ALLOWED_ORIGINS=https://blood.aolabs.io,https://aolabs.io`
- `DATABASE_URL` from a Railway Postgres service, or `DATA_DIR=/data` with a persistent volume

Use Postgres or a persistent volume for real history. Plain filesystem storage is only safe for local development.
