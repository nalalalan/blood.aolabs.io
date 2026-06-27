# blood.aolabs.io

Blood is an AO Labs blood glucose record for readings captured by a CONTOUR NEXT ONE meter.

The public page renders a clear glucose graph from the Blood API. Viewing the graph is public so it works from any device; writing readings requires the ingest token.

## Data path

Automatic target path:

`CONTOUR NEXT ONE -> Blood Android bridge over Bluetooth -> Blood API -> graph`

Backup path:

`CONTOUR NEXT ONE -> Contour app -> Health Connect, only if Contour writes blood glucose there -> Blood Android bridge -> Blood API -> graph`

Current fallbacks:

`Contour CSV export -> blood.aolabs.io Contour export form -> Blood API -> graph`

`Manual mg/dL entry -> blood.aolabs.io Write path form -> Blood API -> graph`

The website cannot directly read another phone app's private storage. The bridge can only read Health Connect glucose records that the phone has permissioned and that another app has actually written.
Because Contour is not appearing as a Health Connect source on the phone, the bridge's primary source is the meter's Bluetooth glucose service, not the Contour app's private app storage.

## Phone setup

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

1. Install Blood Bridge on the Android phone.
2. In Blood Bridge, enter:
   - endpoint: `https://blood.aolabs.io/api/ingest/glucose-readings`
   - token: Railway `BLOOD_INGEST_TOKEN`
3. Tap `Grant Bluetooth permission`.
4. Keep the CONTOUR NEXT ONE near the phone and tap `Sync CONTOUR meter now`.
5. Open `https://blood.aolabs.io/`.

Health Connect backup:

1. Android 14+: open Settings -> Security and privacy -> Privacy Controls -> Health Connect.
2. Android 13 or lower: install Health Connect from the Play Store, then open it from Settings -> Apps -> Health Connect.
3. If Health Connect lists a glucose source, tap `Grant Health Connect backup permission` in Blood Bridge.

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

Body: CSV text with date/time and glucose columns. The public page posts this from the Contour export form when a bridge token is entered. The parser accepts common Contour-style columns such as `Date`, `Time`, `Reading (mg/dL)`, `Meal Marker`, and `Notes`.

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
