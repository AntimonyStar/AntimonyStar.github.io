import { SAFETY_RULES } from "./safetyCatalog.js";

function getFacts(extraction) {
  const facts = new Set();

  if (!extraction) return facts;

  if (extraction.complaint_category) {
    facts.add(extraction.complaint_category);
  }

  if (extraction.onset_pattern === "sudden") {
    facts.add("sudden onset");
  }

  if (extraction.severity === "severe") {
    facts.add("severe headache");
  }

  for (const item of extraction.red_flags_present || []) {
    facts.add(item);
  }

  for (const item of extraction.associated_symptoms_present || []) {
    facts.add(item);
  }

  return facts;
}

function appliesToComplaint(rule, extraction) {
  if (!rule.appliesTo || rule.appliesTo.includes("any")) return true;
  return rule.appliesTo.includes(extraction?.complaint_category);
}

function matchesRule(rule, facts) {
  const hasAll = !rule.all || rule.all.every(item => facts.has(item));
  const hasAny = !rule.any || rule.any.some(item => facts.has(item));
  return hasAll && hasAny;
}

export function runSafetyRules(extraction, userTurnCount, hasAssessment) {
  const facts = getFacts(extraction);

  for (const rule of SAFETY_RULES) {
    if (!appliesToComplaint(rule, extraction)) continue;
    if (!matchesRule(rule, facts)) continue;

    return {
      mode: rule.mode,
      triageLevel: rule.triageLevel,
      redFlags: Array.from(facts),
      matchedRule: rule.id,
      reason: rule.reason
    };
  }

  if (hasAssessment) {
    return {
      mode: "post_assessment",
      triageLevel: "non-emergency",
      redFlags: [],
      matchedRule: null,
      reason: null
    };
  }

  if (userTurnCount <= 4) {
    return {
      mode: "intake",
      triageLevel: "unknown",
      redFlags: [],
      matchedRule: null,
      reason: null
    };
  }

  return {
    mode: "assessment",
    triageLevel: "non-emergency",
    redFlags: [],
    matchedRule: null,
    reason: null
  };
}