# Blood Health Connect Bridge

This Android bridge reads Health Connect `BloodGlucoseRecord` records and posts them to `blood.aolabs.io`. It cannot read the Contour app's private storage.

Download the current debug APK from `https://blood.aolabs.io/downloads/blood-bridge.apk`.

It only works if the phone has glucose records in Health Connect. If Contour is not listed as a Health Connect blood glucose source, use the Contour CSV export form on `blood.aolabs.io` instead.

Default endpoint:

`https://blood.aolabs.io/api/ingest/glucose-readings`

The bridge stores the endpoint and ingest token locally in Android shared preferences. Background sync runs through WorkManager after permission and token setup.

On Android 14 and newer, Health Connect is reached from Settings -> Security and privacy -> Privacy Controls -> Health Connect. It may not appear as a normal app icon.
