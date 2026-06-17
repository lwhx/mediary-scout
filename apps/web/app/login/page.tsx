"use client";

import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";

/**
 * §7 P1 login / register. Only reachable when MEDIA_TRACK_MULTI_USER=1 (single-
 * user deployments never see it — middleware passes through). Posts to the auth
 * routes, which set the signed httpOnly session cookie; on success we hard-nav to
 * the library so the new session is picked up server-side.
 */
export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "操作失败，请重试。");
    });
  };

  return (
    <main style={{ maxWidth: 380, margin: "12vh auto", padding: "0 20px" }}>
      <div className="panel">
        <div className="panel-header">
          <h1 className="panel-title">{mode === "login" ? "登录" : "创建账号"}</h1>
        </div>
        <p className="panel-note" style={{ marginBottom: 16 }}>
          {mode === "login"
            ? "登录以访问你的媒体库。"
            : "创建一个本地账号；账号之间数据相互隔离。"}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="setting-row" style={{ marginBottom: 10 }}>
            <input
              className="setting-control"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用户名"
              aria-label="用户名"
              autoComplete="username"
            />
          </div>
          <div className="setting-row" style={{ marginBottom: 14 }}>
            <input
              type="password"
              className="setting-control"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              aria-label="密码"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {error ? (
            <p className="panel-note" style={{ color: "var(--danger, #e5484d)", marginBottom: 12 }}>
              {error}
            </p>
          ) : null}
          <button type="submit" className="primary-button" disabled={isPending} style={{ width: "100%" }}>
            {isPending ? (
              <LoaderCircle size={14} className="spin" aria-hidden />
            ) : mode === "login" ? (
              "登录"
            ) : (
              "创建并登录"
            )}
          </button>
        </form>
        <p className="panel-note" style={{ marginTop: 14, textAlign: "center" }}>
          {mode === "login" ? "还没有账号？" : "已有账号？"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
            style={{
              background: "none",
              border: "none",
              color: "var(--accent, #1db954)",
              cursor: "pointer",
              padding: 0,
              font: "inherit",
            }}
          >
            {mode === "login" ? "创建账号" : "去登录"}
          </button>
        </p>
      </div>
    </main>
  );
}
