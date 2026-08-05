import type { Metadata } from "next";

import { LiveSuggestion } from "@/components/live-suggestion";

export const metadata: Metadata = { title: "Support chat" };

export default function LivePage() {
  return (
    <div className="live-page">
      <header className="product-hero">
        <p className="product-eyebrow">Accessible customer support</p>
        <h1>Support that helps you find the words.</h1>
        <p>
          Type any message—even incomplete, misspelled, or jumbled words—or choose I don’t know
          what to say. Wordless compares the meaning with read-only account evidence and offers
          short choices for you to confirm. It is designed with aphasia-related word-finding
          barriers in mind, available to everyone, and never infers a diagnosis.
        </p>
      </header>
      <LiveSuggestion />
    </div>
  );
}
