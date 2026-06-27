# Blood paper source notes

Title: Blood: source-bounded personal anxiety scoring from glucose and wearable signals

Current source state checked 2026-06-27 3:11 PM ET from `https://blood.aolabs.io/api/blood/summary`:

- latest glucose: 120 mg/dL, measured 2026-06-27 2:26 PM ET, CONTOUR NEXT ONE meter bridge
- heart rate: 68 bpm
- estimated HRV: 12 ms_est
- HRV basis: sleep_heart_rate_samples
- HRV quality: sleep_dense_hr_estimate
- HRV confidence: highest_available_without_beat_intervals
- HRV samples: 735 heart-rate samples, 240 accepted adjacent RR-difference pairs, 8 selected windows
- sleep: 431 minutes asleep
- steps: 14,764 steps in the recent 24-hour window
- anxiety score: 4.4 /10

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

The suggestion action is taken from the strongest positive current factor and written as one direct more/less adjustment. If no positive factor exists, Blood returns a steady-pattern action.
