"use client";

import { useId, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";

export interface PromptReference {
  token: string;
  kind: "image" | "video" | "audio";
  label: string;
}

export function mentionAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  const match = text.slice(0, caret).match(/@([^\s@，。；：、！？,.;:!?]*)$/);
  return match ? { start: caret - match[0].length, end: caret, query: match[1].toLowerCase() } : null;
}

/** Plain text remains the source of truth; tokens always use the actual submission order. */
export function PromptInput({ value, onChange, references, label }: {
  value: string;
  onChange: (value: string) => void;
  references: PromptReference[];
  label: string;
}) {
  const t = useT("remake");
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const dismissed = useRef<{ text: string; caret: number } | null>(null);
  const [range, setRange] = useState<ReturnType<typeof mentionAt>>(null);
  const [active, setActive] = useState(0);
  const kinds = ["image", "video", "audio"] as const;
  const matches = kinds.flatMap((kind) => references.filter((ref) => ref.kind === kind &&
    (!range?.query || `${ref.token} ${ref.label} ${t(`mention_${kind}`)}`.toLowerCase().includes(range.query))));
  const inspect = (node: HTMLTextAreaElement) => {
    if (dismissed.current?.text === node.value && dismissed.current.caret === node.selectionStart) return;
    dismissed.current = null;
    const next = mentionAt(node.value, node.selectionStart);
    // Browsers emit select again after arrow keydown, even when the caret did not move.
    // Keep the highlighted option unless the query or caret actually changed.
    if (next?.start === range?.start && next?.end === range?.end && next?.query === range?.query) return;
    setRange(next); setActive(0);
  };
  const choose = (ref: PromptReference) => {
    if (!range) return;
    const token = `${ref.token} `;
    onChange(value.slice(0, range.start) + token + value.slice(range.end));
    const caret = range.start + token.length;
    setRange(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret); setRange(null); });
  };
  const open = range !== null;
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  return <div className="relative space-y-1">
    <label htmlFor={id} className="text-xs">{label}</label>
    <Textarea ref={input} id={id} rows={6} value={value} className="text-sm" role="combobox"
      aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-refs` : undefined}
      aria-activedescendant={open && matches.length ? `${id}-ref-${selected}` : undefined}
      onChange={(event) => { onChange(event.target.value); inspect(event.target); }}
      onSelect={(event) => inspect(event.currentTarget)}
      onKeyDown={(event) => {
        if (!open || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault(); dismissed.current = { text: event.currentTarget.value, caret: event.currentTarget.selectionStart }; setRange(null);
        }
        else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
          event.preventDefault(); const next = (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
          setActive(next); document.getElementById(`${id}-ref-${next}`)?.scrollIntoView?.({ block: "nearest" });
        } else if ((event.key === "Enter" || event.key === "Tab") && matches.length) {
          event.preventDefault(); choose(matches[selected]);
        }
      }} onBlur={() => setRange(null)} />
    <p className="text-xs text-muted-foreground">{t("mentionHint")}</p>
    {open && <div id={`${id}-refs`} role="listbox" aria-label={t("mentionTitle")}
      className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
      {kinds.map((kind) => <div role="group" aria-label={t(`mention_${kind}`)} key={kind}>
        <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">{t(`mention_${kind}`)}</p>
        {matches.filter((ref) => ref.kind === kind).map((ref) => {
          const index = matches.indexOf(ref);
          return <button id={`${id}-ref-${index}`} key={ref.token} type="button" role="option" aria-selected={index === selected}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(ref)}
            className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs ${index === selected ? "bg-primary/15 text-primary" : "hover:bg-muted"}`}>
            <span className="shrink-0 font-mono">{ref.token}</span><span className="truncate">{ref.label}</span>
          </button>;
        })}
        {!matches.some((ref) => ref.kind === kind) && <p className="px-2 pb-2 text-xs text-muted-foreground">{t("mentionEmpty")}</p>}
      </div>)}
    </div>}
  </div>;
}
