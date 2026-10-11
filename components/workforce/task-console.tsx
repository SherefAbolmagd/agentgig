"use client";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { toDate } from "@/lib/client/format";
import type { WithId } from "@/lib/client/firestore";
import type { GatewayStep, TaskDoc } from "@/types/firestore";

const STEPS: { key: GatewayStep; label: string }[] = [
  { key: "verify", label: "verify" },
  { key: "reserve", label: "tokens" },
  { key: "scrub", label: "privacy" },
  { key: "ground", label: "knowledge" },
  { key: "run", label: "agent" },
  { key: "deliver", label: "deliver" },
];

interface Props {
  task: WithId<TaskDoc> | null;
  agentName?: string;
  /** True from the click until the task doc shows up. */
  starting: boolean;
}

/** Live view of a task moving through the gateway, fed by the task's Firestore doc. */
export function TaskConsole({ task, agentName, starting }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const steps = task?.steps ?? [];
  const busy = starting || task?.status === "reserved" || task?.status === "running";

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [steps.length]);

  const stateOf = (key: GatewayStep) => {
    const entry = [...steps].reverse().find((s) => s.step === key);
    if (entry?.status === "error") return "bad";
    if (entry) return "done";
    const next = STEPS.find((s) => !steps.some((x) => x.step === s.key));
    return busy && next?.key === key ? "active" : "idle";
  };

  return (
    <section aria-label="Task console" className="overflow-hidden rounded-xl bg-console text-console-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5 font-mono text-xs">
        <div className="flex flex-wrap gap-1">
          {STEPS.map((s) => {
            const st = stateOf(s.key);
            return (
              <span
                key={s.key}
                className={cn(
                  "rounded px-1.5 py-0.5",
                  st === "idle" && "bg-white/5 text-white/40",
                  st === "active" && "animate-pulse bg-white/15 text-white",
                  st === "done" && "bg-emerald-400/15 text-emerald-300",
                  st === "bad" && "bg-red-400/15 text-red-300",
                )}
              >
                {s.label}
              </span>
            );
          })}
        </div>
        <span className="text-white/50">
          {task ? (
            <>
              {agentName} · <span className="text-white/80">{task.id.split("_").pop()?.slice(0, 8)}</span>
            </>
          ) : (
            "idle"
          )}
        </span>
      </div>
      <div ref={scroller} role="log" aria-live="polite" className="h-56 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
        {!task && !starting && <p className="text-white/50">Give an agent a task and watch it go through the gateway here.</p>}
        {starting && !task && <Line time="" tag="gateway" text="Sending task…" />}
        {steps.map((s, i) => (
          <Line key={i} time={toDate(s.at)?.toLocaleTimeString("en-GB") ?? ""} tag={s.step} text={s.message} tone={s.status === "error" ? "bad" : "ok"} />
        ))}
        {busy && task && <p className="mt-1 text-white/60">working<span className="ml-1 inline-block h-3.5 w-2 translate-y-0.5 animate-pulse bg-white/70" /></p>}
      </div>
    </section>
  );
}

function Line({ time, tag, text, tone = "ok" }: { time: string; tag: string; text: string; tone?: "ok" | "bad" }) {
  return (
    <p className="whitespace-pre-wrap break-words">
      <span className="text-white/40">{time}</span> <span className="text-sky-300">[{tag}]</span>{" "}
      <span className={tone === "bad" ? "text-red-300" : "text-white/90"}>{text}</span>
    </p>
  );
}
