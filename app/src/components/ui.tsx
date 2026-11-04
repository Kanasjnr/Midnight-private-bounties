// The app's small set of building blocks, styled with the Midnight tokens in
// index.css. Pages compose these rather than styling buttons and fields
// one by one, so the whole app reads as one system.
import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Check, Copy, Loader2 } from "lucide-react";
import type { Tone } from "~/lib/board";

export function cx(...parts: Parameters<typeof clsx>): string {
  return twMerge(clsx(parts));
}

type Variant = "primary" | "ghost" | "quiet";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-fg text-on-fg hover:bg-fg-2 disabled:bg-chip disabled:text-faint",
  ghost: "border border-line-strong bg-surface text-fg hover:border-line-hover hover:bg-raised disabled:text-faint disabled:hover:border-line-strong disabled:hover:bg-surface",
  quiet: "text-link hover:text-link-hover disabled:text-faint",
};
const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[13px]",
  md: "h-8 px-3 text-sm",
  lg: "h-10 px-4 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", busy = false, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        VARIANTS[variant],
        variant === "quiet" ? "h-auto px-0" : SIZES[size],
        className,
      )}
      {...rest}
    >
      {busy && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
      {children}
    </button>
  );
});

/** A link styled as a button. */
export function LinkButton({ href, variant = "primary", size = "md", className, children }: { href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap no-underline transition-colors",
        VARIANTS[variant],
        variant === "quiet" ? "px-0" : SIZES[size],
        className,
      )}
    >
      {children}
    </a>
  );
}

const FIELD =
  "w-full rounded-md border border-line-strong bg-page px-3 text-fg outline-none transition-[border-color,box-shadow] hover:border-line-hover focus:border-focus focus:ring-3 focus:ring-focus/15";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(FIELD, "h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(FIELD, "min-h-24 resize-y py-2.5", className)} {...rest} />;
});

/** A label above a field, with an optional counter or hint on the right. */
export function Field({ id, label, aside, hint, children }: { id: string; label: ReactNode; aside?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {typeof aside === "string" ? <span className="font-mono text-xs text-faint">{aside}</span> : aside}
      </div>
      {children}
      {hint}
    </div>
  );
}

const TONES: Record<Tone | "private" | "bad", string> = {
  open: "bg-link",
  ok: "bg-ok",
  warn: "bg-warn",
  muted: "bg-faint",
  private: "bg-private",
  bad: "bg-bad",
};

export function Dot({ tone, className }: { tone: keyof typeof TONES; className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block size-[7px] shrink-0 rounded-full", TONES[tone], className)} />;
}

/** A status with its colored dot. */
export function StatusText({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <Dot tone={tone} />
      {label}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex h-5 items-center rounded-[5px] bg-chip px-1.5 text-xs font-medium text-muted", className)}>{children}</span>;
}

/** An amount in the mono face with its unit after it. */
export function Amount({ value, unit = "TEST", className }: { value: string; unit?: string; className?: string }) {
  return (
    <span className={cx("whitespace-nowrap", className)}>
      <span className="tabular font-medium">{value}</span> <span className="text-[0.8em] font-normal text-faint">{unit}</span>
    </span>
  );
}

/** A copy-to-clipboard button that says when it worked. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-chip hover:text-fg"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1_500);
        })
      }
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** A bordered box for a section of the page. */
export function Panel({ children, className, tone = "plain" }: { children: ReactNode; className?: string; tone?: "plain" | "navy" | "warn" | "bad" | "ok" }) {
  const tones = {
    plain: "border-line bg-surface",
    navy: "border-navy-line bg-navy",
    warn: "border-warn-line bg-warn-bg",
    bad: "border-bad-line bg-bad-bg",
    ok: "border-ok-line bg-ok-bg",
  };
  return <div className={cx("rounded-[10px] border", tones[tone], className)}>{children}</div>;
}

/** A label and value list, like the details beside a bounty. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className={cx("py-2.5 pr-6 text-muted", i > 0 && "border-t border-line-soft")}>{k}</dt>
          <dd className={cx("m-0 py-2.5 text-right", i > 0 && "border-t border-line-soft")}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The two-column "public / private" note shown wherever data goes on chain. */
export function Visibility({ pub, priv, privLabel = "Private" }: { pub: ReactNode; priv: ReactNode; privLabel?: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-faint uppercase">Public</span>
        <span className="text-fg-2">{pub}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-private uppercase">{privLabel}</span>
        <span className="text-fg-2">{priv}</span>
      </div>
    </div>
  );
}
