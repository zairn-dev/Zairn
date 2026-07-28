/**
 * lexical-rules.mjs — the deterministic review-coding rules, versioned.
 *
 * V1 is the ruleset that produced every number currently in the paper. It is
 * reproduced here byte-for-byte from code-reviews.mjs and must not be edited.
 *
 * V2 is a correction of V1 against CODEBOOK.md. Both are kept so the same
 * human-coded reliability sample can score both, and so the paper can report
 * what the correction cost.
 *
 * ---------------------------------------------------------------------------
 * WHY V2 EXISTS
 * ---------------------------------------------------------------------------
 * CODEBOOK.md was written later than code-reviews.mjs, as the specification a
 * human coder follows. The two were never reconciled, and on two codes they
 * contradict each other outright:
 *
 *   safety_need — the codebook says "Requires an explicit protective /
 *   wellbeing / peace-of-mind / emergency framing. Merely naming a family
 *   member is not enough on its own." V1 fires on bare family nouns
 *   (son/daughter/mom/husband/...). Measured on the raw corpus, 126 of 224
 *   safety_need hits (56%) fire on a family noun with no protective wording
 *   anywhere in the review.
 *
 *   control_visibility — the codebook says "A passing mention of
 *   'notifications'/'settings' as boilerplate does not qualify." V1 fires on
 *   bare /settings?/ and /notifications?/. Measured on the corpus, 58 of 70
 *   control_visibility hits (83%) fire on that boilerplate alone, with no
 *   control wording anywhere.
 *
 * These are the largest and third-largest codes. safety_need alone is 48.7% of
 * substantive coded instances and sits in the `gap` bucket, so the error runs
 * in the direction of the paper's headline claim. That is precisely the kind
 * of defect this paper is about, which is why it is being corrected rather
 * than noted.
 *
 * ---------------------------------------------------------------------------
 * DISCIPLINE
 * ---------------------------------------------------------------------------
 * V2 was written BEFORE any human coding existed, and derives only from the
 * text of CODEBOOK.md. No rule was chosen, kept, or dropped by looking at what
 * it does to the headline number. The aggregate magnitude of the V1 defect
 * (56% / 83%) was known when V2 was written -- that is what prompted the
 * review -- but no rule was tuned toward a target value, and V2 was frozen
 * before the reliability sample was coded.
 *
 * The headline impact was computed only AFTER V2 was frozen, as a consequence
 * check, and no rule was changed afterwards: corpus counts move safety_need
 * 219 -> 94 and control_visibility 70 -> 13, which shifts the gap-bucket share
 * of substantive coded instances from 51.1% to 42.0% (still the largest
 * bucket). These machine-side figures are provisional until the human-coded
 * reliability sample scores both rulesets.
 *
 * Post-freeze audit facts, recorded for the paper (measured, not acted on):
 *   - Of V2's 94 safety_need positives, 71 (76%) are carried solely by the
 *     /safe(ty)?|peace of mind|comforting|reassur/ pattern; no review matches
 *     two SAFETY_PROTECTIVE patterns at once. V2's safety_need is therefore a
 *     near-single-pattern rule. Unlike V1's family-noun dependence, this
 *     pattern comes directly from the codebook's definition wording ("peace
 *     of mind, reassurance"), so the dependence is legitimate -- but the
 *     human coding is, in effect, measuring this one pattern's precision.
 *     (Of those 71, only 3 look like "is the APP safe" rather than a
 *     person's safety.)
 *   - The found/lost-phone pattern carries 7 of the 94 alone. See below.
 *
 * V2 is RESTRICTIVE ONLY: every V2 positive is also a V1 positive. This is a
 * deliberate constraint, not a coincidence. The reliability sample is
 * stratified on V1 predictions, so a restrictive-only V2 is fully covered by
 * it; adding a trigger would put new positives in the `other` stratum, which
 * is sampled at 2.7% and could not evaluate them. Any future additive change
 * requires re-drawing the sample.
 *
 * ---------------------------------------------------------------------------
 * WHAT V2 DOES NOT CHANGE
 * ---------------------------------------------------------------------------
 * Seven of the nine codes are untouched: the codebook and V1 agree on them, or
 * the codebook is silent and there is no documented basis for a change.
 *
 * Two V1 patterns were examined and deliberately LEFT ALONE, because the
 * codebook does not speak to them and changing them would be our judgement
 * rather than the specification's:
 *
 *   - safety_need /\b(found (my|his|her) phone|lost my phone)/ — recovering a
 *     lost handset is not obviously "protecting the safety or wellbeing of a
 *     person", but the codebook neither includes nor excludes it. Left in V2.
 *     Note the side effect: dropping the family-noun patterns raises this
 *     pattern's relative weight (it alone carries 7 of V2's 94 safety_need
 *     positives). That was not an intended effect of the correction; it is
 *     retained purely because removing it would substitute our judgement for
 *     the codebook's silence. The human coding adjudicates it either way.
 *   - safety_need /\b(safe(ty)?|...)/ matches "is this app safe", which is
 *     about the app rather than a person. Also not addressed by the codebook.
 *     Left in V2; the human coding will expose it as a false positive if it is
 *     one.
 *
 * Both are listed here so that a reader can see they were considered and why
 * they were not touched.
 */

// ---------------------------------------------------------------------------
// safety_need pattern groups (shared by V1 and V2, combined differently)
// ---------------------------------------------------------------------------
export const SAFETY_PROTECTIVE = [
  /\b(safe(ty)?|peace of mind|comforting|reassur)/,
  /\b(emergenc(y|ies)|\bsos\b|911)/,
  /\b(crash (detect|alert)|accident detect)/,
  /\b(worry|worri(ed|es) about|scared|concerned)/,
  /\b(found (my|his|her) phone|lost my phone)/,
];
export const SAFETY_FAMILY = [
  /\b(child(ren)?|kid(s)?|son|daughter|teen(ager)?)/,
  /\b(elderly|grandparent|mom|dad|mother|father|parent)/,
  /\b(husband|wife|spouse|partner|boyfriend|girlfriend)/,
];

// control_visibility: patterns naming an act of control, vs bare nouns.
const CONTROL_ACTS = [
  /\b(who can see|see who|who sees)/,
  /\b(turn (it )?off|toggle|disable|pause)/,
  /\b(per[- ]contact|individual (setting|control)|granular)/,
  /\b(selective(ly)? shar|share with only|share with just)/,
  /\b(hide (from|my location)|invisible to)/,
  /\b(opt[- ]?(in|out))/,
];
const CONTROL_BARE_NOUNS = [
  // NOTE (V1 quirk, preserved untouched): the `privacy setting` alternative in
  // the first pattern is unreachable — `setting(s)?` always matches first.
  // Harmless in V1 (same code either way), documented so nobody "fixes" V1.
  /\b(setting(s)?|permission(s)?|privacy setting)/,
  /\b(notifications?|alerts? (for|when))/,
];
// "privacy setting(s)" survives into V2 because the codebook's definition
// explicitly lists "privacy settings and permissions" as control_visibility
// content — it names the control surface, unlike bare "settings". Measured
// reach: exactly ONE review in the 1,631-review corpus is decided by this
// pattern alone (every other "privacy setting" mention also matches a
// CONTROL_ACTS pattern). It is kept for spec fidelity, not for volume.
const CONTROL_PRIVACY_SETTING = [/\bprivacy setting(s)?\b/];

// Codes V1 and V2 share unchanged.
const SHARED = [
  { code: 'precision_concern', patterns: [
    /\b(approx|approximate|coars(e|er))/,
    /\b(less precise|not exact|rough location)/,
    /\b(neighbou?rhood|city[- ]level|region[- ]only)/,
    /\b(too precise|too accurate|too specific)/,
    /\b(exact location|exact address|pinpoint)/,
    /\b(down to the (inch|foot|meter|metre|house))/,
  ] },
  { code: 'monitoring_coercion', patterns: [
    /\b(controlling|control[- ]freak|possessive|jealous)/,
    /\b(stalk|stalker|stalking)/,
    /\b(spy|spying|surveillance|creep|creepy|invasive)/,
    /\b(forced to|made to|have to have|obligated|coerc)/,
    /\b(abusive|toxic (partner|relationship|parent))/,
    /\b(overbearing|helicopter (parent|mom|dad))/,
    /\b(big brother|watching me|watching my every)/,
    /\b(prison|grounded|feels like (jail|prison))/,
  ] },
  { code: 'freshness_complaint', patterns: [
    /\b(stale|outdated|not (updating|refreshing))/,
    /\b(won'?t update|doesn'?t update|never updates)/,
    /\b(delayed|delay in|lag(s|ging) behind)/,
    /\b(hours? (behind|old|stale|ago))/,
    /\b(last seen \d+)/,
    /\b(frozen (at|on)|stuck at|stuck on)/,
    /\b(real[- ]time|real time|live (location|update))/,
    /\b(keeps? loading|loading forever)/,
  ] },
  { code: 'accuracy_complaint', patterns: [
    /\b(inaccurate|inacurate|wrong location|incorrect)/,
    /\b(miles (off|away from|from where))/,
    /\b(says? (i|they|he|she) (am|are|is) (somewhere|at|in))/,
    /\b(false (arrival|departure|alert|notif|alarm))/,
    /\b(drift|drifting|keeps? moving|moves when)/,
    /\b(random (trip|location|place))/,
    /\b(says (i|they)'?m|thinks (i|they)'?m|placed me)/,
    /\b(way off|completely wrong|totally wrong)/,
  ] },
  { code: 'trust_integrity', patterns: [
    /\b(fake (location|gps|position)|spoof)/,
    /\b(lying|lied about|lies about)/,
    /\b(can'?t trust|don'?t trust|lost trust|trust issues)/,
    /\b(paus(e|ed|ing) (their )?location|ghost mode|bubble)/,
    /\b(tricks? the app|bypass|cheat the app|trick it)/,
    /\b(privacy (concern|issue|worry|violation|nightmare))/,
    /\b(data (broker|sold|sell|selling))/,
    /\b(sells? (our|your|my) (location|data))/,
    /\b(turned off without|quietly turned)/,
  ] },
  { code: 'battery_performance', patterns: [
    /\b(battery (drain|hog|killer|eater|life))/,
    /\b(drains? (my )?battery|eats? (the )?battery|battery dies)/,
    /\b(crash(es|ed|ing)?|freez(e|es|ing)|hangs?\b)/,
    /\b(slow|laggy|unresponsive|sluggish|choppy)/,
    /\b(overheats?|phone gets hot|makes my phone)/,
    /\b(buggy|bugs?\b|glitch(es|y)?|broken|doesn'?t work)/,
    /\b(won'?t load|won'?t open|keeps? crashing|force close)/,
    /\b(uninstall(ed|ing)?|reinstall(ed|ing)?)/,
  ] },
  { code: 'coordination_need', patterns: [
    /\b(pick[- ]?up|drop[- ]?off|pickup|dropoff)/,
    /\b(arrival|arrived|got there|reached|on (the|her|his) way)/,
    /\b(eta\b|estimated time|when .* arrive)/,
    /\b(meet(ing)? up|meet[- ]?up|meet(ing)? at)/,
    /\b(where (is|are|r) (you|they|he|she|my)|find (him|her|them|my friend))/,
    /\b(coordinat(e|ing|ion))/,
    /\b(share (my )?location|sharing location|sending location)/,
    /\b(glympse (to|with)|sent a glympse)/,
  ] },
];

// ---------------------------------------------------------------------------
// V1 — as published. Do not edit.
// ---------------------------------------------------------------------------
export const RULES_V1 = [
  ...SHARED,
  { code: 'safety_need', patterns: [...SAFETY_PROTECTIVE, ...SAFETY_FAMILY] },
  { code: 'control_visibility', patterns: [...CONTROL_ACTS, ...CONTROL_BARE_NOUNS] },
];

// ---------------------------------------------------------------------------
// V2 — corrected against CODEBOOK.md. Restrictive only.
//
//   safety_need         : a family noun no longer fires on its own. Protective
//                         wording is required, matching the codebook's Rule.
//   control_visibility  : bare "settings"/"permissions"/"notifications" no
//                         longer fire. An act of control is required. The one
//                         bare-noun phrase retained is "privacy setting(s)",
//                         which names the control surface rather than
//                         mentioning the app in passing. Note that turning
//                         notifications off is still caught, by the
//                         turn off / disable / pause pattern in CONTROL_ACTS.
// ---------------------------------------------------------------------------
export const RULES_V2 = [
  ...SHARED,
  { code: 'safety_need', patterns: [...SAFETY_PROTECTIVE] },
  { code: 'control_visibility', patterns: [...CONTROL_ACTS, ...CONTROL_PRIVACY_SETTING] },
];

/** Apply a ruleset to one review. Returns the codes that fired ('other' excluded). */
export function applyRules(text, rules) {
  const t = String(text).toLowerCase();
  const codes = new Set();
  for (const rule of rules) {
    for (const pat of rule.patterns) {
      if (pat.test(t)) { codes.add(rule.code); break; }
    }
  }
  return [...codes];
}

/** Sanity invariant: V2 must never fire where V1 did not. */
export function assertRestrictive(texts) {
  for (const t of texts) {
    const v1 = new Set(applyRules(t, RULES_V1));
    for (const c of applyRules(t, RULES_V2)) {
      if (!v1.has(c)) {
        throw new Error('V2 is not restrictive-only: "' + c + '" fired on a review V1 did not code that way:\n' + t);
      }
    }
  }
  return true;
}
