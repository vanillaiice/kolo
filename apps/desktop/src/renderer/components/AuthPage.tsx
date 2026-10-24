import { useEffect, useRef, type ReactNode } from "react";
import { useText } from "./ui.tsx";

/** Shared desktop entry layout: the task stays left, contextual guidance stays right. */
export function AuthPage({ title, description, context, children, aside, onBack, busy = false }: {
  readonly title: string; readonly description: string; readonly context: string; readonly children: ReactNode;
  readonly aside: ReactNode; readonly onBack?: () => void; readonly busy?: boolean;
}): React.JSX.Element {
  const { t } = useText(), heading = useRef<HTMLHeadingElement>(null), page = useRef<HTMLElement>(null), shown = useRef(false);
  useEffect(() => {
    heading.current?.focus();
    // A new step settles in like a new screen, without remounting the form below it (its state stays).
    if (shown.current && !matchMedia("(prefers-reduced-motion: reduce)").matches)
      page.current?.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    shown.current = true;
  }, [title]);
  return <section ref={page} className="entry-page" aria-labelledby="entry-title">
    <div className="entry-heading">{onBack && <button type="button" className="text-button entry-back" disabled={busy} onClick={onBack}><span aria-hidden="true">←</span>{t("back")}</button>}
      <p className="eyebrow">{context}</p><h1 id="entry-title" ref={heading} tabIndex={-1}>{title}</h1><p className="entry-lead">{description}</p>
    </div>
    <div className="entry-columns"><div className="entry-panel">{children}</div><aside className="entry-aside">{aside}</aside></div>
  </section>;
}

/** A whole labelled choice is clickable; supporting copy explains the consequence. */
export function EntryChoice({ title, description, onClick, disabled = false, action, featured = false }: {
  readonly title: string; readonly description: string; readonly onClick: () => void; readonly disabled?: boolean;
  readonly action?: string; readonly featured?: boolean;
}): React.JSX.Element {
  return <button type="button" data-auth-action={action} className={`entry-choice${featured ? " featured" : ""}`} onClick={onClick} disabled={disabled}>
    <span><strong>{title}</strong><span>{description}</span></span><span className="choice-arrow" aria-hidden="true">→</span>
  </button>;
}

export function LocalGuide(): React.JSX.Element {
  const { t } = useText();
  return <><p className="eyebrow">{t("onThisComputer")}</p><h2>{t("localGuideTitle")}</h2><p>{t("localGuideHelp")}</p>
    <div className="entry-note"><span className="status-dot"/><span>{t("offlineGuide")}</span></div></>;
}
