export function deriveChiefComplaint(text = "") {
  const t = text.toLowerCase();

  if (t.includes("chest")) return "chest_pain";
  if (t.includes("breath") || t.includes("cough")) return "respiratory";
  if (t.includes("headache")) return "headache";
  if (t.includes("stomach") || t.includes("abdominal") || t.includes("belly")) {
    return "abdominal_pain";
  }
  if (t.includes("fever")) return "fever_infection";

  return "general";
}

export function runTriageController(encounter, latestMessage) {
  const text = latestMessage.toLowerCase();
  const redFlags = [];

  if (
    text.includes("can't breathe") ||
    text.includes("cannot breathe") ||
    text.includes("severe shortness of breath")
  ) {
    redFlags.push("severe_breathing_problem");
  }

  if (
    text.includes("chest pain") ||
    text.includes("chest pressure")
  ) {
    redFlags.push("high_risk_chest_symptom");
  }

  if (
    text.includes("stroke") ||
    text.includes("face droop") ||
    text.includes("one-sided weakness") ||
    text.includes("trouble speaking")
  ) {
    redFlags.push("possible_stroke");
  }

  if (
    text.includes("unconscious") ||
    text.includes("passed out") ||
    text.includes("seizure")
  ) {
    redFlags.push("loss_of_consciousness_or_seizure");
  }

  if (
    text.includes("severe bleeding") ||
    text.includes("bleeding won't stop")
  ) {
    redFlags.push("severe_bleeding");
  }

  if (redFlags.length > 0) {
    return {
      triageLevel: "emergency",
      redFlags,
      reply:
        "⚠️ This may need emergency care now. Call emergency services or go to the nearest emergency department immediately."
    };
  }

  if (
    text.includes("fever") &&
    (text.includes("shortness of breath") || text.includes("breathing"))
  ) {
    return {
      triageLevel: "urgent",
      redFlags: [],
      reply: null
    };
  }

  return {
    triageLevel: "needs_more_info",
    redFlags: [],
    reply: null
  };
}