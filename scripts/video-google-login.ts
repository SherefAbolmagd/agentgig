/**
 * Opens Microsoft Edge (a normal window, no automation attached) on a profile
 * kept for the video recorder, so you can sign in once to the Google account
 * connected to the video account. Google refuses sign-ins from automated
 * browsers; the recorder later reuses this signed-in profile through
 * Playwright's "msedge" channel. Close the window when Gmail has opened.
 *
 * The profile holds a live Google session: keep it outside the repo and sign
 * out (or delete the folder) when the video is done.
 *
 *   npx tsx scripts/video-google-login.ts <profile-dir>
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("Pass the profile directory.");
  if (!EDGE) throw new Error("Microsoft Edge isn't installed.");
  const edge = spawn(EDGE, [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "https://accounts.google.com/ServiceLogin?continue=https://mail.google.com/mail/u/0/%23drafts"], { stdio: "ignore" });
  console.log("Sign in to the Google account connected to the video account, then close the Edge window.");
  edge.on("exit", () => console.log("✓ Edge closed. The profile keeps the sign-in."));
}

main();
