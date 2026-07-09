# Review Coding Codebook (IRR validation)

This codebook is the ground truth for hand-coding the 200-review reliability
sample (`irr-sample-coder-A.csv` / `irr-sample-coder-B.csv`). It exists to
validate the deterministic lexical coder in `../code-reviews.mjs` against human
judgement (Cohen's kappa / Krippendorff's alpha, plus lexical precision/recall).

**Estimated effort: ~2 hours per coder** (200 short reviews, 9 binary codes).

---

## How to code

- **Unit of analysis:** the whole `review_text` cell (it is the review title +
  body joined, exactly what the automatic coder sees). The `rating` column is
  context only — *do not* let the star count decide a code.
- **One column per code, value `1` or `0`.** Put `1` if the code applies, `0`
  if it does not. Please fill every code cell explicitly (a blank is scored as
  `0`, but explicit `0` is clearer).
- **Multi-label is expected.** A single review can earn several codes; assign
  every code whose theme is substantively present. There is no "pick one".
- **Code substantive claims, not boilerplate.** Ignore generic praise ("nice
  app", "love it", "5 stars"), install chatter, and unrelated feature requests.
  A code applies only when the reviewer makes a *real claim* about that theme.
- **`other` is implicit.** There is no `other` column: if none of the nine
  codes apply, leave all nine at `0`.
- **Code independently.** Do not look at the other coder's sheet, the automatic
  coder's output, or `irr-sample-key.json` while coding. Use the `notes` column
  for genuinely ambiguous items and adjudication hints.

Examples below are **verbatim excerpts from the actual corpus** (`…` = trimmed).

---

## The nine codes

### 1. `safety_need`
**Definition.** The reviewer frames location sharing as *protecting the safety
or wellbeing* of a specific person (child, elderly parent, partner) or of
themselves — peace of mind, reassurance, or emergency / accident / crash
response.

- **+** `We enjoy the app as it's needed for tracking our whereabouts so proper plans can be kept. It also serves as a safety feature for each other.`
- **+** `Highly recommended Great for planning and knowing if my kids have arrive safely to their destination.`
- **~ near-miss (code `monitoring_coercion`, NOT `safety_need`):** `Its great for stalking my family members when I'm home alone. and making fun of my sister cos her phone always almost dead` — names family and tracking, but the framing is playful surveillance/teasing, not protection.

**Rule.** Requires an explicit protective / wellbeing / peace-of-mind /
emergency framing. Merely naming a family member is not enough on its own.

### 2. `battery_performance`
**Definition.** Reliability and device performance of the app itself — battery
drain, overheating, crashes, freezes, lag/slowness, bugs/glitches, "doesn't
work", forced uninstall/reinstall.

- **+** `The app is great, it glitches sometimes and also stops working randomly but overall is great`
- **+** `SO useless anymore. Doesn't even show anything anymore! It just sits there and spins and freezes.`
- **~ near-miss (code `freshness_complaint`, NOT `battery_performance`):** `came to give 5 stars, but the locations are not updating. Horrible since the last update. I will get notifications an hour later.` — the app runs fine; only the *location data* is stale.

**Rule.** Code crashes / battery / speed / bugs of the app. If the app works
but the *location* is old or wrong, use `freshness_complaint` /
`accuracy_complaint` instead.

### 3. `control_visibility`
**Definition.** The user's ability to control their *own* visibility and the
app's intrusions — who can see them, turning sharing/notifications off,
hiding/pausing, per-contact or duration-limited sharing, opt-in/out, privacy
settings and permissions.

- **+** `I can't turn off notifications for marketing, unless I want to turn off notifications completely. It constantly says I have missed notifications…`
- **+** `We use this app every time a family member travels … and you can choose for how long you want to share your location.`
- **~ near-miss (code `coordination_need`/`safety_need`, NOT `control_visibility`):** `I love the fact that it sends you notifications I can see where my family is at all times.` — "notifications" is incidental; there is no claim about *controlling* visibility.

**Rule.** The reviewer must talk about *controlling* what is shared or with
whom (toggles, hiding, opt-out, granular/duration settings). A passing mention
of "notifications"/"settings" as boilerplate does not qualify.

### 4. `freshness_complaint`
**Definition.** The location data is stale / not updating / delayed / frozen /
stuck — the shown position lags reality or won't refresh. Also praise for, or
requests for, real-time / live updates.

- **+** `the locations are not updating. Horrible since the last update. I will get notifications an hour later.`
- **+** `doesn't provide live notifications. Notifications are extremely delayed, so mich can happen during that period of time.`
- **~ near-miss (code `accuracy_complaint`, NOT `freshness_complaint`):** `Life360 Drive speed is way off, and location has been off. Example it would say we are across town when we are at home.` — the location is *wrong*, not merely *late*.

**Rule.** freshness = right place, reported late / not refreshing. If it is the
*wrong* place, that is `accuracy_complaint`. If both (old **and** wrong), code
both.

### 5. `coordination_need`
**Definition.** Using location to coordinate logistics between people —
pickups/drop-offs, ETAs and arrival times, "on my way", meeting up, knowing
when someone reached a destination, sharing location to rendezvous.

- **+** `My husband and I were constantly having to send texts like "How far from home are you now?", or "Have you made it…"`
- **+** `Great for planning and knowing if my kids have arrive safely to their destination.` (also `safety_need` — multi-label)
- **~ near-miss (code `safety_need`, NOT `coordination_need`):** `It also serves as a safety feature for each other.` — protection, with no logistical / rendezvous use.

**Rule.** coordination = logistics / rendezvous / arrival-timing. Pure
protection with no logistical use is `safety_need` only.

### 6. `monitoring_coercion`
**Definition.** Location tracking experienced or described as
surveillance/control — being watched, stalked, spied on; *forced/coerced* into
sharing; controlling / possessive / jealous partner or parent; "big brother";
feels like prison. Includes playful "stalking" self-descriptions.

- **+** `I like being able to stalk my friends on it (jokes) 🙂 it's a good app`
- **+** `Its great for stalking my family members when I'm home alone…`
- **~ near-miss (code `control_visibility`, NOT `monitoring_coercion`):** `I can't turn off notifications for marketing, unless I want to turn off notifications completely.` — annoyance at app settings, not interpersonal surveillance or coercion.

**Rule.** Requires an *interpersonal* surveillance / control / coercion framing
(someone watching or forcing someone). The app nagging you is not coercion.

### 7. `accuracy_complaint`
**Definition.** The displayed location is *wrong* — off by miles, "across town
when at home", false arrival/departure alerts, drifting, random trips, or the
app placing the user somewhere they are not.

- **+** `Life360 Drive speed is way off, and location has been off. Example it would say we are across town when we are at home.`
- **+** `just had dinner in another town with a family member … after 2 hours, it never showed they left their house.`
- **~ near-miss (code `precision_concern`, NOT `accuracy_complaint`):** `very bad experience, didn't get the exact location in data mode.` — wants a more *exact* fix, not reporting a *wrong* one.

**Rule.** accuracy = the location is *incorrect*. If it is correct but too
coarse (or too exact), that is `precision_concern`.

### 8. `precision_concern`
**Definition.** The *granularity / exactness* of location — wanting or valuing a
more exact/pinpoint fix, complaining it is only coarse (approximate /
neighbourhood / city-level), or (privacy angle) that it is *too* precise.

- **+** `very bad experience, didn't get the exact location in data mode.`
- **+** `This helps me easily track my kids … I was able to track it exact location, even better than apple location`
- **~ near-miss (code `accuracy_complaint`, NOT `precision_concern`):** `great for finding people although sometimes a bit inaccurate.` — it is *wrong*, not merely *coarse*.

**Rule.** precision is about *resolution* (coarse vs pinpoint, or too-precise).
correctness (right vs wrong place) is `accuracy_complaint`.

### 9. `trust_integrity`
**Definition.** Trust in the *truthfulness / integrity* of the location signal
or the vendor — spoofing / fake GPS, pausing or ghosting location to deceive,
people lying about where they are, distrust, privacy violations, or
selling/brokering location data.

- **+** `Life 360 sells your data to insurance brokers. If you install this and don't drive like a grandma, expect your rates to go up. An opt out would be great…`
- **+** `NOW I CAN SEE IF MY FRIEND ARE LYING ABOUT THEIR PHONE BATTERY TY ZENLY` (detecting deception)
- **~ near-miss (code `monitoring_coercion`, NOT `trust_integrity`):** `Its great for stalking my family members when I'm home alone…` — a surveillance framing, not a truthfulness / privacy-integrity claim.

**Rule.** trust_integrity = *is the signal/vendor honest and trustworthy?*
(spoofing, ghosting, lying, data-selling, privacy violation). Surveillance or
coercion *of a person* is `monitoring_coercion`.

---

## After coding

1. Save your filled CSV (keep the filename you were given).
2. Both sheets go back next to `compute-irr.mjs`, which computes per-code
   Cohen's kappa + Krippendorff's alpha, a pooled kappa, and the lexical
   coder's precision/recall against your consensus.
3. Optional: adjudicate disagreements into `irr-sample-resolved.csv`
   (`sample_id` + one `0/1` column per code) to fold them back into the
   lexical precision/recall.
