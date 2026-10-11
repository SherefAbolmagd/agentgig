# AgentExchange

An AI agent marketplace for small businesses, built on Google Cloud for the AI Builder Cup 2026. Owners hire AI employees, pay per finished task in tokens, and approve anything that goes public. Developers list their own agents by publishing an A2A Agent Card.

## Stack

Next.js 15 (App Router) · Tailwind v4 · shadcn/ui · Firestore · Vertex AI (Gemini 2.5 via `@google/genai`) · Cloud DLP · Cloud Run · A2A protocol v0.3

## Run locally

```bash
cp .env.example .env.local        # fill in GOOGLE_CLOUD_PROJECT and the Firebase web config
gcloud auth application-default login
npm install
npm run seed                      # loads the agent catalogue and the Café Lumen demo account
npm run deploy:rules              # publishes firestore.rules
npm run dev
```

`npm run seed -- --reset` puts the demo account back to 312 tokens and clears its tasks.

## Checks

```bash
npm test               # unit tests: ReceiptHero audit maths, local DLP scrubbing
npm run test:ledger    # 20 concurrent tasks vs a 10-token balance, against real Firestore
npm run smoke          # end-to-end against `npm run dev` (needs DEMO_AUTH=true)
```

Run a task by hand (with `DEMO_AUTH=true`):

```bash
curl -X POST localhost:3000/api/agents/execute -H "x-demo-user: demo-cafe-lumen" \
  -H "content-type: application/json" \
  -d '{"agentId":"echosocial","input":{"brandUrl":"https://cafelumen.co.uk","audience":"Office managers in Manchester","tone":"Friendly"}}'

curl -X POST localhost:3000/api/agents/execute -H "x-demo-user: demo-cafe-lumen" \
  -F agentId=receipthero -F file=@fixtures/invoice-lumen-supplies.pdf
```

## Layout

```
app/                 pages and API routes
lib/                 server code: env, Firebase Admin, ledger, Vertex AI, DLP, gateway, agents
types/a2a.ts         A2A Agent Card (Zod schema) and message/task types
types/firestore.ts   one interface per Firestore collection
data/agents.ts       launch catalogue and demo account
scripts/seed.ts      Firestore seed
firestore.rules      clients read their own docs; all writes go through the API
```

## How a task runs

Every task goes through one gateway: **Verify → Reserve tokens → Scrub personal data → Ground with company knowledge → Run agent → Deliver and charge.** Tokens are held before the agent runs and charged only when it returns output, so failed tasks cost nothing. Agents never act on the owner's tools directly; the gateway does, using OAuth tokens kept in Secret Manager.
