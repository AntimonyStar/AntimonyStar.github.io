import express from "express";

const router = express.Router();

export default function conversationsRoutes(pool, getOrCreateDbUser, requiresAuth) {

  router.get("/", requiresAuth(), async (req, res) => {
    const userId = await getOrCreateDbUser(req);

    const r = await pool.query(
      `SELECT id, title, last_message_preview, updated_at
       FROM conversations
       WHERE user_id=$1
       ORDER BY updated_at DESC`,
      [userId]
    );

    res.json(r.rows);
  });

  router.post("/", requiresAuth(), async (req, res) => {
    const userId = await getOrCreateDbUser(req);
    const title = req.body?.title || "New consultation";

    const r = await pool.query(
      `INSERT INTO conversations (user_id, title)
       VALUES ($1,$2)
       RETURNING id,title`,
      [userId, title]
    );

    res.json(r.rows[0]);
  });

  router.get("/:id/messages", requiresAuth(), async (req, res) => {
  const routeStart = process.hrtime.bigint();

  try {
    const t1 = process.hrtime.bigint();
    const userId = await getOrCreateDbUser(req);
    const t2 = process.hrtime.bigint();
    console.log("getOrCreateDbUser:", (Number(t2 - t1) / 1e6).toFixed(1), "ms");

    const convoId = Number(req.params.id);

    const t3 = process.hrtime.bigint();
    const ownerCheck = await pool.query(
      `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
      [convoId, userId]
    );
    const t4 = process.hrtime.bigint();
    console.log("ownership check:", (Number(t4 - t3) / 1e6).toFixed(1), "ms");

    if (!ownerCheck.rows.length) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const t5 = process.hrtime.bigint();
    const msgs = await pool.query(
      `SELECT id, role, content, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [convoId]
    );
    const t6 = process.hrtime.bigint();
    console.log("load messages query:", (Number(t6 - t5) / 1e6).toFixed(1), "ms");

    const routeEnd = process.hrtime.bigint();
    console.log(
      `TOTAL ${req.method} ${req.originalUrl}: ${(Number(routeEnd - routeStart) / 1e6).toFixed(1)} ms`
    );

    res.json(msgs.rows);
  } catch (err) {
    console.error("Load messages failed:", err);
    res.status(500).json({ error: err.message });
  }
});

  router.patch("/:id", requiresAuth(), async (req, res) => {
  try {
    const userId = await getOrCreateDbUser(req);
    const conversationId = Number(req.params.id);
    const title = String(req.body?.title || "").trim();

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, title, updated_at`,
      [title, conversationId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Rename conversation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

  router.delete("/:id", requiresAuth(), async (req, res) => {
  try {
    const userId = await getOrCreateDbUser(req);
    const conversationId = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM conversations
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [conversationId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({ success: true, id: conversationId });
  } catch (err) {
    console.error("Delete conversation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

  return router;
}

