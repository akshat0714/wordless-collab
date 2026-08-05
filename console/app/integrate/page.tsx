import type { Metadata } from "next";

export const metadata: Metadata = { title: "Integrate" };

const steps = [
  {
    number: "1",
    title: "Pass every message through",
    body: "Your server sends the customer’s message plus current, read-only account evidence to Wordless.",
  },
  {
    number: "2",
    title: "Follow one host action",
    body: "Show a supported reply or short choices. When Wordless abstains, continue your existing chatbot.",
  },
  {
    number: "3",
    title: "Continue the conversation",
    body: "Record the customer’s choice, then let your normal support flow handle the next step.",
  },
];

const modes = [
  {
    title: "Normal messages",
    body: "Greetings, receipts, returns, and human handoffs continue through the support bot you already use.",
  },
  {
    title: "Short or unclear messages",
    body: "Wordless can clarify duplicate charges, late deliveries, wrong items, and account locks from evidence.",
  },
  {
    title: "No full sentence needed",
    body: "A universal I don’t know what to say action can compose a supported turn from account evidence alone.",
  },
];

const serverExample = `import {
  createSupportChatbotAdapter,
  createWordlessClient,
} from "@wordless/sdk/server";

const wordless = createSupportChatbotAdapter({
  client: createWordlessClient({
    baseUrl: process.env.WORDLESS_BASE_URL!,
    apiKey: process.env.WORDLESS_API_KEY!,
    signingSecret: process.env.WORDLESS_SIGNING_SECRET!,
  }),
  sourceSystem: "company-support-bot",
});

const turn = await wordless.processMessage({
  messageId: incoming.id,
  customerId: incoming.customerId,
  text: incoming.text,
  sentAt: incoming.receivedAt,
  evidence: await loadAccountEvidence(incoming.customerId),
  showChoices: incoming.requestedChoices,
});`;

const browserExample = `if (turn.hostAction === "continue_host_bot") {
  return existingBot.respond(incoming);
}

if (turn.renderMode === "choices") {
  return chat.sendChoices(turn.message, turn.choices);
}

return chat.sendMessage(turn.message);`;

export default function IntegratePage() {
  return (
    <div className="integrate-page">
      <header className="integration-hero">
        <p className="product-eyebrow">Chatbot middleware</p>
        <h1>Keep your support bot. Add clearer communication.</h1>
        <p>
          Wordless runs before each chatbot turn. It adds evidence-backed words when useful and
          gets out of the way when your normal bot should answer.
        </p>
      </header>

      <section aria-labelledby="integration-steps-heading" className="integration-section">
        <div className="integration-section-heading">
          <h2 id="integration-steps-heading">Three steps</h2>
          <p>Your chatbot → Wordless → your existing response flow</p>
        </div>
        <ol className="integration-steps">
          {steps.map((step) => (
            <li key={step.number}>
              <span aria-hidden="true">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <aside className="secret-callout" aria-labelledby="secrets-heading">
        <div aria-hidden="true" className="secret-mark">
          ✓
        </div>
        <div>
          <h2 id="secrets-heading">Secrets stay on your server</h2>
          <p>
            API keys and request signing never enter the browser. Your interface receives only a
            bounded instruction: show choices, show a message, or continue the host bot.
          </p>
        </div>
      </aside>

      <section aria-labelledby="integration-code-heading" className="integration-code">
        <div>
          <p className="product-eyebrow">Your backend</p>
          <h2 id="integration-code-heading">One middleware call per message</h2>
          <p>
            The adapter is not tied to React, Next.js, a chatbot vendor, or a transport. Map its
            host action to the interface you already have.
          </p>
        </div>
        <div className="integration-code-examples">
          <div>
            <span>Server</span>
            <pre aria-label="Node.js server integration example">
              <code>{serverExample}</code>
            </pre>
          </div>
          <div>
            <span>Your chatbot</span>
            <pre aria-label="Chatbot host-action integration example">
              <code>{browserExample}</code>
            </pre>
          </div>
        </div>
      </section>

      <section aria-labelledby="integration-modes-heading" className="integration-section">
        <div className="integration-section-heading">
          <h2 id="integration-modes-heading">One flow, three kinds of turn</h2>
          <p>Ordinary support remains ordinary</p>
        </div>
        <div className="integration-modes">
          {modes.map((mode) => (
            <article key={mode.title}>
              <h3>{mode.title}</h3>
              <p>{mode.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="pilot-callout" aria-labelledby="pilot-heading">
        <p className="product-eyebrow">Available now</p>
        <h2 id="pilot-heading">A controlled paid pilot</h2>
        <p>
          Start with duplicate charges, late deliveries, wrong items, and account locks. Keep every
          action read-only until the customer confirms and your normal support workflow takes over.
        </p>
      </section>
    </div>
  );
}
