# EMS Quick ECG Guide

Deploy from GitHub (drag and drop does not run the analysis function).

Netlify > Site configuration > Environment variables:
- ANTHROPIC_API_KEY = your key from the Claude Console (platform.claude.com > API keys). It only ever goes here, never in a chat or email.
- APP_ACCESS_CODE   = a code your team enters once per phone
- CLAUDE_MODEL      = optional, default claude-sonnet-5: the model that reads the ECG (thorough read, second look).
                      Other readers: claude-sonnet-5-5 (the current Sonnet, same price), claude-opus-5-5 (about 2x the price)
                      or claude-fable-5-2 (about 4x the price, slower). The report shows which model read and what it cost.
                      If the key can't use the model named here, the built-in default reads and the report says so.
- CLAUDE_FAST_MODEL = optional: the model of the first (fast) read, if it should differ from CLAUDE_MODEL
- CLAUDE_EFFORT     = optional: low, medium (default), high (xhigh / max where the model has them)
- CLAUDE_FAST_EFFORT = optional: thinking level of the first (fast) read: low (default, about 20-25 s), medium (about 30+ s), high
- CLAUDE_ORIENT_MODEL = optional, default claude-haiku-5-5: the fast model for the "which way is up" photo check (the main CLAUDE_MODEL must agree with it)
- ADMIN_CODE        = optional: required to remove lessons on the Learning page

Never send temperature / top_p / top_k to the API: current Claude models answer 400 (v6.5 removed them).
When you create the API key, set Expires to "Never". An expired key cannot be switched back on; it shows as "API key rejected (401)" and every reading stops until a new key is put in.
After every update: open the app > Settings > Run system check. It tests the server files, access code,
API key, models, storage and background reader, and names the fix for anything that fails.

Clinical tool for educational and supportive use. Always correlate with clinical presentation, patient history, physical exam, and primary monitoring equipment.

## Background reads (keep reading when the phone switches apps)
- `netlify/edge-functions/read.js` (/api/read) saves each read as a job and starts it in
  `netlify/functions/read-background.mjs` (a Netlify Background Function, up to 15 minutes).
- The app checks for the result every second and again as soon as you come back to it, so the
  read finishes even if you open another app or the screen turns off.
- Photos are uploaded once per patient (as soon as they are added) and reused by every read for that
  patient (fast, double-check, thorough). They are deleted when New patient is tapped, otherwise by the
  next read after about 45 minutes. Results are deleted when the app collects them (or after 3 hours).
- If `read-background.mjs` is missing, /api/read falls back to streaming the read directly (old behaviour).
