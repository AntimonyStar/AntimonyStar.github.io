import express from "express";
import { DOCTOR_CONTRACT } from "../config/constants.js";
import { extractClinicalFacts } from "../services/clinicalExtractor.js";
import { runSafetyRules } from "../services/safetyRules.js";

function makeConversationTitle(message) {
  let title = message.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (title.length > 60) title = title.slice(0, 60).trim() + "...";
  return title || "New consultation";
}

const router = express.Router();

function looksLikeAssessment(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("assessment") ||
    t.includes("possible") ||
    t.includes("likely") ||
    t.includes("next steps") ||
    t.includes("what to do next")
  );
}

function getModeInstructions(mode, extraction, userTurnCount) {
  if (mode === "emergency") {
    return `
- You are in emergency mode.
- Do NOT continue normal intake.
- Clearly explain that the symptoms may need emergency care now.
- State the red flags briefly.
- Tell the user what to do now.
- Do NOT ask routine follow-up questions.
- You may ask at most 1 final question only if it changes immediate safety advice.
- Be direct and concise.
`;
  }

  if (mode === "intake") {
    return `
- You are in intake mode.
- This is still early intake.
- DO NOT provide an assessment yet.
- DO NOT use the word "Assessment".
- Ask exactly 1 to 2 focused follow-up questions.
- Focus on onset, severity, associated symptoms, and red flags.
- Be concise.
`;
  }

  if (mode === "assessment") {
    return `
- You are in assessment mode.
- Provide a brief assessment.
- Give possible explanations, not a diagnosis.
- Suggest next steps.
- Ask at most 1 focused follow-up question only if truly needed.
- Be concise.
`;
  }

  if (mode === "post_assessment") {
    return `
- An assessment has already been given earlier.
- Do NOT restart full intake.
- Answer the user's question directly like a doctor.
- Be conversational and clear.
- Only ask a follow-up question if it is directly necessary.
- Be concise.
`;
  }
  if (mode === "critical_questions") {
  return `
- You are in critical question mode.
- Do NOT give a full assessment yet.
- Ask exactly 1 critical yes/no question that would change urgency.
- Be concise.
- Do NOT use the word "Assessment".
`;
}

  return `
- Continue focused intake.
- Ask at most 1 focused follow-up question.
- Be concise.
`;
}

function buildEmergencyReply(extraction, redFlags) {
  const summary = extraction?.symptom_summary || "There are concerning symptoms.";
  const flags = redFlags?.length ? redFlags.join(", ") : "serious warning signs";

  return `⚠️ This may need emergency care now.

What is concerning:
- ${summary}

Red flags:
- ${flags}

You should seek emergency care now or call emergency services.
Do not drive yourself if you feel faint, confused, weak, or your vision is affected.`;
}

export default function chatRoutes(pool, openai, getOrCreateDbUser, requiresAuth) {
  router.post("/:conversationId/messages", requiresAuth(), async (req, res) => {
    const routeStart = process.hrtime.bigint();

    try {
      const conversationId = Number(req.params.conversationId);
      const message = (req.body.message || "").trim();

      if (!conversationId || !message) {
        return res.status(400).json({ error: "Missing conversationId or message" });
      }

      const userId = await getOrCreateDbUser(req);

      const convoCheck = await pool.query(
        `SELECT id, title
         FROM conversations
         WHERE id = $1 AND user_id = $2`,
        [conversationId, userId]
      );

      if (!convoCheck.rows.length) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      await pool.query(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, 'user', $2)`,
        [conversationId, message]
      );

      const history = await pool.query(
        `SELECT role, content
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [conversationId]
      );

      const recentMessages = history.rows.reverse();
      const userTurnCount = recentMessages.filter(m => m.role === "user").length;

      const hasAssessment = recentMessages.some(
        m => m.role === "assistant" && looksLikeAssessment(m.content)
      );

      // STEP 1: Extract structured clinical facts from recent conversation
      const extraction = await extractClinicalFacts(openai, recentMessages);

      console.log("clinical extraction:", extraction);

      // STEP 2: Run deterministic safety rules on extracted facts
      const safety = runSafetyRules(extraction, userTurnCount, hasAssessment);

      console.log("safety decision:", safety);

      // STEP 3: Emergency short-circuit
      if (safety.mode === "emergency") {
        const reply = buildEmergencyReply(extraction, safety.redFlags);

        await pool.query(
          `INSERT INTO messages (conversation_id, role, content)
           VALUES ($1, 'assistant', $2)`,
          [conversationId, reply]
        );

        return res.json({
          reply,
          triageLevel: safety.triageLevel,
          redFlags: safety.redFlags
        });
      }

      // STEP 4: Normal doctor reply with stage-specific instructions
      const modeInstructions = getModeInstructions(
        safety.mode,
        extraction,
        userTurnCount
      );

      const structuredContext = `
${DOCTOR_CONTRACT}

Extracted facts:
- Complaint category: ${extraction?.complaint_category ?? "unknown"}
- Symptom summary: ${extraction?.symptom_summary ?? "unknown"}
- Onset: ${extraction?.onset ?? "unknown"}
- Onset pattern: ${extraction?.onset_pattern ?? "unknown"}
- Severity: ${extraction?.severity ?? "unknown"}
- Red flags present: ${(extraction?.red_flags_present || []).join(", ") || "none"}
- Associated symptoms present: ${(extraction?.associated_symptoms_present || []).join(", ") || "none"}
- Associated symptoms absent: ${(extraction?.associated_symptoms_absent || []).join(", ") || "none"}
- Missing critical questions: ${(extraction?.missing_critical_questions || []).join(", ") || "none"}
- Possible urgency: ${extraction?.possible_urgency ?? "unknown"}
- User turn count: ${userTurnCount}
- Prior assessment already given: ${hasAssessment ? "yes" : "no"}
- Current mode: ${safety.mode}

Rules for this turn:
${modeInstructions}

General rules:
- Do not diagnose.
- Do not prescribe.
- Do not state final triage as your own decision unless emergency mode has already been triggered by the safety layer.
- Be concise.
`;

      console.log("history rows:", recentMessages.length);
      console.log(
        "approx chars:",
        structuredContext.length +
          recentMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0)
      );

      const aiStart = process.hrtime.bigint();

      const completion = await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages: [
          { role: "developer", content: structuredContext },
          ...recentMessages
        ],
        max_completion_tokens: 600
      });

      const aiMs = Number(process.hrtime.bigint() - aiStart) / 1e6;
      console.log(`OpenAI call: ${aiMs.toFixed(1)} ms`);

      let reply =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Could you tell me a bit more about when this started and how severe it is?";

      await pool.query(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, 'assistant', $2)`,
        [conversationId, reply]
      );

      const currentTitle = convoCheck.rows[0].title || "";
      if (currentTitle === "New consultation") {
        const autoTitle = makeConversationTitle(message);

        await pool.query(
          `UPDATE conversations
           SET title = $1, updated_at = NOW()
           WHERE id = $2 AND user_id = $3`,
          [autoTitle, conversationId, userId]
        );
      }

      const totalMs = Number(process.hrtime.bigint() - routeStart) / 1e6;
      console.log(`TOTAL POST ${req.originalUrl}: ${totalMs.toFixed(1)} ms`);

      res.json({
        reply,
        triageLevel: safety.triageLevel,
        redFlags: safety.redFlags
      });
    } catch (err) {
      console.error("Chat route failed:", err);
      res.status(500).json({
        error: "AI request failed",
        details: err.message
      });
    }
  });

  return router;
}