"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  detectors as fixtureDetectors,
  type Detector,
  type DetectorStatus,
} from "@/data/fixtures";
import {
  maximumConditionLength,
  parseReviewResponse,
  type DetectorReviewRecord,
} from "@/lib/detector-review-schema";

const statusText: Record<DetectorStatus, string> = {
  proposed: "Undecided",
  approved: "Approved",
  edited: "Edited",
  rejected: "Rejected",
};

function statusClass(status: DetectorStatus): string {
  if (status === "approved") return "label-status label-status-ok";
  if (status === "rejected") return "label-status label-status-flag";
  return "label-status label-status-hold";
}

function applyReviews(reviews: DetectorReviewRecord[]): Detector[] {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  return fixtureDetectors.map((detector) => {
    const review = byId.get(detector.id as DetectorReviewRecord["id"]);
    return review
      ? { ...detector, status: review.status, condition: review.condition }
      : detector;
  });
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const value = await response.json() as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
    ) {
      return new Error(value.error);
    }
  } catch {
    // Preserve the bounded fallback for non-JSON server/proxy errors.
  }
  return new Error(fallback);
}

export function DetectorReview() {
  const [items, setItems] = useState<Detector[]>(() => [...fixtureDetectors]);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [hydration, setHydration] = useState<"loading" | "ready" | "error">("loading");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [persistenceNote, setPersistenceNote] = useState("Loading the local review file.");
  const [announcement, setAnnouncement] = useState(
    "Loading saved local detector review decisions.",
  );
  const rowRefs = useRef<Array<HTMLElement | null>>([]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const counts = useMemo(
    () =>
      items.reduce(
        (result, item) => ({ ...result, [item.status]: result[item.status] + 1 }),
        { proposed: 0, approved: 0, edited: 0, rejected: 0 } as Record<DetectorStatus, number>,
      ),
    [items],
  );

  const selectDetector = useCallback(
    (index: number, focus = false) => {
      const next = Math.max(0, Math.min(items.length - 1, index));
      setSelected(next);
      setEditing(null);
      setAnnouncement(
        `${items[next].label} selected. Detector ${next + 1} of ${items.length}.`,
      );
      if (focus) {
        requestAnimationFrame(() => rowRefs.current[next]?.focus());
      }
    },
    [items],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/detector-reviews", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw await responseError(response, "The local detector review file could not be loaded.");
        }
        const payload = parseReviewResponse(await response.json() as unknown);
        setItems(applyReviews(payload.reviews));
        setHydration("ready");
        setPersistenceNote(
          payload.source === "file"
            ? `Saved local review loaded${payload.updatedAt ? ` · ${new Date(payload.updatedAt).toLocaleString()}` : ""}.`
            : "No review file exists yet; fixture defaults are loaded.",
        );
        setAnnouncement(
          `${fixtureDetectors[0].label} selected. Detector 1 of ${fixtureDetectors.length}.`,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setHydration("error");
        setSaveError(error instanceof Error ? error.message : "The local detector review file could not be loaded.");
        setPersistenceNote("Review controls are unavailable until the local file can be read safely.");
        setAnnouncement("Local review hydration failed.");
      }
    })();
    return () => controller.abort();
  }, []);

  const persistReview = useCallback(
    async (review: DetectorReviewRecord, successMessage: string): Promise<boolean> => {
      if (hydration !== "ready" || savingId) return false;
      setSavingId(review.id);
      setSaveError(null);
      setAnnouncement(`Saving ${review.id} to the bounded local review file.`);
      try {
        const response = await fetch("/api/detector-reviews", {
          method: "PATCH",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(review),
        });
        if (!response.ok) {
          throw await responseError(response, "The local detector decision could not be saved.");
        }
        const payload = parseReviewResponse(await response.json() as unknown);
        setItems(applyReviews(payload.reviews));
        setPersistenceNote(
          `Saved to .wordless/detector-reviews.json${payload.updatedAt ? ` · ${new Date(payload.updatedAt).toLocaleString()}` : ""}.`,
        );
        setAnnouncement(successMessage);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The local detector decision could not be saved.";
        setSaveError(message);
        setAnnouncement(`Save failed. ${message}`);
        return false;
      } finally {
        setSavingId(null);
      }
    },
    [hydration, savingId],
  );

  const setDecision = useCallback(
    async (index: number, status: "approved" | "rejected") => {
      const item = items[index];
      if (!item) return;
      setEditing(null);
      await persistReview(
        { id: item.id as DetectorReviewRecord["id"], status, condition: item.condition },
        `${item.label} saved as ${status}.`,
      );
    },
    [items, persistReview],
  );

  const startEditing = useCallback(
    (index: number) => {
      if (hydration !== "ready" || savingId) return;
      setSelected(index);
      setDraft(items[index].condition);
      setEditing(items[index].id);
      setAnnouncement(`Editing ${items[index].label}.`);
    },
    [hydration, items, savingId],
  );

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      switch (event.key.toLowerCase()) {
        case "j":
          event.preventDefault();
          selectDetector(selected + 1, true);
          break;
        case "k":
          event.preventDefault();
          selectDetector(selected - 1, true);
          break;
        case "a":
          event.preventDefault();
          void setDecision(selected, "approved");
          break;
        case "e":
          event.preventDefault();
          startEditing(selected);
          break;
        case "x":
          event.preventDefault();
          void setDecision(selected, "rejected");
          break;
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectDetector, selected, setDecision, startEditing]);

  async function saveEdit(index: number) {
    const condition = draft.trim();
    if (!condition) {
      setAnnouncement("Condition cannot be empty.");
      editorRef.current?.focus();
      return;
    }
    if (Array.from(condition).length > maximumConditionLength) {
      setAnnouncement(`Condition must be at most ${maximumConditionLength} characters.`);
      editorRef.current?.focus();
      return;
    }
    const item = items[index];
    if (!item) return;
    const saved = await persistReview(
      { id: item.id as DetectorReviewRecord["id"], status: "edited", condition },
      `${item.label} condition saved locally.`,
    );
    if (saved) {
      setEditing(null);
      requestAnimationFrame(() => rowRefs.current[index]?.focus());
    }
  }

  return (
    <section className="pt-8" aria-labelledby="detector-list-heading">
      <div className="grid grid-cols-1 gap-5 border-b border-rule-firm pb-6 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <h2 id="detector-list-heading" className="text-lg font-semibold">
            Synthetic fixture conditions
          </h2>
          <p className="mt-2 max-w-prose text-sm text-ink-soft">
            Fixture support is the number of authored detector cases over all 30 synthetic
            interactions. Condition assertion reports whether the exported fixture facts satisfy
            the rule; it is not a measured precision estimate.
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs tabular-nums text-ink-soft">
          <span>{counts.proposed} / {items.length} undecided</span>
          <span>{counts.approved} / {items.length} approved</span>
          <span>{counts.edited} / {items.length} edited</span>
          <span>{counts.rejected} / {items.length} rejected</span>
        </div>
      </div>

      <p
        className={`border-b px-4 py-3 text-xs font-medium ${
          saveError
            ? "border-flag bg-flag-bg text-flag"
            : savingId || hydration === "loading"
              ? "border-rule bg-hold-bg text-hold"
              : "border-rule bg-surface text-ok"
        }`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="block">{persistenceNote}</span>
        <span className="mt-1 block font-normal">{announcement}</span>
      </p>

      <div className="border-t border-rule-firm">
        {items.map((detector, index) => {
          const active = selected === index;
          const isEditing = editing === detector.id;
          return (
            <article
              key={detector.id}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              className="detector-row"
              data-selected={active}
              tabIndex={0}
              aria-labelledby={`${detector.id}-title`}
              aria-expanded={active}
              onFocus={() => {
                if (!active) selectDetector(index);
              }}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, textarea")) return;
                selectDetector(index);
              }}
            >
              <div className="detector-summary">
                <div className="detector-summary-main">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3 id={`${detector.id}-title`} className="text-base font-semibold">
                      {detector.label}
                    </h3>
                    <span className={statusClass(detector.status)}>
                      {statusText[detector.status]}
                    </span>
                  </div>
                  <p className="mt-3 max-w-prose text-sm text-ink-soft">{detector.condition}</p>
                  <p className="mt-3 font-mono text-[11px] text-ink-faint">
                    {detector.id}
                  </p>
                </div>
                <dl className="metric-definition">
                  <dt>Fixture support</dt>
                  <dd>{detector.supportNumerator} / {detector.supportDenominator}</dd>
                  <p className="mt-1 text-[11px] text-ink-faint">authored synthetic cases / all fixture interactions</p>
                </dl>
                <dl className="metric-definition">
                  <dt>Estimated precision</dt>
                  <dd>Not estimated</dd>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    No human-labeled review sample; synthetic assertion is not precision
                  </p>
                </dl>
                <div className="detector-summary-actions flex flex-wrap justify-start gap-2 lg:justify-end">
                  <button
                    type="button"
                    className="button-secondary !min-h-11 !px-3"
                    onClick={() => void setDecision(index, "approved")}
                    disabled={hydration !== "ready" || savingId !== null}
                    aria-label={`Approve detector and save locally: ${detector.label}`}
                  >
                    <span className="mr-2 font-mono text-[11px] text-ink-faint" aria-hidden="true">A</span>
                    Approve detector
                  </button>
                  <button
                    type="button"
                    className="button-secondary !min-h-11 !px-3"
                    onClick={() => startEditing(index)}
                    disabled={hydration !== "ready" || savingId !== null}
                    aria-label={`Edit condition and save locally: ${detector.label}`}
                  >
                    <span className="mr-2 font-mono text-[11px] text-ink-faint" aria-hidden="true">E</span>
                    Edit condition
                  </button>
                  <button
                    type="button"
                    className="button-danger !min-h-11 !px-3"
                    onClick={() => void setDecision(index, "rejected")}
                    disabled={hydration !== "ready" || savingId !== null}
                    aria-label={`Reject detector and save locally: ${detector.label}`}
                  >
                    <span className="mr-2 font-mono text-[11px]" aria-hidden="true">X</span>
                    Reject detector
                  </button>
                </div>
              </div>

              {active ? (
                <div className="detector-detail">
                  {isEditing ? (
                    <div className="mb-8 border-b border-rule-firm pb-7">
                      <label className="block text-xs font-semibold uppercase tracking-[0.1em] text-ink-soft" htmlFor={`${detector.id}-condition`}>
                        Detector condition
                      </label>
                      <textarea
                        ref={editorRef}
                        id={`${detector.id}-condition`}
                        className="condition-field mt-3"
                        value={draft}
                        maxLength={maximumConditionLength}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      <p className="mt-2 font-mono text-[11px] tabular-nums text-ink-faint">
                        {Array.from(draft).length} / {maximumConditionLength} characters
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="button-primary"
                          disabled={savingId !== null}
                          onClick={() => void saveEdit(index)}
                        >
                          {savingId === detector.id ? "Saving…" : "Save condition locally"}
                        </button>
                        <button
                          type="button"
                          className="button-quiet"
                          disabled={savingId !== null}
                          onClick={() => {
                            setEditing(null);
                            setAnnouncement(`Editing ${detector.label} cancelled.`);
                            requestAnimationFrame(() => rowRefs.current[index]?.focus());
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
                    <div className="lg:col-span-8">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-soft">
                        Condition asserted · {Math.min(5, detector.assertions.length)} shown / {detector.assertionDenominator} authored detector cases
                      </h4>
                      <ul className="sample-list mt-3">
                        {detector.assertions.slice(0, 5).map((sample) => (
                          <li key={sample.id}>
                            <span className="font-mono font-semibold tabular-nums">{sample.id}</span>
                            <span className="text-ink-soft">“{sample.fragment}”</span>
                            <span>{sample.evidence}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="lg:col-span-4 lg:border-l lg:border-rule lg:pl-6">
                      <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-soft">
                        Contrasts · 3 shown / 6 authored clean cases
                      </h4>
                      <ul className="mt-3 space-y-0">
                        {detector.contrasts.map((sample) => (
                          <li key={sample.id} className="border-t border-rule py-3 text-xs">
                            <div className="flex gap-3">
                              <span className="font-mono font-semibold tabular-nums">{sample.id}</span>
                              <span className="text-ink-soft">“{sample.fragment}”</span>
                            </div>
                            <p className="mt-2 text-ink">{sample.evidence}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="mt-8 border-t border-rule pt-5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-soft">
                      Circumlocution variants
                    </p>
                    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-soft">
                      {detector.variants.map((variant) => (
                        <li key={variant} className="before:mr-2 before:text-ink-faint before:content-['—']">
                          {variant}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <p className="mt-5 max-w-prose text-xs text-ink-soft">
        Decisions and edited conditions persist only in the bounded local file
        .wordless/detector-reviews.json and hydrate on reload. The file is review metadata: it
        does not activate a detector, modify a replay artifact, call a customer system, or grant
        customer-system write access.
      </p>
    </section>
  );
}
