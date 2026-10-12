import { bookingPrep } from "./booking-prep";
import { bookkeeper } from "./bookkeeper";
import { dmConcierge } from "./dm-concierge";
import { echoSocial } from "./echosocial";
import { inventoryGuardian } from "./inventory-guardian";
import { leadFollowup } from "./lead-followup";
import { newsletterWriter } from "./newsletter-writer";
import { onboardingBuddy } from "./onboarding-buddy";
import { orderDesk } from "./order-desk";
import { receiptHero } from "./receipthero";
import { revenuePulse } from "./revenue-pulse";
import { reviewPulse } from "./reviewpulse";
import { rotaBuilder } from "./rotabuilder";
import { winback } from "./winback";
import type { AnyNativeAgent } from "./types";

/** Native agents by slug. Partner agents are called over A2A instead. */
export const NATIVE_AGENTS: Record<string, AnyNativeAgent> = Object.fromEntries(
  [
    echoSocial,
    receiptHero,
    dmConcierge,
    inventoryGuardian,
    reviewPulse,
    rotaBuilder,
    onboardingBuddy,
    orderDesk,
    winback,
    revenuePulse,
    newsletterWriter,
    leadFollowup,
    bookkeeper,
    bookingPrep,
  ].map((a) => [a.slug, a]),
);

export type { AnyNativeAgent, Grounding, UploadedFile } from "./types";
