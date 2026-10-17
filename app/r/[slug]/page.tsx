import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ReviewBoard } from "@/components/reviews/review-board";
import { accountBySlug, listReviews } from "@/lib/reviews";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const account = await accountBySlug((await params).slug);
  return {
    title: account ? `Reviews of ${account.user.businessName}` : "Reviews",
    // Customer content: keep it out of search results.
    robots: { index: false, follow: false },
  };
}

/** A business's public review page: customers leave a rating, the business's agents answer. */
export default async function ReviewPage({ params }: Props) {
  const { slug } = await params;
  const account = await accountBySlug(slug);
  if (!account) notFound();
  const reviews = await listReviews(account.id);
  const p = account.user.businessProfile;
  return (
    <main className="min-h-dvh bg-background">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Reviews</p>
        <h1 className="mt-1 font-display text-4xl font-bold tracking-tight">{account.user.businessName}</h1>
        {p && <p className="mt-2 text-muted-foreground">{[p.location, p.openingHours].filter(Boolean).join(" · ")}</p>}
        <ReviewBoard slug={slug} businessName={account.user.businessName} initial={reviews} />
        <footer className="mt-16 border-t pt-6 text-xs text-muted-foreground">
          Replies by {account.user.businessName}, with help from{" "}
          <Link href="/" className="font-medium text-foreground hover:underline">
            AgentGig
          </Link>
        </footer>
      </div>
    </main>
  );
}
