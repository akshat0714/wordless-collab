import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:3000"),
  title: {
    default: "Wordless Support",
    template: "%s · Wordless",
  },
  description:
    "A familiar customer-support chat with evidence-backed communication choices built in.",
  openGraph: {
    type: "website",
    title: "Wordless Support",
    description:
      "A familiar customer-support chat with evidence-backed communication choices built in.",
    images: [
      {
        url: "/og.png",
        width: 1536,
        height: 1024,
        alt: "Wordless turns the short message money twice into two clear support choices.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Wordless Support",
    description:
      "A familiar customer-support chat with evidence-backed communication choices built in.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
