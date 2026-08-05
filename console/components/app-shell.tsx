"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const auditNavigation = [
  { number: "01", label: "Fixture data", href: "/corpora" },
  { number: "02", label: "Fixture run", href: "/run" },
  { number: "03", label: "Fixture rules", href: "/detectors" },
  { number: "04", label: "Fixture report", href: "/report" },
];

function ProductShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  return (
    <div className="product-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="product-header">
        <div className="product-header-inner">
          <Link href="/live" className="product-wordmark">
            Wordless
          </Link>
          <nav aria-label="Product" className="product-navigation">
            <Link
              href="/live"
              aria-current={pathname === "/live" ? "page" : undefined}
              className={pathname === "/live" ? "product-nav-active" : undefined}
            >
              Chat
            </Link>
            <Link
              href="/integrate"
              aria-current={pathname === "/integrate" ? "page" : undefined}
              className={pathname === "/integrate" ? "product-nav-active" : undefined}
            >
              Integrate
            </Link>
          </nav>
        </div>
      </header>
      <main id="main-content" className="product-main">
        {children}
      </main>
    </div>
  );
}

function AuditShell({ children, pathname }: { children: ReactNode; pathname: string }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="border-b border-rule-firm bg-surface">
        <div className="mx-auto max-w-audit px-4 md:px-6">
          <div className="flex min-h-20 flex-col justify-center gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:py-0">
            <div className="flex items-baseline gap-3">
              <Link href="/live" className="text-lg font-semibold tracking-[0.08em]">
                WORDLESS
              </Link>
              <span className="border-l border-rule-firm pl-3 text-xs uppercase tracking-[0.14em] text-ink-soft">
                Fixture audit
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs tabular-nums text-ink-soft">
              <span>Wordless synthetic fixture / demo-synthetic-v1</span>
              <span className="inline-flex items-center gap-2 text-ok">
                <span aria-hidden="true" className="status-square bg-ok" />
                Local · bounded writes
              </span>
            </div>
          </div>
          <nav aria-label="Audit" className="overflow-x-auto">
            <ol className="flex min-w-max border-t border-rule">
              {auditNavigation.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`nav-link ${active ? "nav-link-active" : ""}`}
                    >
                      <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                        {item.number}
                      </span>
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </nav>
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-audit px-4 pb-24 pt-10 md:px-6 md:pt-12">
        {children}
      </main>
      <footer className="border-t border-rule bg-surface">
        <div className="mx-auto flex max-w-audit flex-col gap-2 px-4 py-5 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between md:px-6">
          <span>Fixture artifacts + review metadata only · no production connection</span>
          <span className="font-mono tabular-nums">Snapshot demo-synthetic-v1</span>
        </div>
      </footer>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const productMode =
    pathname === "/live" ||
    pathname.startsWith("/live/") ||
    pathname === "/integrate" ||
    pathname.startsWith("/integrate/");

  return productMode ? (
    <ProductShell pathname={pathname}>{children}</ProductShell>
  ) : (
    <AuditShell pathname={pathname}>{children}</AuditShell>
  );
}
