// Live usage log (/api/usage): which phones use the app, and when.
// Holds no photos and no patient details: only the phone (model, system, browser, screen), the app
// version, an optional name the user typed in Settings, and simple events (opened, analyzed, result).
// POST  (team access code)  {dev, name, info, ev, d}  -> records the phone and the event.
// GET   ?view=1 (admin code) -> phones and the latest events, for the live view in Settings.
// PATCH (admin code)        {dev, nick}               -> set a nickname for a phone (e.g. "Ambulance 12").
import { getStore } from "@netlify/blobs";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const DEV = /^[a-z0-9]{8,24}$/;
const EVENTS = new Set(["open", "ping", "back", "photo", "analyze", "result", "error", "camera"]);
const DAY = 86400000, KEEP_DAYS = 30;
const day = (t) => new Date(t + 4 * 3600000).toISOString().slice(0, 10); // UAE date (UTC+4)

function store() {
  try { return getStore({ name: "ecg-usage", consistency: "strong" }); } catch { return getStore("ecg-usage"); }
}
const isAdmin = (req) => {
  const a = (process.env.ADMIN_CODE || "").trim();
  return !!a && (req.headers.get("x-admin-code") === a);
};

export default async (req) => {
  const st = store();
  const url = new URL(req.url);

  if (req.method === "POST") {
    const code = (process.env.APP_ACCESS_CODE || "").trim();
    if (!code || req.headers.get("x-access-code") !== code) return json({ error: "bad_code" }, 401);
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
    const dev = String(b.dev || ""), ev = String(b.ev || "");
    if (!DEV.test(dev) || !EVENTS.has(ev)) return json({ error: "bad_request" }, 400);
    const now = Date.now(), i = b.info || {};
    const old = (await st.get("dev/" + dev, { type: "json" })) || { id: dev, first: now, opens: 0, reads: 0, nick: "" };
    const rec = {
      ...old,
      name: clip(b.name, 40) || old.name || "",
      model: clip(i.model, 60) || old.model || "",
      os: clip(i.os, 40) || old.os || "",
      browser: clip(i.browser, 40) || old.browser || "",
      screen: clip(i.screen, 20) || old.screen || "",
      installed: i.installed === true,
      v: clip(i.v, 10) || old.v || "",
      last: now,
      lastEv: ev === "ping" ? old.lastEv || "open" : ev,
      opens: (old.opens || 0) + (ev === "open" ? 1 : 0),
      reads: (old.reads || 0) + (ev === "result" ? 1 : 0),
    };
    const writes = [st.setJSON("dev/" + dev, rec)];
    if (ev !== "ping") {
      const d = b.d && typeof b.d === "object" ? b.d : {};
      const e = { t: now, dev, ev, d: { decision: clip(d.decision, 12), secs: Math.max(0, Math.min(900, Number(d.secs) || 0)), mode: clip(d.mode, 10), double: d.double === true, msg: clip(d.msg, 80) } };
      writes.push(st.setJSON("ev/" + day(now) + "/" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 7), e));
    }
    await Promise.all(writes);
    return json({ ok: true });
  }

  if (!isAdmin(req)) return json({ error: (process.env.ADMIN_CODE || "").trim() ? "bad_admin_code" : "no_admin_code" }, 403);

  if (req.method === "PATCH") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
    const dev = String(b.dev || "");
    if (!DEV.test(dev)) return json({ error: "bad_request" }, 400);
    const rec = await st.get("dev/" + dev, { type: "json" });
    if (!rec) return json({ error: "not_found" }, 404);
    rec.nick = clip(b.nick, 40);
    await st.setJSON("dev/" + dev, rec);
    return json({ ok: true });
  }

  if (req.method === "GET" && url.searchParams.get("view")) {
    const now = Date.now();
    const [{ blobs: devKeys }, { blobs: today }, { blobs: yday }] = await Promise.all([
      st.list({ prefix: "dev/" }),
      st.list({ prefix: "ev/" + day(now) + "/" }),
      st.list({ prefix: "ev/" + day(now - DAY) + "/" }),
    ]);
    const devices = (await Promise.all(devKeys.slice(0, 300).map((b) => st.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean).sort((a, b) => b.last - a.last);
    const evKeys = today.concat(yday).map((b) => b.key).sort().reverse().slice(0, 150);
    const events = (await Promise.all(evKeys.map((k) => st.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
    const todayStats = { events: today.length, phones: new Set(), results: 0 };
    // Count today's phones and readings from the newest 150 events (enough for a team).
    events.filter((e) => day(e.t) === day(now)).forEach((e) => { todayStats.phones.add(e.dev); if (e.ev === "result") todayStats.results++; });
    // Remove events older than 30 days now and then.
    if (Math.random() < 0.1) {
      try {
        const { blobs } = await st.list({ prefix: "ev/" });
        const cut = day(now - KEEP_DAYS * DAY);
        await Promise.all(blobs.filter((b) => b.key.slice(3, 13) < cut).slice(0, 300).map((b) => st.delete(b.key)));
      } catch {}
    }
    return json({ now, devices, events, today: { phones: todayStats.phones.size, results: todayStats.results, events: todayStats.events } });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/usage" };
