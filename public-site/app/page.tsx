import { WordlessDemo } from "./wordless-demo";

const integrationExample = `const turn = await wordless.processMessage({
  messageId: incoming.id,
  customerId: incoming.customerId,
  text: incoming.text,
  sentAt: incoming.receivedAt,
  channel: "chat",
  evidence: await loadCurrentEvidence(incoming.customerId),
});

if (turn.hostAction === "continue_host_bot") {
  return existingBot.respond(incoming);
}

return chat.render(turn);`;

export default function Home() {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Wordless home">
          Wordless
        </a>
        <nav aria-label="Main navigation">
          <a href="#demo">Try it</a>
          <a href="#how-it-works">How it works</a>
          <a href="#integrate">Integrate</a>
        </nav>
      </header>

      <main id="main-content">
        <section className="hero" id="top">
          <p className="eyebrow">Accessible customer support</p>
          <h1>Support that helps you find the words.</h1>
          <p className="hero-copy">
            Wordless adds communication assistance to an ordinary support chat. A customer can
            use a sentence, a fragment, misspellings, or no words at all. When a configured issue
            matches company-provided account state, Wordless offers short choices; everything
            else stays with the company&apos;s normal bot.
            It is designed with aphasia-related word-finding barriers in mind and available to everyone.
          </p>
          <div className="hero-actions">
            <a className="primary-link" href="#demo">Try the public demo</a>
            <a className="secondary-link" href="#integrate">See the integration</a>
          </div>
          <p className="privacy-line">One synthetic customer · nothing you type is sent or saved</p>
        </section>

        <section className="demo-section" id="demo" aria-labelledby="demo-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Public synthetic demo</p>
              <h2 id="demo-heading">Use an English sentence, a fragment, or no words.</h2>
            </div>
            <p>
              Type anything into one open support chat. Four simultaneous evidence signals let the
              demo rank meaning, fuzzy word matches, and read-only context entirely in this browser.
            </p>
          </div>
          <WordlessDemo />
        </section>

        <section className="how-section" id="how-it-works" aria-labelledby="how-heading">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Evidence first</p>
              <h2 id="how-heading">The company already knows what is true.</h2>
            </div>
          </div>
          <ol className="steps">
            <li>
              <span>1</span>
              <h3>Read current state</h3>
              <p>The company loads read-only billing, delivery, item, or account evidence.</p>
            </li>
            <li>
              <span>2</span>
              <h3>Offer supported words</h3>
              <p>Concept similarity and typo-tolerant matching rank at most three choices grounded in those records.</p>
            </li>
            <li>
              <span>3</span>
              <h3>Keep the normal bot</h3>
              <p>When evidence is not useful, the company&apos;s existing chatbot answers unchanged.</p>
            </li>
          </ol>
        </section>

        <section className="integration-section" id="integrate" aria-labelledby="integrate-heading">
          <div className="integration-copy">
            <p className="eyebrow">For support teams</p>
            <h2 id="integrate-heading">Add one decision before your bot replies.</h2>
            <p>
              The server SDK accepts any English-language message and typed account evidence. Empty or unclear text
              uses the same context ranking; unrelated text continues through the chatbot you already use,
              including Zendesk Messaging.
            </p>
            <ul>
              <li>Any English free-text message</li>
              <li>Incomplete or jumbled words</li>
              <li>One-tap “no words” help</li>
              <li>Existing bot fallback</li>
            </ul>
          </div>
          <div className="code-card" aria-label="Server integration example">
            <div className="code-card-header">
              <span>Server middleware</span>
              <span>Node.js · Zendesk pilot kit</span>
            </div>
            <pre><code>{integrationExample}</code></pre>
          </div>
        </section>

        <section className="pilot-section" aria-labelledby="pilot-heading">
          <p className="eyebrow">Available as a controlled pilot</p>
          <h2 id="pilot-heading">Real assistance, with a clear boundary.</h2>
          <p>
            The public page is a safe synthetic demonstration. A company pilot uses the signed
            Wordless API in its authenticated support interface, maps its own evidence, and keeps
            every refund, replacement, unlock, and handoff in its existing workflow. This pilot is
            English-only; each additional language needs its own labeled evaluation and localized copy.
          </p>
          <div className="run-card">
            <div>
              <strong>Run the full local product</strong>
              <span>Starts the Python evidence service and support console.</span>
            </div>
            <code>uv run python scripts/run_wordless.py</code>
          </div>
        </section>
      </main>

      <footer>
        <span>Wordless</span>
        <span>Communication support without a diagnosis label.</span>
      </footer>
    </div>
  );
}
