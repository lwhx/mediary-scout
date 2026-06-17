import { connection, NextResponse } from "next/server";
import { getActivityView } from "../../../lib/activity-view";
import { ensureDemoSeeded, getCurrentAccountId, getWorkflowRepository } from "../../../lib/workflow-runtime";

/**
 * Live activity feed for the /activity page: the queue+running set + recent
 * completed runs. The client session-scopes 已完成 by matching against the runIds
 * it observed active.
 */
export async function GET() {
  // Request-time only: keep this out of build-time prerender (it reads the DB).
  await connection();
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const view = await getActivityView({ repository, accountId: await getCurrentAccountId() });
  return NextResponse.json(view);
}
