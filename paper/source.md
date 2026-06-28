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
- HRV samples: 735 heart-rate samples, 240 accepted adjacent RR-difference pairs, 8 selected non-overlapping/low-overlap windows
- sleep: 431 minutes asleep
- steps: 13,028 steps in the recent 24-hour window
- anxiety score: 4.4 /10

Current bridge/UI boundary:

- Recurring bridge sync reads a recent Health Connect window in pages so dense heart-rate records are not dropped behind an old first batch.
- Heart rate is current only when Samsung Health or another source writes current samples into Health Connect and the Blood Bridge uploads them. Blood shows both the health-upload time and the latest Samsung/Health Connect HR source time so a stale shared copy is not confused with a stale website.
- True HRV is current only when Health Connect exposes RMSSD HRV records. Without that source, Blood uses the labeled sleep/rest HR estimate and shows its estimate timestamp.
- A direct Samsung Health current-feed path would require the proprietary Samsung Health Data SDK or a separate watch sensor bridge; the current Blood Bridge reads the Health Connect copy.

Anxiety score source function: `server.js::estimateAnxietyState`.
Anxiety trend source function: `server.js::estimateAnxietyTrend`.
Time-pattern source function: `server.js::estimateInstabilityPatterns`.

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

Time blocks are used only for the learned pattern window, not for the top action label:

- 5 AM to before 10 AM ET: morning
- 10 AM to before 2 PM ET: midday
- 2 PM to before 6 PM ET: afternoon
- 6 PM to before 10 PM ET: evening
- 10 PM to before 5 AM ET: night

The suggestion action is taken from the strongest positive latest-uploaded factor and written as source reason plus one positive eating, drinking, or movement action. If no positive factor exists, Blood returns a water/food/movement action. The visible suggestion must name whether the triggering metric is too high, too low, near an edge, short, light, or raised, plus a concrete diet, water, or more-movement behavior. Blood recommendations do not restrict exercise and do not use phone, breathing, task-switching, focus, or work-management language.

The top pattern surface groups recent source records by Eastern time block: morning, midday, afternoon, evening, and night. It scores glucose, HR, HRV, sleep, and steps with the same bounded high/low/short/light/raised factors used by the latest estimate, reduces dense heart-rate records to hourly median buckets, and reports the block with the strongest recent instability pattern. The rolling window is 45 days, and the pattern is recomputed from stored source records on each summary API response so it changes as additional bridge data arrives.

The anxiety graph is the first graph in the aligned stack. It reconstructs historical score points from stored glucose readings and health-trend samples, keeps only points with at least two source inputs, and appends the latest anxiety score as the newest visible point when available. The visible chart stack is six graphs: anxiety, glucose, HR, HRV, sleep, and steps.

HRV estimate tightening:

- true source HRV/RMSSD always wins for a date when present
- proxy HRV uses sleep heart-rate samples first, then resting samples only when sleep samples are unavailable
- each candidate window must be at least 18 minutes long, have at least 14 accepted adjacent RR-difference pairs, median sample gap no higher than 2.25 minutes, and coverage at least 80%
- candidate windows with high median HR, high HR standard deviation, high median/p90 HR steps, or high p90 RR difference are rejected
- noisy adjacent pairs are removed with median-absolute-deviation gates before RMSSD-like calculation
- selected windows must be independent or low-overlap; at least two windows and 40 accepted pairs are required before an estimated HRV is emitted
- API metadata exposes pair count, rejected pair count, median gap, coverage ratio, selected window count, quality, and confidence
