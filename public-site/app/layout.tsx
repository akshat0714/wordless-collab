import type { Metadata } from "next";
import "./globals.css";

const title = "Wordless — Support that helps you find the words";
const description =
  "A public synthetic demo of evidence-backed communication choices inside an ordinary customer-support chat.";

export const metadata: Metadata = {
  metadataBase: new URL("https://wordless-support.magarwal-iit.chatgpt.site"),
  title,
  description,
  openGraph: {
    type: "website",
    title,
    description,
    images: [{
      url: "/og.png",
      width: 1536,
      height: 1024,
      alt: "Wordless turns the short message money twice into clear support choices.",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
        />
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>{children}</body>
    </html>
  );
}
