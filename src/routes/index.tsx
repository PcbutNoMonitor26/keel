import { createFileRoute } from "@tanstack/react-router";
import { Desk } from "@/components/desk/Desk";
import { getScan } from "@/lib/keel/scan";

export const Route = createFileRoute("/")({
  loader: () => getScan({ data: { held: [] } }),
  component: Home,
});

function Home() {
  const scan = Route.useLoaderData();
  return <Desk initial={scan} />;
}
