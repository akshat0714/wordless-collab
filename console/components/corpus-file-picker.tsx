"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useId,
  useRef,
  useState,
} from "react";

const acceptedExtensions = [".csv", ".json", ".jsonl", ".zip"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasAcceptedExtension(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  return acceptedExtensions.some((extension) => lowerName.endsWith(extension));
}

export function CorpusFilePicker() {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("No file selected.");
  const [error, setError] = useState(false);

  function choose(candidate: File | undefined) {
    if (!candidate) return;
    if (!hasAcceptedExtension(candidate)) {
      setFile(null);
      setError(true);
      setMessage("File type not recognized. Choose CSV, JSON, JSONL, or ZIP.");
      return;
    }
    setFile(candidate);
    setError(false);
    setMessage(`${candidate.name} selected locally. ${formatBytes(candidate.size)}.`);
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    choose(event.target.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files?.[0]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      inputRef.current?.click();
    }
  }

  return (
    <div>
      <div
        className={`drop-region ${dragging ? "drop-region-active" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
          }
        }}
        onDrop={handleDrop}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-describedby={`${inputId}-description ${inputId}-status`}
      >
        <input
          ref={inputRef}
          id={inputId}
          className="sr-only"
          type="file"
          accept=".csv,.json,.jsonl,.zip,application/json,text/csv,application/zip"
          onChange={handleInput}
        />
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-lg font-semibold">Drop one export file</p>
            <p id={`${inputId}-description`} className="mt-2 max-w-prose text-sm text-ink-soft">
              CSV, JSON, JSONL, or ZIP. This fixture-only console records the filename in the
              current tab; it does not parse, retain, or upload the file.
            </p>
          </div>
          <label className="button-secondary cursor-pointer" htmlFor={inputId}>
            Choose file
          </label>
        </div>
        <div
          id={`${inputId}-status`}
          className={`mt-7 border-t pt-4 font-mono text-xs tabular-nums ${
            error ? "border-flag text-flag" : file ? "border-ok text-ok" : "border-rule text-ink-faint"
          }`}
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      </div>
      {file ? (
        <div className="flex flex-col gap-4 border-x border-b border-rule-firm bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-prose text-xs text-ink-soft">
            Selection is UI-only. The run page can execute the fixed synthetic fixture, but this
            selected file is never sent to that route and no validation, redaction, or replay has
            started for it.
          </p>
          <Link href="/run" className="button-primary shrink-0">
            Open fixture runner
          </Link>
        </div>
      ) : null}
      <details className="mt-5 border-y border-rule py-4 text-sm">
        <summary className="min-h-11 cursor-pointer py-2 font-semibold">
          Using a mapped CSV
        </summary>
        <div className="grid grid-cols-1 gap-5 pb-3 pt-4 text-ink-soft md:grid-cols-2">
          <p className="max-w-prose">
            Place a YAML map beside the CSV. Map interaction ID, customer ID, open time,
            message fields, and resolution fields in their nested sections. Only mapped fields
            are normalized; map <code>fields.metadata</code> explicitly when needed.
          </p>
          <pre className="overflow-x-auto border-l-2 border-rule-firm bg-surface p-4 font-mono text-xs leading-5 text-ink" aria-label="YAML mapping example">
{`format: csv
fields:
  id: ticket_id
  customer_id: requester_id
  opened_at: created_at
messages:
  fields:
    author: author_type
    sent_at: message_created_at
    text: body
  author_map:
    requester: customer
    staff: agent
resolution:
  fields:
    resolved_at: closed_at
    original_label: category
    closing_text: closing_note`}
          </pre>
        </div>
      </details>
    </div>
  );
}
