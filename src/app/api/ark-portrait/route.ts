import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isArkAssetConfigured, parseAssetId, parseGroupId, type ArkAssetType, type ArkPortraitKind } from "@/lib/ark-portrait";
import {
  ArkOpenApiError,
  createAsset,
  createValidateSession,
  createVirtualGroup,
  getAsset,
  getValidateResult,
  listGroupAssets,
  listPortraitGroups,
} from "@/lib/ark-portrait-server";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import { resolveUploadFilePath } from "@/lib/remote-image";

export const runtime = "nodejs";

const TYPES: ArkAssetType[] = ["Image", "Video", "Audio"];

/**
 * POST /api/ark-portrait — the presenter library's door to the Ark real-person portrait library.
 * Credentials come with every request (they live in the browser's settings, like every API key here).
 *
 * body: { credentials, op, ... }
 *   op=groups     kind?=real|virtual           → { groups }           (also the credentials test)
 *   op=createGroup  name, description?         → { groupId }          (virtual portrait group)
 *   op=session    callbackUrl                  → { h5Link, bytedToken }
 *   op=result     bytedToken                   → { groupId | null }
 *   op=create     groupId, url, type?, name?, objectStorage?  → { id }
 *   op=status     ids[]                        → { assets }
 *   op=list       groupId, kind?               → { assets }
 */
export async function POST(req: NextRequest) {
  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const credentials = body.credentials;
  if (!isArkAssetConfigured(credentials)) {
    return apiError(req, "请先在 设置 → 火山方舟素材库 填写 Access Key", "Fill in the Access Key under Settings → Ark portrait library first", 400);
  }
  const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
  const kind: ArkPortraitKind = body.kind === "virtual" ? "virtual" : "real";

  try {
    switch (body.op) {
      case "groups":
        return NextResponse.json({ groups: await listPortraitGroups(credentials, kind) });

      case "createGroup": {
        const name = str("name");
        if (!name) return apiError(req, "缺少素材组名称", "Missing group name", 400);
        return NextResponse.json({ groupId: await createVirtualGroup(credentials, { name, description: str("description") || undefined }) });
      }

      case "session": {
        const callbackUrl = str("callbackUrl");
        if (!/^https?:\/\//.test(callbackUrl)) return apiError(req, "缺少回调地址", "Missing callback URL", 400);
        return NextResponse.json(await createValidateSession(credentials, callbackUrl));
      }

      case "result": {
        const token = str("bytedToken");
        if (!token) return apiError(req, "缺少认证凭证", "Missing verification token", 400);
        return NextResponse.json({ groupId: await getValidateResult(credentials, token) });
      }

      case "create": {
        const groupId = parseGroupId(str("groupId"));
        if (!groupId) return apiError(req, "无效的素材组 ID", "Invalid group ID", 400);
        const type = TYPES.includes(body.type as ArkAssetType) ? (body.type as ArkAssetType) : "Image";
        let url = str("url");
        if (!/^https?:\/\//.test(url)) {
          // Ark fetches the file itself: a local file goes through the user's bucket as a presigned link
          const local = resolveUploadFilePath(url);
          if (!local) return apiError(req, "素材地址无效", "Invalid media URL", 400);
          if (!isObjectStorageConfigured(body.objectStorage)) {
            return apiError(
              req,
              "本地素材需要先上传到对象存储才能入库：请在 设置 → 对象存储 配置存储桶",
              "A local file must go through object storage first: configure a bucket under Settings → Object storage",
              400,
            );
          }
          url = await uploadToObjectStorage(body.objectStorage, local);
        }
        return NextResponse.json({ id: await createAsset(credentials, { groupId, url, type, name: str("name") || undefined }) });
      }

      case "status": {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map((id) => parseAssetId(String(id))).filter((id): id is string => !!id).slice(0, 50);
        const assets = await Promise.all(
          ids.map((id) =>
            getAsset(credentials, id).catch((error: unknown) =>
              // an asset authorised from another account cannot be read through the management API
              ({ id, unreadable: error instanceof Error ? error.message : String(error) }),
            ),
          ),
        );
        return NextResponse.json({ assets });
      }

      case "list": {
        const groupId = parseGroupId(str("groupId"));
        if (!groupId) return apiError(req, "无效的素材组 ID", "Invalid group ID", 400);
        return NextResponse.json({ assets: await listGroupAssets(credentials, groupId, kind) });
      }

      default:
        return apiError(req, "未知操作", "Unknown operation", 400);
    }
  } catch (error) {
    const status = error instanceof ArkOpenApiError && error.status >= 400 && error.status < 500 ? error.status : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), ...(error instanceof ArkOpenApiError && { code: error.code }) },
      { status },
    );
  }
}
