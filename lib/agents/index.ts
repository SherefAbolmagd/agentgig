import { dmConcierge } from "./dm-concierge";
import { echoSocial } from "./echosocial";
import { inventoryGuardian } from "./inventory-guardian";
import { onboardingBuddy } from "./onboarding-buddy";
import { receiptHero } from "./receipthero";
import { reviewPulse } from "./reviewpulse";
import { rotaBuilder } from "./rotabuilder";
import type { AnyNativeAgent } from "./types";

/** Native agents by slug. Partner agents are called over A2A instead. */
export const NATIVE_AGENTS: Record<string, AnyNativeAgent> = Object.fromEntries(
  [echoSocial, receiptHero, dmConcierge, inventoryGuardian, reviewPulse, rotaBuilder, onboardingBuddy].map((a) => [a.slug, a]),
);

export type { AnyNativeAgent, Grounding, UploadedFile } from "./types";
