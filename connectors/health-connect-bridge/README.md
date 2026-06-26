# Blood Health Connect Bridge

This Android bridge reads Health Connect `BloodGlucoseRecord` records and posts them to `blood.aolabs.io`.

It only works if the phone has glucose records in Health Connect. The Contour app may still require CSV export if it does not write CONTOUR NEXT ONE readings to Health Connect on the phone.

Default endpoint:

`https://blood.aolabs.io/api/ingest/glucose-readings`

The bridge stores the endpoint and ingest token locally in Android shared preferences. Background sync runs through WorkManager after permission and token setup.
