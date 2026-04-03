export const SAFETY_RULES = [
  {
    id: "stroke_emergency",
    appliesTo: ["any"],
    mode: "emergency",
    triageLevel: "emergency",
    any: ["face droop", "speech difficulty", "one-sided weakness", "sudden confusion"],
    reason: "possible stroke symptoms"
  },

  {
    id: "chest_pain_emergency",
    appliesTo: ["chest_pain"],
    mode: "emergency",
    triageLevel: "emergency",
    all: ["chest pressure", "shortness of breath"],
    reason: "high-risk chest pain pattern"
  },

  {
    id: "headache_immediate_emergency",
    appliesTo: ["headache"],
    mode: "emergency",
    triageLevel: "emergency",
    any: ["worst headache of life"],
    reason: "sudden severe headache red flag"
  },

  {
    id: "headache_critical_questions",
    appliesTo: ["headache"],
    mode: "critical_questions",
    triageLevel: "urgent",
    all: ["sudden onset", "severe headache"],
    reason: "concerning headache pattern"
  }
];