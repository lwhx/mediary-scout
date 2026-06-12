"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "media-track.lastQuery";

/** Persists the current search query so navigation can restore it. */
export function RememberQuery({ query }: { query: string }) {
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, query);
    } catch {
      // storage unavailable — nothing to remember
    }
  }, [query]);
  return null;
}

/**
 * 搜索 nav entry that restores the last query: leaving for 媒体库/通知 and
 * coming back must not reset the result list.
 */
export function SearchNavLink({
  active,
  knownQuery = "",
}: {
  active: boolean;
  knownQuery?: string;
}) {
  const router = useRouter();
  return (
    <Link
      className={`nav-item ${active ? "is-active" : ""}`}
      href={`/?tab=search&q=${encodeURIComponent(knownQuery)}`}
      onClick={(event) => {
        if (knownQuery) {
          return; // server-known query already in href
        }
        let remembered = "";
        try {
          remembered = sessionStorage.getItem(STORAGE_KEY) ?? "";
        } catch {
          remembered = "";
        }
        if (remembered) {
          event.preventDefault();
          router.push(`/?tab=search&q=${encodeURIComponent(remembered)}`);
        }
      }}
    >
      <Search size={16} aria-hidden />
      搜索
    </Link>
  );
}
