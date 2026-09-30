"use client";

import { useSyncExternalStore } from "react";
import { formatRelative, formatUtc } from "@/lib/time";

const TICK_MS = 30_000;

function subscribe(onTick: () => void) {
  const t = setInterval(onTick, TICK_MS);
  return () => clearInterval(t);
}
// A bucket number: stable between ticks, changes every 30s. 0 means "server render / not hydrated".
const clientSnapshot = () => Math.floor(Date.now() / TICK_MS);
const serverSnapshot = () => 0;

/** Renders "in 27 minutes" but keeps the exact UTC time available and refreshes as time passes. */
export function RelativeTime({ iso, prefix }: { iso: string; prefix?: string }) {
  const bucket = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return (
    <time dateTime={iso} title={formatUtc(iso)}>
      {prefix}
      {bucket === 0 ? formatUtc(iso) : formatRelative(iso, new Date(bucket * TICK_MS))}
    </time>
  );
}
