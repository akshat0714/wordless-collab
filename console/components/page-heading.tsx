import type { ReactNode } from "react";

export function PageHeading({
  index,
  eyebrow,
  title,
  description,
  aside,
}: {
  index: string;
  eyebrow: string;
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <header className="grid grid-cols-1 gap-6 border-b border-rule-firm pb-8 md:grid-cols-12">
      <div className="md:col-span-8">
        <div className="mb-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-soft">
          <span className="font-mono tabular-nums text-ink-faint">{index}</span>
          <span>{eyebrow}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em] md:text-[40px] md:leading-[46px]">
          {title}
        </h1>
        <p className="mt-4 max-w-prose text-base text-ink-soft">{description}</p>
      </div>
      {aside ? <div className="md:col-span-4 md:border-l md:border-rule md:pl-6">{aside}</div> : null}
    </header>
  );
}
