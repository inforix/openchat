"use client";

import { useParams } from "next/navigation";
import React from "react";

import { NewBotScreen } from "../../../../../src/screens/new-bot-screen";

export default function NewBotRoutePage({
}: Record<string, never>) {
  const { hostId } = useParams<{ hostId: string }>();

  return <NewBotScreen hostId={hostId} />;
}
