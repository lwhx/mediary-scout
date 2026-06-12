import Link from "next/link";
import { Bell, Film, Library, ShieldCheck } from "lucide-react";
import { SearchNavLink } from "./search-memory";

export function AppSidebar({
  active,
  searchQuery = "",
}: {
  active: "search" | "library" | "notifications" | "none";
  searchQuery?: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Film size={18} aria-hidden />
        </span>
        <span className="brand-copy">
          <strong>Media Track</strong>
          <span>115 library ops</span>
        </span>
      </div>

      <nav aria-label="主导航">
        <ul className="nav-list">
          <li>
            <SearchNavLink active={active === "search"} knownQuery={searchQuery} />
          </li>
          <li>
            <Link
              className={`nav-item ${active === "library" ? "is-active" : ""}`}
              href="/?tab=library"
            >
              <Library size={16} aria-hidden />
              媒体库
            </Link>
          </li>
          <li>
            <Link
              className={`nav-item ${active === "notifications" ? "is-active" : ""}`}
              href="/notifications"
            >
              <Bell size={16} aria-hidden />
              通知
            </Link>
          </li>
        </ul>
      </nav>

      <div className="sidebar-footer">
        <Link className="health-card" href="/settings" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="health-icon">
            <ShieldCheck size={16} aria-hidden />
          </span>
          <span>
            <strong>115 连接</strong>
            <span>查看状态 / 扫码连接</span>
          </span>
        </Link>
      </div>
    </aside>
  );
}
