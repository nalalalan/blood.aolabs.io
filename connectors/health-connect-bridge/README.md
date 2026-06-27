# Blood Android Bridge

This Android bridge reads a nearby CONTOUR NEXT ONE meter over the Bluetooth Glucose service and posts readings to `blood.aolabs.io`. It also reads Health Connect heart rate, steps, and sleep records and posts them to Blood. HRV is estimated by Blood from sleep/rest heart-rate samples when source HRV is unavailable. Health Connect `BloodGlucoseRecord` remains a backup glucose source only when another app actually writes glucose there. The bridge cannot read the Contour app's private storage.

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

The primary automatic glucose path is the meter itself:

`CONTOUR NEXT ONE -> Bluetooth -> Blood Bridge -> blood.aolabs.io`

The health metrics path is:

`Health Connect HR / steps / sleep -> Blood Bridge -> blood.aolabs.io -> estimated HRV`

Manual entry and Contour CSV import are fallback tools only when the automatic meter bridge is blocked.

Default endpoint:

`https://blood.aolabs.io/api/ingest/glucose-readings`

The released APK is preconfigured for the Blood upload endpoint. Background sync runs invisibly through WorkManager after permissions are granted and automatic upload is started. No persistent Blood Bridge notification is used. Android may delay invisible background work, so the website is the freshness source of truth. The recurring worker reads a recent Health Connect window in pages so dense Samsung heart-rate records are not lost behind an old first batch.

Advanced diagnostics can override the glucose endpoint locally. The metrics endpoint is derived from that URL by replacing `/api/ingest/glucose-readings` with `/api/ingest/health-metrics`.

On Android 14 and newer, Health Connect is reached from Settings -> Security and privacy -> Privacy Controls -> Health Connect. It may not appear as a normal app icon. Grant Blood Bridge blood glucose, heart rate, HRV when available, steps, sleep, and background Health Connect access.

Heart rate stays current when Samsung Health or another source writes current heart-rate samples into Health Connect. Blood shows the sample time on the website so a recent bridge upload cannot hide stale source data. True HRV is uploaded only when Health Connect exposes real RMSSD HRV records. Missing HRV permission does not block metric sync; Blood calculates a labeled estimate from sufficiently dense sleep/rest heart-rate samples.
