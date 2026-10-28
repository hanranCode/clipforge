"use client";
import { useT } from "@/lib/i18n";
import { formatUsd } from "@/lib/model-pricing";
import type { ProjectCost } from "@/lib/project-costs";
export function TaskCost({ cost }: { cost?: ProjectCost }) {
  const t = useT("projectsPage");
  if (!cost?.calls) return null;
  const amounts = [cost.totalCny > 0 ? `¥${cost.totalCny.toFixed(4)}` : "", cost.totalUsd > 0 ? formatUsd(cost.totalUsd) : ""].filter(Boolean).join(" + ") || (cost.unpricedCalls ? "—" : "$0");
  return <p className="text-xs text-muted-foreground" title={t("costHint")}>
    {t("taskCost")} ≈{amounts}{cost.unpricedCalls > 0 && ` · ${t("unpricedCost", { n: cost.unpricedCalls })}`}
  </p>;
}
