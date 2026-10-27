import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentWork, WorkVersion } from "./types";

export async function exportEditableProject(dir: string, w: AgentWork, v: WorkVersion, width: number, height: number) {
  const imports = ["media", "prepare", "time", "space", "visual", "audio", "film"];
  const packages = ["media", "media-operations", "timeline-author", "spatial", "visual-track", "audio-track", "film"];
  let cursor = 0;
  const shots = v.plan.segments.map((seg, index) => { const from = cursor; cursor += seg.duration * 24; return { index, from, until: cursor }; });
  const retainSourceAudio = w.voice === "original";
  const xml = `<?svml using="@hypit/markup@1"?>\n<svml>\n${imports.map((name, i) => `  <import as="${name}" from="@hypit/${packages[i]}@1"/>`).join("\n")}
  <import as="look" source="./film.svs"/>
  <time:Clock id="clock" frame-rate="24"/>
  <space:Canvas id="canvas" width="${width}" height="${height}"/>
${shots.map(s => `  <media:Video id="shot${s.index}" src="./segment-${s.index}.mp4"/>\n  <prepare:Normalize id="ready${s.index}" source={shot${s.index}} video="primary-moving" audio="default" span-authority="video" clock={clock}/>`).join("\n")}
${retainSourceAudio ? '  <media:Video id="finalSound" src="./final.mp4"/>\n  <prepare:Normalize id="finalReady" source={finalSound} video="primary-moving" audio="default" span-authority="video" clock={clock}/>' : ""}
  <time:Timeline id="program" clock={clock} end="${w.duration}s">
${retainSourceAudio ? `    <time:Window id="full" from="0f" until="${cursor}f"/>` : ""}
${shots.map(s => `    <time:Window id="window${s.index}" from="${s.from}f" until="${s.until}f"/>`).join("\n")}
  </time:Timeline>
  <visual:Track id="picture" timeline={program.timeline}>
${shots.map(s => `    <visual:Clip id="visual${s.index}" media={ready${s.index}.media} during={program.window${s.index}} frame={canvas.bounds} z="10" fit="contain"/>`).join("\n")}
  </visual:Track>
  <audio:Track id="sound" timeline={program.timeline}>
${retainSourceAudio ? '    <audio:Clip id="originalSound" source={finalReady.media} during={program.full}/>' : shots.map(s => `    <audio:Clip id="audio${s.index}" source={ready${s.index}.media} during={program.window${s.index}}/>`).join("\n")}
  </audio:Track>
  <film:Film id="main" canvas={canvas.canvas} timeline={program.timeline} appearance={look.film.main}>
    <film:Track source={picture.visual}/><film:Track source={sound.audio}/>
  </film:Film>
</svml>`;
  await Promise.all([
    writeFile(join(dir, "package.json"), JSON.stringify({ name: `clipforge-${v.id}`, private: true, type: "module", hypit: { project: true } }, null, 2)),
    writeFile(join(dir, "finished.svml"), xml),
    writeFile(join(dir, "film.svs"), '<?svml using="@hypit/recipe@1"?>\n<sheet version="1">film.main { background: "#111111"; }</sheet>'),
    writeFile(join(dir, "finished.svrun"), '<?svml using="@hypit/markup/run@1"?>\n<svrun version="1"><author source="./finished.svml"/><target output="main.composition"/></svrun>'),
    writeFile(join(dir, "hypit.runtime.json"), JSON.stringify({ format: "hypit.runtime-local@1", dataRoot: ".hypit/runtime", endpoints: { "media.local": { use: "@hypit/media-local" } }, bindings: {} }, null, 2))
  ]);
}
