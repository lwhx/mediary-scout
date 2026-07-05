import { connection, NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../lib/agent-api/guard";
import { acquireMedia, type AcquireInput } from "../../../../lib/agent-api/acquire";
import { assertNotDemoFromEnv } from "../../../../lib/demo-mode";
import { getOwnerAccountId } from "../../../../lib/agent-api/owner";

export async function POST(request: NextRequest) {
  await connection();
  const denied = await agentApiGuard(request);
  if (denied) {
    return denied;
  }
  try {
    assertNotDemoFromEnv(process.env);
  } catch {
    return NextResponse.json({ error: "demo 模式禁止写操作" }, { status: 403 });
  }

  let body: AcquireInput;
  try {
    body = (await request.json()) as AcquireInput;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (!body.query?.trim() && !body.tmdbId) {
    return NextResponse.json({ error: "query 或 tmdbId 至少提供一个" }, { status: 400 });
  }

  const accountId = await getOwnerAccountId();
  const result = await acquireMedia(body, accountId);

  if (result.status === "ambiguous") {
    return NextResponse.json(result, { status: 409 });
  }
  if (result.status === "not_found") {
    return NextResponse.json(result, { status: 404 });
  }
  return NextResponse.json(result);
}
