"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { LuCheck, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { isArkAssetConfigured } from "@/lib/ark-portrait";

/**
 * Where the Ark H5 liveness check lands when the person taps 完成:
 * /presenters/ark-callback/<presenterId>?bytedToken=…&resultCode=10000. Opened on this machine it
 * binds the new Asset Group to the presenter straight away; opened on a phone it just reports the
 * result — the presenter dialog on the desktop is polling for the same group meanwhile.
 */
export default function ArkCallbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useT("settings");
  const credentials = useSettingsStore((s) => s.arkAssets);
  const updateCharacter = useCharacterStore((s) => s.updateCharacter);
  const presenter = useCharacterStore((s) => s.characters.find((c) => c.id === id));
  const [state, setState] = useState<"checking" | "bound" | "passed" | "failed">("checking");
  const [code, setCode] = useState("");

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const resultCode = query.get("resultCode") ?? "";
    const token = query.get("bytedToken") ?? "";
    setCode(resultCode);
    if (resultCode !== "10000") return setState("failed");
    // another browser (the person's phone): nothing to bind here
    if (!presenter || !isArkAssetConfigured(credentials) || !token) return setState("passed");
    let cancelled = false;
    const attempt = async (left: number): Promise<void> => {
      const res = await fetch("/api/ark-portrait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "result", credentials, bytedToken: token }),
      });
      const data = (await res.json().catch(() => ({}))) as { groupId?: string | null };
      if (cancelled) return;
      if (data.groupId) {
        updateCharacter(id, { arkPortrait: { ...(presenter.arkPortrait ?? { assets: [] }), kind: "real", groupId: data.groupId, session: undefined } });
        return setState("bound");
      }
      // the result is stored asynchronously, a few seconds after the check
      if (left > 0) return new Promise((r) => setTimeout(r, 3000)).then(() => attempt(left - 1));
      setState("passed");
    };
    void attempt(5).catch(() => !cancelled && setState("passed"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the landing URL
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm space-y-3 text-center">
        {state === "checking" ? (
          <LuLoaderCircle className="mx-auto size-8 animate-spin text-muted-foreground" />
        ) : state === "failed" ? (
          <LuTriangleAlert className="mx-auto size-8 text-destructive" />
        ) : (
          <LuCheck className="mx-auto size-8 text-emerald-600" />
        )}
        <p className="text-sm">
          {state === "checking"
            ? t("arkCallbackChecking")
            : state === "bound"
              ? t("arkCallbackBound", { name: presenter?.name ?? "" })
              : state === "passed"
                ? t("arkCallbackPassed")
                : t("arkCallbackFailed", { code: code || "—" })}
        </p>
        {state === "bound" && (
          <Link href="/presenters" className="text-xs text-primary hover:underline">
            {t("arkCallbackBack")}
          </Link>
        )}
      </div>
    </div>
  );
}
