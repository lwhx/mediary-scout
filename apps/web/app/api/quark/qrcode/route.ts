import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse } from "next/server";
import { QuarkQrLoginClient } from "@media-track/workflow";

export async function POST(): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  try {
    const session = await new QuarkQrLoginClient().getToken();
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
