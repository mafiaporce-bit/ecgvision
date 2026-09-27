const json = (o, s) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const code = process.env.APP_ACCESS_CODE;
  if (!code || req.headers.get("x-access-code") !== code) return json({ error: "bad_code" }, 401);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "no_key" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { prompt, images } = body || {};
  if (typeof prompt !== "string" || prompt.length > 20000) return json({ error: "bad_request" }, 400);
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) return json({ error: "bad_request" }, 400);
  for (const im of images) if (!im || !TYPES.has(im.media_type) || typeof im.data !== "string") return json({ error: "bad_request" }, 400);

  const content = [
    ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
    { type: "text", text: prompt },
  ];

  const up = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-5", max_tokens: 3500, stream: true, messages: [{ role: "user", content }] }),
  });
  if (!up.ok) return json({ error: "upstream", status: up.status, detail: (await up.text()).slice(0, 300) }, 502);
  return new Response(up.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
};

export const config = { path: "/api/analyze" };
