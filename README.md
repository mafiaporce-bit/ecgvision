# EMS Quick ECG Guide

Deploy from GitHub (drag and drop does not run the analysis function).

Netlify > Site configuration > Environment variables:
- ANTHROPIC_API_KEY = your key from console.anthropic.com
- APP_ACCESS_CODE   = a code your team enters once per phone
- CLAUDE_MODEL      = optional, default claude-sonnet-5
- CLAUDE_EFFORT     = optional: low, medium (default), high
- CLAUDE_FAST_EFFORT = optional: thinking level of the first (fast) read: low (default, about 20-25 s), medium (about 30+ s), high
- CLAUDE_ORIENT_MODEL = optional, default claude-haiku-5-5: the fast model for the "which way is up" photo check (the main CLAUDE_MODEL must agree with it)
- ADMIN_CODE        = optional: required to remove lessons on the Learning page

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
