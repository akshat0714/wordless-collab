import type { Metadata } from "next";

import { DetectorReview } from "@/components/detector-review";
import { PageHeading } from "@/components/page-heading";

export const metadata: Metadata = { title: "Detectors" };

export default function DetectorsPage() {
  return (
    <>
      <PageHeading
        index="03"
        eyebrow="Detector review"
        title="Inspect what fixture evidence can assert"
        description="Each condition is exercised by six authored cases in the 30-interaction synthetic fixture. Review decisions persist to one bounded local metadata file; they never activate runtime detectors or write to a customer system."
        aside={
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-soft">
              Keyboard review
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <div className="flex items-center gap-2"><dt className="keyboard-key">J</dt><dd>Next</dd></div>
              <div className="flex items-center gap-2"><dt className="keyboard-key">K</dt><dd>Previous</dd></div>
              <div className="flex items-center gap-2"><dt className="keyboard-key">A</dt><dd>Approve</dd></div>
              <div className="flex items-center gap-2"><dt className="keyboard-key">E</dt><dd>Edit</dd></div>
              <div className="flex items-center gap-2"><dt className="keyboard-key">X</dt><dd>Reject</dd></div>
            </dl>
          </div>
        }
      />
      <DetectorReview />
    </>
  );
}
