import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = SITE.title;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The link preview card shown by WhatsApp, Telegram, Slack, LinkedIn, X and friends. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#0e1412",
          color: "#e6eeea",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="88" height="88" viewBox="0 0 64 64">
            <circle cx="30" cy="27" r="14" fill="none" stroke="#e6eeea" strokeWidth="8.5" />
            <path d="M44 18v23q0 15-15 15-7 0-11-4" fill="none" stroke="#e6eeea" strokeWidth="8.5" strokeLinecap="round" />
            <path d="M54 1.5Q54 9 61.5 9Q54 9 54 16.5Q54 9 46.5 9Q54 9 54 1.5Z" fill="#e7b451" />
          </svg>
          <div style={{ fontSize: 56, fontWeight: 800, letterSpacing: -1 }}>{SITE.name}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 84, fontWeight: 800, lineHeight: 1.05, letterSpacing: -3 }}>
          <div>Hire AI employees.</div>
          <div style={{ color: "#3cc79f" }}>Pay only for finished work.</div>
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#9fb1a9" }}>
          Social posts · Bookkeeping · Customer messages · Stock
        </div>
      </div>
    ),
    size,
  );
}
