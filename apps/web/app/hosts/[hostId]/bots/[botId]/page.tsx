"use client";

import { useParams } from "next/navigation";
import React from "react";

import { BotScreen } from "../../../../../src/screens/bot-screen";

export default function BotRoutePage({
}: Record<string, never>) {
  const { botId, hostId } = useParams<{ hostId: string; botId: string }>();

  return <BotScreen hostId={hostId} botId={decodeURIComponent(botId)} />;
}
