import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { simulatorAvailable } from "@/server/channels/simulator/guard";
import { policy } from "@/server/config/policy";
import { normalizeSimPhone } from "../phones";
import { SimChat } from "./sim-chat";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Simulator · Nutrition Coach",
  robots: { index: false, follow: false },
};

export default async function DevChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // proxy.ts already 404s here when the simulator is off; this is the handler-level re-check.
  if (!simulatorAvailable()) notFound();
  const { phone } = await searchParams;
  const initialPhone = (typeof phone === "string" && normalizeSimPhone(phone)) || policy.simulator.defaultPhone;
  return <SimChat initialPhone={initialPhone} />;
}
