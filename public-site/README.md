# Wordless public demo

A safe, public demonstration of Wordless inside a normal customer-support chat.
The one sample account and its four evidence signals are synthetic. The conversation runs in
the visitor's browser, sends no network requests, and stores no messages.
The current demo and pilot contract are English-only.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the exact local URL printed by the command, normally
`http://localhost:3000`.

To run the full local Python evidence service and support console instead:

```bash
cd /Users/ak/Desktop/Wordless
uv run python scripts/run_wordless.py
```

## Verify

- `npm run check`: type-check the public site
- `npm test`: production-build and test the rendered Worker response
