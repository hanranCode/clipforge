import { NextRequest, NextResponse } from "next/server";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { extname, join } from "path";
import { getUploadsDir } from "@/lib/paths";
import { requireReferenceStorage, registerReferenceFile, resolveReferenceResource } from "@/lib/reference-resource-server";

export const runtime = "nodejs";
export const maxDuration = 300;

/** All remake inputs enter the library and the configured TOS bucket before selection/submission. */
export async function POST(req: NextRequest) {
  let temporary: string | undefined;
  try {
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData();
      const config: unknown = JSON.parse(String(form.get("objectStorage")));
      requireReferenceStorage(config);
      const files = form.getAll("files");
      if (!files.length || files.length > 30 || files.some((file) => !(file instanceof File) || !file.size || file.size > 30 * 1024 * 1024)) return NextResponse.json({ error: "请上传最多 30 个参考文件，每个不超过 30MB" }, { status: 400 });
      await mkdir(getUploadsDir(), { recursive: true });
      temporary = await mkdtemp(join(getUploadsDir(), "remake-resources-"));
      const resources = [];
      for (const [index, value] of files.entries()) {
        const file = value as File;
        const ext = extname(file.name).toLowerCase();
        if (!/^\.(jpg|jpeg|png|webp|mp3|wav|m4a|mp4|mov|webm)$/.test(ext)) return NextResponse.json({ error: "不支持的参考文件格式" }, { status: 400 });
        const local = join(temporary, `${index}${ext}`);
        await writeFile(local, Buffer.from(await file.arrayBuffer()));
        resources.push(await registerReferenceFile(config, local, file.name));
      }
      return NextResponse.json({ resources });
    }
    const body = await req.json();
    requireReferenceStorage(body.objectStorage);
    const refs: unknown = body.references;
    if (!Array.isArray(refs) || !refs.length || refs.length > 50 || refs.some((ref) => !ref || typeof ref.path !== "string" || !ref.path)) return NextResponse.json({ error: "参考资源无效" }, { status: 400 });
    const resources = [];
    for (const ref of refs) resources.push(await resolveReferenceResource(body.objectStorage, ref.path, typeof ref.label === "string" ? ref.label : undefined));
    return NextResponse.json({ resources });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "参考素材上传失败" }, { status: 400 });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
