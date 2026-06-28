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
- steps: 13,028 steps as the latest daily total for the current Eastern date
- anxiety score: 4.4 /10

Current bridge/UI boundary:

- Recurring bridge sync reads a recent Health Connect window in pages so dense heart-rate records are not dropped behind an old first batch.
- Heart rate is current only when Samsung Health or another source writes current samples into Health Connect and the Blood Bridge uploads them. Blood shows both the health-upload time and the latest Samsung/Health Connect HR source time so a stale shared copy is not confused with a stale website.
- True HRV is current only when Health Connect exposes RMSSD HRV records. Without that source, Blood uses the labeled sleep/rest HR estimate and shows its estimate timestamp.
- A direct Samsung Health current-feed path would require the proprietary Samsung Health Data SDK or a separate watch sensor bridge; the current Blood Bridge reads the Health Connect copy.
- Glucose readings can be disregarded from the website with the protected Blood write key. Disregarded readings remain in protected export/history, but the public summary, latest glucose, glucose graph, anxiety score, pattern detector, range stats, and visible readings table ignore them. Re-uploading the same bridge reading preserves the disregard flag.

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

The top condition read is taken from current uploaded source values plus recent source movement and written in simple English. It must say whether the overall source state looks steady, slightly elevated, elevated, or high; name the useful current glucose, HR, estimated-or-source HRV, and daily-step facts; and give easy food, water, or movement actions. Actionable visible factors are glucose, HR, true source HRV, recent glucose/HR/HRV changes, and daily steps. Estimated HRV is shown as a normal Blood estimate by default; it becomes an actionable watchout only when the estimate dips meaningfully against recent history. Sleep can contribute to the score only when the source sleep record is still fresh enough to describe the current recovery context, but sleep is not selected as the visible recommendation source. If no actionable positive factor exists, Blood returns a water/food/movement action. Blood recommendations do not restrict exercise and do not use phone, breathing, task-switching, focus, work-management, or old-sleep correction language.

The watchout surface groups recent source records by Eastern time block: morning, midday, afternoon, evening, and night. It scores glucose, HR, true HRV, HRV-change, sleep, and steps, reduces dense heart-rate records to hourly median buckets, and reports a visible window when there is a concrete actionable glucose, HR, HRV-change, or step reason to name. If the rolling window is thin, it still reports the best abnormal signal it can infer from the latest uploaded values or recent dynamics and pairs it with a concrete food, water, or movement action. Sleep-only history stays on the sleep graph and may remain part of the bounded score context, but it does not produce a visible instruction about an old night. The visible detail must name concrete actionable source states and values, such as `HR too high (114 bpm)`, `glucose near high edge (159 mg/dL)`, or `HRV dip`, rather than a vague aggregate such as `2 of 7 source samples read high, low, short, light, or raised` or a dead `Need more samples` learning state. The rolling window is 45 days, and the pattern is recomputed from stored source records on each summary API response so it changes as additional bridge data arrives.

The anxiety graph is the first graph in the aligned stack. It reconstructs historical score points from stored glucose readings and health-trend samples, keeps only points with at least two source inputs, recomputes small dynamic factors from the time history leading into each point, and appends the latest anxiety score as the newest visible point when available. The visible chart stack is six graphs: anxiety, glucose, HR, HRV, sleep, and steps. The chart renderer separates source measurement time from plotting endpoint: current latest-upload values use the current upload endpoint for x-position so the last current point lands on the right edge, while the label and tooltip still show the true source measurement time. Steps are collapsed to one latest daily total per Eastern date so repeated Samsung/Health Connect uploads cannot multiply the day.

The glucose graph and score use active readings only. The website's latest-readings table includes a protected Disregard action for one glucose reading at a time. This is a soft-delete control: it removes that measurement from current Blood calculations and visible graphs while preserving the raw record for protected audit/export.

HRV estimate tightening:

- true source HRV/RMSSD always wins for a date when present
- proxy HRV uses sleep heart-rate samples first, then resting samples only when sleep samples are unavailable
- each candidate window must be at least 18 minutes long, have at least 14 accepted adjacent RR-difference pairs, median sample gap no higher than 2.25 minutes, and coverage at least 80%
- candidate windows with high median HR, high HR standard deviation, high median/p90 HR steps, or high p90 RR difference are rejected
- noisy adjacent pairs are removed with median-absolute-deviation gates before RMSSD-like calculation
- selected windows must be independent or low-overlap; at least two windows and 40 accepted pairs are required before an estimated HRV is emitted
- API metadata exposes pair count, rejected pair count, median gap, coverage ratio, selected window count, quality, and confidence
