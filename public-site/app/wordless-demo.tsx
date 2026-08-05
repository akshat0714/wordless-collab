"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  evidenceSignals,
  assistMessage,
  type AssistChoice,
} from "./concept-engine";
import { humanRequested } from "./human-request";

type Entry = { id: string; role: "assistant" | "customer"; text: string; choices?: AssistChoice[] };

const welcome: Entry = {
  id: "welcome",
  role: "assistant",
  text: "Hi. How can I help today?",
};

function hostReply(message: string): string {
  const text = message.trim().toLowerCase();
  if (/^(hi|hello|hey|good (morning|afternoon|evening))[!. ]*$/.test(text)) {
    return "Hi. I can help with billing, delivery, an item, or signing in. What do you need?";
  }
  // A person request always wins over any topic words in the same message.
  if (humanRequested(text)) {
    return "This public demo has not contacted anyone. A company maps this turn to its own support queue.";
  }
  if (/\b(receipt|invoice|proof of purchase)\b/.test(text)) {
    return "For a receipt, open the order and choose Receipt. In a company chatbot, this answer comes from its existing help flow.";
  }
  if (/\b(return|exchange|send (it|this) back|wrong size)\b/.test(text)) {
    return "Is this about returning an item or exchanging it? A company connects this turn to its normal returns workflow.";
  }
  if (/\b(hours?|when (are|is) .*open|open (today|tomorrow)|24[ /-]?7)\b/.test(text)) {
    return "Chat support is available any time in this demo. A company integration uses its Zendesk schedule for live-agent hours.";
  }
  if (/\b(track|tracking|order status|where(?:'s| is) my (order|package))\b/.test(text)) {
    return "Open Orders and choose the order to see its latest tracking status. If tracking has not updated, ask for delivery help.";
  }
  if (/\b(forgot|reset|change).{0,18}\bpassword\b|\bpassword.{0,18}(forgot|reset|change)\b/.test(text)) {
    return "Choose Forgot password on the sign-in page and use the verified email link. Never send a password or reset code in chat.";
  }
  if (/\b(payment|card).{0,20}\b(declined|failed|not working)\b|\b(declined|failed).{0,20}\b(payment|card)\b/.test(text)) {
    return "Check the billing address and ask your bank whether it blocked the payment. Do not send a full card number in chat.";
  }
  if (/\b(cancel|stop).{0,18}\b(order|subscription|membership)\b/.test(text)) {
    return "Is this an order or a subscription? No cancellation happens until the company confirms it.";
  }
  if (/\b(change|update|wrong).{0,18}\b(address|shipping address)\b/.test(text)) {
    return "If the order has not shipped, open it and choose Change address. Otherwise ask for a person; do not post the full address in chat.";
  }
  if (/\b(damaged|broken|warranty|doesn'?t work|not working)\b/.test(text)) {
    return "Which item is damaged or not working? A company can connect this answer to its warranty flow.";
  }
  if (/\b(promo|coupon|discount|voucher)\b/.test(text)) {
    return "Enter the code once at checkout and check its dates and item rules. If it is still rejected, ask for a person.";
  }
  if (/\b(delete|close).{0,18}\b(account|data)\b|\bprivacy (request|rights?)\b/.test(text)) {
    return "A verified company workflow must confirm identity before changing an account or deleting data.";
  }
  return "I want to understand. Is this about billing, delivery, an item, or signing in? You can also choose I don’t know what to say.";
}

function newEntry(role: Entry["role"], text: string, choices?: AssistChoice[]): Entry {
  return { id: crypto.randomUUID(), role, text, ...(choices ? { choices } : {}) };
}

export function WordlessDemo() {
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([welcome]);
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [entries]);

  function respond(message: string, forceChoices = false) {
    const customerText = message || "I don’t know what to say.";
    const customer = newEntry("customer", customerText);
    const decision = humanRequested(message) ? null : assistMessage(message, { forceChoices });
    const assistant = decision?.outcome === "show_grounded_choices"
      ? newEntry("assistant", decision.prompt, decision.choices)
      : newEntry("assistant", hostReply(message));

    setEntries((current) => [...current, customer, assistant]);
    setDraft("");
    setAnnouncement(assistant.choices ? `${assistant.text} ${assistant.choices.length} choices are ready.` : assistant.text);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) {
      respond("", true);
      return;
    }
    respond(message);
  }

  function choose(choice: AssistChoice) {
    const customerText = choice.label;
    const reply = choice.confirmation;
    setEntries((current) => [
      ...current.map((entry) => entry.choices ? { ...entry, choices: undefined } : entry),
      newEntry("customer", customerText),
      newEntry("assistant", reply),
    ]);
    setAnnouncement(reply);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <div className="demo-wrap" data-public-demo="browser-only">
      <div className="scenario-picker">
        <div>
          <strong>One synthetic customer · current sample context</strong>
          <span>Type anything below. These are evidence signals, not message options.</span>
        </div>
        <div className="evidence-signals" aria-label="Synthetic account evidence">
          {evidenceSignals.map((item) => (
            <span key={item.id}>{item.label}</span>
          ))}
        </div>
      </div>

      <div className="chat-card">
        <header className="chat-header">
          <div className="avatar" aria-hidden="true">A</div>
          <div>
            <h3>Acme Support</h3>
            <p><span aria-hidden="true" /> Demo bot ready · short replies</p>
          </div>
          <strong>Public synthetic demo</strong>
        </header>

        <div className="evidence-bar" role="note" aria-label="How the demo uses evidence">
          <span>Read-only context</span>
          <strong>4 sample signals available for meaning and no-words assistance</strong>
        </div>

        <div ref={transcriptRef} className="transcript" role="region" aria-label="Support conversation">
          {entries.map((entry) => (
            <article className={`message-row ${entry.role}`} key={entry.id}>
              <span>{entry.role === "assistant" ? "Support" : "You"}</span>
              <div className="bubble">
                <p>{entry.text}</p>
                {entry.choices ? (
                  <div className="choice-list" aria-label="Choose one reply">
                    {entry.choices.map((choice) => (
                      <button type="button" key={choice.id} onClick={() => choose(choice)}>
                        <strong>{choice.label}</strong>
                        {choice.supporting ? <span>{choice.supporting}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <p className="composer-notice">
          Synthetic product demo. No real account or support agent is connected. Do not enter
          personal information. Wordless is an accessibility aid, not a diagnosis or medical service.
        </p>

        <form className="composer" onSubmit={submit} noValidate>
          <label htmlFor="message">Message support</label>
          <div className="composer-row">
            <textarea
              ref={inputRef}
              id="message"
              rows={2}
              maxLength={500}
              value={draft}
              placeholder="Type any words you have…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <button className="send-button" type="submit">Send</button>
          </div>
          <div className="composer-tools">
            <button className="choices-button" type="button" onClick={() => respond(draft.trim(), true)}>
              <span aria-hidden="true">1 · 2 · 3</span>
              <span><strong>I don’t know what to say</strong><small>Show grounded choices</small></span>
            </button>
            <button className="person-button" type="button" onClick={() => respond("I need a support person.")}>Preview human handoff</button>
            <p>Enter sends · Shift + Enter adds a line</p>
          </div>
        </form>
      </div>

      <p className="engine-note"><strong>How this demo reads a message:</strong> concept vectors + typo similarity + current account evidence. It never diagnoses the person.</p>
      <p className="demo-safety">Runs in your browser. No login, diagnosis, account change, or message storage.</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  );
}
