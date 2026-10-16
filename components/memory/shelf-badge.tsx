import { SHELF_INFO } from "@/lib/shelves";
import { cn } from "@/lib/utils";
import type { Shelf } from "@/types/firestore";

export const SHELF_CLASSES: Record<Shelf, string> = {
  customers: "bg-you-soft text-you",
  money: "bg-accent text-accent-foreground",
  stock: "bg-token-soft text-token",
  brand: "bg-destructive-soft text-destructive",
  team: "bg-secondary text-muted-foreground",
};

export function ShelfBadge({ shelf, className }: { shelf: Shelf; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11.5px] font-medium", SHELF_CLASSES[shelf], className)}>
      <span aria-hidden className="size-1.5 rounded-[2px] bg-current" />
      {SHELF_INFO[shelf].label}
    </span>
  );
}
