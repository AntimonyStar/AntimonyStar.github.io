export async function extractClinicalFacts(openai, recentMessages) {
  const extractionPrompt = `
You are a clinical information extractor.

Your job is to read the conversation and extract structured medical facts.

Return ONLY valid JSON. No explanation.

Schema:
{
  "complaint_category": string | null,
  "onset": string | null,
  "onset_pattern": "sudden" | "gradual" | "unknown",
  "severity": "mild" | "moderate" | "severe" | "unknown",
  "symptom_summary": string,
  "red_flags_present": string[],
  "associated_symptoms_present": string[],
  "associated_symptoms_absent": string[],
  "missing_critical_questions": string[],
  "possible_urgency": "low" | "moderate" | "urgent" | "emergency"
}

Rules:
- Be conservative: include a red flag if reasonably suggested.
- Normalize wording (e.g. "worst headache of life" → "worst headache of life").
- If unknown, use null or "unknown".
`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.4-nano",
    messages: [
      { role: "developer", content: extractionPrompt },
      ...recentMessages
    ],
    temperature: 0
  });

  const text = response.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Extraction JSON parse failed:", text);
    return null;
  }
}