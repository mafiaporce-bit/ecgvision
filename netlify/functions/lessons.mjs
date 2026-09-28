// Learning store: ACP/physician-reviewed lessons, plus an anonymous usage and validation log.
// Lessons only guide how ECGs are measured; activation criteria stay in the app's protocol code.
// The log holds no photos and no patient details: only the app's decision and the reviewer's confirmed answer.
import { getStore } from "@netlify/blobs";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const LEADS = new Set(["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]);
const MAX_LESSONS = 60, MAX_LOG = 2000;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export default async (req) => {
  const code = process.env.APP_ACCESS_CODE;
  if (!code || req.headers.get("x-access-code") !== code) return json({ error: "bad_code" }, 401);

  const store = getStore("ecg-learning");
  const doc = (await store.get("doc", { type: "json" })) || { lessons: [], stats: { correct: 0, corrected: 0 } };
  const log = (await store.get("log", { type: "json" })) || { entries: [] };

  if (req.method === "GET") return json({ ...doc, log: log.entries });

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

    if (b.verdict === "log") {
      const e = b.entry || {};
      const entry = {
        id: newId(), date: new Date().toISOString(),
        decision: ["met", "consult", "not_met"].includes(e.decision) ? e.decision : "consult",
        criterion: clip(e.criterion, 80), conf: Math.max(0, Math.min(100, Number(e.conf) || 0)),
        omi: Array.isArray(e.omi) ? e.omi.slice(0, 12).map((x) => clip(x, 40)) : [],
        double: !!e.double, secs: Math.max(0, Math.min(600, Number(e.secs) || 0)), missing: Math.max(0, Math.min(12, Number(e.missing) || 0)),
        ref: "", review: "",
      };
      log.entries.push(entry);
      if (log.entries.length > MAX_LOG) log.entries = log.entries.slice(-MAX_LOG);
      await store.set("log", JSON.stringify(log));
      return json({ ok: true, id: entry.id });
    }

    if (b.verdict === "reference") {
      const e = log.entries.find((x) => x.id === b.id);
      if (!e) return json({ error: "not_found" }, 404);
      if (!["stemi", "not_stemi", "omi"].includes(b.ref)) return json({ error: "bad_request" }, 400);
      e.ref = b.ref;
      await store.set("log", JSON.stringify(log));
      return json({ ok: true });
    }

    if (b.verdict === "correct") {
      doc.stats.correct = (doc.stats.correct || 0) + 1;
    } else if (b.verdict === "corrected") {
      const l = b.lesson || {};
      if (l.reviewed !== true || clip(l.text, 300).length < 5) return json({ error: "Lesson must be reviewed and describe the error." }, 400);
      doc.lessons.push({
        id: newId(), date: new Date().toISOString(),
        text: clip(l.text, 300), final: clip(l.final, 200),
        leads: Array.isArray(l.leads) ? l.leads.filter((x) => LEADS.has(x)) : [],
        role: ["ACP", "Physician", "Paramedic"].includes(l.role) ? l.role : "ACP",
        app_reading: clip(b.reading, 240),
      });
      if (doc.lessons.length > MAX_LESSONS) doc.lessons = doc.lessons.slice(-MAX_LESSONS);
      doc.stats.corrected = (doc.stats.corrected || 0) + 1;
    } else return json({ error: "bad_request" }, 400);

    if (b.logId) { const e = log.entries.find((x) => x.id === b.logId); if (e) { e.review = b.verdict; await store.set("log", JSON.stringify(log)); } }
    await store.set("doc", JSON.stringify(doc));
    return json({ ok: true, stats: doc.stats });
  }

  if (req.method === "DELETE") {
    const admin = process.env.ADMIN_CODE;
    if (admin && req.headers.get("x-admin-code") !== admin && req.headers.get("x-access-code") !== admin) return json({ error: "Only an admin can remove lessons." }, 403);
    const id = new URL(req.url).searchParams.get("id");
    doc.lessons = doc.lessons.filter((x) => x.id !== id);
    await store.set("doc", JSON.stringify(doc));
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/lessons" };
