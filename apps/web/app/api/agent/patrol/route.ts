import { connection, NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../lib/agent-api/guard";
import { assertNotDemoFromEnv } from "../../../../lib/demo-mode";
import { runScheduledType3 } from "../../../../lib/workflow-runtime";

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
  const result = await runScheduledType3({ force: true });
  return NextResponse.json(result);
}
