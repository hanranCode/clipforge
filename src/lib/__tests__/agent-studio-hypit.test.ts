// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportEditableProject } from "@/lib/agent-studio/hypit-project";
import type { AgentWork, WorkVersion } from "@/lib/agent-studio/types";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe("editable project audio fidelity", () => {
  it.each(["original", "female"] as const)("preserves the %s audio strategy across export", async voice => {
    const directory = await mkdtemp(join(tmpdir(), "clipforge-project-")); directories.push(directory);
    await exportEditableProject(directory, { duration: 18, voice } as AgentWork, { id: "version", plan: { segments: [{ duration: 9 }, { duration: 9 }] } } as WorkVersion, 496, 864);
    const xml = await readFile(join(directory, "finished.svml"), "utf8");
    const sound = xml.split('<audio:Track id="sound"')[1].split("</audio:Track>")[0];
    expect(xml).toContain('src="./segment-0.mp4"'); expect(xml).toContain('src="./segment-1.mp4"');
    if (voice === "original") { expect(xml).toContain('src="./final.mp4"'); expect(sound).toContain("source={finalReady.media}"); expect(sound).not.toContain("source={ready0.media}"); expect(sound.match(/<audio:Clip/g)).toHaveLength(1); expect(xml).toContain('id="full" from="0f" until="432f"'); }
    else { expect(sound).toContain("source={ready0.media}"); expect(sound).toContain("source={ready1.media}"); expect(sound.match(/<audio:Clip/g)).toHaveLength(2); }
  });
  it("keeps local Agent app entrypoints on loopback by default", async () => { const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")); for (const entry of ["dev", "start"]) expect(pkg.scripts[entry]).toMatch(/--hostname\s+127\.0\.0\.1(?:\s|$)/); });
});
