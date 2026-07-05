import { connection, NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../lib/agent-api/guard";
import { readAgentConfig, writeAgentConfig, type AgentConfigWriteInput } from "../../../../lib/agent-api/config-io";
import { assertNotDemoFromEnv } from "../../../../lib/demo-mode";
import { getOwnerAccountId } from "../../../../lib/agent-api/owner";

export async function GET(request: NextRequest) {
  await connection();
  const denied = await agentApiGuard(request);
  if (denied) {
    return denied;
  }
  const accountId = await getOwnerAccountId();
  const config = await readAgentConfig(accountId);
  return NextResponse.json(config);
}

export async function PUT(request: NextRequest) {
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

  let body: AgentConfigWriteInput;
  try {
    body = (await request.json()) as AgentConfigWriteInput;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const accountId = await getOwnerAccountId();
  const result = await writeAgentConfig(accountId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, field: result.field }, { status: 400 });
  }
  const config = await readAgentConfig(accountId);
  return NextResponse.json({ updated: result.updated, config });
}
