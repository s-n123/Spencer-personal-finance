import { notFound, redirect } from "next/navigation";
import { simulatorAvailable } from "@/server/channels/simulator/guard";

export const dynamic = "force-dynamic";

export default function DevIndex(): never {
  if (!simulatorAvailable()) notFound();
  redirect("/dev/chat");
}
