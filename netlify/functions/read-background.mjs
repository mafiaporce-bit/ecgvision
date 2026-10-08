// Background ECG read (Netlify Background Function, runs up to 15 minutes).
// Started by netlify/edge-functions/read.js. It reads the saved request, asks Claude, and saves the
// report so the phone can collect it later, even if the user switched to another app meanwhile.
// It never throws: Netlify retries failed background runs, which would charge the read twice.
import { getStore } from "@netlify/blobs";

const ID = /^[a-z0-9]{6,12}-[a-z0-9]{4,16}$/;
const HOURS = 3600000;

function jobs() {
  try { return getStore({ name: "ecg-jobs", consistency: "strong" }); } catch { return getStore("ecg-jobs"); }
}

// Remove old results and leftovers (results at most 3 hours; photos about 45 minutes, or sooner when
// the app taps New patient).
async function cleanup(st) {
  try {
    const now = Date.now();
    const age = (k) => now - parseInt((k.split("/")[1] || "").split("-")[0], 36);
    const { blobs } = await st.list();
    const old = blobs.filter((b) => {
      const a = age(b.key);
      if (!Number.isFinite(a)) return false;
      return b.key.startsWith("in/") ? a > 0.5 * HOURS : b.key.startsWith("img/") ? a > 0.75 * HOURS : a > 3 * HOURS;
    });
    await Promise.all(old.slice(0, 200).map((b) => st.delete(b.key)));
  } catch {}
}

export default async (req) => {
  let b;
  try { b = await req.json(); } catch { return; }
  if (!b || b.warm) return;
  const code = (process.env.APP_ACCESS_CODE || "").trim();
  if (!code || req.headers.get("x-access-code") !== code) return;
  const id = String(b.id || "");
  if (!ID.test(id)) return;

  const st = jobs();
  const t0 = Date.now(), sent = parseInt(id.split("-")[0], 36);
  let tAI = 0;
  // Timings (ms): queue = phone's job saved -> this function started; ai = Claude's reading time.
  const finish = async (o) => {
    const t = Date.now();
    try { await st.setJSON("done/" + id, { ...o, ms: { queue: Math.max(0, t0 - sent), ai: tAI ? t - tAI : 0, total: Math.max(0, t - sent) } }); } catch {}
  };
  try {
    const job = await st.get("in/" + id, { type: "json" });
    await st.delete("in/" + id);
    if (!job) return finish({ status: "error", error: "lost" });
    // The photos are saved once per patient (img/...) and swapped in here.
    const payload = job.payload || job;
    const images = job.img ? await st.get("img/" + job.img, { type: "json" }) : job.images;
    if (!images) return finish({ status: "error", error: "img_missing" });
    for (const m of payload.messages)
      m.content = m.content.flatMap((b) => (b.type === "images_ref" ? images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })) : [b]));
    const key = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!key) return finish({ status: "error", error: "no_key" });

    const ctl = new AbortController();
    tAI = Date.now();
    const up = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ctl.signal,
    });
    if (!up.ok) return finish({ status: "error", error: "upstream", http: up.status, detail: (await up.text()).slice(0, 300) });
    await st.setJSON("w/" + id, { phase: "thinking" });

    const reader = up.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "", stopped = false, writing = false, errType = "", lastCheck = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          text += ev.delta.text;
          if (!writing) { writing = true; st.setJSON("w/" + id, { phase: "writing" }).catch(() => {}); }
        } else if (ev.type === "message_stop") stopped = true;
        else if (ev.type === "error") errType = (ev.error && ev.error.type) || "error";
      }
      // Every 3 seconds, check whether the phone asked to stop (Stop / New patient).
      if (Date.now() - lastCheck > 3000) {
        lastCheck = Date.now();
        if (await st.get("x/" + id).catch(() => null)) {
          ctl.abort();
          return finish({ status: "error", error: "cancelled" });
        }
      }
    }
    if (errType) return finish({ status: "error", error: errType === "overloaded_error" ? "rate_limited" : "server" });
    if (!stopped) return finish({ status: "error", error: "timeout" });
    return finish({ status: "done", text });
  } catch (e) {
    if (e && e.name === "AbortError") return finish({ status: "error", error: "cancelled" });
    return finish({ status: "error", error: "server", detail: String((e && e.message) || e).slice(0, 200) });
  } finally {
    try { await st.delete("x/" + id); } catch {}
    await cleanup(st);
  }
};
