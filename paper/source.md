# Blood paper source notes

Title: Blood: source-bounded personal anxiety scoring from glucose and wearable signals

Current source state checked 2026-06-27 6:13 PM ET from `https://blood.aolabs.io/api/blood/summary`:

- latest glucose: 82 mg/dL, measured 2026-06-27 4:14 PM ET, CONTOUR NEXT ONE meter bridge
- health upload: 2026-06-27 4:17 PM ET
- heart rate: 68 bpm, source sample measured 2026-06-27 1:50 PM ET
- estimated HRV: 12 ms_est, source estimate timestamp 2026-06-27 4:04 AM ET
- HRV basis: sleep_heart_rate_samples
- HRV quality: sleep_dense_hr_estimate
- HRV confidence: highest_available_without_beat_intervals
- HRV samples: 735 heart-rate samples, 240 accepted adjacent RR-difference pairs, 8 selected windows
- sleep: 431 minutes asleep
- steps: 13,028 steps in the recent 24-hour window
- anxiety score: 4.4 /10

Current bridge/UI boundary:

- Recurring bridge sync reads a recent Health Connect window in pages so dense heart-rate records are not dropped behind an old first batch.
- Heart rate is current only when Samsung Health or another source writes current samples into Health Connect and the Blood Bridge uploads them. Blood now shows both the health-upload time and the latest Samsung/Health Connect HR source time so a stale shared copy is not confused with a stale website.
- True HRV is current only when Health Connect exposes RMSSD HRV records. Without that source, Blood uses the labeled sleep/rest HR estimate and shows its estimate timestamp.
- A direct Samsung Health current-feed path would require the proprietary Samsung Health Data SDK or a separate watch sensor bridge; the current Blood Bridge reads the Health Connect copy.

Anxiety score source function: `server.js::estimateAnxietyState`.

Calculation:

- Start with raw = 2.2.
- Glucose:
  - <70 mg/dL: +1.00
  - >180 mg/dL: +0.90
  - <82 or >140 mg/dL: +0.35
  - otherwise: -0.15
- Heart rate:
  - >=100 bpm: +0.85
  - >=85 bpm: +0.40
  - 55-75 bpm: -0.15
- HRV:
  - <25 ms: +0.80
  - <40 ms: +0.45
  - >=65 ms: -0.25
- Sleep:
  - <300 min: +0.90
  - <360 min: +0.45
  - >=420 min: -0.25
- Steps:
  - <1500: +0.35
  - <4000: +0.15
  - >=8000: -0.25
- Final score = clamp(1, 10, raw * 2), rounded to one decimal place.

Live worked example:

`raw = 2.2 - 0.15 - 0.15 + 0.80 - 0.25 - 0.25 = 2.20`

`score = 2.20 * 2 = 4.4 /10`

Suggestion timing is deliberately simple current-block labeling, not delay scheduling or learned pattern detection:

- 5 AM to before 10 AM ET: morning
- 10 AM to before 2 PM ET: midday
- 2 PM to before 6 PM ET: afternoon
- 6 PM to before 10 PM ET: evening
- 10 PM to before 5 AM ET: night

The suggestion action is taken from the strongest positive current factor and written as source reason plus one direct food, water, or movement adjustment. If no positive factor exists, Blood returns a water/food/movement action. The visible suggestion must name the triggering metric, value or freshness boundary, and concrete behavior so it does not read like a disconnected wellness fragment. Blood recommendations do not use phone, breathing, task-switching, focus, or work-management language.
