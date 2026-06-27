# Blood Android Bridge

This Android bridge reads a nearby CONTOUR NEXT ONE meter over the Bluetooth Glucose service and posts readings to `blood.aolabs.io`. Health Connect `BloodGlucoseRecord` remains a backup source. The bridge cannot read the Contour app's private storage.

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

The primary automatic path is the meter itself:

`CONTOUR NEXT ONE -> Bluetooth -> Blood Bridge -> blood.aolabs.io`

Manual entry and Contour CSV import are fallback tools only when the automatic meter bridge is blocked.

Default endpoint:

`https://blood.aolabs.io/api/ingest/glucose-readings`

The bridge stores the endpoint and ingest token locally in Android shared preferences. Background sync runs through WorkManager after permission and token setup.

On Android 14 and newer, Health Connect is reached from Settings -> Security and privacy -> Privacy Controls -> Health Connect. It may not appear as a normal app icon. This matters only for the backup path.
