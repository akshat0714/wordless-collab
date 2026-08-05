import type { Metadata } from "next";
import Link from "next/link";

import { AuditRunner } from "@/components/audit-runner";
import { PageHeading } from "@/components/page-heading";

export const metadata: Metadata = { title: "Run" };

export default function RunPage() {
  return (
    <>
      <PageHeading
        index="02"
        eyebrow="Run"
        title="Run the fixed local fixture audit"
        description="Start the complete deterministic synthetic audit from this console and watch only observable, measured stages. The server accepts no runtime arguments, runs one process at a time, and stops it after 15 minutes."
        aside={
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 metric-definition md:grid-cols-1">
            <div>
              <dt>Input</dt>
              <dd>demo-synthetic-v1</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>Local · offline</dd>
            </div>
            <div>
              <dt>Write boundary</dt>
              <dd>Demo artifacts only</dd>
            </div>
          </dl>
        }
      />

      <AuditRunner />

      <section className="section-rule grid grid-cols-1 gap-8 md:grid-cols-12" aria-labelledby="provenance-ladder">
        <div className="md:col-span-7">
          <div className="section-kicker">
            <span className="section-kicker-number">02.1</span>
            <h2 id="provenance-ladder">State provenance</h2>
          </div>
          <p className="mt-3 max-w-prose text-xs text-ink-soft">
            Interaction-level highest provenance rung in the synthetic report; n=30.
          </p>
          <div className="audit-table-wrap mt-5">
            <table className="audit-table !min-w-[560px]">
              <thead>
                <tr>
                  <th scope="col">Rung</th>
                  <th scope="col">Method</th>
                  <th scope="col">n / 30</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-mono">1</td>
                  <td>Exported synthetic facts</td>
                  <td className="font-mono">30 / 30</td>
                  <td className="font-mono">100.0%</td>
                </tr>
                <tr>
                  <td className="font-mono">2</td>
                  <td>Reconstructed from agent turns</td>
                  <td className="font-mono">0 / 30</td>
                  <td className="font-mono">0.0%</td>
                </tr>
                <tr>
                  <td className="font-mono">3</td>
                  <td>Inferred · degraded mode</td>
                  <td className="font-mono">0 / 30</td>
                  <td className="font-mono">0.0%</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={2}>Total</td>
                  <td className="font-mono">30 / 30</td>
                  <td className="font-mono">100.0%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <aside className="md:col-span-5 md:border-l md:border-rule md:pl-6">
          <h3 className="font-semibold">Reproducibility record</h3>
          <dl className="mt-5 space-y-4 metric-definition">
            <div>
              <dt>Verified embed seed</dt>
              <dd>17</dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>Offline · cached artifacts</dd>
            </div>
            <div>
              <dt>Report date</dt>
              <dd>2026-02-02</dd>
            </div>
            <div>
              <dt>Benchmark dataset</dt>
              <dd className="break-all !text-xs">699eb0ac…b5720</dd>
            </div>
          </dl>
          <p className="mt-5 max-w-prose text-xs text-ink-soft">
            A separate public-corpus audit had 360 / 360 inferred interactions, 0 / 360
            evidence-eligible interactions, and 360 / 360 abstentions. Those degraded-mode
            counts are not blended into this fixture headline.
          </p>
          <Link href="/detectors" className="button-primary mt-6">
            Inspect fixture detectors
          </Link>
        </aside>
      </section>
    </>
  );
}
