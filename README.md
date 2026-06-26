# blood.aolabs.io

Blood is an AO Labs blood glucose record for readings captured by a CONTOUR NEXT ONE through the Contour app.

The public page renders a clear glucose graph from the Blood API. Viewing the graph is public so it works from any device; writing readings requires the ingest token.

## Data path

Preferred Android path:

`CONTOUR NEXT ONE -> Contour app -> Health Connect, if Contour writes blood glucose there -> Blood Android bridge -> Blood API -> graph`

Current fallback:

`Contour CSV export -> POST /api/ingest/contour-csv -> Blood API -> graph`

The website cannot directly read another phone app's private storage. The bridge can only read Health Connect glucose records that the phone has permissioned and that another app has actually written.

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

Body: CSV text with date/time and glucose columns. The parser accepts common Contour-style columns such as `Date`, `Time`, `Reading (mg/dL)`, `Meal Marker`, and `Notes`.

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
