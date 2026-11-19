// Background ECG read (Netlify Background Function, runs up to 15 minutes).
// Started by netlify/edge-functions/read.js. It reads the saved request, asks Claude, and saves the
// report so the phone can collect it later, even if the user switched to another app meanwhile.
// It never throws: Netlify retries failed background runs, which would charge the read twice.
//
// 6.5: no sampling settings are sent (current models reject temperature / top_p / top_k with a 400).
// The result now also says which model answered, how hard it was asked to think and how many tokens it used.
// If the key can't use the chosen model, or the model declines, the read is made once more on the fallback model.
import { getStore } from "@netlify/blobs";

const ID = /^[a-z0-9]{6,12}-[a-z0-9]{4,16}$/;
const HOURS = 3600000;
const API = "https://api.anthropic.com/v1/messages";

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

// Read one streamed answer. Every 3 seconds it checks whether the phone asked to stop (Stop / New patient).
async function readAnswer(up, st, id, ctl) {
  const reader = up.body.getReader(), dec = new TextDecoder();
  const out = { text: "", stopped: false, stop: "", errType: "", cancelled: false, model: "", usage: { in: 0, out: 0 } };
  let buf = "", writing = false, lastCheck = Date.now();
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
        out.text += ev.delta.text;
        if (!writing) { writing = true; st.setJSON("w/" + id, { phase: "writing" }).catch(() => {}); }
      } else if (ev.type === "message_start" && ev.message) {
        out.model = ev.message.model || "";
        const u = ev.message.usage || {};
        out.usage.in = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      } else if (ev.type === "message_delta") {
        if (ev.delta && ev.delta.stop_reason) out.stop = ev.delta.stop_reason;
        if (ev.usage && ev.usage.output_tokens) out.usage.out = ev.usage.output_tokens;
      } else if (ev.type === "message_stop") out.stopped = true;
      else if (ev.type === "error") out.errType = (ev.error && ev.error.type) || "error";
    }
    if (Date.now() - lastCheck > 3000) {
      lastCheck = Date.now();
      if (await st.get("x/" + id).catch(() => null)) { ctl.abort(); out.cancelled = true; return out; }
    }
  }
  return out;
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
    const base = job.payload || job;
    // (6.9: an upload is stored as it arrived, { upload, images }; older uploads are the bare list.)
    const saved = job.img ? await st.get("img/" + job.img, { type: "json" }) : job.images;
    const images = Array.isArray(saved) ? saved : saved && Array.isArray(saved.images) ? saved.images : null;
    const okImage = (im) => im && typeof im.data === "string" && im.data.length > 0 && /^image\/(jpeg|png|webp|gif)$/.test(im.media_type);
    if (!images || !images.length || images.length > 5 || !images.every(okImage)) return finish({ status: "error", error: "img_missing" });
    for (const m of base.messages)
      m.content = m.content.flatMap((b) => (b.type === "images_ref" ? images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })) : [b]));
    const key = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!key) return finish({ status: "error", error: "no_key" });

    const ctl = new AbortController();
    tAI = Date.now();
    const call = (p) => fetch(API, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ ...p, stream: true }),
      signal: ctl.signal,
    });
    // Sampling settings are never sent, even if an older read.js queued them.
    let { temperature, top_p, top_k, ...p } = base;
    const alt = typeof job.alt === "string" && job.alt && job.alt !== p.model ? job.alt : "";
    const note = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const up = await call(p);
      if (!up.ok) {
        const status = up.status, txt = await up.text();
        // A thinking level this model doesn't have: step down to "high", then to the model's own default.
        if (status === 400 && p.output_config && /effort|output_config/i.test(txt)) {
          if (["xhigh", "max"].includes(p.output_config.effort)) { p = { ...p, output_config: { effort: "high" } }; note.push("effort_high"); }
          else { const { output_config, ...rest } = p; p = rest; note.push("effort_default"); }
          continue;
        }
        // This key can't use the chosen model: read with the fallback model instead (the app says which one read).
        if (alt && p.model !== alt && (status === 404 || status === 403 || (status === 400 && /model/i.test(txt)))) { p = { ...p, model: alt }; note.push("model_fallback"); continue; }
        return finish({ status: "error", error: "upstream", http: status, detail: txt.slice(0, 300), model: p.model });
      }
      await st.setJSON("w/" + id, { phase: "thinking" });
      const r = await readAnswer(up, st, id, ctl);
      if (r.cancelled) return finish({ status: "error", error: "cancelled" });
      if (r.errType) return finish({ status: "error", error: r.errType === "overloaded_error" ? "rate_limited" : "server", detail: r.errType });
      if (r.stop === "refusal") {
        if (alt && p.model !== alt) { p = { ...p, model: alt }; note.push("refusal_fallback"); continue; }
        return finish({ status: "error", error: "refused", model: p.model });
      }
      if (!r.stopped) return finish({ status: "error", error: "timeout" });
      // Thinking used up the whole answer space before the report was written.
      if (r.stop === "max_tokens" && r.text.lastIndexOf("}") < 0) return finish({ status: "error", error: "too_long", model: p.model });
      return finish({ status: "done", text: r.text, model: r.model || p.model, asked: base.model, effort: p.output_config ? p.output_config.effort : "", usage: r.usage, note });
    }
    return finish({ status: "error", error: "server", detail: "too many retries" });
  } catch (e) {
    if (e && e.name === "AbortError") return finish({ status: "error", error: "cancelled" });
    return finish({ status: "error", error: "server", detail: String((e && e.message) || e).slice(0, 200) });
  } finally {
    try { await st.delete("x/" + id); } catch {}
    await cleanup(st);
  }
};
