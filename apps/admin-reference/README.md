# Neutral admin reference

This application is deliberately plain. It provides a local operations surface for diagnostics, queued jobs, holds, and review cases through the reference API. Product moderation policy, authorization, escalation, notifications, and commercial workflows are supplied by private extensions.

Run `npm run dev:reference-api` and then `npm run dev:reference-admin` from the repository root. It listens on `http://127.0.0.1:4174` and proxies `/api/*` to `http://127.0.0.1:4100` by default. Set `UBEEQ_REFERENCE_API_URL` to point it elsewhere.
