# blood.aolabs.io

Blood is an AO Labs health record for glucose readings captured by a CONTOUR NEXT ONE meter plus Health Connect HR, sleep, and steps. Blood estimates HRV from sleep/rest heart-rate samples when true HRV/RMSSD is unavailable.

The public page renders a compact anxiety estimate, one plain-English health read, and six aligned graphs for anxiety, glucose, HR, HRV, sleep, and steps. The score uses latest uploaded values plus recent source history, so quick glucose drops/rises, HR rises, and HRV dips can affect the score before the endpoint alone explains the state. The top health read is intentionally three natural sentences: one good sign, one biggest watchout, and one concrete food, water, or movement move to improve the day. Provenance, diagnosis boundaries, rolling-window basis lines, and recalculation mechanics stay in the paper, references, API, or diagnostics instead of appearing as tiny secondary text under the main read. The read uses normal-weight text with green status words for good signals and the positive move, and red status words for the watchout. Estimated HRV is shown as an estimate by default; its absolute value is not treated like a true RMSSD threshold unless a true source HRV record exists. The shared x-axis ends at the newest current upload endpoint, so current latest-upload values sit on the right edge while labels keep their true source times. In short ranges such as 24h, HRV, sleep, and steps borrow adjacent context points for the clipped line path so they read like zoomed trend lines rather than isolated dots. HR samples are retained per type so dense partial heart-rate syncs do not erase older HR days; the public HR graph uses 5-minute median buckets and keeps the latest raw HR point exact. Steps are daily Samsung-style totals: the current day accumulates as newer uploads arrive, and the next day starts a separate total. Low steps before morning are shown as early-day context, not as an anxiety watchout. The current-readings section gives glucose, HR, HRV, sleep, and steps equal visual weight. Sleep stays visible as history; old sleep does not drive the current action, and sleep is never selected as the visible recommendation source. Viewing the graph is public so it works from any device; Disregard uses the Blood edit key `031120`; bridge, manual, and CSV writes still require the ingest token.

## Data path

Automatic target path:

`CONTOUR NEXT ONE -> Blood Android bridge over Bluetooth -> Blood API -> glucose graph`

Health metrics path:

`Health Connect HR / sleep / steps -> Blood Android bridge -> Blood API -> /10 anxiety estimate + aligned health graphs + estimated HRV`

Backup glucose path:

`CONTOUR NEXT ONE -> Contour app -> Health Connect, only if Contour writes blood glucose there -> Blood Android bridge -> Blood API -> graph`

Fallbacks only:

`Contour CSV export -> blood.aolabs.io Contour export form -> Blood API -> graph`

`Manual mg/dL entry -> blood.aolabs.io Write path form -> Blood API -> graph`

The website cannot directly read another phone app's private storage. Glucose comes from the meter's Bluetooth service. HR, sleep, and steps come from Health Connect after the phone grants those permissions and another phone/wearable source writes records there. Health uploads are merged by metric id; a partial upload should add or update what it contains without clearing older HR, sleep, HRV, or step records. Step samples are collapsed to one latest daily total per Eastern date so repeated Health Connect uploads do not inflate the graph. If true HRV/RMSSD is unavailable, Blood calculates an estimated HRV only from sufficiently dense, clean, independent sleep/rest HR windows.

## Phone setup

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

1. Install or update Blood Bridge on the Android phone.
2. Open Blood Bridge.
3. Tap `Grant Bluetooth permission`.
4. Tap `Grant Health Connect metrics permission`.
5. Tap `Start automatic upload`.
6. Keep Android background sync allowed for Blood Bridge.
7. Keep the CONTOUR NEXT ONE near the phone after a reading.
8. Open `https://blood.aolabs.io/`.

Blood Bridge uses Android WorkManager background sync and queues an immediate background upload when automatic upload is started. It does not use a persistent foreground notification. Android may still delay invisible background work; when that happens, Blood shows the last upload time until the next worker run posts the stored meter and Health Connect records. The recurring worker reads the recent Health Connect window in pages so dense Samsung heart-rate records are not dropped behind an old first batch. The server keeps heart-rate history with a separate per-type limit instead of one shared health-row cap, so dense recent HR cannot crowd out older HR days. `Run one upload check now` is diagnostic only; it is not the normal workflow.

Health Connect metrics:

1. Android 14+: open Settings -> Security and privacy -> Privacy Controls -> Health Connect.
2. Android 13 or lower: install Health Connect from the Play Store, then open it from Settings -> Apps -> Health Connect.
3. Confirm the phone has sources for heart rate, steps, sleep, and HRV if a true RMSSD source is available.
4. Tap `Grant Health Connect metrics permission` in Blood Bridge.

HR should stay current when the watch or phone writes current heart-rate samples into Health Connect and the bridge uploads them. Blood separates those two freshness states on the page: health upload time, and the latest Samsung/Health Connect HR sample time. If Samsung Health is visibly newer than Blood while Blood shows an older HR source time, the shared Health Connect copy is stale or delayed; Blood is not reading Samsung Health's private app store directly. HRV is true only when Health Connect exposes RMSSD HRV records. When Samsung Health does not expose HRV, Blood calculates a labeled estimate from dense sleep/rest heart-rate samples, trims sleep-window edges, rejects noisy or sparse segments, requires at least three low-overlap clean windows and at least 75 accepted adjacent pairs, reports window spread, and waits if the sample set is too thin or too noisy. A truly live watch feed requires a separate Samsung SDK or watch-sensor bridge rather than the current Health Connect phone bridge.

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

Body: CSV text with date/time and glucose columns. The public page posts this only from the fallback Contour export form. The parser accepts common Contour-style columns such as `Date`, `Time`, `Reading (mg/dL)`, `Meal Marker`, and `Notes`.

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

`DELETE /api/blood/readings/:readingId`

Authorization: `Bearer 031120`. Soft-disregards one glucose reading from public Blood calculations while preserving the protected raw record/export history.

## Railway

Set these variables on the Railway service:

- `BLOOD_INGEST_TOKEN`
- `BLOOD_EDIT_KEY=031120` optional; the server default is `031120`.
- `BLOOD_READ_TOKEN` only for raw export access; the website summary is public.
- `BLOOD_ALLOWED_ORIGINS=https://blood.aolabs.io,https://aolabs.io`
- `DATABASE_URL` from a Railway Postgres service, or `DATA_DIR=/data` with a persistent volume

Use Postgres or a persistent volume for real history. Plain filesystem storage is only safe for local development.
