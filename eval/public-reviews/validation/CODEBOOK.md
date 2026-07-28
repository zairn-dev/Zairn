# Review Coding Codebook (IRR validation)

This codebook is the ground truth for hand-coding the 200-review reliability
sample (`irr-sample-coder-A.csv` / `irr-sample-coder-B.csv`). It exists to
validate the deterministic lexical coder in `../code-reviews.mjs` against human
judgement (Cohen's kappa / Krippendorff's alpha, plus lexical precision/recall).

**Estimated effort: ~2 hours per coder** (200 short reviews, 9 binary codes).

**Tool.** Open `coding-tool.html` in any browser and load your assigned CSV. It
shows one review at a time with the nine codes, keeps each code's rule and its
near-miss example on screen, takes `1`–`9` / `Enter` on the keyboard, autosaves
to the browser so you can stop and resume, and exports a CSV in exactly the
format `compute-irr.mjs` expects. It never loads `irr-sample-key.json` or the
lexical coder's output. Coding by hand in a spreadsheet works too.

---

## A note on the examples below

Examples marked **[verbatim]** are real excerpts from the corpus (`…` = trimmed)
that are **not** in the 200-review sample, so reading them here does not give
away the answer to any row you will code.

Examples marked **[constructed]** were written for this codebook. They are used
only where the corpus cannot supply a held-out illustration: `monitoring_coercion`,
`accuracy_complaint`, `precision_concern` and `trust_integrity` occur just 15,
14, 7 and 6 times respectively across all 1,631 reviews, and every one of those
instances is in the reliability sample. Illustrating them with a real excerpt
would hand you a pre-answered row. Constructed examples are written in the same
register as the corpus (lowercase, unpunctuated, typos) and are never counted as
data anywhere in the analysis.

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
- **Code the theme, not the sentiment.** Praise and complaint are coded alike:
  "it keeps my kids safe" and "it never tells me where my kids are" are both
  about the same theme. Star ratings and tone are irrelevant.
- **Code substantive claims, not boilerplate.** Ignore generic praise ("nice
  app", "love it", "5 stars"), install chatter, and unrelated feature requests.
  A code applies only when the reviewer makes a *real claim* about that theme.
- **`other` is implicit.** There is no `other` column: if none of the nine
  codes apply, leave all nine at `0`. This is a common and correct outcome —
  roughly seven in ten reviews in this corpus carry no code at all.
- **Code independently.** Do not look at the other coder's sheet, the automatic
  coder's output, or `irr-sample-key.json` while coding. Use the `notes` column
  for genuinely ambiguous items and adjudication hints.

---

## The nine codes

### 1. `safety_need`
**Definition.** The reviewer frames location sharing as *protecting the safety
or wellbeing* of a specific person (child, elderly parent, partner) or of
themselves — peace of mind, reassurance, or emergency / accident / crash
response.

- **+** [verbatim] `We enjoy the app as it's needed for tracking our whereabouts so proper plans can be kept. It also serves as a safety feature for each other.`
- **+** [verbatim] `I Love this app I feel great knowing where my kids are at any given time. It brings deep peace of mind`
- **~ near-miss (code `monitoring_coercion`, NOT `safety_need`):** [constructed] `my mom makes me keep this on 24/7 and checks it constantly, i cant go anywhere without getting a text asking why im there` — names family and tracking, but the framing is surveillance and control, not protection.

**Rule.** Requires an explicit protective / wellbeing / peace-of-mind /
emergency framing. Merely naming a family member is **not** enough on its own.

### 2. `battery_performance`
**Definition.** Reliability and device performance of the app itself — battery
drain, overheating, crashes, freezes, lag/slowness, bugs/glitches, "doesn't
work", forced uninstall/reinstall.

- **+** [verbatim] `still has some glitches but has improved a lot since the last time I used this app.`
- **+** [verbatim] `SO useless anymore. Doesn't even show anything anymore! It just sits there and spins and freezes.`
- **~ near-miss (code `freshness_complaint`, NOT `battery_performance`):** [verbatim] `its not live location...always need to click refresh...and sometime dont show anything location` — the app runs fine; only the *location data* is stale.

**Rule.** Code crashes / battery / speed / bugs of the app. If the app works
but the *location* is old or wrong, use `freshness_complaint` /
`accuracy_complaint` instead.

### 3. `control_visibility`
**Definition.** The user's ability to control their *own* visibility and the
app's intrusions — who can see them, turning sharing/notifications off,
hiding/pausing, per-contact or duration-limited sharing, opt-in/out, privacy
settings and permissions.

- **+** [constructed] `wish i could pick who sees me. right now its my whole circle or nobody, i want to share with just my partner some days`
- **+** [verbatim] `Hmmm so what's kind of another apps can i use to see my friend location, after you turn off the apps?`
- **~ near-miss (code `coordination_need`/`safety_need`, NOT `control_visibility`):** [verbatim] `I love the fact that it sends you notifications I can see where my family is at all times.` — "notifications" is incidental; there is no claim about *controlling* visibility.

**Rule.** The reviewer must talk about *controlling* what is shared or with
whom (toggles, hiding, opt-out, granular/duration settings). A passing mention
of "notifications"/"settings" as boilerplate does **not** qualify — this is the
most common false positive in this category, so read for an actual control
claim before ticking it.

### 4. `freshness_complaint`
**Definition.** The location data is stale / not updating / delayed / frozen /
stuck — the shown position lags reality or won't refresh. Also praise for, or
requests for, real-time / live updates.

- **+** [verbatim] `doesn't give real time has too much time delay`
- **+** [verbatim] `doesn't provide live notifications. Notifications are extremely delayed, so mich can happen during that period of time.`
- **~ near-miss (code `accuracy_complaint`, NOT `freshness_complaint`):** [constructed] `it had me at the shopping centre when i was sat at home, does that most evenings` — the location is *wrong*, not merely *late*. (Recurring, so not a one-off freeze.)

**Rule.** freshness = right place, reported late / not refreshing. If it is the
*wrong* place, that is `accuracy_complaint`. If both (old **and** wrong), code
both.

### 5. `coordination_need`
**Definition.** Using location to coordinate logistics between people —
pickups/drop-offs, ETAs and arrival times, "on my way", meeting up, knowing
when someone reached a destination, sharing location to rendezvous.

- **+** [verbatim] `why can't we no longer see arrival times and navigation? I relied on that a lot.`
- **+** [verbatim] `I love this app! It really cuts down on my family members' anxiety if I share my location on the way home.`
- **~ near-miss (code `safety_need`, NOT `coordination_need`):** [verbatim] `It also serves as a safety feature for each other.` — protection, with no logistical / rendezvous use.

**Rule.** coordination = logistics / rendezvous / arrival-timing. Pure
protection with no logistical use is `safety_need` only.

### 6. `monitoring_coercion`
**Definition.** Location tracking experienced or described as
surveillance/control — being watched, stalked, spied on; *forced/coerced* into
sharing; controlling / possessive / jealous partner or parent; "big brother";
feels like prison. Includes playful "stalking" self-descriptions.

- **+** [constructed] `bf checks this every 10 min and calls if i stop somewhere he doesnt know. feels like im being watched all day`
- **+** [constructed] `had to install it or i wasnt allowed the car. basically spyware for parents lol`
- **~ near-miss (code `control_visibility`, NOT `monitoring_coercion`):** [verbatim] `I don't like the fact that you get a notification every single time someone leaves the house or if someone leaves somewhere you get a notification it's really annoying` — annoyance at app behaviour, not interpersonal surveillance or coercion.

**Rule.** Requires an *interpersonal* surveillance / control / coercion framing
(someone watching or forcing someone). The app nagging you is not coercion.

### 7. `accuracy_complaint`
**Definition.** The displayed location is *wrong* — off by miles, "across town
when at home", false arrival/departure alerts, drifting, random trips, or the
app placing the user somewhere they are not.

- **+** [constructed] `keeps putting me at the retail park two miles away, ive never even been there`
- **+** [verbatim] `just had dinner in another town with a family member … after 2 hours, it never showed they left their house.`
- **~ near-miss (code `precision_concern`, NOT `accuracy_complaint`):** [constructed] `only shows the street not the actual building, would be better if it could pinpoint the exact door` — wants a more *exact* fix, not reporting a *wrong* one.

**Rule.** accuracy = the location is *incorrect*. If it is correct but too
coarse (or too exact), that is `precision_concern`.

### 8. `precision_concern`
**Definition.** The *granularity / exactness* of location — wanting or valuing a
more exact/pinpoint fix, complaining it is only coarse (approximate /
neighbourhood / city-level), or (privacy angle) that it is *too* precise.

- **+** [constructed] `it only narrows it down to the neighbourhood which isnt much use when youre trying to find someone in a crowd`
- **+** [verbatim] `This helps me easily track my kids … I was able to track it exact location, even better than apple location`
- **~ near-miss (code `accuracy_complaint`, NOT `precision_concern`):** [constructed] `showed my daughter three towns over when she was upstairs, no idea where it got that from` — it is *wrong*, not merely *coarse*.

**Rule.** precision is about *resolution* (coarse vs pinpoint, or too-precise).
correctness (right vs wrong place) is `accuracy_complaint`.

### 9. `trust_integrity`
**Definition.** Trust in the *truthfulness / integrity* of the location signal
or the vendor — spoofing / fake GPS, pausing or ghosting location to deceive,
people lying about where they are, distrust, privacy violations, or
selling/brokering location data.

- **+** [constructed] `you can freeze your location and everyone still thinks its live, so people just lie about where they are`
- **+** [constructed] `didnt realise they hand this data to third parties until i read the small print. deleting`
- **~ near-miss (code `monitoring_coercion`, NOT `trust_integrity`):** [constructed] `my dad watches every move i make on here, its honestly invasive` — a surveillance framing, not a truthfulness / privacy-integrity claim.

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
