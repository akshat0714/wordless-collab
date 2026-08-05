"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  maximumSupportMessageLength,
  hasBackedSupportChoice,
  parseSupportChatRequest,
  parseSupportChatResponse,
  type SupportChatAction,
  type SupportChatChoice,
  type SupportResponseSource,
  type SupportScenarioId,
} from "@/lib/support-chat-schema";
import {
  parseLiveApiError,
  parseLiveFeedbackInput,
  parseLiveFeedbackResponse,
} from "@/lib/live-suggestion-schema";
import {
  noneOfTheseReply,
  navigationReply,
  supportConfirmationReply,
  supportScenario,
} from "@/lib/support-scenarios";

type ChatEntry = {
  id: string;
  role: "assistant" | "customer";
  text: string;
  choices: SupportChatChoice[];
  suggestionId: string | null;
  responseSource: SupportResponseSource;
  reviewRequired: boolean;
  selection: string | "none" | null;
};

type RequestState = "idle" | "sending" | "reviewing";

const welcomeEntry: ChatEntry = {
  id: "welcome",
  role: "assistant",
  text: "Hi. Type whatever words you have—even fragments. Or choose I don’t know what to say.",
  choices: [],
  suggestionId: null,
  responseSource: "host_bot",
  reviewRequired: false,
  selection: null,
};

function responseError(response: Response, fallback: string): Promise<Error> {
  return response
    .json()
    .then((value: unknown) => new Error(parseLiveApiError(value).error.message))
    .catch(() => new Error(fallback));
}

function makeLocalEntry(
  role: ChatEntry["role"],
  text: string,
  suffix: string,
): ChatEntry {
  return {
    id: `local-${suffix}-${crypto.randomUUID()}`,
    role,
    text,
    choices: [],
    suggestionId: null,
    responseSource: "host_bot",
    reviewRequired: false,
    selection: null,
  };
}

export function LiveSuggestion() {
  const scenarioId: SupportScenarioId = "full_account";
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([welcomeEntry]);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [inputInvalid, setInputInvalid] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusReplyId, setFocusReplyId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const choiceHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const busy = requestState !== "idle";
  const scenario = supportScenario(scenarioId);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries, requestState]);

  useEffect(() => {
    if (!focusReplyId) return;
    const frame = requestAnimationFrame(() => choiceHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusReplyId]);

  async function send(action: SupportChatAction, messageOverride?: string) {
    if (busy) return;
    const message = (messageOverride ?? draft).trim();
    if (action === "message" && !message) {
      setError("Type any words you have, or choose I don’t know what to say.");
      setInputInvalid(true);
      setAnnouncement("Type any words you have, or choose I don’t know what to say.");
      composerRef.current?.focus();
      return;
    }
    if (Array.from(message).length > maximumSupportMessageLength) {
      setError(`Keep the message under ${maximumSupportMessageLength} characters.`);
      setInputInvalid(true);
      setAnnouncement(`Keep the message under ${maximumSupportMessageLength} characters.`);
      composerRef.current?.focus();
      return;
    }

    const requestId = crypto.randomUUID();
    if (!conversationIdRef.current) conversationIdRef.current = crypto.randomUUID();
    const payload = parseSupportChatRequest({
      schema_version: 1,
      request_id: requestId,
      conversation_id: conversationIdRef.current,
      observed_at: new Date().toISOString(),
      scenario_id: scenarioId,
      action,
      message,
    });
    const customerText = message || "I don’t know what to say.";
    const customerEntry = makeLocalEntry("customer", customerText, "customer");
    setEntries((current) => [...current, customerEntry]);
    if (messageOverride === undefined) setDraft("");
    setError(null);
    setInputInvalid(false);
    setFocusReplyId(null);
    setRequestState("sending");
    setAnnouncement("Support is checking your message.");

    try {
      const response = await fetch("/api/chat/messages", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw await responseError(response, `Support returned HTTP ${response.status}.`);
      }
      const result = parseSupportChatResponse(await response.json() as unknown);
      if (result.request_id !== requestId) throw new Error("Support returned the wrong reply.");
      const entry: ChatEntry = {
        id: result.reply_id,
        role: "assistant",
        text: result.message,
        choices: result.choices,
        suggestionId: result.suggestion_id,
        responseSource: result.response_source,
        reviewRequired: result.review_required,
        selection: null,
      };
      setEntries((current) => [...current, entry]);
      setRequestState("idle");
      if (result.choices.length > 0) {
        setFocusReplyId(result.reply_id);
        setAnnouncement(`${result.message} Short choices are ready.`);
      } else {
        setAnnouncement(result.message);
      }
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : "Support could not reply.";
      setEntries((current) => current.filter((entry) => entry.id !== customerEntry.id));
      setError(`${messageText} Try sending your message again.`);
      setInputInvalid(false);
      if (messageOverride === undefined) setDraft(message);
      setRequestState("idle");
      setAnnouncement("Support could not reply. Try again.");
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }

  async function choose(entry: ChatEntry, choice: SupportChatChoice | null) {
    if (busy || entry.selection !== null) return;
    const hasBackedDetectorChoice = hasBackedSupportChoice(entry.choices);
    const reviewedWordlessTurn =
      entry.responseSource === "wordless" &&
      entry.reviewRequired &&
      entry.suggestionId !== null &&
      hasBackedDetectorChoice;
    const locallyConfirmableSyntheticTurn =
      entry.responseSource === "synthetic_demo" &&
      !entry.reviewRequired &&
      entry.suggestionId === null &&
      hasBackedDetectorChoice;
    const isBackedChoice =
      (reviewedWordlessTurn || locallyConfirmableSyntheticTurn) &&
      choice !== null &&
      choice.detector_id !== null;
    const selection = choice?.id ?? "none";
    setRequestState("reviewing");
    setError(null);
    setInputInvalid(false);
    setAnnouncement(
      isBackedChoice && reviewedWordlessTurn ? "Saving your choice." : "Continuing the chat.",
    );

    try {
      if (reviewedWordlessTurn && entry.suggestionId !== null) {
        const requestId = crypto.randomUUID();
        const feedback = parseLiveFeedbackInput({
          schema_version: 1,
          request_id: requestId,
          outcome: isBackedChoice ? "confirmed" : "none",
          selected_detector_id: isBackedChoice ? choice?.detector_id ?? null : null,
        });
        const response = await fetch(
          `/api/live/suggestions/${encodeURIComponent(entry.suggestionId)}/feedback`,
          {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(feedback),
          },
        );
        if (!response.ok) {
          throw await responseError(response, `Feedback returned HTTP ${response.status}.`);
        }
        const saved = parseLiveFeedbackResponse(await response.json() as unknown);
        if (
          saved.suggestion_id !== entry.suggestionId ||
          saved.outcome !== feedback.outcome ||
          saved.selected_detector_id !== feedback.selected_detector_id
        ) {
          throw new Error("The saved choice did not match your selection.");
        }
      }

      setEntries((current) =>
        current.map((item) => (item.id === entry.id ? { ...item, selection } : item)),
      );
      const customerText = isBackedChoice
        ? `Yes — ${choice.label}`
        : choice?.detail ?? "None of these";
      const assistantText = isBackedChoice
        ? supportConfirmationReply(choice.detector_id ?? "")
        : hasBackedDetectorChoice
          ? noneOfTheseReply
          : choice
            ? navigationReply(choice.id)
            : noneOfTheseReply;
      setEntries((current) => [
        ...current,
        makeLocalEntry("customer", customerText, "choice"),
        makeLocalEntry("assistant", assistantText, "resolution"),
      ]);
      setRequestState("idle");
      setFocusReplyId(null);
      setAnnouncement(assistantText);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (caught) {
      setRequestState("idle");
      setError(caught instanceof Error ? caught.message : "Your choice could not be saved.");
      setAnnouncement("Your choice could not be saved. Choose it again to retry.");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send("message");
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="support-demo" aria-labelledby="support-demo-heading">
      <div className="scenario-picker">
        <div>
          <p className="scenario-kicker">One open support conversation</p>
          <p>Type any request. The options below are account signals, not things you must choose.</p>
        </div>
        <div className="scenario-options" aria-label="Available synthetic account signals">
          <span>Billing</span>
          <span>Delivery</span>
          <span>Item</span>
          <span>Sign-in</span>
        </div>
      </div>

      <div className="support-chat-card">
        <header className="support-chat-header">
          <div className="support-avatar" aria-hidden="true">A</div>
          <div>
            <h2 id="support-demo-heading">Acme Support</h2>
            <p><span aria-hidden="true" /> Demo bot ready · replies use short sentences</p>
          </div>
          <span className="synthetic-badge">Synthetic account</span>
        </header>

        <div
          className="account-context"
          role="note"
          aria-label="Current synthetic account evidence"
        >
          <span>{scenario.label}</span>
          <strong>{scenario.context}</strong>
        </div>

        <div
          className="support-transcript"
          role="region"
          aria-busy={busy}
          aria-label="Support conversation"
        >
          {entries.map((entry) => {
            const hasChoices = entry.choices.length > 0;
            return (
              <article
                key={entry.id}
                className={`chat-row chat-row-${entry.role}`}
                aria-label={entry.role === "assistant" ? "Support" : "You"}
              >
                <div className="chat-speaker">{entry.role === "assistant" ? "Support" : "You"}</div>
                <div className="chat-bubble">
                  {hasChoices ? (
                    <h3
                      ref={focusReplyId === entry.id ? choiceHeadingRef : undefined}
                      tabIndex={focusReplyId === entry.id ? -1 : undefined}
                    >
                      {entry.text}
                    </h3>
                  ) : (
                    <p>{entry.text}</p>
                  )}
                  {hasChoices ? (
                    <div className="chat-choice-list" aria-label="Choose one reply">
                      {entry.choices.map((choice) => (
                        <button
                          key={choice.id}
                          type="button"
                          className="chat-choice"
                          disabled={busy || entry.selection !== null}
                          aria-pressed={entry.selection === choice.id}
                          onClick={() => void choose(entry, choice)}
                        >
                          <strong>{choice.label}</strong>
                          {choice.evidence_label ? <span>{choice.evidence_label}</span> : null}
                        </button>
                      ))}
                      {entry.suggestionId !== null && !entry.choices.some((choice) => choice.detector_id === null) ? (
                        <button
                          type="button"
                          className="chat-choice chat-choice-none"
                          disabled={busy || entry.selection !== null}
                          aria-pressed={entry.selection === "none"}
                          onClick={() => void choose(entry, null)}
                        >
                          <strong>None of these</strong>
                          <span>Ask me a short question instead</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
          {busy ? (
            <div className="chat-typing" aria-hidden="true">
              <span /> <span /> <span />
            </div>
          ) : null}
          <div ref={transcriptEndRef} />
        </div>

        <p className="support-demo-disclosure">
          Synthetic product demo. No real account or support agent is connected. Do not enter
          personal information. Wordless is an accessibility aid, not a diagnosis or medical service.
        </p>

        <form className="support-composer" onSubmit={submit} noValidate>
          <label htmlFor="support-message">Message support</label>
          <div className="composer-row">
            <textarea
              ref={composerRef}
              id="support-message"
              value={draft}
              rows={2}
              maxLength={maximumSupportMessageLength}
              placeholder="Type what you can…"
              disabled={busy}
              aria-invalid={inputInvalid || undefined}
              onKeyDown={composerKeyDown}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
                setInputInvalid(false);
              }}
            />
            <button className="chat-send" type="submit" disabled={busy}>
              {requestState === "sending" ? "Sending…" : "Send"}
            </button>
          </div>
          <div className="composer-tools">
            <div className="composer-aids">
              <button
                type="button"
                className="show-choices-button"
                disabled={busy}
                onClick={() => void send("show_choices")}
              >
                <span aria-hidden="true" className="choice-mark">1 · 2 · 3</span>
                <span><strong>I don’t know what to say</strong><small>Show safe choices from this account</small></span>
              </button>
              <button
                type="button"
                className="human-button"
                disabled={busy}
                onClick={() => void send("message", "I need a support person.")}
              >
                Preview human handoff
              </button>
            </div>
            <p>Enter sends · Shift + Enter adds a line</p>
          </div>
          {error ? <p className="composer-error">{error}</p> : null}
        </form>
      </div>

      <p className="support-safety-note">
        Wordless reads account evidence and suggests words. It never changes the account by itself.
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  );
}
