import type { Metadata } from "next";

import { CorpusFilePicker } from "@/components/corpus-file-picker";
import { PageHeading } from "@/components/page-heading";

export const metadata: Metadata = { title: "Corpora" };

const adapters = [
  ["Zendesk", "ZIP or JSON", "Tickets, comments, users, custom fields"],
  ["Intercom", "ZIP or JSON", "Conversations, parts, tags, attributes"],
  ["Chatwoot", "JSON", "Conversations, messages, contacts"],
  ["Zammad", "JSON", "Tickets, articles, customer records"],
  ["Mapped CSV", "CSV + YAML", "Your columns mapped to the canonical contract"],
] as const;

export default function CorporaPage() {
  return (
    <>
      <PageHeading
        index="01"
        eyebrow="Corpora"
        title="Prepare a resolved support export"
        description="Review the supported historical export shapes. This local console can execute only its fixed synthetic fixture; selecting another file does not ingest or replay it."
        aside={
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 metric-definition md:grid-cols-1">
            <div>
              <dt>Customer writes</dt>
              <dd>None</dd>
            </div>
            <div>
              <dt>Network required</dt>
              <dd>No</dd>
            </div>
            <div>
              <dt>Local writes</dt>
              <dd>Artifacts + review</dd>
            </div>
          </dl>
        }
      />

      <section className="grid grid-cols-1 gap-8 pt-8 md:grid-cols-12" aria-labelledby="choose-export">
        <div className="md:col-span-8">
          <h2 id="choose-export" className="text-lg font-semibold">
            Choose the export
          </h2>
          <p className="mt-2 max-w-prose text-sm text-ink-soft">
            Drop a Zendesk, Intercom, Chatwoot, or Zammad export here. For another system,
            provide a CSV and a YAML column map. Selection is a local UI preview only; the Run
            screen remains restricted to demo-synthetic-v1.
          </p>
          <div className="mt-6">
            <CorpusFilePicker />
          </div>
        </div>
        <aside className="md:col-span-4 md:border-l md:border-rule md:pl-6" aria-labelledby="before-you-start">
          <h2 id="before-you-start" className="text-sm font-semibold">
            Before you start
          </h2>
          <ol className="mt-4 space-y-4 text-sm text-ink-soft">
            <li className="grid grid-cols-[28px_1fr] gap-3">
              <span className="font-mono text-xs tabular-nums text-ink-faint">01</span>
              <span>Export only resolved interactions and their message history.</span>
            </li>
            <li className="grid grid-cols-[28px_1fr] gap-3">
              <span className="font-mono text-xs tabular-nums text-ink-faint">02</span>
              <span>Include linked order, billing, or account fields when available.</span>
            </li>
            <li className="grid grid-cols-[28px_1fr] gap-3">
              <span className="font-mono text-xs tabular-nums text-ink-faint">03</span>
              <span>Keep the per-corpus salt outside the normalized workspace.</span>
            </li>
          </ol>
          <div className="mt-6 border-t border-rule pt-5 text-xs text-ink-soft">
            Personal data is redacted before persistence or model use. Amounts, order IDs,
            SKUs, and declared product names remain available as evidence.
          </div>
        </aside>
      </section>

      <section className="section-rule" aria-labelledby="accepted-exports">
        <div className="section-kicker">
          <span className="section-kicker-number">01.1</span>
          <h2 id="accepted-exports">Accepted exports</h2>
        </div>
        <div className="audit-table-wrap mt-5">
          <table className="audit-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Format</th>
                <th scope="col">Records used</th>
              </tr>
            </thead>
            <tbody>
              {adapters.map(([source, format, records]) => (
                <tr key={source}>
                  <td className="font-semibold">{source}</td>
                  <td className="font-mono tabular-nums text-ink-soft">{format}</td>
                  <td className="text-ink-soft">{records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section-rule" aria-labelledby="recent-corpus">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="section-kicker">
              <span className="section-kicker-number">01.2</span>
              <h2 id="recent-corpus">Audited local snapshots</h2>
            </div>
            <p className="mt-3 text-sm text-ink-soft">
              One deterministic synthetic fixture and one pinned public-corpus audit. Their
              findings are reported separately.
            </p>
          </div>
          <span className="label-status label-status-ok">Artifacts available</span>
        </div>
        <div className="audit-table-wrap mt-5">
          <table className="audit-table">
            <thead>
              <tr>
                <th scope="col">Corpus</th>
                <th scope="col">Period</th>
                <th scope="col">Interactions</th>
                <th scope="col">State provenance</th>
                <th scope="col">Audit date</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="font-semibold">Wordless synthetic fixture · demo-synthetic-v1</td>
                <td className="font-mono tabular-nums">2026-01-03–2026-02-01</td>
                <td className="font-mono tabular-nums">30</td>
                <td>
                  <span className="font-mono tabular-nums">30 / 30 exported</span>
                  <span className="ml-2 text-xs text-ink-faint">0 / 30 inferred</span>
                </td>
                <td className="font-mono tabular-nums">2026-02-02</td>
              </tr>
              <tr>
                <td className="font-semibold">Help Desk Tickets v2 · public audit</td>
                <td className="font-mono tabular-nums">2022-01-02–2022-12-28</td>
                <td className="font-mono tabular-nums">360</td>
                <td>
                  <span className="font-mono tabular-nums text-hold">360 / 360 inferred</span>
                  <span className="ml-2 text-xs text-ink-faint">0 / 360 evidence-eligible</span>
                </td>
                <td className="font-mono tabular-nums">2026-07-25</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
