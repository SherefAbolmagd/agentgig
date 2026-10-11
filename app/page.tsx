import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { SEED_AGENTS } from "@/data/agents";

// Milestone 0 placeholder: checks the theme, fonts and catalogue render.
// Replaced by the real Home page in Milestone 2.
export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-12">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">AgentExchange · foundation</p>
      <h1 className="mt-3 text-5xl font-extrabold">
        Hire AI employees. <span className="text-primary">Pay only for finished work.</span>
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
        Theme, fonts and the seed catalogue are wired up. The marketplace, workforce and developer pages arrive in
        Milestone 2.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SEED_AGENTS.map((a) => (
          <Card key={a.slug} className="flex flex-col">
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-lg bg-accent font-display font-bold text-accent-foreground">
                  {a.initials}
                </span>
                <div>
                  <CardTitle className="font-display">{a.name}</CardTitle>
                  <CardDescription>{a.category}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 text-sm text-muted-foreground">{a.description}</CardContent>
            <CardFooter className="justify-between">
              <span className="font-mono text-sm">
                <b className="text-base font-medium">{a.tokensPerTask}</b> tokens/task
              </span>
              <Badge variant="secondary">{a.source === "native" ? "Live" : "Partner"}</Badge>
            </CardFooter>
          </Card>
        ))}
      </div>

      <Button className="mt-10" size="lg">
        Browse AI employees <ArrowRight />
      </Button>
    </main>
  );
}
