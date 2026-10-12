import { z } from "zod";

/** Validates the business profile form. Shared by the API and the form. */
export const BusinessProfileSchema = z.object({
  businessName: z.string().trim().min(1, "Enter your business name").max(80),
  description: z.string().trim().min(10, "Describe your business in a sentence or two").max(1000),
  products: z.string().trim().min(3, "List what you sell").max(1500),
  audience: z.string().trim().min(3, "Say who your customers are").max(300),
  toneOfVoice: z.string().trim().min(3, "Describe how you sound").max(200),
  avoidWords: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  website: z.union([z.url({ protocol: /^https?$/ }), z.literal("")]).optional(),
  location: z.string().trim().max(120).optional(),
  openingHours: z.string().trim().max(120).optional(),
  reviewUrl: z.union([z.url({ protocol: /^https$/ }), z.literal("")]).optional(),
  companyNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([0-9]{8}|[A-Z]{2}[0-9]{6})$/, "Companies House numbers are 8 characters, e.g. 01234567 or SC123456")
    .optional(),
  timeZone: z
    .string()
    .refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "Choose a valid time zone")
    .optional(),
});
export type BusinessProfileInput = z.infer<typeof BusinessProfileSchema>;
