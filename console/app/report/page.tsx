import type { Metadata } from "next";

import { PageHeading } from "@/components/page-heading";
import { findings } from "@/data/fixtures";

export const metadata: Metadata = { title: "Report" };

const lengthSegments = [
  { label: "≤5 words", value: 40, numerator: 4, denominator: 10 },
  { label: "6–15 words", value: 40, numerator: 4, denominator: 10 },
  { label: "16+ words", value: 40, numerator: 4, denominator: 10 },
];

const riskCoverage = [
  { selected: "4 / 15", coverage: "26.7%", correct: "4 / 4", precision: "100.0%" },
  { selected: "8 / 15", coverage: "53.3%", correct: "8 / 8", precision: "100.0%" },
  { selected: "12 / 15", coverage: "80.0%", correct: "12 / 12", precision: "100.0%" },
];

export default function ReportPage() {
  return (
    <>
      <PageHeading
        index="04"
        eyebrow="Audit report"
        title="The fixture finding, its evidence, and its limits"
        description="This page renders the deterministic synthetic demo snapshot. Every rate states its denominator and method; none of the fixture assertions is presented as a production estimate."
        aside={
          <dl className="space-y-4 metric-definition">
            <div>
              <dt>Corpus</dt>
              <dd>demo-synthetic-v1</dd>
            </div>
            <div>
              <dt>Period</dt>
              <dd>2026-01-03–2026-02-01</dd>
            </div>
            <div>
              <dt>Artifact date</dt>
              <dd>2026-02-02</dd>
            </div>
          </dl>
        }
      />

      <article className="report-sheet mt-10" aria-labelledby="report-title">
        <header className="px-4 py-7 sm:px-8 lg:px-12">
          <div className="flex flex-col gap-4 border-b border-rule-firm pb-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
                Wordless audit · synthetic fixture
              </p>
              <h2 id="report-title" className="mt-2 text-lg font-semibold">
                Wordless synthetic fixture · demo-synthetic-v1
              </h2>
            </div>
            <div className="font-mono text-xs tabular-nums text-ink-soft sm:text-right">
              <p>30 / 30 synthetic interactions analyzed</p>
              <p>2026-01-03–2026-02-01 · artifact 2026-02-02</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-8 py-10 md:grid-cols-12 md:py-14">
            <div className="md:col-span-9">
              <p className="font-mono text-3xl font-semibold leading-none tracking-[-0.04em] tabular-nums text-flag">
                9
              </p>
              <p className="mt-4 max-w-[62ch] text-lg leading-7">
                synthetic interactions were emitted as findings; each recorded resolution was
                authored to contradict the exported fixture evidence
              </p>
              <p className="mt-5 font-mono text-sm tabular-nums text-ink-soft">
                9 / 30 analyzed · 30.0% · 0 / 9 findings human-reviewed
              </p>
            </div>
            <aside className="border-l-2 border-flag pl-5 text-sm text-ink-soft md:col-span-3">
              <p className="font-semibold text-flag">Fixture outcome</p>
              <p className="mt-2">
                “Evidence disagreed” means a state-backed detector candidate contradicted the
                authored synthetic resolution. It is an end-to-end test assertion, not an
                estimate of support quality.
              </p>
            </aside>
          </div>
        </header>

        <section className="report-section" aria-labelledby="who-heading">
          <div className="section-kicker">
            <span className="section-kicker-number">1</span>
            <h2 id="who-heading">First-message length check</h2>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-9 lg:grid-cols-12">
            <div className="lg:col-span-8">
              <h3 className="text-lg font-semibold">Agreement@3 by authored length bucket</h3>
              <p className="mt-2 max-w-prose text-xs text-ink-soft">
                Method: top-three replay agreement with the authored resolution. The 30 fixture
                interactions are partitioned into three mutually exclusive buckets of n=10.
              </p>
              <div className="mt-7 space-y-6">
                {lengthSegments.map((segment) => (
                  <div key={segment.label}>
                    <div className="mb-2 grid grid-cols-[86px_1fr] items-baseline gap-4 text-sm sm:grid-cols-[100px_1fr_180px]">
                      <span className="font-semibold">{segment.label}</span>
                      <span className="font-mono text-right tabular-nums sm:order-3">
                        {segment.value}.0%
                        <span className="ml-3 text-xs text-ink-faint">
                          {segment.numerator} / {segment.denominator}
                        </span>
                      </span>
                      <div className="report-bar-track col-span-2 sm:order-2 sm:col-span-1" aria-hidden="true">
                        <div
                          className="report-bar-fill"
                          style={{ width: `${segment.value}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <aside className="lg:col-span-4 lg:border-l lg:border-rule lg:pl-7">
              <p className="font-mono text-2xl tabular-nums">0.0 pp</p>
              <p className="mt-3 max-w-prose text-sm">
                No first-message length difference appears in this fixture snapshot.
              </p>
              <p className="mt-4 text-xs text-ink-soft">
                Each bucket records 4 / 10 agreement@3, or 40.0%. Equal authored fixture rates
                do not establish how message length affects real interactions.
              </p>
            </aside>
          </div>
        </section>

        <section className="report-section" aria-labelledby="tickets-heading">
          <div className="section-kicker">
            <span className="section-kicker-number">2</span>
            <h2 id="tickets-heading">The synthetic interactions</h2>
          </div>
          <h3 className="mt-7 text-lg font-semibold">Evidence disagreed with the authored resolution</h3>
          <p className="mt-2 max-w-prose text-xs text-ink-soft">
            All 9 / 9 findings in outputs/demo-audit/report.json, ordered by interaction ID.
            Evidence values come from exported synthetic state facts at contact time. Each ID
            opens the generated HTML artifact at its full interaction-evidence record.
          </p>
          <div className="audit-table-wrap mt-6">
            <table className="audit-table !min-w-[860px]">
              <thead>
                <tr>
                  <th scope="col">Interaction</th>
                  <th scope="col">Authored as</th>
                  <th scope="col">Evidence indicated</th>
                  <th scope="col">Exported synthetic evidence</th>
                </tr>
              </thead>
              <tbody>
                {findings.map(([id, closedAs, indicated, evidence]) => (
                  <tr className="finding-row" key={id}>
                    <td>
                      <a
                        className="finding-link"
                        href={`/demo-report#interaction-${id}`}
                        aria-label={`Open ${id} full evidence in the generated demo report`}
                      >
                        {id}
                      </a>
                    </td>
                    <td className="text-ink-soft">{closedAs}</td>
                    <td>
                      <span className="label-status label-status-flag">{indicated}</span>
                    </td>
                    <td className="font-mono text-xs tabular-nums">{evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-ink-faint">
            All IDs, fragments, resolutions, and state facts on this page are deterministic
            synthetic fixtures; they are not linked to a support system.
          </p>
        </section>

        <section className="report-section" aria-labelledby="declined-heading">
          <div className="section-kicker">
            <span className="section-kicker-number">3</span>
            <h2 id="declined-heading">Where the fixture replay declined</h2>
          </div>
          <div className="mt-7 grid grid-cols-1 gap-8 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <p className="font-mono text-2xl tabular-nums text-hold">9</p>
              <p className="mt-2 font-semibold">synthetic interactions abstained</p>
              <p className="mt-3 font-mono text-xs tabular-nums text-ink-soft">
                9 / 30 replay outcomes · 30.0%
              </p>
              <p className="mt-5 max-w-prose text-sm text-ink-soft">
                Method: the aggregate outcome stored in the demo report. The report does not
                persist a reason code for each abstention, so this interface does not invent one.
                This offline fixture routed no case to a person.
              </p>
            </div>
            <div className="lg:col-span-8 lg:border-l lg:border-rule lg:pl-7">
              <h3 className="font-semibold">Held-out synthetic risk–coverage assertions</h3>
              <p className="mt-2 max-w-prose text-xs text-ink-soft">
                Three of 12 representative points from the stored curve. Method: empirical
                selective precision on the complementary alternating fixture split (n=15);
                “correct” means the pre-threshold top detector ID matched the authored
                expected_detector value. This is not an external calibration sample.
              </p>
              <div className="audit-table-wrap mt-5">
                <table className="audit-table !min-w-[650px]">
                  <thead>
                    <tr>
                      <th scope="col">Selected / held-out</th>
                      <th scope="col">Coverage</th>
                      <th scope="col">Correct / selected</th>
                      <th scope="col">Selective precision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {riskCoverage.map((row) => (
                      <tr key={row.selected}>
                        <td className="font-mono">{row.selected}</td>
                        <td className="font-mono">{row.coverage}</td>
                        <td className="font-mono">{row.correct}</td>
                        <td className="font-mono">{row.precision}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        <section id="method-limits" className="report-section" aria-labelledby="method-heading">
          <div className="section-kicker">
            <span className="section-kicker-number">4</span>
            <h2 id="method-heading">Method and limits</h2>
          </div>
          <div className="mt-8 grid grid-cols-1 gap-x-12 gap-y-9 md:grid-cols-2">
            <div>
              <h3 className="font-semibold">State evidence</h3>
              <p className="mt-3 max-w-prose text-sm text-ink-soft">
                The synthetic report uses exported fixture state for 30 / 30 interactions
                (100.0%); 0 / 30 were reconstructed and 0 / 30 inferred. Separately, the public
                audit had 360 / 360 inferred interactions, 0 / 360 evidence-eligible, and 360 /
                360 abstentions. Public degraded-mode counts are not blended into this headline.
              </p>
            </div>
            <div>
              <h3 className="font-semibold">Judgment check</h3>
              <p className="mt-3 max-w-prose text-sm text-ink-soft">
                Human review is n=0: 0 / 9 findings were reviewed by a person. The stored judge
                field instead records 21 / 24 matches against authored fixture outcomes (87.5%).
                Its method is a synthetic expected-outcome check, not human inter-rater validation.
              </p>
            </div>
            <div>
              <h3 className="font-semibold">Circumlocution gate</h3>
              <p className="mt-3 max-w-prose text-sm text-ink-soft">
                On 128 / 128 hand-authored closed-set fragment–target pairs, the semantic method
                produced 109 / 128 top-three hits (85.2%) and BM25 produced 61 / 128 (47.7%), a
                difference of 48 / 128 pairs or 37.5 percentage points. This benchmark is not a
                prevalence or production-quality sample.
              </p>
            </div>
            <div>
              <h3 className="font-semibold">What this does not establish</h3>
              <p className="mt-3 max-w-prose text-sm text-ink-soft">
                The fixture tests system behavior; it does not estimate production disagreement,
                assign fault, diagnose disability, or establish an effect of brief messages. All
                three length buckets were equal at 4 / 10 agreement@3 (40.0%).
              </p>
            </div>
          </div>
          <div className="mt-10 grid grid-cols-1 gap-5 border-y border-rule-firm py-5 font-mono text-xs tabular-nums text-ink-soft sm:grid-cols-3">
            <p><span className="block text-[10px] uppercase tracking-[0.1em] text-ink-faint">Snapshot</span>demo-synthetic-v1</p>
            <p><span className="block text-[10px] uppercase tracking-[0.1em] text-ink-faint">Verified embed seed</span>17</p>
            <p><span className="block text-[10px] uppercase tracking-[0.1em] text-ink-faint">Report source</span>outputs/demo-audit/report.json</p>
          </div>
        </section>
      </article>
    </>
  );
}
